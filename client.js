let currentPeriod=7,currentMinViews=1000000,countdownSeconds=300,countdownTimer=null;
let currentTab='feed',savedData={},pendingSave=null;
const videoMap={};

function fmt(n){if(n>=1000000)return(n/1000000).toFixed(1)+'M';if(n>=1000)return(n/1000).toFixed(1)+'K';return String(n)}
function fmtDate(iso){const d=new Date(iso);return String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+d.getFullYear()}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}

function startCountdown(){
  clearInterval(countdownTimer);countdownSeconds=300;
  countdownTimer=setInterval(()=>{
    if(--countdownSeconds<0)countdownSeconds=0;
    const m=Math.floor(countdownSeconds/60),s=countdownSeconds%60;
    document.getElementById('countdown').textContent=m+':'+String(s).padStart(2,'0');
  },1000);
}

async function loadSaved(){const r=await fetch('/api/saved');savedData=await r.json()}

function getBadges(id){
  const e=savedData[id];if(!e||!e.users||!e.users.length)return '';
  return e.users.map(u=>u==='Arkadia'?'<span class="badge badge-arkadia">Arkadia</span>':'<span class="badge badge-holly">Holly</span>').join(' ');
}

function buildCard(s,forSaved){
  const url='https://www.youtube.com/shorts/'+s.id;
  videoMap[s.id]=s;
  const saved=!!savedData[s.id];
  const copied=savedData[s.id]&&savedData[s.id].copied===true;
  const badges=getBadges(s.id);
  const rankClass = 'card-rank-' + (s.rank || 'gray');
  const rankEmoji = s.rank === 'diamond' ? '💎' : s.rank === 'gold' ? '🥇' : s.rank === 'silver' ? '🥈' : s.rank === 'bronze' ? '🥉' : '⚫';
  const fireIcon = s.viewsPerHour > 100000 ? '🔥' : '';
  return '<div class="card '+rankClass+(copied?' copied':'')+'" data-id="'+s.id+'">'
    +'<div class="rank-badge">'+rankEmoji+'</div>'
    +'<a class="card-thumb" href="'+url+'" target="_blank" rel="noopener noreferrer"><img src="'+esc(s.thumbnail)+'" alt="" loading="lazy"/></a>'
    +'<div class="card-body">'
    +'<a class="card-title" href="'+url+'" target="_blank" rel="noopener noreferrer">'+esc(s.title)+'</a>'
    +'<div class="card-channel">'+esc(s.channelName)+'</div>'
    +'<div class="card-stats"><span>👁 '+fmt(s.views)+'</span><span>👍 '+fmt(s.likes)+'</span><span>💬 '+fmt(s.comments||0)+'</span></div>'
    +'<div class="card-velocity"><span>⚡ '+fmt(s.viewsPerHour||0)+'/h'+fireIcon+'</span><span>📊 '+((s.engagementRatio||0).toFixed(2))+'% eng.</span></div>'
    +'<div class="card-date">'+fmtDate(s.publishedAt)+'</div>'
    +'<div class="card-actions">'
    +'<button class="btn-save'+(saved?' saved':'')+'" data-id="'+s.id+'">'+(saved?'✓ Salvato':'+ Salva')+'</button>'
    +(saved?'<button class="btn-copied'+(copied?' done':'')+'" data-id="'+s.id+'">'+(copied?'✅ Copiato':'📋 Segna copiato')+'</button>':'')
    +(badges?'<span>'+badges+'</span>':'')
    +(forSaved?'<button class="btn-remove" data-id="'+s.id+'">🗑</button>':'')
    +'<button class="btn-audio" data-id="'+s.id+'">🎵 Audio</button>'
    +'</div></div></div>';
}

