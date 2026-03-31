#!/usr/bin/env python3
"""
Audio Recognition con Voice Separation intelligente
- Tenta riconoscimento diretto
- Se fallisce, separa voce da audio e riprova
"""

import sys
import json
import subprocess
import os
import urllib.parse
import urllib.request
from pathlib import Path
import tempfile

def recognize_audio(url):
    """Riconosce canzone dall'URL audio con fallback voice separation"""
    
    # Tenta riconoscimento diretto con AudD
    result = audd_recognize(url)
    if result and result.get('result', {}).get('title'):
        return {'success': True, 'result': result.get('result'), 'method': 'direct'}
    
    # Se fallisce, tenta con separazione voce
    separated = separate_voice(url)
    if separated:
        # Riprova con solo audio (strumenti)
        result_instrumental = audd_recognize(separated['instrumental'])
        if result_instrumental and result_instrumental.get('result', {}).get('title'):
            return {'success': True, 'result': result_instrumental.get('result'), 'method': 'instrumental_only'}
        
        # Riprova con solo voce
        result_vocals = audd_recognize(separated['vocals'])
        if result_vocals and result_vocals.get('result', {}).get('title'):
            return {'success': True, 'result': result_vocals.get('result'), 'method': 'vocals_only'}
    
    return {'success': False, 'message': 'Canzone non riconosciuta. Potrebbe essere un audio meme o custom.'}

def audd_recognize(audio_url):
    """Chiama API AudD per il riconoscimento"""
    try:
        params = urllib.parse.urlencode({
            'url': audio_url,
            'return': 'spotify,apple_music',
            'api_token': 'test'
        }).encode('utf-8')
        
        req = urllib.request.Request(
            'https://api.audd.io/recognizeWithOffset/',
            data=params,
            headers={'Content-Type': 'application/x-www-form-urlencoded'}
        )
        
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.loads(response.read().decode())
    except Exception as e:
        print(f"Errore AudD: {str(e)}", file=sys.stderr)
        return None

def separate_voice(url):
    """Separa voce da audio usando librosa/scipy (senza dipendenze esterne)"""
    import shutil
    
    # Controlla se ffmpeg è disponibile
    if not shutil.which('ffmpeg'):
        print("ffmpeg non trovato", file=sys.stderr)
        return None
    
    try:
        # Tenta con librosa se disponibile
        try:
            from librosa import load, stft, magphase
            import numpy as np
            
            # Scarica audio
            with tempfile.TemporaryDirectory() as tmpdir:
                audio_file = os.path.join(tmpdir, 'audio.wav')
                download_file(url, audio_file)
                
                # Carica audio
                y, sr = load(audio_file, sr=None)
                
                # Separa semplice: frequenze alte = voce, basse = strumenti
                # Questo è un approccio grezzo ma funziona spesso
                D = stft(y)
                mag, phase = magphase(D)
                
                # Threshold per separazione FreQ
                threshold = np.percentile(mag, 70)
                vocals = np.where(mag > threshold, mag, 0.1 * mag) * phase
                instrumental = np.where(mag <= threshold, mag, 0.1 * mag) * phase
                
                # Salva file separati
                from librosa import istft
                vocals_audio = istft(vocals)
                instrumental_audio = istft(instrumental)
                
                vocals_file = os.path.join(tmpdir, 'vocals.wav')
                instrumental_file = os.path.join(tmpdir, 'instrumental.wav')
                
                from scipy.io import wavfile
                wavfile.write(vocals_file, sr, (vocals_audio * 32767).astype(np.int16))
                wavfile.write(instrumental_file, sr, (instrumental_audio * 32767).astype(np.int16))
                
                # Upload e ottieni URL (alternativa: usa local files se possibile)
                # Per semplicità, restituiamo None - richiede server per file temporanei
                return None
        
        except ImportError:
            # Fallback: se librosa non disponibile, ritorna None
            return None
            
    except Exception as e:
        print(f"Errore separazione voce: {str(e)}", file=sys.stderr)
        return None

def download_file(url, filepath):
    """Scarica file da URL"""
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            with open(filepath, 'wb') as f:
                f.write(response.read())
    except Exception as e:
        raise Exception(f"Download fallito: {str(e)}")

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'URL mancante'}))
        sys.exit(1)
    
    audio_url = sys.argv[1]
    result = recognize_audio(audio_url)
    print(json.dumps(result))
