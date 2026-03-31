#!/usr/bin/env python3
"""
Audio Recognition - ShazamAPI + Demucs (separazione voce/musica) + fallback
Usa: ShazamAPI, Demucs (Meta AI), pydub, ffmpeg
"""

import sys
import json
import subprocess
import urllib.request
import urllib.parse
import tempfile
import os
import shutil
import traceback
import threading
import re

FFMPEG_PATH = os.environ.get('FFMPEG_PATH', r'F:\Cose Mie\ffmpeg-7.1.1-essentials_build\bin\ffmpeg.exe' if os.name == 'nt' else 'ffmpeg')
FFMPEG_DIR = os.path.dirname(FFMPEG_PATH) if os.path.dirname(FFMPEG_PATH) else ''

# Aggiungi ffmpeg al PATH per pydub/ShazamAPI
if FFMPEG_DIR:
    os.environ['PATH'] = FFMPEG_DIR + os.pathsep + os.environ.get('PATH', '')

from ShazamAPI import Shazam

TEMP_FILES = []


def cleanup():
    for f in TEMP_FILES:
        try:
            if os.path.isdir(f):
                shutil.rmtree(f, ignore_errors=True)
            elif os.path.isfile(f):
                os.unlink(f)
        except Exception:
            pass


def download_audio(url):
    """Scarica audio da URL usando ffmpeg e converte in MP3 (ShazamAPI lo preferisce)"""
    try:
        tmp = tempfile.NamedTemporaryFile(suffix='.mp3', delete=False)
        tmp.close()
        TEMP_FILES.append(tmp.name)

        result = subprocess.run(
            [FFMPEG_PATH, '-y',
             '-headers', 'User-Agent: Mozilla/5.0\r\n',
             '-i', url,
             '-ar', '44100', '-ac', '1', '-t', '60',
             tmp.name],
            capture_output=True, timeout=30
        )

        if result.returncode != 0:
            print(f"DEBUG: ffmpeg download failed: {result.stderr.decode(errors='replace')[:300]}", file=sys.stderr)
            return None

        if os.path.exists(tmp.name) and os.path.getsize(tmp.name) > 1000:
            print(f"DEBUG: Audio scaricato: {os.path.getsize(tmp.name)} bytes", file=sys.stderr)
            return tmp.name

        return None
    except Exception as e:
        print(f"DEBUG: download_audio failed: {e}", file=sys.stderr)
        return None


def extract_segment(audio_path, start_sec, duration_sec):
    """Estrai un segmento audio con ffmpeg"""
    try:
        tmp = tempfile.NamedTemporaryFile(suffix='.mp3', delete=False)
        tmp.close()
        TEMP_FILES.append(tmp.name)

        result = subprocess.run(
            [FFMPEG_PATH, '-y',
             '-i', audio_path,
             '-ss', str(start_sec),
             '-t', str(duration_sec),
             '-ar', '44100', '-ac', '1',
             tmp.name],
            capture_output=True, timeout=10
        )

        if result.returncode == 0 and os.path.getsize(tmp.name) > 1000:
            return tmp.name
        return None
    except Exception:
        return None


def get_duration(audio_path):
    """Ottieni durata audio con ffmpeg"""
    try:
        probe = subprocess.run(
            [FFMPEG_PATH, '-i', audio_path, '-f', 'null', '-'],
            capture_output=True, timeout=5
        )
        stderr_text = probe.stderr.decode(errors='replace')
        for line in stderr_text.split('\n'):
            if 'Duration:' in line:
                parts = line.split('Duration:')[1].split(',')[0].strip()
                h, m, s = parts.split(':')
                return int(h) * 3600 + int(m) * 60 + float(s)
    except Exception:
        pass
    return 30


# ── Shazam Recognition ─────────────────────────────────────────────

def _shazam_worker(audio_data, result_holder):
    """Worker thread per Shazam con protezione crash"""
    try:
        shazam = Shazam(audio_data)
        recognize_gen = shazam.recognizeSong()
        attempts = 0
        max_attempts = 6  # Non iterare all'infinito

        for offset, result in recognize_gen:
            attempts += 1
            track = result.get('track')
            if track:
                title = track.get('title', 'Sconosciuto')
                artist = track.get('subtitle', 'Sconosciuto')
                cover = track.get('images', {}).get('coverart', '')
                link = track.get('url', '')

                # Prova hub per streaming links
                hub = track.get('hub', {})
                for action in hub.get('actions', []):
                    if action.get('type') == 'uri' and 'spotify' in action.get('uri', ''):
                        link = action.get('uri', link)

                result_holder['result'] = {
                    'title': title,
                    'artist': artist,
                    'cover': cover,
                    'link': link,
                    'method': 'shazam'
                }
                return

            if attempts >= max_attempts:
                break

    except Exception as e:
        result_holder['error'] = str(e)