function attachEvents(){
  document.querySelectorAll('.btn-save').forEach(function(btn){
    if(btn.classList.contains('saved'))return;
    btn.addEventListener('click',function(){
      var id=btn.dataset.id;
      var s=videoMap[id];
      if(!s)return;
      pendingSave={id:s.id,title:s.title,thumbnail:s.thumbnail,channelName:s.channelName,views:s.views,likes:s.likes,comments:s.comments||0,publishedAt:s.publishedAt,videoUrl:'https://www.youtube.com/shorts/'+s.id};
      document.getElementById('popupOverlay').classList.add('visible');
    });
  });
  document.querySelectorAll('.btn-copied').forEach(function(btn){
    btn.addEventListener('click',async function(){
      var id=btn.dataset.id;
      var newVal=!(savedData[id]&&savedData[id].copied===true);
      await fetch('/api/saved',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,copied:newVal})});
      await loadSaved();
      currentTab==='saved'?renderSaved():fetchShorts();
    });
  });
  document.querySelectorAll('.btn-remove').forEach(function(btn){
    btn.addEventListener('click',async function(){
      await fetch('/api/saved?id='+btn.dataset.id,{method:'DELETE'});
      await loadSaved();renderSaved();
    });
  });
  document.querySelectorAll('.btn-audio').forEach(function(btn){
    btn.addEventListener('click',async function(){
      var id=btn.dataset.id;
      var video=videoMap[id];
      btn.textContent='⚡ Ricerca...';btn.classList.add('loading');btn.disabled=true;
      try{
        var title=video?encodeURIComponent(video.title):'';
        var r=await fetch('/api/audio?id='+id+'&title='+title);
        var data=await r.json();
        var res=document.getElementById('audioResult');
        if(data.error){
          res.innerHTML='<div style="background:#2a1a1a;padding:12px;border-radius:6px;border-left:4px solid #f44336">'
            +'<b style="color:#f48fb1">❌ Errore</b><br>'
            +'<span style="color:#aaa;font-size:.85rem">'+esc(data.error)+'</span>'
            +'</div>';
        }
        else if(!data.recognized || !data.tracks || data.tracks.length === 0){
          res.innerHTML='<div style="background:#1a2a1a;padding:12px;border-radius:6px;border-left:4px solid #ff9800">'
            +'<b style="color:#ffc107">⚠️ Non riconosciuto</b><br>'
            +'<span style="color:#aaa;font-size:.85rem">'+esc(data.message)+'</span><br><br>'
            +'<a href="'+data.audioUrl+'" target="_blank" style="color:#64b5f6;font-size:.8rem">🔗 Scarica audio</a>'
            +'</div>';
        }
        else {
          let tracksHtml = data.tracks.map(t => 
            '<div style="background:#222;padding:10px;border-radius:8px;margin-bottom:8px;display:flex;align-items:center;gap:12px;border:1px solid #333">'
            +(t.cover ? '<img src="'+t.cover+'" style="width:50px;height:50px;border-radius:4px;object-fit:cover"/>' : '<div style="width:50px;height:50px;background:#333;border-radius:4px;display:flex;justify-content:center;align-items:center">🎵</div>')
            +'<div style="flex:1">'
            +'<div style="font-weight:bold;color:#fff;font-size:.95rem">'+esc(t.title)+'</div>'
            +'<div style="color:#aaa;font-size:.85rem">'+esc(t.artist)+'</div>'
            +'<div style="margin-top:4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
            +'<a href="https://www.youtube.com/results?search_query='+encodeURIComponent(t.title+' '+t.artist)+'" target="_blank" style="color:#f44336;font-size:.75rem;text-decoration:none">▶️ YouTube</a>'
            +(t.link ? '<a href="'+t.link+'" target="_blank" style="color:#2196f3;font-size:.75rem;text-decoration:none">🔗 Shazam</a>' : '')
            +'<span style="color:#555;font-size:.7rem">via '+esc(t.method || 'shazam')+'</span>'
            +'</div></div></div>'
          ).join('');

          res.innerHTML='<div style="background:#1a2a1a;padding:12px;border-radius:6px;border-left:4px solid #4caf50">'
            +'<b style="color:#81c784;display:block;margin-bottom:8px">✅ '+esc(data.message)+'</b>'
            +tracksHtml
            +'<a href="'+data.audioUrl+'" target="_blank" style="color:#64b5f6;font-size:.8rem;display:inline-block;margin-top:8px">🔗 Scarica audio completo</a>'
            +'</div>';
        }
        document.getElementById('audioOverlay').classList.add('visible');
      }catch(e){
        alert('Errore durante l\'analisi audio.');
      }finally{
        btn.textContent='🎵 Audio';btn.classList.remove('loading');btn.disabled=false;
      }
    });
  });
}

async function fetchShorts(){
  if(currentTab!=='feed')return;
  var spinner=document.getElementById('spinner'),grid=document.getElementById('grid'),emptyMsg=document.getElementById('emptyMsg'),statsInfo=document.getElementById('statsInfo');
  spinner.classList.add('visible');grid.innerHTML='';emptyMsg.classList.remove('visible');
  try{
    await loadSaved();
    var res=await fetch('/api/shorts?period='+currentPeriod+'&minViews='+currentMinViews);
    var data=await res.json();var shorts=data.shorts||[];
    // Filtra i video già copiati dal feed
    shorts=shorts.filter(s=>!savedData[s.id]||!savedData[s.id].copied);
    if(!shorts.length){emptyMsg.classList.add('visible');statsInfo.textContent='';}
    else{
      statsInfo.textContent='Canali: '+(data.channelCount||0)+'  |  Video: '+shorts.length;
      grid.innerHTML=shorts.map(function(s){return buildCard(s,false)}).join('');
      attachEvents();
    }
  }catch(e){emptyMsg.textContent='Errore nel caricamento.';emptyMsg.classList.add('visible');}
  finally{spinner.classList.remove('visible');startCountdown();}
}

