"""
captions_engine.py
-------------------
faster-whisper (small.en, CPU, int8 — wahi model jo silence_engine.py
use karta hai, isliye koi extra download nahi hoga) se video ki audio
transcribe kar ke WORD-LEVEL timestamps nikalta hai.

Zaroori design-decision: ye file sirf RAW DATA deti hai (kaunsa word,
kab bola gaya) — koi bhi "style" (color/font/animation) yahan nahi hai.
Style poori tarah frontend (captions.js) mein hai, taake naya caption-
style banane ke liye is file ko kabhi chhedne ki zaroorat na pade —
sirf ek naya JS config-object likhna kaafi ho.

NAYA (SUBTITLES CACHE): poora words-list backend/data/<video_id>_transcript.json
mein cache hota hai — same video par Auto-Captions/Subtitles dobara maango
to whisper PHIR SE nahi chalta (bohat time save hota hai).
"""

import subprocess
import tempfile
import os
import json

from ffmpeg_path import get_ffmpeg

FFMPEG = get_ffmpeg()

_model = None  # lazy-loaded singleton — silence_engine.py se shared nahi
                # (alag process/import) lekin same cache-folder use karta
                # hai, isliye dobara download nahi hoga


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


def transcribe_words(video_path: str, cache_dir: str = None, video_id: str = None):
    """
    Returns: list of {text, start, end} — har bola hua word, SOURCE video
    ke apne time mein (0 se video ki asal duration tak). Frontend isi
    source-time ko current timeline-position mein map karega (bilkul
    silence-detection wale fix jaisa) — taake agar video pehle se
    trim/edit ho chuki ho, tab bhi caption sahi jagah par dikhe.

    NAYA: video_id + cache_dir diye jayen to words backend/data/
    <video_id>_transcript.json mein CACHE hote hain — dobara call par
    whisper bilkul nahi chalta (time save).
    """
    # ---- CACHE CHECK (same video ki transcription pehle ban chuki?) ----
    cache_path = None
    if cache_dir and video_id:
        cache_path = os.path.join(cache_dir, f"{video_id}_transcript.json")
        if os.path.exists(cache_path):
            try:
                with open(cache_path, "r", encoding="utf-8") as f:
                    cached = json.load(f)
                if isinstance(cached, list) and cached:
                    return cached  # ⚡ whisper ke baghair seedha wapas
            except Exception:
                pass  # corrupt cache — fresh transcribe

    audio_path = extract_audio(video_path)
    try:
        model = get_model()
        segments, _ = model.transcribe(audio_path, word_timestamps=True)

        words = []
        for seg in segments:
            for w in (seg.words or []):
                text = (w.word or "").strip()
                if not text:
                    continue
                words.append({
                    "text": text,
                    "start": round(w.start, 3),
                    "end": round(w.end, 3),
                })
        # ---- CACHE WRITE ----
        if cache_path and words:
            try:
                with open(cache_path, "w", encoding="utf-8") as f:
                    json.dump(words, f)
            except Exception:
                pass
        return words
    finally:
        os.remove(audio_path)


def group_words_into_cues(words, max_words_per_cue: int = 4, max_gap: float = 0.6):
    """
    Words ko chhote "cues" (ek waqt mein screen par dikhne wali line/group)
    mein group karta hai — poori sentence ek sath nahi dikhani (bohat lambi
    ho jati hai), na hi ek-ek word alag cue (bohat zyada flicker karega).

    Naya cue shuru hota hai jab:
    (a) pichle cue mein max_words_per_cue words aa chuke hon, YA
    (b) pichle word aur is word ke beech max_gap se zyada khamoshi ho
        (natural sentence/pause break)
    """
    cues = []
    current = []

    def flush():
        if current:
            cues.append({
                "start": current[0]["start"],
                "end": current[-1]["end"],
                "words": [dict(w) for w in current],
            })

    for w in words:
        if current and (
            (w["start"] - current[-1]["end"] > max_gap)
            or (len(current) >= max_words_per_cue)
        ):
            flush()
            current = []
        current.append(w)
    flush()

    return cues


def generate_caption_cues(video_path: str, max_words_per_cue: int = 4, max_gap: float = 0.6, cache_dir: str = None, video_id: str = None):
    """Convenience wrapper: transcribe + group in one call."""
    words = transcribe_words(video_path, cache_dir=cache_dir, video_id=video_id)
    return group_words_into_cues(words, max_words_per_cue=max_words_per_cue, max_gap=max_gap)


def build_subtitles_lines(words, max_chars_per_line: int = 42):
    """
    SUBTITLES (SRT/TXT ke liye): words ko readable LINES mein group karta hai
    (max ~42 chars per line — SRT standard). Har line: {start, end, text}.
    Ye captions-cues se alag hai — subtitles ki lines poori sentences jaisi
    hoti hain (chhote 4-word cues nahi).
    """
    lines = []
    current = []

    def flush():
        if not current:
            return
        text = " ".join(w["text"] for w in current).strip()
        lines.append({
            "start": current[0]["start"],
            "end": current[-1]["end"],
            "text": text,
        })

    for w in words:
        cur_len = sum(len(x["text"]) + 1 for x in current)
        if current and (
            cur_len + len(w["text"]) + 1 > max_chars_per_line
            or (w["start"] - current[-1]["end"] > 1.2)  # lamba pause = nayi line
        ):
            flush()
            current = []
        current.append(w)
    flush()
    return lines