def shazam_recognize(audio_path, timeout_sec=20):
    """Riconosce musica tramite Shazam API con timeout protezione"""
    try:
        with open(audio_path, 'rb') as f:
            audio_data = f.read()

        result_holder = {}
        t = threading.Thread(target=_shazam_worker, args=(audio_data, result_holder), daemon=True)
        t.start()
        t.join(timeout=timeout_sec)

        if t.is_alive():
            print(f"DEBUG: Shazam timeout ({timeout_sec}s) - segmento saltato", file=sys.stderr)
            return None

        if 'error' in result_holder:
            print(f"DEBUG: Shazam worker error: {result_holder['error']}", file=sys.stderr)
            return None

        if 'result' in result_holder:
            r = result_holder['result']
            print(f"DEBUG: Shazam trovato: {r['title']} - {r['artist']}", file=sys.stderr)
            return r

        print("DEBUG: Shazam nessun risultato per questo segmento", file=sys.stderr)
    except Exception as e:
        print(f"DEBUG: shazam_recognize failed: {e}", file=sys.stderr)
    return None


# ── Separazione Audio con Demucs (voce vs musica) ──────────────────

def separate_audio(audio_path):
    """
    Separa voce e musica usando Demucs (Meta AI).
    Ritorna percorso della traccia 'no_vocals' (solo musica, senza voce).
    Usa il modello htdemucs (veloce, buona qualità).
    """
    try:
        out_dir = tempfile.mkdtemp(prefix='demucs_')
        TEMP_FILES.append(out_dir)

        # Converti in WAV per demucs (richiede wav)
        wav_path = tempfile.NamedTemporaryFile(suffix='.wav', delete=False).name
        TEMP_FILES.append(wav_path)

        result = subprocess.run(
            [FFMPEG_PATH, '-y', '-i', audio_path, '-ar', '44100', '-ac', '2', wav_path],
            capture_output=True, timeout=15
        )
        if result.returncode != 0:
            print(f"DEBUG: Conversione WAV per demucs fallita", file=sys.stderr)
            return None

        print("DEBUG: Avvio separazione audio con Demucs (htdemucs)...", file=sys.stderr)

        # Esegui demucs come subprocess (evita conflitti di memoria)
        python_exe = sys.executable
        result = subprocess.run(
            [python_exe, '-m', 'demucs',
             '--two-stems', 'vocals',  # separa solo vocals vs no_vocals (più veloce)
             '-n', 'htdemucs',
             '-o', out_dir,
             '--mp3',  # output in mp3 (più piccolo)
             wav_path],
            capture_output=True, timeout=120,
            cwd=os.path.dirname(os.path.abspath(__file__))
        )

        if result.returncode != 0:
            stderr_text = result.stderr.decode(errors='replace')[:500]
            print(f"DEBUG: Demucs fallito: {stderr_text}", file=sys.stderr)
            return None

        # Cerca il file no_vocals (musica senza voce)
        wav_basename = os.path.splitext(os.path.basename(wav_path))[0]
        # Demucs crea: out_dir/htdemucs/<filename>/no_vocals.mp3
        no_vocals_path = os.path.join(out_dir, 'htdemucs', wav_basename, 'no_vocals.mp3')

        if os.path.exists(no_vocals_path) and os.path.getsize(no_vocals_path) > 1000:
            print(f"DEBUG: Traccia musicale estratta: {os.path.getsize(no_vocals_path)} bytes", file=sys.stderr)
            return no_vocals_path

        # Cerca anche con estensione wav
        no_vocals_wav = os.path.join(out_dir, 'htdemucs', wav_basename, 'no_vocals.wav')
        if os.path.exists(no_vocals_wav) and os.path.getsize(no_vocals_wav) > 1000:
            print(f"DEBUG: Traccia musicale estratta (wav): {os.path.getsize(no_vocals_wav)} bytes", file=sys.stderr)
            return no_vocals_wav

        # Lista file trovati per debug
        htdemucs_dir = os.path.join(out_dir, 'htdemucs', wav_basename)
        if os.path.isdir(htdemucs_dir):
            files = os.listdir(htdemucs_dir)
            print(f"DEBUG: File demucs output: {files}", file=sys.stderr)
            # Prova qualsiasi file "no_vocals"
            for f in files:
                if 'no_vocals' in f:
                    path = os.path.join(htdemucs_dir, f)
                    if os.path.getsize(path) > 1000:
                        return path

        print("DEBUG: File no_vocals non trovato nell'output demucs", file=sys.stderr)
        return None

    except subprocess.TimeoutExpired:
        print("DEBUG: Demucs timeout (120s)", file=sys.stderr)
        return None
    except Exception as e:
        print(f"DEBUG: separate_audio failed: {e}", file=sys.stderr)
        return None