async function renderSaved(){
  await loadSaved();
  var grid=document.getElementById('grid'),emptyMsg=document.getElementById('emptyMsg'),statsInfo=document.getElementById('statsInfo');
  emptyMsg.classList.remove('visible');
  var entries=Object.values(savedData);
  if(!entries.length){grid.innerHTML='';emptyMsg.textContent='Nessun video salvato.';emptyMsg.classList.add('visible');statsInfo.textContent='';}
  else{
    statsInfo.textContent='Salvati: '+entries.length;
    grid.innerHTML=entries.map(function(s){return buildCard(s,true)}).join('');
    attachEvents();
  }
}

async function saveForUser(user){
  if(!pendingSave)return;
  var body=JSON.parse(JSON.stringify(pendingSave));
  body.user=user;
  await fetch('/api/saved',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  document.getElementById('popupOverlay').classList.remove('visible');
  pendingSave=null;await loadSaved();
  currentTab==='saved'?renderSaved():fetchShorts();
}

document.getElementById('popupArkadia').addEventListener('click',function(){saveForUser('Arkadia')});
document.getElementById('popupHolly').addEventListener('click',function(){saveForUser('Holly')});
document.getElementById('popupCancel').addEventListener('click',function(){document.getElementById('popupOverlay').classList.remove('visible');pendingSave=null;});
document.getElementById('audioClose').addEventListener('click',function(){document.getElementById('audioOverlay').classList.remove('visible')});

document.getElementById('tabFeed').addEventListener('click',function(){
  currentTab='feed';
  document.getElementById('tabFeed').classList.add('active');document.getElementById('tabSaved').classList.remove('active');
  document.getElementById('controls').style.display='';
  document.getElementById('emptyMsg').textContent='Nessuno Short trovato con i filtri selezionati';
  fetchShorts();
});
document.getElementById('tabSaved').addEventListener('click',function(){
  currentTab='saved';
  document.getElementById('tabSaved').classList.add('active');document.getElementById('tabFeed').classList.remove('active');
  document.getElementById('controls').style.display='none';
  renderSaved();
});

document.querySelectorAll('.btn-period').forEach(function(btn){
  btn.addEventListener('click',function(){
    document.querySelectorAll('.btn-period').forEach(function(b){b.classList.remove('active')});
    btn.classList.add('active');currentPeriod=parseInt(btn.dataset.period,10);fetchShorts();
  });
});

var minViewsInput=document.getElementById('minViews');
function applyMinViews(){
  var val=parseInt(minViewsInput.value,10);
  if(!Number.isInteger(val)||val<=0){currentMinViews=1000000;minViewsInput.value=1000000;}
  else currentMinViews=val;
  fetchShorts();
}
minViewsInput.addEventListener('blur',applyMinViews);
minViewsInput.addEventListener('keydown',function(e){if(e.key==='Enter')applyMinViews();});
document.getElementById('searchBtn').addEventListener('click',applyMinViews);

// --- Search bar: lookup short by URL ---
function extractVideoId(input){
  input=input.trim();
  var m=input.match(/(?:youtube\.com\/shorts\/|youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if(m)return m[1];
  if(/^[a-zA-Z0-9_-]{11}$/.test(input))return input;
  return null;
}
var lookupBtn=document.getElementById('shortLookupBtn');
var lookupInput=document.getElementById('shortLinkInput');
async function doLookup(){
  var vid=extractVideoId(lookupInput.value);
  if(!vid){lookupInput.style.border='2px solid #e74c3c';return;}
  lookupInput.style.border='';
  lookupBtn.disabled=true;lookupBtn.textContent='⏳ Cerco...';
  try{
    await loadSaved();
    var res=await fetch('/api/lookup?id='+encodeURIComponent(vid));
    var data=await res.json();
    if(data.error){alert('Errore: '+data.error);return;}
    var grid=document.getElementById('grid');
    grid.innerHTML=buildCard(data.short,false)+grid.innerHTML;
    attachEvents();
    lookupInput.value='';
  }catch(e){alert('Errore di rete.');}
  finally{lookupBtn.disabled=false;lookupBtn.textContent='🔍 Cerca Short';}
}
lookupBtn.addEventListener('click',doLookup);
lookupInput.addEventListener('keydown',function(e){if(e.key==='Enter')doLookup();});

setInterval(fetchShorts,5*60*1000);
fetchShorts();
