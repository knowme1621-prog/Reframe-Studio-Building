"""
silence_engine.py
------------------
Video mein khamoshi (silence-gaps) aur filler-words (um/uh/hmm/etc.) detect karta hai.

FIX (reliability):
  Pehle ye sirf faster-whisper ke word-timestamps ke beech ke gaps se silence
  nikaalta tha. Whisper ka VAD chhote pauses swallow kar leta hai aur kabhi-kabhi
  model load/transcribe hi fail ho jata hai — isliye "Detect Silence" aksar kuch
  nahi deta thi ya poora ka poora fail hoti thi.

  Ab core detection ffmpeg ke BUILT-IN `silencedetect` filter se hoti hai — ye
  hamesha available hai, fast hai, aur actual audio-levels par kaam karta hai
  (whisper ke "chup" hona nahi). Whisper ab SIRF filler-words ke liye best-effort
  try hota hai: fail ho to bhi silence detection phir bhi poori chalti hai.
"""

import subprocess
import tempfile
import os
import re
import json

from ffmpeg_path import get_ffmpeg, get_ffprobe

FFMPEG = get_ffmpeg()

# Common English filler-words/disfluencies jo detect + remove karni hain
FILLER_WORDS = {
    "um", "umm", "ummm", "uh", "uhh", "uhm", "er", "err", "erm",
    "ah", "ahh", "hmm", "mhm", "mm", "uh-huh",
}

_model = None  # lazy-loaded singleton — sirf pehli baar load hoga


def get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        _model = WhisperModel("small.en", device="cpu", compute_type="int8")
    return _model


def extract_audio(video_path: str) -> str:
    """Video se mono 16kHz WAV nikalta hai (whisper ka preferred format)."""
    fd, wav_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    subprocess.run(
        [FFMPEG, "-y", "-i", video_path, "-ac", "1", "-ar", "16000", "-vn", wav_path],
        check=True, capture_output=True,
    )
    return wav_path


def detect_silences_ffmpeg(video_path: str, min_silence_ms: int = 500, noise_db: float = -30.0):
    """
    ffmpeg `silencedetect` filter se silence-ranges nikalta hai.
    Returns: list of {start, end, type: "silence"} — SOURCE-time mein (seconds).
    Ye hamesha chalta hai (whisper/model-download ki dependency nahi).
    """
    min_silence_s = max(0.05, min_silence_ms / 1000.0)
    cmd = [
        FFMPEG, "-hide_banner", "-nostats", "-i", video_path,
        "-af", f"silencedetect=noise={noise_db}dB:d={min_silence_s}",
        "-f", "null", "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    log = (proc.stderr or "") + (proc.stdout or "")

    silences = []
    cur_start = None
    for line in log.splitlines():
        m = re.search(r"silence_start:\s*(-?\d+(?:\.\d+)?)", line)
        if m:
            cur_start = max(0.0, float(m.group(1)))
            continue
        m = re.search(r"silence_end:\s*(\d+(?:\.\d+)?)(?:\s*\|\s*silence_duration:\s*(\d+(?:\.\d+)?))?", line)
        if m and cur_start is not None:
            end = float(m.group(1))
            silences.append({"start": round(cur_start, 3), "end": round(end, 3), "type": "silence"})
            cur_start = None

    # agar video silence mein khatam hota hai to end-event nahi aata
    if cur_start is not None:
        try:
            dur_out = subprocess.run(
                [get_ffprobe(), "-v", "error", "-show_entries", "format=duration",
                 "-of", "json", video_path],
                capture_output=True, text=True,
            )
            dur = float(json.loads(dur_out.stdout)["format"]["duration"])
            if dur - cur_start >= 0.05:
                silences.append({"start": round(cur_start, 3), "end": round(dur, 3), "type": "silence"})
        except Exception:
            pass

    return silences


def detect_fillers_whisper(video_path: str, min_silence_ms: int = 500):
    """
    Whisper se filler-words nikalta hai (BEST-EFFORT).
    Model-download/network/model-load/transcribe — kisi bhi failure par []
    return karta hai, exception nahi uchhalta (silence-detection ko nahi rokna).
    Returns: list of {start, end, type: "filler", word}
    """
    audio_path = None
    try:
        audio_path = extract_audio(video_path)
        model = get_model()
        segments, _ = model.transcribe(
            audio_path,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=min_silence_ms),
        )

        words = []
        for seg in segments:
            for w in (seg.words or []):
                words.append(w)

        ranges = []
        for w in words:
            clean = (w.word or "").strip().lower().strip(".,!?-")
            if clean in FILLER_WORDS:
                ranges.append({
                    "start": round(w.start, 3),
                    "end": round(w.end, 3),
                    "type": "filler",
                    "word": clean,
                })
        return ranges
    except Exception:
        return []  # best-effort: filler detection fail ho to silence-detection phir bhi chalе
    finally:
        if audio_path:
            try:
                os.remove(audio_path)
            except OSError:
                pass


def detect_silence_and_fillers(video_path: str, min_silence_ms: int = 500):
    """
    Returns: list of {start, end, type: "silence"|"filler", word?} — SOURCE-time.
    Silence: ffmpeg silencedetect (reliable core).
    Fillers: whisper best-effort.
    Overlapping/contained filler-ranges merge ho jate hain silence ke andar.
    """
    silences = detect_silences_ffmpeg(video_path, min_silence_ms)
    fillers = detect_fillers_whisper(video_path, min_silence_ms)

    ranges = list(silences) + fillers
    ranges.sort(key=lambda r: (r["start"], r["end"]))
    return ranges