# ── MusicBrainz / Genius (fallback titolo) ─────────────────────────

def query_musicbrainz(title, artist=''):
    try:
        query = f'"{title}"'
        if artist:
            query += f' AND artist:"{artist}"'
        params = {'query': query, 'type': 'recording', 'limit': '1', 'fmt': 'json'}
        url = f"https://musicbrainz.org/ws/2/recording?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={'User-Agent': 'YTShortViewer/1.0'})
        with urllib.request.urlopen(req, timeout=8) as r:
            data = json.loads(r.read().decode())
        recordings = data.get('recordings')
        if recordings:
            rec = recordings[0]
            artist_name = 'Sconosciuto'
            ac = rec.get('artist-credit')
            if isinstance(ac, list) and ac and isinstance(ac[0], dict):
                artist_name = ac[0].get('artist', {}).get('name', 'Sconosciuto')
            return {
                'title': rec.get('title', 'Sconosciuto'),
                'artist': artist_name,
                'link': f"https://musicbrainz.org/recording/{rec.get('id', '')}",
                'method': 'musicbrainz'
            }
    except Exception as e:
        print(f"DEBUG: musicbrainz error: {e}", file=sys.stderr)
    return None


def query_genius(title, artist=''):
    try:
        q = f"{title} {artist}" if artist else title
        params = {'q': q}
        url = f"https://genius.com/api/search?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={'User-Agent': 'YTShortViewer/1.0'})
        with urllib.request.urlopen(req, timeout=8) as r:
            data = json.loads(r.read().decode())
        hits = data.get('response', {}).get('hits', [])
        if hits:
            song = hits[0].get('result', {})
            return {
                'title': song.get('title', 'Sconosciuto'),
                'artist': song.get('primary_artist', {}).get('name', 'Sconosciuto'),
                'cover': song.get('song_art_image_url', ''),
                'link': song.get('url', ''),
                'method': 'genius'
            }
    except Exception as e:
        print(f"DEBUG: genius error: {e}", file=sys.stderr)
    return None


# ── Pipeline principale ────────────────────────────────────────────

def recognize_audio(audio_path, title=''):
    """
    Pipeline di riconoscimento:
    1. Shazam sull'intero audio
    2. Shazam su segmenti (inizio, centro, fine) per catturare più tracce
    3. Fallback: MusicBrainz/Genius dal titolo
    """
    tracks = []
    seen = set()

    def add_track(t):
        key = f"{t.get('title','').lower()}_{t.get('artist','').lower()}"
        if key not in seen:
            seen.add(key)
            tracks.append(t)

    duration = get_duration(audio_path)
    print(f"DEBUG: Durata audio: {duration:.1f}s", file=sys.stderr)

    # === STEP 1: Shazam sull'intero audio ===
    print("DEBUG: Step 1 - Shazam intero audio...", file=sys.stderr)
    result = shazam_recognize(audio_path)
    if result:
        add_track(result)

    # === STEP 2: Shazam su segmenti per trovare tracce diverse ===
    if duration > 15:
        segments = []
        seg_len = min(15, duration / 3)

        # Segmento iniziale
        seg = extract_segment(audio_path, 0, seg_len)
        if seg:
            segments.append(('inizio', seg))

        # Segmento centrale
        mid_start = max(0, duration / 2 - seg_len / 2)
        seg = extract_segment(audio_path, mid_start, seg_len)
        if seg:
            segments.append(('centro', seg))

        # Segmento finale
        end_start = max(0, duration - seg_len - 1)
        seg = extract_segment(audio_path, end_start, seg_len)
        if seg:
            segments.append(('fine', seg))

        for name, seg_path in segments:
            print(f"DEBUG: Step 2 - Shazam segmento {name}...", file=sys.stderr)
            res = shazam_recognize(seg_path)
            if res:
                add_track(res)

    # === STEP 2.5: Separazione audio (voce/musica) con Demucs ===
    # Se Shazam non ha trovato nulla, probabilmente c'è troppo parlato.
    # Separiamo la traccia musicale e riproviamo.
    if not tracks:
        print("DEBUG: Step 2.5 - Separazione audio con Demucs...", file=sys.stderr)
        music_track = separate_audio(audio_path)
        if music_track:
            print("DEBUG: Shazam sulla traccia musicale separata...", file=sys.stderr)
            res = shazam_recognize(music_track)
            if res:
                res['method'] = 'shazam (separato)'
                add_track(res)

            # Prova anche segmenti della traccia separata
            if not tracks:
                music_dur = get_duration(music_track)
                if music_dur > 10:
                    mid_start = max(0, music_dur / 2 - 7.5)
                    seg = extract_segment(music_track, mid_start, 15)
                    if seg:
                        print("DEBUG: Shazam segmento centrale della traccia separata...", file=sys.stderr)
                        res2 = shazam_recognize(seg)
                        if res2:
                            res2['method'] = 'shazam (separato)'
                            add_track(res2)

    # === STEP 3: Fallback titolo ===
    if not tracks and title:
        print(f"DEBUG: Step 3 - Fallback titolo: {title}", file=sys.stderr)

        # Estrai possibili nomi di canzoni dal titolo:
        # 1. Testo tra parentesi (es. "bla bla (World's Smallest Violin)" -> "World's Smallest Violin")
        # 2. Dopo " - " o " | " (es. "bla - Song Name" -> "Song Name")
        # 3. Titolo pulito (senza hashtag, emoji, ecc.)
        candidates = []

        # Parentesi tonde
        parens = re.findall(r'\(([^)]{3,})\)', title)
        for p in parens:
            clean = p.strip()
            if clean.lower() not in ('official video', 'official audio', 'lyrics', 'lyric video',
                                      'music video', 'audio', 'visualizer', 'slowed', 'reverb',
                                      'slowed + reverb', 'sped up', 'nightcore'):
                candidates.append(clean)

        # Dopo " - " o " | "
        for sep in [' - ', ' | ', ' — ', ' ~ ']:
            if sep in title:
                parts = title.split(sep)
                for part in parts:
                    clean = part.strip()
                    if clean and len(clean) > 2:
                        candidates.append(clean)

        # Titolo pulito (rimuovi hashtag, emoji, punteggiatura eccessiva)
        clean_title = re.sub(r'#\w+', '', title)  # rimuovi hashtag
        clean_title = re.sub(r'[^\w\s\'\-]', ' ', clean_title)  # rimuovi emoji/simboli
        clean_title = re.sub(r'\s+', ' ', clean_title).strip()
        if clean_title and len(clean_title) > 2:
            candidates.append(clean_title)

        # Rimuovi duplicati mantenendo ordine
        seen_candidates = set()
        unique_candidates = []
        for c in candidates:
            cl = c.lower()
            if cl not in seen_candidates:
                seen_candidates.add(cl)
                unique_candidates.append(c)

        print(f"DEBUG: Candidati titolo: {unique_candidates}", file=sys.stderr)

        for candidate in unique_candidates:
            if tracks:
                break
            print(f"DEBUG: Provo Genius con: '{candidate}'", file=sys.stderr)
            g = query_genius(candidate)
            if g:
                add_track(g)
                break
            # Prova anche MusicBrainz
            mb = query_musicbrainz(candidate)
            if mb:
                add_track(mb)
                break

    return tracks


def main():
    try:
        if len(sys.argv) < 2:
            print(json.dumps({'error': 'URL mancante'}))
            return

        audio_url = sys.argv[1]
        title = sys.argv[2] if len(sys.argv) > 2 else ''
        print(f"DEBUG: title='{title}'", file=sys.stderr)

        print(f"DEBUG: Audio URL: {audio_url[:80]}...", file=sys.stderr)

        audio_path = download_audio(audio_url)
        if not audio_path:
            if title:
                tracks = []
                mb = query_musicbrainz(title)
                if mb:
                    tracks.append(mb)
                if not tracks:
                    g = query_genius(title)
                    if g:
                        tracks.append(g)
                if tracks:
                    print(json.dumps({'success': True, 'results': tracks}))
                    return
            print(json.dumps({'success': False, 'message': 'download audio fallito'}))
            return

        tracks = recognize_audio(audio_path, title)

        if tracks:
            print(json.dumps({'success': True, 'results': tracks}))
        else:
            print(json.dumps({'success': False, 'message': 'audio non riconosciuto', 'results': []}))

    except Exception as e:
        print(json.dumps({'success': False, 'error': str(e), 'traceback': traceback.format_exc()}))
    finally:
        cleanup()


if __name__ == '__main__':
    main()
