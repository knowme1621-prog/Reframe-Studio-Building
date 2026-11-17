### Name: backend/captions_engine.py
```python
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
```

### Name: backend/export_engine.py
```python
"""
export_engine.py
------------------
Poori timeline (videoClips + segments + audioLanes + captions) ko
actual MP4 file mein render karta hai — bilkul wahi jo frontend ke
canvas (crop_editor.js) mein dikhta hai, wahi crop/speed/caption
logic yahan Python (cv2 + PIL) mein dobara implement ki gayi hai.

Pipeline (3 steps):
  1. VIDEO: timeline ko frame-by-frame walk karo, har frame par
     (a) sahi source-frame nikalo (clip.sourceStart + speed-adjusted
         offset), (b) crop/reframe compose karo (segment ke active
         layout-mode ke hisaab se, ya letterbox agar koi segment
         nahi), (c) caption burn-in karo agar enabled ho
     -> ek raw-frame stream ffmpeg ko pipe kiya jata hai, jo usse
        silent H.264/H.265 .mp4 banata hai.
  2. AUDIO: ek filter_complex graph banaya jata hai jo har kept
     video-clip ka embedded-audio (agar muted/detached na ho) aur
     har audioLane ko sahi position/speed par "atrim + atempo +
     adelay" kar ke "amix" se mila deta hai -> ek .wav.
  3. MUX: dono ko final output.mp4 mein jod diya jata hai.
"""

import subprocess
import os

from ffmpeg_path import get_ffmpeg

FFMPEG = get_ffmpeg()
import json
import math
import shutil
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

QUALITY_PRESETS = {
    # name: (out_w, out_h, crf, preset, frame_stride)
    # frame_stride>1 = test-mode mein har Nth frame hi render hota hai (fast preview)
    "test":  {"w": 480,  "h": 854,  "crf": 30, "preset": "ultrafast", "stride": 2},
    "720p":  {"w": 720,  "h": 1280, "crf": 23, "preset": "veryfast",  "stride": 1},
    "1080p": {"w": 1080, "h": 1920, "crf": 20, "preset": "medium",    "stride": 1},
}

# Design-reference resolution jis par slot-aspect-ratios calculate hoti hain
# (crop_editor.js ke OUTPUT_W/OUTPUT_H se match) — actual export resolution
# (QUALITY_PRESETS) se ALAG hai, sirf box-SHAPE (aspect ratio) ke liye.
DESIGN_OUTPUT_W = 1080
DESIGN_OUTPUT_H = 1920
# Output aspect (9:16) — spotlight vertical-screens ka height-factor
OUT_ASPECT_H = DESIGN_OUTPUT_H / DESIGN_OUTPUT_W  # = 16/9 (height/width)

LAYOUT_MODES = {
    "single":     {"boxes": [{"slot": {"x": 0, "y": 0, "w": 1, "h": 1}}]},
    "centered":   {"boxes": [{"slot": {"x": 0, "y": 0, "w": 1, "h": 1}}]},
    "dual":       {"boxes": [{"slot": {"x": 0, "y": 0, "w": 1, "h": 0.5}}, {"slot": {"x": 0, "y": 0.5, "w": 1, "h": 0.5}}]},
    "trio":       {"boxes": [{"slot": {"x": 0, "y": 0, "w": 1, "h": 1/3}}, {"slot": {"x": 0, "y": 1/3, "w": 1, "h": 1/3}}, {"slot": {"x": 0, "y": 2/3, "w": 1, "h": 1/3}}]},
    "spotlight":  {"boxes": [{"slot": {"x": 0, "y": 0, "w": 1, "h": 1}}, {"slot": {"x": 0.55, "y": 0.04, "w": 0.4, "h": 0.22}, "isPiP": True}]},
    "horizontal": {"boxes": []},
}

CAPTION_STYLES = {
    # NOTE: ye RGB tuples captions.js ke hex codes se EXACTLY match hone chahiye
    # (#ffde59 -> (255,222,89), #2fb8a6 -> (47,184,166)) — pehle yahan R/B
    # channels galti se reverse the, isi wajah se export mein caption color
    # kharab dikhta tha jab ke app-preview mein sahi tha.
    #
    # NAYA: naye styles (hormozi, mrbeast, tiktokPop, neonGlow, podcastBold) bhi
    # yahan mirror hain + color-override support (frontend ke Captions panel se).
    "hormozi":      {"color": (255, 255, 255), "active": (17, 17, 17),   "highlight_bg": (255, 212, 42), "outline": (0, 0, 0), "outline_w": 3.5, "uppercase": True,  "box": True, "anim": "box"},
    "mrbeast":      {"color": (255, 255, 255), "active": (0, 255, 51),   "highlight_bg": None,           "outline": (0, 0, 0), "outline_w": 5.0,  "uppercase": True,  "box": False, "anim": "pop" },
    "tiktokPop":    {"color": (255, 255, 255), "active": (255, 45, 85),  "highlight_bg": None,           "outline": (0, 0, 0), "outline_w": 4.5,  "uppercase": True,  "box": False, "anim": "rotPop" },
    "neonGlow":     {"color": (234, 255, 255), "active": (0, 229, 255), "highlight_bg": None,           "outline": (27, 94, 122), "outline_w": 3.5, "uppercase": True, "box": False, "glow": (0, 229, 255), "anim": "glowPulse" },
    "podcastBold":  {"color": (255, 255, 255), "active": (255, 255, 255), "highlight_bg": (230, 57, 70), "outline": (0, 0, 0), "outline_w": 3.5, "uppercase": True,  "box": True, "anim": "doubleBox" },
    "boldHighlight": {"color": (255, 255, 255), "active": (17, 17, 17), "highlight_bg": (255, 222, 89), "outline": (0, 0, 0), "outline_w": 3.5, "uppercase": True,  "box": True, "anim": "lineBox" },
    "bigPop":        {"color": (255, 255, 255), "active": (255, 222, 89), "highlight_bg": None,          "outline": (0, 0, 0), "outline_w": 3.5, "uppercase": True,  "box": False, "anim": "stamp" },
    "karaokeFill":   {"color": (120, 120, 120), "active": (47, 184, 166), "highlight_bg": None,          "outline": (0, 0, 0), "outline_w": 3.5, "uppercase": False, "box": False, "anim": "fill" },
    "minimal":       {"color": (255, 255, 255), "active": (47, 184, 166), "highlight_bg": None,          "outline": None,      "uppercase": False, "box": False, "anim": "underline" },
    "classic":       {"color": (255, 255, 255), "active": (255, 255, 255), "highlight_bg": None,          "outline": (0, 0, 0), "outline_w": 3.5, "uppercase": False, "box": False, "anim": "none" },
    # ===== NAYE 16 STYLES (total 26) — captions.js registry ka exact mirror =====
    "viralYellow":   {"color": (255, 255, 255), "active": (255, 230, 0),   "highlight_bg": None,          "outline": (0, 0, 0), "outline_w": 5.0, "uppercase": True,  "box": False, "anim": "popBounce" },
    "greenScreen":   {"color": (0, 255, 0),      "active": (255, 255, 255), "highlight_bg": (17, 17, 17),  "outline": (0, 0, 0), "outline_w": 2.0, "uppercase": True,  "box": True, "anim": "boxBounce" },
    "retroWave":     {"color": (255, 113, 206), "active": (1, 205, 254),   "highlight_bg": None,          "outline": (40, 0, 60), "outline_w": 3.5, "uppercase": True, "box": False, "glow": (185, 103, 255), "glow2": (1, 205, 254), "anim": "glowSwap" },
    "comicPop":      {"color": (255, 255, 255), "active": (255, 45, 85),  "highlight_bg": (255, 222, 0), "outline": (0, 0, 0), "outline_w": 4.0, "uppercase": True,  "box": True, "anim": "boxTilt" },
    "gymBeast":      {"color": (255, 255, 255), "active": (255, 56, 0),   "highlight_bg": (17, 17, 17),  "outline": (0, 0, 0), "outline_w": 5.0, "uppercase": True,  "box": True, "anim": "shake" },
    "newsTicker":    {"color": (0, 0, 0),        "active": (0, 0, 0),      "highlight_bg": (255, 255, 255), "outline": (255, 255, 255), "outline_w": 2.0, "uppercase": False, "box": True, "anim": "tickerBar" },
    "karaokeWave":   {"color": (115, 115, 115), "active": (0, 229, 255),  "highlight_bg": None,          "outline": (0, 0, 0), "outline_w": 3.5, "uppercase": False, "box": False, "anim": "fillSweep" },
    "softPastel":    {"color": (255, 209, 220), "active": (255, 143, 171), "highlight_bg": None,          "outline": None,      "uppercase": False, "box": False, "anim": "underlineFloat" },
    "gamingRgb":     {"color": (57, 255, 20),   "active": (255, 255, 255), "highlight_bg": (17, 17, 17),  "outline": (0, 0, 0), "outline_w": 3.0, "uppercase": True,  "box": True, "anim": "rgbCycle", "active_palette": [(255, 45, 85), (255, 230, 0), (0, 229, 255), (168, 85, 247), (57, 255, 20)] },
    "luxuryGold":    {"color": (212, 175, 55),  "active": (255, 255, 255), "highlight_bg": None,          "outline": (0, 0, 0), "outline_w": 3.5, "uppercase": True,  "box": False, "glow": (212, 175, 55), "anim": "glow" },
    "oceanBlue":     {"color": (255, 255, 255), "active": (76, 201, 240), "highlight_bg": None,          "outline": (0, 48, 73), "outline_w": 4.0, "uppercase": True,  "box": False, "anim": "slide" },
    "fireRed":       {"color": (255, 255, 255), "active": (255, 77, 0),   "highlight_bg": None,          "outline": (32, 0, 0), "outline_w": 4.5, "uppercase": True,  "box": False, "anim": "flash" },
    "bubbleGum":     {"color": (255, 255, 255), "active": (255, 255, 255), "highlight_bg": (255, 93, 162), "outline": (0, 0, 0), "outline_w": 3.0, "uppercase": True,  "box": True, "anim": "boxRounded" },
    "monoGray":      {"color": (208, 208, 208), "active": (255, 255, 255), "highlight_bg": None,          "outline": (51, 51, 51), "outline_w": 2.0, "uppercase": False, "box": False, "anim": "strike" },
    "bananaSplit":   {"color": (17, 17, 17),     "active": (17, 17, 17),   "highlight_bg": (255, 225, 53), "outline": (0, 0, 0), "outline_w": 3.0, "uppercase": True,  "box": True, "anim": "outlineBox" },
    "whisperSmall":  {"color": (238, 238, 238), "active": (255, 255, 255), "highlight_bg": None,          "outline": (0, 0, 0), "outline_w": 2.0, "uppercase": False, "box": False, "anim": "squash" },
    # ===== "MY CAPTION" STYLES (sample-video mirror: white + yellow active +
    # golden glow; JS glowAll mirror — glow HAR word par lagta hai) =====
    "myCaption1":    {"color": (255, 255, 255), "active": (255, 226, 0),  "highlight_bg": None,          "outline": None,      "uppercase": False, "box": False, "glow": (255, 212, 0), "glow_all": True, "anim": "glowPop" },
    "myCaption2":    {"color": (199, 199, 199), "active": (255, 221, 0),  "highlight_bg": None,          "outline": None,      "uppercase": False, "box": False, "glow": (255, 230, 62), "glow_all": True, "anim": "popFill" },
    # My Caption 3 — sample-video ka EXACT look (frontend wrapBig ka mirror):
    # 2 words/line, KEY word (video/editor/work) 1.55x + yellow + glow, filler
    # chhota/white, active par extra pop. draw_captions me "wrapBig" branch hai.
    "myCaption3":    {"color": (255, 255, 255), "active": (255, 226, 0),  "highlight_bg": None,          "outline": None,      "uppercase": False, "box": False, "glow": (255, 212, 0), "base_px": 56, "anim": "wrapBig" },
    # My Caption 4 — mussy-style sample mirror: dim ghost words + smooth
    # fade-up reveal + REPEATER keyword accent (blue) + quick pop.
    "myCaption4":    {"color": (255, 255, 255), "active": (255, 255, 255), "highlight_bg": None,          "outline": None,      "uppercase": True,  "box": False, "accent": (46, 139, 255), "dim_opacity": 0.5, "fade_up": 14, "base_px": 62, "anim": "fadeCloud" },
    # My Caption 5 — mussy full-video mirror: max-2-word lines, per-pair
    # reveal (dim->accent->white), keyword color-cycle (blue/purple/green/red)
    # + soft black shadow. draw_captions me "fadeSplit" branch hai.
    "myCaption5":    {"color": (255, 255, 255), "active": (255, 255, 255), "highlight_bg": None,          "outline": None,      "uppercase": True,  "box": False, "accents": [(51, 177, 255), (163, 75, 255), (51, 204, 85), (255, 45, 40)], "dim_opacity": 0.55, "anim_scale": 1.06, "base_px": 60, "anim": "fadeSplit" },
    # My Caption 6 — mussy NEON multi-color sample mirror (frontend mirror):
    # phrase chunks 2-4 white + 1-3 colored words — har naya chunk ko palette
    # se NAYA random color (pichle repeat nahi). NEON = same-color glow + dark
    # drop. 2 lines: L1 ~57px (y=52%), L2 85% (y=58%), tight stacked. Layout
    # PRE-COMPUTED & centered; word fade-in ~100ms with blur. draw_captions me
    # "neonChunks" branch hai.
    "myCaption6":    {"color": (255, 255, 255), "active": (1, 205, 254),   "highlight_bg": None,          "outline": None,      "uppercase": True,  "box": False, "glow": (1, 205, 254), "neon_palette": [(45, 180, 255), (74, 140, 255), (255, 194, 26), (255, 230, 0), (31, 230, 242), (255, 61, 224), (255, 90, 217), (255, 28, 28), (77, 255, 106), (179, 107, 255)], "neon_chunk_max": 3, "anim_scale": 1.04, "line2_ratio": 0.85, "base_px": 57, "anim": "neonChunks" },
}

def _hex_to_rgb(h):
    """'#rrggbb' -> (r, g, b) — frontend ke color-overrides parse karne ke liye."""
    if not isinstance(h, str):
        return None
    h = h.strip().lstrip("#")
    if len(h) != 6:
        return None
    try:
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except ValueError:
        return None


# Frontend camelCase override-key -> backend style RGBU field mapping.
# (fixed legacy fields + dynamic per-style fields — deta hai)
_CAPTION_KEY_FIELD_MAP = {
    "color": "color", "activeColor": "active", "highlightBg": "highlight_bg",
    "glow": "glow", "accentColor": "accent",
}

# list-fields: override ARRAY of hex -> backend list-of-RGB field
_CAPTION_LIST_FIELD_MAP = {
    "accentColors": "accents",
    "neonPalette": "neon_palette",
}


def resolve_caption_style(style_key, overrides=None):
    """Frontend ke getEffectiveCaptionStyle() ka mirror: style + user ke
    color-overrides merge kar ke effective style deta hai. DYNAMIC: ab sirf
    3 fixed nahi — har color-field override parse hota hai (single hex YA
    array-of-hex list-field ke liye)."""
    style = dict(CAPTION_STYLES.get(style_key, CAPTION_STYLES["hormozi"]))
    ov = overrides or {}
    for key, field in _CAPTION_KEY_FIELD_MAP.items():
        rgb = _hex_to_rgb(ov.get(key))
        if rgb is not None:
            style[field] = rgb
    for key, field in _CAPTION_LIST_FIELD_MAP.items():
        arr = ov.get(key)
        if not isinstance(arr, (list, tuple)) or not arr:
            continue
        parsed = []
        for h in arr:
            rgb = _hex_to_rgb(h)
            if rgb is not None:
                parsed.append(rgb)
        if parsed:
            style[field] = parsed
    return style

_FONT_CACHE = {}


# ===== TITLES LAYER (9:16 heading templates — titles.js drawTitleOnCanvas ka
# exact Python mirror; render_export me frame loop se call hota hai) =====
# Data: titlesSpans = [{id, start, end, template, text, position:{x,y}, scale}]
# text-empty condition badhiya hai — frontend cue-text-resolve frontend-only hai
# (titles_cues backend se alag bhej sakte hain, hum DRY-RUN ke liye text placeholder
# use karte hain).
TITLE_TEMPLATES = {
    "boldPop":     {"weight": "bold", "size": 72, "color": (255, 255, 255), "accent": (255, 210, 42), "bg": None,           "anim": "pop",       "upper": True,  "shadow": True},
    "filmFade":    {"weight": "bold", "size": 58, "color": (255, 255, 255), "accent": (255, 255, 255), "bg": None,       "anim": "fade",      "upper": False, "shadow": True},
    "typewriter":  {"weight": "bold", "size": 54, "color": (234, 255, 255), "accent": (0, 229, 255),  "bg": None,        "anim": "typewriter","upper": False, "shadow": False},
    "boxIn":       {"weight": "bold", "size": 60, "color": (17, 17, 17),    "accent": (255, 210, 42), "bg": (255, 210, 42), "anim": "boxIn", "upper": True,  "shadow": False},
    "slideUp":     {"weight": "bold", "size": 62, "color": (255, 255, 255), "accent": (47, 184, 166), "bg": None,        "anim": "slideUp",   "upper": True,  "shadow": True},
    "neonTitle":   {"weight": "bold", "size": 64, "color": (234, 255, 255), "accent": (0, 229, 255),  "bg": None,        "anim": "neon",      "upper": False, "shadow": False},
    "stampIn":     {"weight": "bold", "size": 76, "color": (255, 45, 85),   "accent": (255, 255, 255), "bg": None,       "anim": "stamp",     "upper": True,  "shadow": False},
    "tickerHead":  {"weight": "bold", "size": 46, "color": (17, 17, 17),    "accent": (255, 255, 255), "bg": (255, 255, 255), "anim": "ticker","upper": False, "shadow": False},
    "outlineGrow": {"weight": "bold", "size": 66, "color": (0, 255, 51),    "accent": (0, 0, 0),      "bg": None,         "anim": "grow",      "upper": True,  "shadow": False},
    "karaokeLine": {"weight": "bold", "size": 56, "color": (138, 138, 138), "accent": (255, 255, 255), "bg": None,       "anim": "karaoke",   "upper": False, "shadow": False},
    # ---- captions-styles mirror (naye 16) — frontend titles.js ke saath sync ----
    "hormozi":     {"weight": "bold", "size": 58, "color": (255, 255, 255), "accent": (255, 210, 42), "bg": (255, 210, 42), "anim": "boxIn",     "upper": True,  "shadow": False},
    "mrbeast":     {"weight": "bold", "size": 56, "color": (255, 255, 255), "accent": (0, 255, 51),   "bg": None,           "anim": "grow",      "upper": True,  "shadow": False},
    "tiktokPop":   {"weight": "bold", "size": 54, "color": (255, 45, 85),  "accent": (255, 255, 255), "bg": None,         "anim": "pop",       "upper": True,  "shadow": True},
    "podcastBold": {"weight": "bold", "size": 50, "color": (255, 255, 255), "accent": (230, 57, 70),  "bg": (230, 57, 70), "anim": "boxIn",     "upper": True,  "shadow": False},
    "boldHighlight": {"weight": "bold", "size": 54, "color": (17, 17, 17),  "accent": (255, 222, 89), "bg": (255, 222, 89), "anim": "boxIn",    "upper": True,  "shadow": False},
    "viralYellow": {"weight": "bold", "size": 60, "color": (255, 230, 0),  "accent": (0, 0, 0),      "bg": None,           "anim": "grow",      "upper": True,  "shadow": False},
    "karaokeWave": {"weight": "bold", "size": 50, "color": (180, 255, 255), "accent": (0, 229, 255), "bg": None,          "anim": "karaoke",   "upper": False, "shadow": False},
    "softPastel":  {"weight": "bold", "size": 46, "color": (255, 209, 220), "accent": (255, 143, 171), "bg": None,         "anim": "fade",      "upper": False, "shadow": True},
    "retroWave":   {"weight": "bold", "size": 52, "color": (255, 113, 206), "accent": (1, 205, 254),  "bg": None,          "anim": "neon",      "upper": True,  "shadow": False},
    "comicPop":    {"weight": "bold", "size": 56, "color": (255, 255, 255), "accent": (255, 45, 85),  "bg": (255, 222, 0), "anim": "boxIn",     "upper": True,  "shadow": False},
    "gymBeast":    {"weight": "bold", "size": 62, "color": (255, 255, 255), "accent": (255, 56, 0),   "bg": (17, 17, 17),  "anim": "boxIn",     "upper": True,  "shadow": True},
    "luxuryGold":  {"weight": "bold", "size": 52, "color": (212, 175, 55), "accent": (255, 248, 216), "bg": None,          "anim": "neon",      "upper": True,  "shadow": False},
    "oceanBlue":   {"weight": "bold", "size": 52, "color": (76, 201, 240), "accent": (0, 48, 73),    "bg": None,           "anim": "slideUp",   "upper": True,  "shadow": True},
    "fireRed":     {"weight": "bold", "size": 58, "color": (255, 77, 0),   "accent": (32, 0, 0),     "bg": None,           "anim": "stamp",     "upper": True,  "shadow": False},
    "bubbleGum":   {"weight": "bold", "size": 54, "color": (255, 255, 255), "accent": (255, 93, 162), "bg": (255, 93, 162), "anim": "boxIn",      "upper": True,  "shadow": False},
    "monoGray":    {"weight": "bold", "size": 46, "color": (208, 208, 208), "accent": (17, 17, 17),   "bg": None,           "anim": "fade",      "upper": False, "shadow": False},
    "bananaSplit": {"weight": "bold", "size": 56, "color": (17, 17, 17),   "accent": (255, 225, 53), "bg": (255, 225, 53), "anim": "boxIn",     "upper": True,  "shadow": False},
    "whisperSmall": {"weight": "bold", "size": 34, "color": (238, 238, 238), "accent": (255, 255, 255), "bg": None,          "anim": "fade",      "upper": False, "shadow": True},
    # ===== "MY TITLES" (frontend titles.js myCaption1/2 mirror) =====
    "myCaption1":  {"weight": "bold", "size": 60, "color": (255, 226, 0),  "accent": (255, 212, 0),  "bg": None,           "anim": "neon",      "upper": False, "shadow": False},
    "myCaption2":  {"weight": "bold", "size": 56, "color": (255, 255, 255), "accent": (255, 221, 0),  "bg": None,           "anim": "karaoke",   "upper": False, "shadow": False},
    "myCaption3":  {"weight": "bold", "size": 62, "color": (255, 226, 0),  "accent": (255, 212, 0),  "bg": None,           "anim": "neon",      "upper": False, "shadow": False},
}
# frontend titles.js ke TITLE_ALIGN_PRESETS ka mirror (span.align = left/center/right,
# position.x isko OVERRIDES — draw_titles() me resolve logic dekho)
TITLE_ALIGN_PRESETS = {"left": 0.12, "center": 0.5, "right": 0.88}


def find_active_title(titles_spans, t):
    for s in titles_spans or []:
        if s.get("start", 0) <= t < s.get("end", 0):
            return s
    return None


def _ease_out_cubic(p):
    p = max(0.0, min(1.0, p))
    return 1.0 - (1.0 - p) ** 3


def draw_titles(canvas_bgr, span, t, titles_cues, source_t, out_w, out_h):
    """TITLES burn-in (canvas BGR, in-place mutadd). titles.js mirror:
    template-driven heading text out-frame par bake hota hai."""
    if not span:
        return canvas_bgr
    tpl = TITLE_TEMPLATES.get(span.get("template") or "boldPop", TITLE_TEMPLATES["boldPop"])

    # ---- text resolve: manual text first — cue-fallback (frontend wala) ----
    text = (span.get("text") or "").strip()
    if not text and source_t is not None:
        for c in (titles_cues or []):
            if c.get("start", 0) <= source_t < c.get("end", 0):
                wlist = c.get("words") or []
                if wlist:
                    text = " ".join((w.get("text") or "") for w in wlist).strip()
                else:
                    text = (c.get("text") or "").strip()
                break
    if not text:
        return canvas_bgr
    label = text.upper() if tpl["upper"] else text

    scale = out_h / 1920.0
    font_size = max(14, int(tpl["size"] * scale * (span.get("scale") or 1.0)))
    font = _get_font(font_size)

    start_t = span.get("start", 0)
    dur = max(0.01, float(span.get("end", start_t + 1)) - start_t)
    prog = max(0.0, min(1.0, (t - start_t) / dur))

    pos = span.get("position") or {}
    # ALIGN resolve (frontend mirror): position.x override > align-preset > center
    if pos.get("x") is not None:
        cx_frac = pos.get("x")
    else:
        cx_frac = TITLE_ALIGN_PRESETS.get(span.get("align") or "center", 0.5)
    cx = int(out_w * cx_frac)
    cy = int(out_h * ((pos.get("y") if pos.get("y") is not None else 0.22)))

    img = Image.fromarray(cv2.cvtColor(canvas_bgr, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(img)
    lines = label.split("\n")
    line_h = int(font_size * 1.22)
    anim = tpl["anim"]

    # ---- per-template transforms (mirror titles.js) ----
    draw_scale = 1.0
    dy = 0.0
    alpha = 255
    total_chars = max(1, len(label))
    if anim == "pop":
        p = _ease_out_cubic(prog * 4)
        draw_scale = 0.6 + 0.4 * p
        dy = (1 - p) * 40 * scale
    elif anim == "fade":
        alpha = int(255 * min(1.0, prog * 2.2))
    elif anim == "slideUp":
        p = _ease_out_cubic(prog * 2.2)
        dy = (1 - p) * 90 * scale
        alpha = int(255 * min(1.0, prog * 3))
    elif anim == "neon":
        alpha = int(255 * (0.85 + 0.15 * math.sin(prog * math.pi * 4)))
    elif anim == "stamp":
        p = _ease_out_cubic(prog * 3)
        draw_scale = 2.4 - 1.4 * p
        alpha = int(255 * min(1.0, prog * 4))
    elif anim == "grow":
        p = _ease_out_cubic(prog * 3.5)
        draw_scale = 0.3 + 0.7 * p
        alpha = int(255 * min(1.0, prog * 2.4))


    # ---- ticker bar: full-width bottom bar (frontend mirror) ----
    if anim == "ticker":
        bar_h = int(font_size * 2.0)
        bar_y = int(out_h * (pos.get("y") if pos.get("y") is not None else 0.85))
        off = int((1 - _ease_out_cubic(prog * 2.2)) * out_w)
        bgr_bg = (tpl["bg"][2], tpl["bg"][1], tpl["bg"][0])
        cv2.rectangle(canvas_bgr, (0, bar_y - bar_h // 2), (out_w, bar_y + bar_h // 2), bgr_bg[::-1], -1)
        # text: BGR-mode (draw karne ke badle — ASCII-only ur функци simple)
        tx = int(out_w * 0.05) + int(off * 0.4)
        ty = bar_y
        # text-layer reuse — simple direct draw
        draw.text((tx, ty), label, font=font, fill=(tpl["color"][0], tpl["color"][1], tpl["color"][2]), anchor="lm")
        out2 = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
        canvas_bgr[:, :] = out2
        return canvas_bgr

    # ---- normal text: PIL layer par draw (shadow/outline/anim se) phir composite ----
    layer = Image.new("RGBA", (out_w, out_h), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    start_y = cy + dy - ((len(lines) - 1) * line_h) / 2
    chars_used = 0
    for li, ln in enumerate(lines):
        y = start_y + li * line_h
        # typewriter: per-line proportional chars
        txt_to_draw = ln
        if anim == "typewriter":
            shown = int(prog * total_chars + 0.5)
            line_start = chars_used
            chars_used += len(ln) + 1
            n = max(0, min(len(ln), shown - line_start))
            txt_to_draw = ln[:n]
            if not txt_to_draw:
                continue
        # draw text (transform: center + draw_scale)
        # PIL ka direct anchor=mm scale nahi karta — draw_scale via resize-composite
        # (approx: larger font when scale > 1 — captions-draw fit-style approach)
        f = font if draw_scale == 1.0 else _get_font(int(font_size * draw_scale))
        lw_approx = int(ld.textlength(txt_to_draw, font=f))
        fill = tpl["color"] + (alpha,)
        outline_fill = (tpl["accent"][0], tpl["accent"][1], tpl["accent"][2], alpha)
        if anim == "grow":
            ld.text((cx, y), txt_to_draw, font=f, fill=outline_fill, anchor="mm",
                    stroke_width=max(1, int(4 * scale)), stroke_fill=outline_fill)
        if tpl["shadow"] and anim not in ("neon",):
            ld.text((cx + 3 * scale, y + 3 * scale), txt_to_draw, font=f, fill=(0, 0, 0, alpha), anchor="mm")
        if anim == "neon":
            # neon glow: blurred accent-text behind main text (caption-glow wala)
            pad_g = int(22 * scale) * 3 + 10
            glow_layer = Image.new("RGBA", (out_w + pad_g * 2, out_h + pad_g * 2), (0, 0, 0, 0))
            gd = ImageDraw.Draw(glow_layer)
            gd.text((cx + pad_g, y + pad_g), txt_to_draw, font=f, fill=outline_fill, anchor="mm")
            glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(max(2, 22 * scale)))
            layer.paste(glow_layer, (-pad_g, -pad_g), glow_layer)
        ld.text((cx, y), txt_to_draw, font=f, fill=fill, anchor="mm")
        if anim == "karaoke":
            # clip-based reveal — accent-text sirf start se prog tak (numpy mask)
            w_ln = int(ld.textlength(ln, font=f))
            reveal_w = int(w_ln * prog)
            kar_layer = Image.new("RGBA", (out_w, out_h), (0, 0, 0, 0))
            kd = ImageDraw.Draw(kar_layer)
            kd.text((cx, y), txt_to_draw, font=f, fill=(tpl["accent"][0], tpl["accent"][1], tpl["accent"][2], alpha), anchor="mm")
            kar_np = np.array(kar_layer)
            x_left = cx - w_ln // 2
            kar_np[:, :x_left, 3] = 0
            kar_np[:, x_left + reveal_w:, 3] = 0
            layer = Image.alpha_composite(layer, Image.fromarray(kar_np))
            ld = ImageDraw.Draw(layer)

    arr = np.array(layer)
    # alpha-composite layer onto BGR canvas
    a = arr[..., 3:4].astype(np.float32) / 255.0
    rgb = arr[..., :3].astype(np.float32)
    base = cv2.cvtColor(canvas_bgr, cv2.COLOR_BGR2RGB).astype(np.float32)
    blended = (rgb * a + base * (1.0 - a)).astype(np.uint8)
    canvas_bgr[:] = cv2.cvtColor(blended, cv2.COLOR_RGB2BGR)
    return canvas_bgr


def _get_font(size):
    size = max(10, int(size))
    if size not in _FONT_CACHE:
        try:
            _FONT_CACHE[size] = ImageFont.truetype("arialbd.ttf", size)
        except Exception:
            _FONT_CACHE[size] = ImageFont.load_default()
    return _FONT_CACHE[size]


# ===== TIMELINE LOOKUP HELPERS (mirror timeline.js logic) =====

def find_active_clip(video_clips, t):
    found = None
    for c in video_clips:
        if c["start"] <= t < c["end"]:
            found = c
    return found


def find_active_segment(segments, t):
    for s in segments:
        if s["start"] <= t < s["end"]:
            return s
    return None


def find_active_audio_lane(audio_lanes, t):
    found = None
    for a in audio_lanes:
        if a["start"] <= t < a["end"]:
            found = a
    return found


def find_active_caption(cues, source_t):
    if source_t is None:
        return None
    for c in cues:
        if c["start"] <= source_t < c["end"]:
            return c
    return None


# ===== NAYE EFFECT-LAYERS (layers.js ke mirrors) =====

def find_active_grade_span(grade_spans, t):
    for s in grade_spans or []:
        if s.get("start", 0) <= t < s.get("end", 0):
            return s
    return None


def find_active_caption_span(spans, t):
    for s in spans or []:
        if s.get("start", 0) <= t < s.get("end", 0):
            return s
    return None


def find_active_panzoom(spans, t):
    for s in spans or []:
        if s.get("start", 0) <= t < s.get("end", 0):
            return s
    return None


def find_active_transition(transitions, t):
    for tr in transitions or []:
        if tr.get("start", 0) <= t < tr.get("end", 0):
            return tr
    return None


def _smoothstep(p):
    p = max(0.0, min(1.0, p))
    return p * p * (3 - 2 * p)


def _blend_black(frame, alpha):
    if alpha <= 0:
        return frame
    return (frame.astype(np.float32) * (1.0 - min(1.0, alpha))).astype(np.uint8)


def find_boundary_in_span(video_clips, tr):
    """Span ke andar clip-cut (end == next.start) — crossfade isi par lagta hai.
    layers.js findBoundaryInSpan ka mirror."""
    mid = (tr["start"] + tr["end"]) / 2.0
    best = None
    for c in video_clips:
        nxt = None
        for x in video_clips:
            if abs(x["start"] - c["end"]) < 0.02:
                nxt = x
                break
        if nxt is None:
            continue
        b = c["end"]
        if tr["start"] < b < tr["end"]:
            if best is None or abs(b - mid) < abs(best - mid):
                best = b
    return best


def apply_transition_frame(out_frame, tr, t, out_w, out_h, video_clips, segment, get_source_frame_b):
    """TRANSITION BURN-IN (layers.js transApplyToCanvas ka mirror):
    fadein/fadeout = black-blend; crossfade = real A+B blend (boundary par);
    slide/zoom = geometric transform. NO keyframing — fixed params."""
    if not tr:
        return out_frame
    ttype = tr.get("type") or "crossfade"
    dur = max(0.05, float(tr.get("duration") or 0.6))
    inten = tr.get("intensity")
    k = 0.6 if inten is None else max(0.0, min(1.0, float(inten) / 100.0))

    if ttype == "fadein":
        p = _smoothstep((t - tr["start"]) / dur)
        if p < 1:
            return _blend_black(out_frame, (1 - p) * k)
        return out_frame

    if ttype == "fadeout":
        p = _smoothstep((tr["end"] - t) / dur)
        if p < 1:
            return _blend_black(out_frame, (1 - p) * k)
        return out_frame

    if ttype == "crossfade":
        b = find_boundary_in_span(video_clips, tr)
        if b is None:
            return out_frame
        a = max(0.0, min(1.0, (t - (b - dur / 2)) / dur))
        if a <= 0 or a >= 1:
            return out_frame
        # REAL crossfade: frame B = agle clip ka usi timeline-time wala frame
        nxt = None
        for x in video_clips:
            if abs(x["start"] - b) < 0.02:
                nxt = x
                break
        frame_b = None
        if nxt is not None:
            src_b = clip_source_time(nxt, t)
            raw_b = get_source_frame_b(src_b)
            if raw_b is not None:
                frame_b = compose_frame(raw_b, segment, out_w, out_h)
        if frame_b is None:
            # fallback: dip-through-dark
            return _blend_black(out_frame, math.sin(a * math.pi) * 0.85 * k)
        af = out_frame.astype(np.float32)
        bf = frame_b.astype(np.float32)
        return (af * (1 - a) + bf * a).astype(np.uint8)

    if ttype in ("slideleft", "slideright"):
        p = _smoothstep((t - tr["start"]) / dur)
        if p >= 1:
            return out_frame
        off = int((1 - p) * out_w * k)
        if off <= 0:
            return out_frame
        if off >= out_w:
            return np.zeros_like(out_frame)
        canvas = np.zeros_like(out_frame)
        if ttype == "slideleft":
            canvas[:, off:] = out_frame[:, :out_w - off]
        else:
            canvas[:, :out_w - off] = out_frame[:, off:]
        return canvas

    if ttype == "zoomin":
        p = _smoothstep((t - tr["start"]) / dur)
        if p >= 1:
            return out_frame
        s = 1 + (1 - p) * 0.5 * k
        if s <= 1.001:
            return out_frame
        dw, dh = int(out_w * s), int(out_h * s)
        resized = cv2.resize(out_frame, (dw, dh))
        x1, y1 = (dw - out_w) // 2, (dh - out_h) // 2
        return resized[y1:y1 + out_h, x1:x1 + out_w]

    return out_frame


def pz_zoom_at(span, t):
    z = max(1.0, float(span.get("zoom") or 1))
    mode = span.get("mode") or "static"
    if mode in ("in", "out"):
        dur = max(0.01, float(span["end"] - span["start"]))
        p = max(0.0, min(1.0, (t - span["start"]) / dur))
        e = _smoothstep(p)
        return (1 + (z - 1) * e) if mode == "in" else (z - (z - 1) * e)
    return z


def pz_region_at(span, t):
    """9:16 output ke andar crop-region (normalized) — layers.js pzRegionAt ka mirror."""
    z = pz_zoom_at(span, t)
    b = span.get("box") or {"x": 0, "y": 0, "w": 1, "h": 1}
    w = min(1.0, float(b.get("w", 1)) / z)
    h = min(1.0, float(b.get("h", 1)) / z)
    cx = float(b.get("x", 0)) + float(b.get("w", 1)) / 2
    cy = float(b.get("y", 0)) + float(b.get("h", 1)) / 2
    x = max(0.0, min(cx - w / 2, 1 - w))
    y = max(0.0, min(cy - h / 2, 1 - h))
    return {"x": x, "y": y, "w": w, "h": h}


def apply_panzoom_frame(out_frame, span, t):
    """CROP AND ZOOM (Pan & Zoom) burn-in: output-frame ko region se crop kar ke
    wapas full-frame stretch — bilkul preview jaisa (zoom-in = region chhoti)."""
    if not span:
        return out_frame
    r = pz_region_at(span, t)
    if r["w"] >= 0.999 and r["h"] >= 0.999 and r["x"] <= 0.001 and r["y"] <= 0.001:
        return out_frame
    h, w = out_frame.shape[:2]
    x1, y1 = int(r["x"] * w), int(r["y"] * h)
    sw, sh = max(2, int(r["w"] * w)), max(2, int(r["h"] * h))
    x2, y2 = min(w, x1 + sw), min(h, y1 + sh)
    crop = out_frame[y1:y2, x1:x2]
    if crop.size == 0:
        return out_frame
    return cv2.resize(crop, (w, h))


def compute_default_box(target_aspect, slot, is_pip, video_w, video_h):
    """crop_editor.js ke computeDefaultBox() ka exact Python mirror — segment
    ka box kabhi bhi frontend mein cache/save nahi hua ho, tab bhi export
    ke waqt SAHI default box khud compute kar leta hai (letterbox par
    fallback karne ke bajaye)."""
    if is_pip:
        box_w_norm = 0.35
        phys_w = box_w_norm * video_w
        phys_h = phys_w / target_aspect
        box_h_norm = phys_h / video_h
        if box_h_norm > 1:
            box_h_norm = 1
        return {"x": max(0, 1 - box_w_norm - 0.03), "y": 0.03, "w": box_w_norm, "h": box_h_norm}

    box_w = target_aspect * (video_h / video_w)
    box_h = 1
    if box_w > 1:
        box_w = 1
        box_h = video_w / (target_aspect * video_h)

    slot_center = slot["y"] + slot["h"] / 2
    y = slot_center - box_h / 2
    y = max(0, min(y, 1 - box_h))

    return {"x": (1 - box_w) / 2, "y": y, "w": box_w, "h": box_h}


def get_segment_boxes(segment, mode, video_w, video_h):
    """Pehle frontend ka cached modeBoxState try karo (user ke manual
    drag/resize edits respect karne ke liye) — agar wo missing/empty ho
    (kyunke us segment/mode ko preview mein kabhi "dekha" nahi gaya tha),
    to default boxes yahan khud compute karo, letterbox par fallback
    karne ke bajaye."""
    mode_box_state = segment.get("modeBoxState") or {}
    cached = mode_box_state.get(mode)
    if cached:
        return cached

    config = LAYOUT_MODES.get(mode)
    if not config or not config["boxes"]:
        return None

    boxes = []
    for b in config["boxes"]:
        slot = b["slot"]
        target_aspect = (slot["w"] * DESIGN_OUTPUT_W) / (slot["h"] * DESIGN_OUTPUT_H)
        box = compute_default_box(target_aspect, slot, b.get("isPiP", False), video_w, video_h)
        box["slot"] = slot
        boxes.append(box)
    return boxes


def clip_source_time(clip, timeline_t):
    speed = clip.get("speed") or 1
    return clip["sourceStart"] + (timeline_t - clip["start"]) * speed


def export_duration(video_clips, audio_lanes, segments, stack2_video_clips=None, stack2_audio_lanes=None, stack2_segments=None):
    farthest = 0
    for c in video_clips:
        farthest = max(farthest, c["end"])
    for a in audio_lanes:
        farthest = max(farthest, a["end"])
    for s in segments:
        farthest = max(farthest, s["end"])
    # STACK-2 (2-Stack Spotlight): doosri stack ka content bhi duration badhata hai
    for c in (stack2_video_clips or []):
        farthest = max(farthest, c["end"])
    for a in (stack2_audio_lanes or []):
        farthest = max(farthest, a["end"])
    for s in (stack2_segments or []):
        farthest = max(farthest, s["end"])
    return farthest


# ===== COLOR GRADE (color_grade.js ka Python mirror) =====

def grade_frame(frame_bgr, grade):
    """Global color grade burn-in. grade dict: brightness/contrast/saturation/
    temperature/sharpen/vignette (-100..100, sirf 0-100). frontend ke canvas-
    filter + soft-light-overlay + vignette-gradient ke equivalent."""
    if not grade:
        return frame_bgr
    b = grade.get("brightness") or 0
    c = grade.get("contrast") or 0
    s = grade.get("saturation") or 0
    t = grade.get("temperature") or 0
    sh = grade.get("sharpen") or 0
    v = grade.get("vignette") or 0
    if not any([b, c, s, t, sh, v]):
        return frame_bgr

    out = frame_bgr
    if b:
        out = cv2.convertScaleAbs(out, alpha=1.0, beta=b * 1.28)  # -128..128 shift
    if c:
        out = cv2.convertScaleAbs(out, alpha=(100 + c) / 100.0, beta=128 * (1 - (100 + c) / 100.0))
    if s:
        hsv = cv2.cvtColor(out, cv2.COLOR_BGR2HSV).astype(np.float32)
        hsv[..., 1] = np.clip(hsv[..., 1] * ((100 + s) / 100.0), 0, 255)
        out = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)
    if t:
        # warm: R up / B down; cool: ulta — soft-light-equivalent gentle shift
        tval = (t / 100.0) * 28.0
        b_ch, g_ch, r_ch = cv2.split(out)
        r_ch = np.clip(r_ch.astype(np.float32) + tval, 0, 255).astype(np.uint8)
        b_ch = np.clip(b_ch.astype(np.float32) - tval, 0, 255).astype(np.uint8)
        out = cv2.merge([b_ch, g_ch, r_ch])
    if sh:
        amount = (sh / 100.0) * 0.8
        blur = cv2.GaussianBlur(out, (0, 0), 2.0)
        out = cv2.addWeighted(out, 1.0 + amount, blur, -amount, 0)
    if v:
        h, w = out.shape[:2]
        strength = v / 100.0 * 0.75
        yy, xx = np.mgrid[0:h, 0:w]
        cy, cx = h / 2.0, w / 2.0
        dist = np.sqrt(((xx - cx) / (w * 0.75)) ** 2 + ((yy - cy) / (h * 0.75)) ** 2)
        vign = np.clip((dist - 0.42) / 0.33, 0, 1) * strength
        out = (out.astype(np.float32) * (1.0 - vign[..., None])).astype(np.uint8)
    return out


def get_segment_boxes_py(segment, mode, video_w, video_h):
    """get_segment_boxes ka alias — spotlight multi-screen engine isiko use karta
    hai (naam-pasand, behavior same)."""
    return get_segment_boxes(segment, mode, video_w, video_h)


def _hex_to_bgr(h):
    """'#rrggbb' -> BGR tuple (OpenCV frames BGR hote hain — pehle ye RGB banta
    tha jis se colored borders ULTI rang mein burn hote the)."""
    rgb = _hex_to_rgb(h)
    if rgb is None:
        return (255, 255, 255)
    return (rgb[2], rgb[1], rgb[0])


def spot_shape_mask(style, size):
    """spotlight.js ke spotShapePath() ka numpy-mirror — (size x size) uint8
    alpha mask (255 = shape ke andar). size = bubble ki full width (2r).
    Shapes: circle | square | star | heart | hexagon | diamond (ring burn nahi
    hota — upar early-return)."""
    mask = np.zeros((size, size), dtype=np.uint8)
    r = size / 2.0
    cx = cy = r

    if style == "square":
        mask[:, :] = 255
        return mask

    if style == "star":
        i = np.arange(10)
        ang = -np.pi / 2 + i * (np.pi / 5)
        rad = np.where(i % 2 == 0, r, r * 0.42)  # JS: Ri = r * 0.42
        pts = np.stack([cx + np.cos(ang) * rad, cy + np.sin(ang) * rad], axis=1).astype(np.int32)
        cv2.fillPoly(mask, [pts], 255)
        return mask

    if style == "heart":
        K = r / 16.0

        def bez(p0, c1, c2, p3, n=48):
            ts = np.linspace(0.0, 1.0, n)
            xs = ((1 - ts) ** 3) * p0[0] + 3 * ((1 - ts) ** 2) * ts * c1[0] + 3 * (1 - ts) * (ts ** 2) * c2[0] + (ts ** 3) * p3[0]
            ys = ((1 - ts) ** 3) * p0[1] + 3 * ((1 - ts) ** 2) * ts * c1[1] + 3 * (1 - ts) * (ts ** 2) * c2[1] + (ts ** 3) * p3[1]
            return np.stack([xs, ys], axis=1)

        P = [
            (cx, cy + 0.5 * K), (cx, cy - 2.5 * K), (cx - 7 * K, cy - 12.5 * K), (cx - 12 * K, cy - 9.5 * K),
            (cx - 16 * K, cy - 6.5 * K), (cx - 14 * K, cy + 0.5 * K), (cx - 8 * K, cy + 5.5 * K),
            (cx - 4.5 * K, cy + 9 * K), (cx, cy + 11.5 * K), (cx, cy + 12.5 * K),
            (cx + 4.5 * K, cy + 9 * K), (cx + 8 * K, cy + 5.5 * K),
            (cx + 14 * K, cy + 0.5 * K), (cx + 16 * K, cy - 6.5 * K), (cx + 12 * K, cy - 9.5 * K),
            (cx + 7 * K, cy - 12.5 * K),
        ]
        pts = np.concatenate([
            bez(P[0], P[1], P[2], P[3]),
            bez(P[3], P[4], P[5], P[6]),
            bez(P[6], P[7], P[8], P[9]),
            bez(P[9], P[8], P[10], P[11]),  # S4: c1=P[8], c2=P[10] (JS ke sath exact)
            bez(P[11], P[12], P[13], P[14]),
            bez(P[14], P[15], P[1], P[0]),  # S6: c1=P[15], c2=P[1]
        ])
        cv2.fillPoly(mask, [pts.astype(np.int32)], 255)
        return mask

    if style == "hexagon":
        i = np.arange(6)
        ang = -np.pi / 2 + i * (np.pi / 3)
        pts = np.stack([cx + np.cos(ang) * r, cy + np.sin(ang) * r], axis=1).astype(np.int32)
        cv2.fillPoly(mask, [pts], 255)
        return mask

    if style == "diamond":
        pts = np.array([
            (cx, cy - r), (cx + r * 0.7, cy), (cx, cy + r), (cx - r * 0.7, cy)
        ], dtype=np.int32)
        cv2.fillPoly(mask, [pts], 255)
        return mask

    # circle (default) — ring kabhi yahan nahi aata (early-return)
    cv2.circle(mask, (int(r), int(r)), int(r), 255, -1)
    return mask


def compose_spotlight_screens(out_frame, segment, get_s2_frame, source_path, out_w, out_h, s2_w=None, s2_h=None, s2_path=None):
    """SPOTLIGHT MULTI-SCREEN BURN-IN (spotlight.js ke drawSpotlightOverlay ka
    mirror): spotlight segment ke seg.screens[] — jitni chaho — final video par
    bake hote hain:
      - kind="spot":  shape screens (circle/square/star/heart/hexagon/diamond;
                       ring sirf preview-guide hai, burn NAHI hota) — content =
                       S2 video ka S1-spotlight-base-box ka ZOOMED square crop.
      - kind="vertical": FULL-HEIGHT 9:16 vertical crop screen — S2 video ka
                       aspect-correct vertical region (user ka signature layout:
                       V1 + V1-duplicate side-by-side).
    Har screen: apna zoom/size/position/border/shadow. Painter order per screen:
    shadow -> content -> border."""
    if not segment:
        return out_frame
    screens = segment.get("screens") or []
    if not screens:
        # LEGACY: purane bubble-params wale segment -> 1 screen (frontend ke sath)
        if segment.get("bubbleState"):
            screens = [{
                "kind": "spot", "shape": segment.get("bubbleStyle") or "circle",
                "x": segment["bubbleState"].get("x", 0.5), "y": segment["bubbleState"].get("y", 0.38),
                "r": segment["bubbleState"].get("r", 0.17),
                "zoom": segment.get("bubbleZoom", 1.6),
                "border": segment.get("bubbleBorder") or {"color": "#ffffff", "width": 8},
                "shadow": segment.get("bubbleShadow") or {"enabled": True},
            }]
            segment["screens"] = screens  # write-back: baar-baar recompute na ho
        else:
            return out_frame

    # S2 base box (S1 spotlight crop, source-normalized) — spot-screens isi par zoom
    src_h2, src_w2 = (s2_h, s2_w) if (s2_w and s2_h) else (out_frame.shape[0], out_frame.shape[1])
    boxes = get_segment_boxes_py(segment, "spotlight", src_w2, src_h2)
    base_box = boxes[0] if boxes else {"x": 0.22, "y": 0.0, "w": 0.56, "h": 1.0}

    for scr in screens:
        kind = scr.get("kind") or "spot"
        s2_frame = get_s2_frame()  # lazy — sirf jab pehli zaroorat pare
        if s2_frame is None:
            continue

        if kind == "vertical":
            out_frame = _burn_vertical_screen(out_frame, scr, s2_frame, out_w, out_h)
        else:
            out_frame = _burn_spot_screen(out_frame, scr, s2_frame, base_box, src_w2, src_h2, out_w, out_h)
    return out_frame


def _burn_vertical_screen(out_frame, scr, s2_frame, out_w, out_h):
    """VERTICAL SCREEN (user ka FINAL model): 16:9 SOURCE par jo portrait area
    select hua (scr.srcX/srcY/srcW — frontend player-canvas source-box ka
    mirror), WAHI area 9:16 output ki poori height bhar deta hai. Output par
    strip sirf MOVE hoti hai (scr.x) + width resize (scr.w). Aspect-correct
    fill: crop-AR (px) = strip-AR (px)."""
    src_h2, src_w2 = s2_frame.shape[:2]
    tw = max(0.02, min(1.0, float(scr.get("w", 0.45))))
    cx_frac = max(tw / 2, min(1.0 - tw / 2, float(scr.get("x", 0.5))))

    # ---- source-crop (16:9 frame par select kiya hua area) ----
    strip_ar = (tw * out_w) / float(out_h)            # strip w_px/h_px
    c_w = max(0.02, min(1.0, float(scr.get("srcW", 0.25) or 0.25)))
    c_h = c_w * (float(src_w2) / float(src_h2)) / strip_ar
    if c_h > 1.0:
        c_h = 1.0
        c_w = c_h * strip_ar * (float(src_h2) / float(src_w2))
    scx = float(scr.get("srcX", 0.5) if scr.get("srcX") is not None else 0.5)
    scy = float(scr.get("srcY", 0.5) if scr.get("srcY") is not None else 0.5)
    c_x = max(0.0, min(scx - c_w / 2, 1.0 - c_w))
    c_y = max(0.0, min(scy - c_h / 2, 1.0 - c_h))

    sx, sy = int(c_x * src_w2), int(c_y * src_h2)
    sw, sh = max(2, int(c_w * src_w2)), max(2, int(c_h * src_h2))
    sx2, sy2 = min(src_w2, sx + sw), min(src_h2, sy + sh)
    crop = s2_frame[sy:sy2, sx:sx2]
    if crop.size == 0:
        return out_frame

    # ---- destination: full-height strip ----
    w_px = max(2, int(tw * out_w))
    x1 = max(0, min(int((cx_frac - tw / 2) * out_w), out_w - 1))
    x2 = min(out_w, x1 + w_px)
    if x2 <= x1:
        return out_frame

    resized = cv2.resize(crop, (x2 - x1, out_h))
    # BORDER-LESS (user): vertical screen par koi border burn nahi hota
    out_frame[0:out_h, x1:x2] = resized
    return out_frame


def _burn_spot_screen(out_frame, scr, s2_frame, base_box, src_w2, src_h2, out_w, out_h):
    """Shape-screen burn-in (pehle compose_spotlight_bubble ka logic, ab per-screen
    params ke sath): shadow -> zoomed content -> border."""
    style = scr.get("shape") or scr.get("bubbleStyle") or "circle"
    if style == "ring":
        return out_frame  # ring sirf preview-guide hai

    # USER MODEL (final): shape 16:9 par PLACE hui thi (srcX/srcY/srcR) — jo
    # area shape ke andar select hua WAHI shape mein 9:16 par dikhta hai.
    # (base-box zoom legacy fallback — sirf jab srcR hi na ho)
    src_r = scr.get("srcR")
    if src_r is not None:
        src_r = max(0.01, min(1.0, float(src_r)))
        # JS preview ka EXACT mirror: sample-square side = 2*srcR*src_w2
        # (video px — fitRect aspect-fit hai, radius isotropic), center
        # (srcX*src_w2, srcY*src_h2). (Purani formula me Y me src_r*src_h2 aur
        # side me min(src_w,src_h) — dono preview se alag the, export me
        # select-kiya-hua area match nahi karta tha.)
        side = min(2.0 * src_r * src_w2, float(src_w2), float(src_h2))
        scx_s = float(scr.get("srcX", 0.5) or 0.5)
        scy_s = float(scr.get("srcY", 0.5) or 0.5)
        sq_x = max(0.0, min(scx_s * src_w2 - side / 2.0, src_w2 - side))
        sq_y = max(0.0, min(scy_s * src_h2 - side / 2.0, src_h2 - side))
    else:
        zoom = max(1.0, float(scr.get("zoom", 1.6) or 1.6))
        box = base_box or {"x": 0.22, "y": 0.0, "w": 0.56, "h": 1.0}
        zw = box["w"] / zoom
        zh = box["h"] / zoom
        zx = box["x"] + box["w"] / 2 - zw / 2
        zy = box["y"] + box["h"] / 2 - zh / 2
        side = min(zw * src_w2, zh * src_h2)
        sq_x = max(0.0, min(zx * src_w2 + (zw * src_w2 - side) / 2, src_w2 - side))
        sq_y = max(0.0, min(zy * src_h2 + (zh * src_h2 - side) / 2, src_h2 - side))

    side = int(max(2, side))
    sx, sy = int(sq_x), int(sq_y)
    sx2, sy2 = min(src_w2, sx + side), min(src_h2, sy + side)
    crop = s2_frame[sy:sy2, sx:sx2]
    if crop.size == 0:
        return out_frame

    r = max(2, int(float(scr.get("r", 0.17)) * out_w))
    cx = int(float(scr.get("x", 0.5)) * out_w)
    cy = int(float(scr.get("y", 0.38)) * out_h)
    size = r * 2
    content = cv2.resize(crop, (size, size))
    shape = spot_shape_mask(style, size)  # 7-shape engine (JS mirror)

    # ----- border/shadow params (design-scale 1080 -> out_w) -----
    dscale = out_w / 1080.0
    border = scr.get("border") or {"color": "#ffffff", "width": 8}
    b_rgb = _hex_to_bgr(border.get("color"))
    b_w = float(border.get("width", 8) or 0) * dscale
    shadow = scr.get("shadow")
    # shadow normalize: None -> ON, bool -> {enabled:bool}, dict -> as-is
    if shadow is None:
        shadow = {"enabled": True}
    elif isinstance(shadow, bool):
        shadow = {"enabled": shadow}
    s_on = bool(shadow.get("enabled", True))
    s_blur = max(1.0, 16 * dscale)
    s_off = int(6 * dscale)
    s_alpha = 0.5

    pad = int(b_w / 2 + s_blur * 1.5 + s_off + 6)
    x1, y1 = max(0, cx - r - pad), max(0, cy - r - pad)
    x2, y2 = min(out_w, cx + r + pad), min(out_h, cy + r + pad)
    if x2 <= x1 or y2 <= y1:
        return out_frame
    LW, LH = x2 - x1, y2 - y1
    ox, oy = cx - r - x1, cy - r - y1  # shape ke local origin

    color_acc = np.zeros((LH, LW, 3), dtype=np.float32)
    alpha_acc = np.zeros((LH, LW), dtype=np.float32)

    def paste_over(color, alpha):
        """source-over composite into (color_acc, alpha_acc)"""
        nonlocal color_acc, alpha_acc
        a = alpha[..., None] if alpha.ndim == 2 else alpha
        color_acc[:] = color * a + color_acc * (1.0 - a)
        alpha_acc[:] = np.clip(alpha + alpha_acc * (1.0 - alpha), 0, 1)

    # 1) DROP-SHADOW (sab neeche): shape shifted+blurred black silhouette
    if s_on:
        sh_canvas = np.zeros((LH, LW), dtype=np.uint8)
        sy1 = max(0, oy + s_off); sx1 = max(0, ox)
        sy2 = min(LH, oy + s_off + size); sx2 = min(LW, ox + size)
        if sy2 > sy1 and sx2 > sx1:
            sh_canvas[sy1:sy2, sx1:sx2] = shape[sy1 - (oy + s_off):sy2 - (oy + s_off), sx1 - ox:sx2 - ox]
        sh_blur = cv2.GaussianBlur(sh_canvas, (0, 0), s_blur).astype(np.float32) / 255.0
        paste_over(np.zeros(3, dtype=np.float32), sh_blur * s_alpha)

    # 2) CONTENT: shape-mask ke andar zoomed S2 frame
    c_canvas = np.zeros((LH, LW, 3), dtype=np.float32)
    a_canvas = np.zeros((LH, LW), dtype=np.float32)
    cy1, cx1 = max(0, oy), max(0, ox)
    cy2, cx2 = min(LH, oy + size), min(LW, ox + size)
    if cy2 > cy1 and cx2 > cx1:
        c_canvas[cy1:cy2, cx1:cx2] = content[cy1 - oy:cy2 - oy, cx1 - ox:cx2 - ox].astype(np.float32)
        a_canvas[cy1:cy2, cx1:cx2] = shape[cy1 - oy:cy2 - oy, cx1 - ox:cx2 - ox].astype(np.float32) / 255.0
    paste_over(c_canvas, a_canvas)

    # 3) BORDER: shape ka edge-band (shape minus eroded-shape)
    if b_w >= 1:
        k = max(1, int(round(b_w)))
        kernel = np.ones((2 * k + 1, 2 * k + 1), dtype=np.uint8)
        eroded = cv2.erode(shape, kernel)
        edge = cv2.subtract(shape, eroded).astype(np.float32) / 255.0
        e_canvas = np.zeros((LH, LW, 3), dtype=np.float32)
        e_canvas[cy1:cy2, cx1:cx2] = np.array(b_rgb, dtype=np.float32)
        e_alpha = np.zeros((LH, LW), dtype=np.float32)
        e_alpha[cy1:cy2, cx1:cx2] = edge[cy1 - oy:cy2 - oy, cx1 - ox:cx2 - ox]
        paste_over(e_canvas, e_alpha)

    # final composite onto frame
    roi = out_frame[y1:y2, x1:x2].astype(np.float32)
    out_frame[y1:y2, x1:x2] = (
        color_acc + roi * (1.0 - alpha_acc[..., None])
    ).astype(np.uint8)
    return out_frame


# ===== VIDEO: crop/reframe compositing (mirrors crop_editor.js) =====

def letterbox(frame, out_w, out_h):
    canvas = np.zeros((out_h, out_w, 3), dtype=np.uint8)
    src_h, src_w = frame.shape[:2]
    if src_w == 0 or src_h == 0:
        return canvas
    src_aspect = src_w / src_h
    canvas_aspect = out_w / out_h
    if src_aspect > canvas_aspect:
        dw, dh = out_w, int(out_w / src_aspect)
    else:
        dh, dw = out_h, int(out_h * src_aspect)
    dw, dh = max(1, dw), max(1, dh)
    dx, dy = (out_w - dw) // 2, (out_h - dh) // 2
    resized = cv2.resize(frame, (dw, dh))
    canvas[dy:dy + dh, dx:dx + dw] = resized
    return canvas


def compose_frame(frame, segment, out_w, out_h):
    src_h, src_w = frame.shape[:2]

    if not segment or segment.get("mode") == "horizontal":
        return letterbox(frame, out_w, out_h)

    mode = segment.get("mode")
    boxes = get_segment_boxes(segment, mode, src_w, src_h)
    if not boxes:
        return letterbox(frame, out_w, out_h)

    canvas = np.zeros((out_h, out_w, 3), dtype=np.uint8)
    for box in boxes:
        sx, sy = int(box["x"] * src_w), int(box["y"] * src_h)
        sw, sh = max(1, int(box["w"] * src_w)), max(1, int(box["h"] * src_h))
        sx2, sy2 = min(src_w, sx + sw), min(src_h, sy + sh)
        crop = frame[sy:sy2, sx:sx2]
        if crop.size == 0:
            continue

        slot = box.get("slot") or {"x": 0, "y": 0, "w": 1, "h": 1}
        dx, dy = int(slot["x"] * out_w), int(slot["y"] * out_h)
        dw, dh = max(1, int(slot["w"] * out_w)), max(1, int(slot["h"] * out_h))
        dx2, dy2 = min(out_w, dx + dw), min(out_h, dy + dh)
        if dx2 <= dx or dy2 <= dy:
            continue
        resized = cv2.resize(crop, (dx2 - dx, dy2 - dy))
        canvas[dy:dy2, dx:dx2] = resized

    return canvas


# ===== CAPTIONS: burn-in (mirrors captions.js drawCaptionsOnCanvas) =====

def draw_captions(canvas_bgr, cue, source_t, style_key, position, font_scale, out_w, out_h, overrides=None, all_cues=None):
    style = resolve_caption_style(style_key, overrides)
    base_font_px = 54 * (out_h / 1920.0) * font_scale

    words = [w["text"].upper() if style["uppercase"] else w["text"] for w in cue["words"]]
    font = _get_font(base_font_px)

    img = Image.fromarray(cv2.cvtColor(canvas_bgr, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(img)

    gap = 10 * (out_h / 1920.0)
    widths = [draw.textlength(w, font=font) for w in words]
    total_w = sum(widths) + gap * max(0, len(words) - 1)

    fit_scale = 1.0
    if total_w > out_w * 0.92:
        fit_scale = (out_w * 0.92) / total_w if total_w > 0 else 1.0
        font = _get_font(base_font_px * fit_scale)
        widths = [draw.textlength(w, font=font) for w in words]
        total_w = sum(widths) + (gap * fit_scale) * max(0, len(words) - 1)

    x = out_w * position["x"] - total_w / 2
    y = out_h * position["y"]
    final_gap = gap * fit_scale
    fsz = base_font_px * fit_scale
    anim = style.get("anim", "box")
    s = out_h / 1920.0 * font_scale  # global scale unit (JS 'scale * fitScale' ke barabar)
    sc = fit_scale
    tx = y - fsz / 2  # text center-line

    # JS 'hs' hump + wordProg ka exact mirror
    def _hump(p):
        return math.sin(max(0.0, min(1.0, p)) * math.pi)

    def _word_prog(w):
        if source_t is None or w["end"] <= w["start"]:
            return 0.0
        return max(0.0, min(1.0, (source_t - w["start"]) / (w["end"] - w["start"])))

    def _glow(text_, cx_, cy_, color, blur_px):
        # PIL mein ctx.shadowBlur ka equivalent: alag layer par text -> GaussianBlur -> paste
        # (text LAYER ke center par relative draw hota hai, phir paste bhi center-aligned)
        pad = int(blur_px * 3) + 8
        lw = int(fsz * 2 + pad * 2)
        lh = int(fsz * 2 + pad * 2)
        layer = Image.new("RGBA", (max(4, lw), max(4, lh)), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        ld.text((lw / 2, lh / 2), text_, font=font, fill=color + (255,), anchor="mm")
        layer = layer.filter(ImageFilter.GaussianBlur(blur_px))
        img.paste(layer, (int(cx_ - lw / 2), int(cy_ - lh / 2)), layer)

    def _box(bx, by, bw2, bh2, fill=None, tilt=0.0, rounded=False, stroke=None, stroke_w=0):
        pad = 40
        bx_i, by_i = int(bx) - pad, int(by) - pad
        bw_i, bh_i = int(bw2) + pad * 2, int(bh2) + pad * 2
        layer = Image.new("RGBA", (max(4, bw_i), max(4, bh_i)), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        rx, ry, rw, rh = pad, pad, int(bw2), int(bh2)
        if tilt:
            cxl, cyl = rx + rw / 2, ry + rh / 2
            pt = [(rx, ry), (rx + rw, ry), (rx + rw, ry + rh), (rx, ry + rh)]
            ca, sa = math.cos(tilt), math.sin(tilt)
            pt = [(cxl + (px - cxl) * ca - (py - cyl) * sa, cyl + (px - cxl) * sa + (py - cyl) * ca) for px, py in pt]
            if fill:
                ld.polygon(pt, fill=fill + (255,))
            if stroke:
                ld.polygon(pt, outline=stroke + (255,), width=max(1, int(stroke_w)))
        elif rounded:
            if fill:
                ld.rounded_rectangle([rx, ry, rx + rw, ry + rh], radius=rh / 2, fill=fill + (255,))
            if stroke:
                ld.rounded_rectangle([rx, ry, rx + rw, ry + rh], radius=rh / 2, outline=stroke + (255,), width=max(1, int(stroke_w)))
        else:
            if fill:
                ld.rectangle([rx, ry, rx + rw, ry + rh], fill=fill + (255,))
            if stroke:
                ld.rectangle([rx, ry, rx + rw, ry + rh], outline=stroke + (255,), width=max(1, int(stroke_w)))
        img.paste(layer, (bx_i, by_i), layer)

    # ---------- "My Caption 3" — wrapBig custom renderer (frontend mirror) ----------
    # 2 words per line centered block; KEY word (video/editor/work...) 1.55x +
    # yellow + glow; filler word chhota + white; active word extra peek-pop.
    if anim == "wrapBig":
        stop = set(("a an the and or but for with is are was were be been am it i you we they he she me my your our their as by from of to in on at if so do does did done has have had not will can could should would just about out up down all any what when where who why how than then too very also into over there here that this those these no nor yet both each other some such only own same s t don now").split())
        def _kw(txt):
            b = "".join(ch for ch in txt.lower() if ch.isalnum())
            return len(b) >= 4 and b not in stop and not b.endswith("ing")
        cx0 = out_w * position["x"]
        lines = [cue["words"][i:i + 2] for i in range(0, len(cue["words"]), 2)]
        gap_w = 14 * s
        line_ws, line_hs, meta = [], [], {}
        for ln in lines:
            wsum, hmax = 0.0, 0.0
            for w in ln:
                act = source_t is not None and w["start"] <= source_t < w["end"]
                key = _kw(w["text"])
                p = max(0.0, min(1.0, (source_t - w["start"]) / (w["end"] - w["start"]))) if (act and w["end"] > w["start"]) else 0.0
                pop = (1 + 0.06 * (1 - abs(2 * p - 1))) if act else 1.0
                fsz = base_font_px * (1.55 if key else 1.0) * pop
                f = _get_font(fsz)
                ww = draw.textlength(w["text"], font=f)
                meta[id(w)] = (ww, fsz, act, key, f)
                wsum += ww
                hmax = max(hmax, fsz)
            wsum += gap_w * max(0, len(ln) - 1)
            line_ws.append(wsum)
            line_hs.append(hmax)
        tot_h = sum(line_hs) + 14 * s * max(0, len(lines) - 1)
        yy = y - tot_h / 2 + line_hs[0] / 2
        for li, ln in enumerate(lines):
            lx = cx0 - line_ws[li] / 2
            line_cy = yy
            for w in ln:
                ww, fsz, act, key, f = meta[id(w)]
                cxw, cyw = lx + ww / 2, line_cy
                glow_on = (key or act) and style.get("glow")
                if glow_on:
                    blur = (34 if act else 20) * s
                    pad = int(blur * 3) + 8
                    gw, gh = int(fsz * 2 + pad * 2), int(fsz * 2 + pad * 2)
                    g_layer = Image.new("RGBA", (max(4, gw), max(4, gh)), (0, 0, 0, 0))
                    gd = ImageDraw.Draw(g_layer)
                    gd.text((gw / 2, gh / 2), w["text"], font=f, fill=style["glow"] + (255,), anchor="mm")
                    g_layer = g_layer.filter(ImageFilter.GaussianBlur(max(2, blur)))
                    img.paste(g_layer, (int(cxw - gw / 2), int(cyw - gh / 2)), g_layer)
                fill = (style["active"] if key else style["color"])
                draw.text((cxw, cyw), w["text"], font=f, fill=fill, anchor="mm")
                lx += ww + gap_w
            yy += line_hs[li] / 2 + line_hs[min(li + 1, len(line_hs) - 1)] / 2 + 14 * s
        return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)

    # ---------- "My Caption 6" — neonChunks renderer (frontend mirror) ----------
    # PHRASE-CHUNKING: 2-4 white words + 1-3 colored (NEON) — har naya colored
    # chunk palette se DIFFERENT random color (deterministic seed = cue-index,
    # JS mirror). 2 lines: L1 ~57px, L2 ~85% — DRAG-FOLLOW (pos.y - 0.34 -> L1,
    # JS yLine1/yLine2 mirror; fix: pehle block frame se bahar jata tha).
    # Layout PRE-COMPUTED & centered — har word FINAL jagah par fade-in
    # (alpha in ~100ms, no slide). NEON = same-color glow (6 + 14px @60%) +
    # dark drop shadow. EMPHASIS-N/A (JS cue.length==1 special bhi mirror nahi —
    # chunk loop khud usko handle karta hai).
    if anim == "neonChunks":
        pal = [tuple(p) for p in (style.get("neon_palette") or [(45, 180, 255)])]
        fs1 = float(style.get("base_px", 57)) * (out_h / 1920.0) * font_scale
        fs2 = fs1 * float(style.get("line2_ratio", 0.85))
        anim_s6 = float(style.get("anim_scale", 1.04))
        _clamp01_6 = lambda v: max(0.02, min(0.98, v))
        yl1 = out_h * _clamp01_6(position["y"] - 0.34)
        y_line1 = yl1
        y_line2 = yl1 + out_h * 0.06
        y_single = out_h * _clamp01_6(position["y"] - 0.31)
        cx6 = out_w * position["x"]

        # cue INDEX (deterministic seed — JS captionCues.indexOf(cue) mirror)
        cue_idx = 0
        if all_cues:
            for _i, _c in enumerate(all_cues):
                if _c is cue:
                    cue_idx = _i
                    break

        # --- CHUNK build: 2-4 white + 1-3 colored (seeded, no-repeat color) ---
        # GUARANTEE: har cue me kam-az-kam 1 COLORED chunk (video: 3-word
        # phrases bhi colored — NEVER BEEN EASIER). JS mirror.
        chunks = []
        W = len(cue["words"])
        wi = 0
        last_color = -1
        max_white6 = max(1, W - 2) if W <= 3 else max(2, W - 2)
        while wi < W:
            remains = W - wi
            wc = 2 + ((cue_idx * 7 + wi * 3) % 3)
            if remains <= max_white6 + 1:
                wc = remains - 1
            if remains - wc < 1:
                wc = remains - 1
            wc = max(1, min(wc, remains))
            white_i = []
            for _k in range(wc):
                if wi < W:
                    white_i.append(wi)
                    wi += 1
            if white_i and (len(white_i) < W or chunks):
                chunks.append({"idxs": white_i, "color": None})
            if wi < W:
                cc = min(1 + ((cue_idx + wi) % 3), W - wi)
                ci = int(abs(math.sin(cue_idx * 17.3 + wi * 7.7)) * len(pal)) % len(pal)
                if ci == last_color:
                    ci = (ci + 1 + ((cue_idx + wi) % max(1, len(pal) - 1))) % len(pal)
                last_color = ci
                col_i = []
                for _k in range(cc):
                    if wi < W:
                        col_i.append(wi)
                        wi += 1
                chunks.append({"idxs": col_i, "color": pal[ci]})
        if chunks and not any(ch["color"] for ch in chunks):
            chunks[-1]["color"] = pal[int(abs(math.sin(cue_idx * 17.3)) * len(pal)) % len(pal)]

        gap_w6 = 10 * (out_h / 1920.0)
        fs_white6 = fs2             # white words CHHOTE (~85%)
        fs_color6 = fs1 * 1.18      # NEON words BARE (video: FOLLOWERS/MONEY

        # per-word color/size (chunk se) — JS neeche-wrap mirror
        word_color6, word_fs6 = {}, {}
        for ch in chunks:
            for i in ch["idxs"]:
                word_color6[i] = ch["color"]
                word_fs6[i] = fs_color6 if ch["color"] else fs_white6

        # greedy wrap 86% (JS mirror) + 88% squash per-line
        lines6 = []
        cur6, cur_w6 = [], 0.0
        for i in range(W):
            f_w = _get_font(word_fs6[i])
            ww = draw.textlength(words[i], font=f_w)
            if cur6 and (cur_w6 + gap_w6 + ww) > out_w * 0.86:
                lines6.append(cur6)
                cur6, cur_w6 = [], 0.0
            cur6.append({"i": i, "ww": ww, "fs": word_fs6[i], "color": word_color6[i] or None})
            cur_w6 += (gap_w6 + ww) if len(cur6) > 1 else ww
        if cur6:
            lines6.append(cur6)
        line_ws6 = []
        for ln in lines6:
            tot = sum(it["ww"] for it in ln) + gap_w6 * (len(ln) - 1)
            if tot > out_w * 0.88:
                f = (out_w * 0.88) / tot
                for it in ln:
                    it["ww"] *= f
                    it["fs"] *= f
                tot *= f
            line_ws6.append(tot)

        # layout: lines centered — drag-follow (JS neonChunks ka mirror)
        layout6 = []
        line_h6 = fs_color6 * 0.62 * s   # tight stacking
        for li, ln in enumerate(lines6):
            cy = y_single if len(lines6) == 1 else (y_line1 if li == 0 else y_line2 + (li - 1) * line_h6)
            lx = cx6 - line_ws6[li] / 2
            for it in ln:
                layout6.append({"i": it["i"], "x": lx + it["ww"] / 2, "y": cy, "fs": it["fs"], "color": it["color"], "ww": it["ww"]})
                lx += it["ww"] + gap_w6

        pad6 = int(14 * (out_h / 1920.0) * 3) + 8
        for it in layout6:
            w = cue["words"][it["i"]]
            st_start = float(w.get("start", 0) or 0)
            st_end = float(w.get("end", 0) or 0)
            act = source_t is not None and st_start <= source_t < st_end
            spoken = source_t is not None and source_t >= st_end
            dur = min(0.1, (st_end - st_start) or 0.1)
            tt = min(1.0, max(0.0, (source_t - st_start) / max(0.02, dur))) if (act and source_t is not None) else (1.0 if spoken else 0.0)
            alpha6 = tt
            if alpha6 <= 0:
                continue
            pop6 = 1 + (anim_s6 - 1) * math.sin(tt * math.pi) if act else 1.0
            fsz6 = it["fs"]
            f6 = _get_font(fsz6)
            fill6 = it["color"] if it["color"] else style["color"]
            lw6 = int(it["ww"] * pop6) + pad6 * 2
            lh6 = int(fsz6 * 2 * pop6) + pad6 * 2
            layer = Image.new("RGBA", (max(4, lw6), max(4, lh6)), (0, 0, 0, 0))
            tx6, ty6 = lw6 / 2, lh6 / 2
            if it["color"]:
                # NEON: same-color glow (6px full + 14px @60%) — JS mirror
                col = it["color"]
                gl1 = Image.new("RGBA", layer.size, (0, 0, 0, 0))
                ImageDraw.Draw(gl1).text((tx6, ty6), words[it["i"]], font=f6, fill=col + (int(255 * alpha6),), anchor="mm")
                gl1 = gl1.filter(ImageFilter.GaussianBlur(max(2, 6 * s)))
                layer = Image.alpha_composite(layer, gl1)
                gl2 = Image.new("RGBA", layer.size, (0, 0, 0, 0))
                ImageDraw.Draw(gl2).text((tx6, ty6), words[it["i"]], font=f6, fill=col + (int(255 * alpha6 * 0.6),), anchor="mm")
                gl2 = gl2.filter(ImageFilter.GaussianBlur(max(2, 14 * s)))
                layer = Image.alpha_composite(layer, gl2)
            # dark drop shadow (har word ke peeche — white bhi, neon bhi)
            shl = Image.new("RGBA", layer.size, (0, 0, 0, 0))
            ImageDraw.Draw(shl).text((tx6, ty6 + 2 * s), words[it["i"]], font=f6, fill=(0, 0, 0, int(128 * alpha6)), anchor="mm")
            shl = shl.filter(ImageFilter.GaussianBlur(max(2, 6 * s)))
            layer = Image.alpha_composite(layer, shl)
            ImageDraw.Draw(layer).text((tx6, ty6), words[it["i"]], font=f6, fill=fill6 + (int(255 * alpha6),), anchor="mm")
            img.paste(layer, (int(it["x"] - lw6 / 2), int(it["y"] - lh6 / 2)), layer)
        return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)

    # ---------- "My Caption 5" — fadeSplit renderer (frontend mirror) ----------
    # MAX 2 WORDS PER LINE: 3+ word cues 2 lines mein re-wrapped. Per-word
    # reveal: unspoken words dim, ACTIVE word ACCENT-color reveal (keyword
    # color-cycle blue/purple/green/red — keyword-count order), bol-chuka
    # white. Soft black shadow poore text par. PIL mini-layers (globalAlpha).
    if anim == "fadeSplit":
        acc_list = style.get("accents") or [(51, 177, 255)]
        dim = float(style.get("dim_opacity", 0.55))
        anim_s = float(style.get("anim_scale", 1.06))
        fsz_base = float(style.get("base_px", 60)) * (out_h / 1920.0) * font_scale
        font = _get_font(fsz_base)
        texts = [str(w.get("text", "")).upper() if style["uppercase"] else str(w.get("text", "")) for w in cue["words"]]
        widths = [draw.textlength(t, font=font) for t in texts]
        gap_w = 16 * (out_h / 1920.0)

        def _kw(txt):
            return len("".join(ch for ch in str(txt) if ch.isalnum())) >= 4

        # 2-word lines (frontend loop ka mirror)
        lines_idx = [list(range(i, min(i + 2, len(cue["words"])))) for i in range(0, len(cue["words"]), 2)]

        cx0 = out_w * position["x"]
        cy0 = out_h * position["y"]
        lh2 = fsz_base * 1.05
        yy = cy0 - (len(lines_idx) * lh2) / 2 + lh2 / 2
        kw_before = 0
        for w_i in range(len(cue["words"])):
            cue["words"][w_i]["_kw_idx"] = kw_before if _kw(cue["words"][w_i]["text"]) else -1
            if _kw(cue["words"][w_i]["text"]):
                kw_before += 1
        # NOTE: _kw_idx mutates cue dict (cached cue-objects bhi) — idempotent hai
        # (same cue-dict par dobara run se wahi value set hoti hai)
        for ln in lines_idx:
            lw = sum(widths[i] for i in ln) + gap_w * max(0, len(ln) - 1)
            lx = cx0 - lw / 2
            for i in ln:
                w = cue["words"][i]
                st_end = float(w.get("end", 0) or 0)
                st_start = float(w.get("start", 0) or 0)
                act = source_t is not None and st_start <= source_t < st_end
                reveal = act or (source_t is not None and st_end <= source_t)
                dur = min(0.25, (st_end - st_start) or 0.2)
                tt = min(1.0, max(0.0, (source_t - st_start) / max(0.02, dur))) if (act and source_t is not None) else 1.0
                alpha = (dim + (1 - dim) * tt) if act else (1.0 if reveal else dim)
                is_kw = w.get("_kw_idx", -1) >= 0
                fill = style["color"]
                # keyword = accent (unspoken ghost-dim tint included), active
                # keyword = accent; spoken-pass = solid white (JS mirror)
                if is_kw:
                    fill = acc_list[w["_kw_idx"] % len(acc_list)]
                elif reveal and not act:
                    fill = style["active"]
                pop = 1 + (anim_s - 1) * (1 - abs(2 * tt - 1)) if act else 1.0
                # mini-layer (alpha-blend + shadow + scale — PIL equivalent)
                shadow_rgba = dict(fill=fill)
                lw2 = int(widths[i]) + 48
                lh3 = int(fsz_base * 2) + 48
                layer = Image.new("RGBA", (max(4, lw2), max(4, lh3)), (0, 0, 0, 0))
                ld = ImageDraw.Draw(layer)
                tx2, ty2 = lw2 / 2, lh3 / 2
                # soft black shadow (blur layer)
                sh_l = Image.new("RGBA", layer.size, (0, 0, 0, 0))
                sh_d = ImageDraw.Draw(sh_l)
                sh_d.text((tx2, ty2), texts[i], font=font, fill=(0, 0, 0, 140), anchor="mm")
                sh_l = sh_l.filter(ImageFilter.GaussianBlur(max(2, 14 * (out_h / 1920.0))))
                layer = Image.alpha_composite(layer, sh_l)
                ld = ImageDraw.Draw(layer)
                ld.text((tx2, ty2), texts[i], font=font, fill=fill + (int(255 * alpha),), anchor="mm")
                if pop != 1.0:
                    nw, nh = max(1, int(lw2 * pop)), max(1, int(lh3 * pop))
                    layer = layer.resize((nw, nh), Image.BICUBIC)
                img.paste(layer, (int(lx + widths[i] / 2 - layer.width / 2), int(yy - layer.height / 2)), layer)
                lx += widths[i] + gap_w
            yy += lh2
        return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)

    # ---------- "My Caption 4" — fadeCloud renderer (frontend mirror) ----------
    # BOLNE-WALA word smooth fade-up (alpha 0.3->1 + float-up + quick pop);
    # upcoming words dim (~50% opacity black-ghost jaisa); bol-chuka poora
    # solid; REPEATER keyword (4+ letters, poore cues mein 2+ dufa) ACCENT
    # (blue); font auto-shrink + word-wrap 90% width par.
    if anim == "fadeCloud":
        acc = style.get("accent")
        dim = float(style.get("dim_opacity", 0.5))
        rise = float(style.get("fade_up", 14)) * s
        fsz_base = float(style.get("base_px", 54)) * (out_h / 1920.0) * font_scale
        font = _get_font(fsz_base)
        # repeater-keyword dict: poori caption-cue set mein har 4+ letter word
        # kitni dafa aaya (frontend global captionCues dict ka mirror)
        counts = {}
        if all_cues:
            for c in all_cues:
                for w in c.get("words", []):
                    b = "".join(ch for ch in str(w.get("text", "")).lower() if ch.isalnum())
                    if len(b) >= 4:
                        counts[b] = counts.get(b, 0) + 1
        texts = [str(w.get("text", "")).upper() if style["uppercase"] else str(w.get("text", "")) for w in cue["words"]]
        widths = [draw.textlength(t, font=font) for t in texts]
        gap_w = 16 * (out_h / 1920.0)
        # fit-scale: poori line 92% width se zyada to shrink (JS fitScale jaisa)
        total_w = sum(widths) + gap_w * max(0, len(widths) - 1)
        fit = 1.0
        if total_w > out_w * 0.92:
            fit = (out_w * 0.92) / total_w if total_w > 0 else 1.0
            font = _get_font(fsz_base * fit)
            widths = [draw.textlength(t, font=font) for t in texts]
        gap_w_wrap = 16 * (out_h / 1920.0) * fit
        # word-wrap: line 90% width bhar jaye to agla word nayi line par
        lines_idx = []
        cur, cur_w = [], 0.0
        for i, ww in enumerate(widths):
            if cur and cur_w + gap_w_wrap + ww > out_w * 0.9:
                lines_idx.append(cur)
                cur, cur_w = [], 0.0
            cur.append(i)
            cur_w += ww + (gap_w_wrap if len(cur) > 1 else 0)
        if cur:
            lines_idx.append(cur)
        cx0 = out_w * position["x"]
        cy0 = out_h * position["y"]
        lh2 = fsz_base * fit * 1.12
        yy = cy0 - (len(lines_idx) * lh2) / 2 + lh2 / 2
        for ln in lines_idx:
            lw = sum(widths[i] for i in ln) + gap_w_wrap * max(0, len(ln) - 1)
            lx = cx0 - lw / 2
            for i in ln:
                w = cue["words"][i]
                st_end = float(w.get("end", 0) or 0)
                st_start = float(w.get("start", 0) or 0)
                act = source_t is not None and st_start <= source_t < st_end
                dur = min(0.22, (st_end - st_start) or 0.2)
                tt = min(1.0, max(0.0, (source_t - st_start) / max(0.02, dur))) if (act and source_t is not None) else 1.0
                if act:
                    alpha = 0.3 + 0.7 * tt
                    dy = -rise * tt
                    pop = 1 + 0.07 * math.sin(tt * math.pi)
                else:
                    alpha = 1.0 if (source_t is not None and st_end <= source_t) else dim
                    dy = 0.0
                    pop = 1.0
                fill = style["color"]
                b = "".join(ch for ch in texts[i].lower() if ch.isalnum())
                if acc and len(b) >= 4 and counts.get(b, 0) >= 2:
                    fill = acc
                # per-word RGBA mini-layer (ctx.globalAlpha ka blend-mirror)
                fpx = fsz_base * fit
                layer = Image.new("RGBA", (int(widths[i]) + 40, int(fpx * 2) + 40), (0, 0, 0, 0))
                ld = ImageDraw.Draw(layer)
                ld.text((layer.width / 2, layer.height / 2), texts[i], font=font, fill=fill + (int(255 * alpha),), anchor="mm")
                if pop != 1.0:
                    nw, nh = max(1, int(layer.width * pop)), max(1, int(layer.height * pop))
                    layer = layer.resize((nw, nh), Image.BICUBIC)
                img.paste(layer, (int(lx + widths[i] / 2 - layer.width / 2), int(yy + dy - layer.height / 2)), layer)
                lx += widths[i] + gap_w_wrap
            yy += lh2
        return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)

    for i, w in enumerate(cue["words"]):
        is_active = source_t is not None and w["start"] <= source_t < w["end"]
        text = words[i]
        ww = widths[i]
        cx = x + ww / 2
        prog = _word_prog(w)
        hump = _hump(prog)
        padX, padY = 10 * s, 6 * s

        # ---------- BOX BACKDROPS (JS order mirror; texture-free fills) ----------
        if is_active and style.get("highlight_bg"):
            hbg = style["highlight_bg"]
            if anim == "box":
                _box(x - padX, tx - fsz / 2 - padY, ww + padX * 2, fsz + padY * 2, fill=hbg)
            elif anim == "doubleBox":
                _box(x - padX - 4 * s, tx - fsz / 2 - padY - 4 * s, ww + padX * 2 + 8 * s, fsz + padY * 2 + 8 * s, fill=(255, 255, 255))
                _box(x - padX, tx - fsz / 2 - padY, ww + padX * 2, fsz + padY * 2, fill=hbg)
            elif anim == "boxTilt":
                _box(x - padX, tx - fsz / 2 - padY, ww + padX * 2, fsz + padY * 2, fill=hbg, tilt=-0.06)
            elif anim == "boxBounce":
                hop = -hump * 6 * s
                _box(x - padX, tx - fsz / 2 - padY + hop, ww + padX * 2, fsz + padY * 2, fill=hbg)
            elif anim == "boxRounded":
                _box(x - padX, tx - fsz / 2 - padY, ww + padX * 2, fsz + padY * 2, fill=hbg, rounded=True)
            elif anim == "outlineBox":
                _box(x - padX, tx - fsz / 2 - padY, ww + padX * 2, fsz + padY * 2, rounded=True,
                     stroke=hbg, stroke_w=max(3, 6 * s))
        if is_active and anim == "lineBox" and style.get("highlight_bg"):
            line_left = out_w * position["x"] - total_w / 2
            _box(line_left - padX, tx - fsz / 2 - padY, total_w + padX * 2, fsz + padY * 2, fill=style["highlight_bg"])
        if is_active and anim == "tickerBar":
            _box(x - padX, y - fsz * 0.75, ww + padX * 2, fsz * 1.5, fill=style["highlight_bg"])

        # ---------- TRANSFORM (JS values ka exact mirror) ----------
        draw_scale, dx, dy, rot = 1.0, 0.0, 0.0, 0.0
        if is_active:
            if anim == "pop":
                draw_scale = 1.15
            elif anim == "stamp":
                draw_scale = 1.35
            elif anim == "rotPop":
                draw_scale = 1.12
                rot = (-1 if i % 2 == 0 else 1) * 0.09
            elif anim == "popBounce":
                draw_scale = 1.12
                dy = -hump * 10 * s
            elif anim == "boxBounce":
                dy = -hump * 6 * s
            elif anim == "shake":
                dx = math.sin(prog * 24) * 3 * s
                dy = math.cos(prog * 19) * 2 * s
            elif anim == "slide":
                dx = -(1 - min(1, prog * 2.2)) * 26 * s
            elif anim == "squash":
                draw_scale = 1 + 0.08 * hump
                dy = 0.06 * hump * fsz
            elif anim == "underlineFloat":
                dy = -hump * 4 * s
            elif anim == "flash":
                draw_scale = 1 + 0.1 * hump
            elif anim == "glowPop":
                draw_scale = 1.12
            elif anim == "popFill":
                draw_scale = 1 + 0.15 * hump

        # ---------- FILL COLOR (color-highlighting) ----------
        fill = style["active"] if is_active else style["color"]
        if is_active:
            if anim == "rgbCycle" and style.get("active_palette"):
                fill = style["active_palette"][i % len(style["active_palette"])]
            elif anim == "glowSwap" and style.get("glow2"):
                fill = style["active"] if i % 2 == 0 else style["glow2"]
            elif anim == "flash" and prog < 0.3:
                fill = (255, 224, 138)
            elif anim == "popFill" and prog < 0.35:
                fill = (255, 255, 255)
            elif anim == "fillSweep":
                fill = style["color"]

        ol = style.get("outline")
        ow = max(2, int(round(style.get("outline_w", 3.5) * sc)))

        # ---------- GLOW (JS ctx.shadowBlur mirror) ----------
        # glow_all (My Caption styles): glow HARB word par — sample-video look
        if style.get("glow") and (is_active or style.get("glow_all")):
            blur = (10 + 22 * hump) * s if anim == "glowPulse" else (30 * s if anim == "glowPop" else (22 * s if anim == "popFill" else 18 * s))
            _glow(text, cx + dx, tx + dy, style["glow"], max(2, blur))

        # ---------- TRANSFORMED TEXT (rotate/scale via mini-layer) ----------
        need_layer = (rot != 0.0) or (draw_scale != 1.0)
        if need_layer:
            pad = int(fsz * 0.8) + 8
            lw = int(ww + pad * 2)
            lh = int(fsz * 2 + pad * 2)
            layer = Image.new("RGBA", (max(4, lw), max(4, lh)), (0, 0, 0, 0))
            ld = ImageDraw.Draw(layer)
            lcx, lcy = lw / 2, lh / 2
            if ol:
                lox = max(1, int(round(ow / max(draw_scale, 0.01))))
                for ox, oy in ((-lox, 0), (lox, 0), (0, -lox), (0, lox)):
                    ld.text((lcx + ox, lcy + oy), text, font=font, fill=ol + (255,), anchor="mm")
            ld.text((lcx, lcy), text, font=font, fill=fill + (255,), anchor="mm")
            if rot:
                layer = layer.rotate(-math.degrees(rot), resample=Image.BICUBIC, center=(lcx, lcy))
            if draw_scale != 1.0:
                nw, nh = max(1, int(lw * draw_scale)), max(1, int(lh * draw_scale))
                layer = layer.resize((nw, nh), Image.BICUBIC)
            img.paste(layer, (int(cx + dx - lw / 2), int(tx + dy - lh / 2)), layer)
        else:
            if ol:
                for ox, oy in ((-ow, 0), (ow, 0), (0, -ow), (0, ow)):
                    draw.text((cx + dx + ox, tx + dy + oy), text, font=font, fill=ol, anchor="mm")
            draw.text((cx + dx, tx + dy), text, font=font, fill=fill, anchor="mm")

        # ---------- SWEEP / KARAOKE FILL (clip-based, fill ke baad) ----------
        if is_active and (anim == "fillSweep" or anim == "fill"):
            pad = 8
            lw = int(ww + pad * 2)
            lh = int(fsz * 2 + pad * 2)
            layer = Image.new("RGBA", (max(4, lw), max(4, lh)), (0, 0, 0, 0))
            ld = ImageDraw.Draw(layer)
            clip_w = ww * prog if anim == "fillSweep" else ww
            mask = Image.new("L", layer.size, 0)
            md = ImageDraw.Draw(mask)
            md.rectangle([pad, 0, pad + max(0, int(clip_w)), lh], fill=255)
            ld.text((lw / 2, lh / 2), text, font=font, fill=style["active"] + (255,), anchor="mm")
            img.paste(layer, (int(cx - lw / 2), int(tx - lh / 2)), mask)

        # ---------- UNDERLINE / STRIKE OVERLAYS ----------
        if is_active and (anim == "underline" or anim == "underlineFloat"):
            uy = y + dy + fsz * 0.42
            draw.line([cx + dx - ww / 2, uy, cx + dx + ww / 2, uy], fill=style["active"], width=max(1, int(3 * s)))
        if is_active and anim == "strike":
            draw.line([cx + dx - ww / 2 - 2, y + dy, cx + dx + ww / 2 + 2, y + dy], fill=style["active"], width=max(1, int(4 * s)))

        x += ww + final_gap

    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


# ===== AUDIO: build via ffmpeg filter_complex (atrim + atempo + adelay + amix) =====

def _atempo_chain(speed):
    """atempo filter sirf 0.5-2.0 range support karta hai — extreme speeds ke
    liye kai atempo filters chain karne padte hain."""
    if speed <= 0:
        speed = 1.0
    parts = []
    remaining = speed
    while remaining > 2.0:
        parts.append("atempo=2.0")
        remaining /= 2.0
    while remaining < 0.5:
        parts.append("atempo=0.5")
        remaining /= 0.5
    parts.append(f"atempo={remaining:.4f}")
    return ",".join(parts)


def build_audio(source_path, video_clips, audio_lanes, total_duration, out_wav_path, stack2_video_clips=None, stack2_audio_lanes=None):
    # MULTI-SOURCE: har piece apni file se aata hai (S2 clip ka _path; na ho to
    # source_path). Inputs: pehla source_path, baqi unique extra files.
    input_paths = [source_path]
    input_idx = {source_path: 0}

    def idx_for(path):
        if path not in input_idx:
            input_paths.append(path)
            input_idx[path] = len(input_paths) - 1
        return input_idx[path]

    pieces = []  # (input_idx, src_start, src_end, speed, dest_start)

    def add_from(clips, lanes):
        for c in clips:
            if c.get("muted") or c.get("audioDetached"):
                continue
            pieces.append((idx_for(c.get("_path") or source_path), c["sourceStart"], c["sourceEnd"], c.get("speed") or 1, c["start"]))
        for a in lanes:
            if a.get("muted"):
                continue
            pieces.append((idx_for(a.get("_path") or source_path), a["sourceStart"], a["sourceEnd"], 1, a["start"]))

    add_from(video_clips, audio_lanes)
    # STACK-2 audio: S2 clips ka embedded-audio (agar unmuted) + S2 audio lanes.
    # NOTE: duplicate-video workflow mein S2 clips muted hote hain, isliye yahan
    # aam tor par kuch nahi hoga — magar independent S2 media support hai.
    add_from(stack2_video_clips or [], stack2_audio_lanes or [])

    if not pieces:
        subprocess.run(
            [FFMPEG, "-y", "-f", "lavfi", "-i", f"anullsrc=r=44100:cl=stereo",
             "-t", str(max(0.1, total_duration)), out_wav_path],
            capture_output=True,
        )
        return

    filter_parts = []
    labels = []
    for i, (in_idx, src_start, src_end, speed, dest_start) in enumerate(pieces):
        src_end = max(src_end, src_start + 0.05)
        tempo = _atempo_chain(speed)
        delay_ms = max(0, int(dest_start * 1000))
        label = f"a{i}"
        filter_parts.append(
            # NOTE: volume filter andar hi nahi hai — pieces ki ORIGINAL loudness
            # preserve hoti hai (sirf atrim/adelay/atempo, koi gain change nahi)
            f"[{in_idx}:a]atrim=start={src_start}:end={src_end},asetpts=PTS-STARTPTS,"
            f"{tempo},adelay={delay_ms}|{delay_ms}[{label}]"
        )
        labels.append(f"[{label}]")

    mix = "".join(labels) + (
        f"amix=inputs={len(labels)}:duration=longest:dropout_transition=0"
        # FIX: amix DEFAULT mein inputs normalize karta hai (har clip ki volume
        # uske hisse ke mutabiq ghaat deta hai) — silence-removal ke baad clips
        # jitni zyada hongi, output volume utna GIR JATA THA. normalize=0 se har
        # piece apni original volume par full mix hota hai (overlaps genuinely
        # audio-overlap karte hain to sum hota hai, jo sahi behavior hai).
        ":normalize=0"
        "[aout]"
    )
    filter_complex = ";".join(filter_parts) + ";" + mix

    cmd = [FFMPEG, "-y"]
    for p in input_paths:
        cmd += ["-i", p]
    cmd += [
        "-filter_complex", filter_complex,
        "-map", "[aout]",
        "-t", str(max(0.1, total_duration)),
        out_wav_path,
    ]
    r = subprocess.run(cmd, capture_output=True)
    # ROBUSTNESS: agar source mein AUDIO STREAM hi na ho (video-only file) to
    # [0:a] fail hota hai. Fallback: pure silence ka wav bana do — export na
    # toote, bas audio khali hogi.
    if r.returncode != 0 or not os.path.exists(out_wav_path) or os.path.getsize(out_wav_path) < 100:
        subprocess.run(
            [FFMPEG, "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
             "-t", str(max(0.1, total_duration)), out_wav_path],
            capture_output=True,
        )


# ===== SHORTS CANVAS: burn-in (mirrors frontend shorts_canvas.js) =====

def apply_shorts_canvas_frame(frame, sc, out_w, out_h, src_fps, blur_cache=None):
    """16:9 source-frame ko 9:16 shorts-window me place karta hai:
    Canvas 1 = bg me same video blurred (blurLevel adjustable)
    Canvas 2 = bg solid color (bgColor)
    fg = adjustable size/posX/posY box (aspect preserve)"""
    mode = sc.get("mode") or "blur"
    canvas = np.zeros((out_h, out_w, 3), dtype=np.uint8)

    # --- BACKGROUND (poori 9:16 window) ---
    if mode == "blur":
        lvl = max(0, int(sc.get("blurLevel") or 0))
        if lvl > 0 and frame is not None:
            # perf: chhote width par blur, phir upscale (blur me quality farak nahi)
            small_w = 180
            sh = max(1, int(round(frame.shape[0] * (small_w / frame.shape[1]))))
            small = cv2.resize(frame, (small_w, sh), interpolation=cv2.INTER_LINEAR)
            # frontend sigma ~ lvl*1.2 at output-width; 180px par scale-down equivalent
            sigma = max(1.0, lvl * 1.2 * (small_w / 1080.0))
            k = int(sigma * 2) * 2 + 1
            small_blur = cv2.GaussianBlur(small, (k, k), sigmaX=sigma)
            canvas[:] = cv2.resize(small_blur, (out_w, out_h), interpolation=cv2.INTER_LINEAR)
        else:
            canvas[:] = 0
    else:
        hexc = sc.get("bgColor") or "#000000"
        try:
            h = hexc.lstrip("#")
            r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        except Exception:
            r = g = b = 0
        canvas[:] = (b, g, r)  # BGR

    # --- FOREGROUND video box (aspect-preserve, frontend scBoxNormalized jaisa) ---
    if frame is None:
        return canvas
    va = float(frame.shape[1]) / float(max(1, frame.shape[0]))
    size = min(1.0, max(0.3, float(sc.get("size") or 1.0)))
    target = out_w / float(out_h)
    if va > target:
        bw0 = out_w * size
        bh0 = bw0 / va
    else:
        bh0 = out_h * size
        bw0 = bh0 * va
    # edge-handle stretch (frontend wS/hS jaisa — single-edge resize bhi export me)
    wS = min(4.0, max(0.05, float(sc.get("wS") or 1.0)))
    hS = min(4.0, max(0.05, float(sc.get("hS") or 1.0)))
    bw = int(round(max(20, min(bw0 * wS, out_w))))
    bh = int(round(max(20, min(bh0 * hS, out_h))))
    cx = min(1.0, max(0.0, float(sc.get("posX") or 0.5))) * out_w
    cy = min(1.0, max(0.0, float(sc.get("posY") or 0.5))) * out_h
    x = max(0, min(int(round(cx - bw / 2)), out_w - bw))
    y = max(0, min(int(round(cy - bh / 2)), out_h - bh))
    canvas[y:y + bh, x:x + bw] = cv2.resize(frame, (bw, bh))
    return canvas


# ===== MAIN ENTRY POINT =====

def render_export(source_path, timeline_state, quality, codec, progress_cb, out_path):
    """
    timeline_state: dict with videoClips, audioLanes, segments, captionCues,
                     captionStyle, captionsEnabled, captionPosition, captionFontScale
    quality: "test" | "720p" | "1080p"
    codec: "h264" | "h265"
    progress_cb: optional callable(fraction_done: float)
    """
    preset = QUALITY_PRESETS[quality]
    out_w, out_h, crf, x_preset, stride = preset["w"], preset["h"], preset["crf"], preset["preset"], preset["stride"]

    video_clips = timeline_state.get("videoClips", [])
    segments = timeline_state.get("segments", [])
    audio_lanes = timeline_state.get("audioLanes", [])
    # STACK-2 (2-Stack Spotlight)
    stack2_video_clips = timeline_state.get("stack2VideoClips", []) or []
    stack2_audio_lanes = timeline_state.get("stack2AudioLanes", []) or []
    stack2_segments = timeline_state.get("stack2Segments", []) or []
    stack_count = timeline_state.get("stackCount", 2 if stack2_video_clips or stack2_segments else 1)
    caption_cues = timeline_state.get("captionCues", []) if timeline_state.get("captionsEnabled", True) else []
    caption_style = timeline_state.get("captionStyle", "hormozi")
    caption_overrides = timeline_state.get("captionOverrides") or {}
    caption_position = timeline_state.get("captionPosition") or {"x": 0.5, "y": 0.86}
    caption_font_scale = timeline_state.get("captionFontScale") or 1.0
    grade = timeline_state.get("colorGrade") or None
    # NAYE EFFECT-LAYERS
    caption_spans = timeline_state.get("captionSpans") or []
    grade_spans = timeline_state.get("gradeSpans") or []
    pan_zoom_spans = timeline_state.get("panZoomSpans") or []
    transitions = timeline_state.get("transitions") or []
    # TITLES LAYER (9:16 heading-spans — caption-cues text-source ke sath)
    titles_spans = timeline_state.get("titlesSpans") or []
    titles_cues = timeline_state.get("titlesCues") or []  # (optional — cue fallback)
    # SHORTS CANVAS (16:9 -> 9:16 placement: blur/color bg + adjustable video box)
    shorts = timeline_state.get("shortsCanvas") or None
    shorts_enabled = bool(shorts and shorts.get("enabled"))
    _sc_blur_cache = {"key": None, "small": None}
    # MIGRATION: purana GLOBAL grade (bina grade-layer ke) → full-span layer
    if (not grade_spans) and grade and any((grade.get(k) or 0) != 0 for k in grade):
        grade_spans = [{"id": "migrated", "start": 0, "end": 1e9, "grade": grade}]
        grade = None

    total_duration = export_duration(video_clips, audio_lanes, segments, stack2_video_clips, stack2_audio_lanes, stack2_segments)
    if total_duration <= 0:
        raise ValueError("Timeline khaali hai — export karne ke liye kuch nahi hai")

    cap = cv2.VideoCapture(source_path)
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 25
    out_fps = max(5, src_fps / stride)

    # ===== SEQUENTIAL-DECODE OPTIMIZATION =====
    # cap.set(POS_MSEC) har baar call karna EXTREMELY slow hai kyunke compressed
    # (H.264/H.265) video mein ye hamesha nearest keyframe se dobara decode karta
    # hai. Zyada tar output-frames sequentially forward hi hoti hain (normal speed,
    # ek hi clip ke andar) — isliye hum seedha cap.read() se aage badhte hain, aur
    # SIRF bade jump (naya clip/cut, backward seek) par actual seek karte hain.
    # Ye hi wo fix hai jo render ko kaafi (kai guna) fast karta hai.
    SEEK_THRESHOLD = 1.0  # seconds — is se zyada ka gap ho to hi hard-seek karo
    decoder_pos = [None]   # list wrapper — closure se mutate karne ke liye
    last_frame = [None]

    def get_frame_at(src_t):
        src_t = max(0, src_t)
        if decoder_pos[0] is None or src_t < decoder_pos[0] - 0.001 or (src_t - decoder_pos[0]) > SEEK_THRESHOLD:
            cap.set(cv2.CAP_PROP_POS_MSEC, src_t * 1000)
            ok, frame = cap.read()
            if ok:
                last_frame[0] = frame
                decoder_pos[0] = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            return last_frame[0]
        # chhota forward gap — sequentially read karte hue aage badho (hard-seek se
        # kaafi zyada fast, kyunke isme keyframe-se-dobara-decode nahi hota)
        while decoder_pos[0] < src_t - (0.5 / src_fps):
            ok, frame = cap.read()
            if not ok:
                break
            last_frame[0] = frame
            decoder_pos[0] = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
        return last_frame[0]

    # ===== STACK-2 DECODERS (MULTI-SOURCE: per-file VideoCapture) =====
    # S1 aur S2 ka frame-time har frame alag hota hai — ek hi capture share
    # karo ge to har frame backward-seek hogi (keyframe re-decode = grind).
    # Isliye S2 ka APNA capture-map + per-file decoder-state (same sequential-
    # read trick). S2 clip ka apna file: clip["_path"] (main.py resolve karta
    # hai), na ho to main source file.
    s2_caps = {}
    s2_dec = {}
    s2_last = {}

    def s2_capture_for(path):
        if path not in s2_caps:
            cap = cv2.VideoCapture(path)
            s2_caps[path] = cap if cap.isOpened() else None
        return s2_caps[path]

    def get_frame_at_s2(src_t, path):
        cap = s2_capture_for(path)
        if cap is None:
            return None
        src_t = max(0, src_t)
        dec = s2_dec.get(path)
        if dec is None or src_t < dec - 0.001 or (src_t - dec) > SEEK_THRESHOLD:
            cap.set(cv2.CAP_PROP_POS_MSEC, src_t * 1000)
            ok, frame = cap.read()
            if ok:
                s2_last[path] = frame
                s2_dec[path] = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            return s2_last.get(path)
        while s2_dec.get(path, 0) < src_t - (0.5 / src_fps):
            ok, frame = cap.read()
            if not ok:
                break
            s2_last[path] = frame
            s2_dec[path] = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
        return s2_last.get(path)

    tmp_dir = os.path.dirname(out_path)
    silent_video_path = os.path.join(tmp_dir, "_export_silent.mp4")
    audio_path = os.path.join(tmp_dir, "_export_audio.wav")

    codec_name = "libx265" if codec == "h265" else "libx264"
    ffmpeg_cmd = [
        FFMPEG, "-y",
        "-f", "rawvideo", "-vcodec", "rawvideo",
        "-s", f"{out_w}x{out_h}", "-pix_fmt", "bgr24",
        "-r", str(out_fps),
        "-i", "-",
        "-an", "-vcodec", codec_name, "-crf", str(crf), "-preset", x_preset,
        "-pix_fmt", "yuv420p",
        silent_video_path,
    ]
    proc = subprocess.Popen(ffmpeg_cmd, stdin=subprocess.PIPE)

    total_frames = int(total_duration * out_fps)
    frame_i = 0
    t = 0.0
    dt = 1.0 / out_fps

    while t < total_duration:
        clip = find_active_clip(video_clips, t)
        if clip:
            src_t = clip_source_time(clip, t)
            frame = get_frame_at(src_t)
            if frame is None:
                frame = np.zeros((720, 1280, 3), dtype=np.uint8)
            source_t_for_caption = src_t
        else:
            frame = None
            source_t_for_caption = None

        # ===== SHORTS CANVAS COMPOSE (compose_frame se pehle — preview jaisa) =====
        # frame None (gap) ho to pichhla frame reuse (blur bg ke liye), warna black.
        if shorts_enabled:
            sc_src = frame if frame is not None else last_frame[0]
            if sc_src is None:
                sc_src = np.zeros((720, 1280, 3), dtype=np.uint8)
            out_frame = apply_shorts_canvas_frame(
                sc_src, shorts, out_w, out_h, src_fps,
                _sc_blur_cache,
            )
        else:
            segment = find_active_segment(segments, t)
            if frame is not None:
                out_frame = compose_frame(frame, segment, out_w, out_h)
            else:
                out_frame = np.zeros((out_h, out_w, 3), dtype=np.uint8)

        # ===== SPOTLIGHT MULTI-SCREEN BURN-IN =====
        # Spotlight segment (chahe S1 ya legacy S2-segments mein ho) ke screens
        # S2 source-frame se bana kar bake hote hain. S2 frame LAZY decode hota
        # hai — sirf jab koi screen actually render hogi (bina spotlight ke
        # export par koi S2 decoder overhead nahi).
        spot_seg = find_active_segment(segments, t)
        if not (spot_seg and spot_seg.get("mode") == "spotlight") and stack2_segments:
            cand = find_active_segment(stack2_segments, t)
            if cand and cand.get("mode") == "spotlight":
                spot_seg = cand
        if spot_seg and spot_seg.get("mode") == "spotlight":
            # USER MODEL: screens MAIN video (16:9 frame) se crop hoti hain —
            # get_s2_frame() ab wahi current source-frame deta hai (koi S2
            # decoder nahi — zero extra decode overhead).
            def get_s2_frame():
                return frame if frame is not None else last_frame[0]

            s2_path = source_path

            s2_dim_cap = s2_capture_for(s2_path)
            s2_w_px = int(s2_dim_cap.get(cv2.CAP_PROP_FRAME_WIDTH)) if s2_dim_cap else None
            s2_h_px = int(s2_dim_cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) if s2_dim_cap else None

            out_frame = compose_spotlight_screens(out_frame, spot_seg, get_s2_frame, source_path, out_w, out_h, s2_w=s2_w_px, s2_h=s2_h_px, s2_path=s2_path)

        # COLOR GRADE burn-in — pehle SPAN (layer-based), warna global (legacy).
        # captions hamesha grade-unaffected rehti hain (grade pehle lagta hai).
        g_span = find_active_grade_span(grade_spans, t) if grade_spans else None
        if g_span:
            g = g_span.get("grade")
        else:
            # (USER FIX) grade-layers exist → unke BAHAR koi grade nahi.
            # Purana global-fallback yahan saved colorGrade (panel ka last edit)
            # poore frame par burn karta tha — wahi frontend bug ka mirror.
            g = None if grade_spans else grade
        if g:
            out_frame = grade_frame(out_frame, g)

        if caption_cues and source_t_for_caption is not None:
            cue = find_active_caption(caption_cues, source_t_for_caption)
            if cue:
                # CAPTIONS LAYER: jitna span, utne params (style/position/size per-piece)
                c_span = find_active_caption_span(caption_spans, t) if caption_spans else None
                if c_span:
                    c_style = c_span.get("style") or caption_style
                    c_pos = c_span.get("position") or caption_position
                    c_scale = caption_font_scale if c_span.get("fontScale") is None else float(c_span["fontScale"])
                    c_over = c_span.get("overrides") if c_span.get("overrides") is not None else caption_overrides
                else:
                    c_style, c_pos, c_scale, c_over = caption_style, caption_position, caption_font_scale, caption_overrides
                out_frame = draw_captions(out_frame, cue, source_t_for_caption, c_style, c_pos, c_scale, out_w, out_h, c_over, all_cues=caption_cues if c_style in ("myCaption4", "myCaption6") else None)

        # TRANSITION burn-in (output-window level — captions ke baad, preview jaisa)
        if transitions:
            tr = find_active_transition(transitions, t)
            if tr:
                seg_now = find_active_segment(segments, t)
                out_frame = apply_transition_frame(
                    out_frame, tr, t, out_w, out_h, video_clips, seg_now,
                    lambda st: get_frame_at_s2(st, source_path),
                )

        # TITLES burn-in (9:16 headings — captions ke baad, trans/pz-transforms
        # se PEHLE — titles par panzoom-apply NAHI hota jaisa frontend-in-mirror)
        if titles_spans:
            ttl = find_active_title(titles_spans, t)
            if ttl:
                out_frame = draw_titles(out_frame, ttl, t, titles_cues, source_t_for_caption, out_w, out_h)

        # CROP AND ZOOM (Pan & Zoom) burn-in (sab se aakhir — output-window zoom)
        if pan_zoom_spans:
            pz = find_active_panzoom(pan_zoom_spans, t)
            if pz:
                out_frame = apply_panzoom_frame(out_frame, pz, t)

        proc.stdin.write(out_frame.tobytes())

        frame_i += 1
        t += dt
        if progress_cb and total_frames > 0 and frame_i % 10 == 0:
            progress_cb(min(0.85, frame_i / total_frames))

    proc.stdin.close()
    proc.wait()
    cap.release()
    for c in s2_caps.values():
        if c is not None:
            c.release()
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg video-encode fail (rc={proc.returncode})")

    if progress_cb:
        progress_cb(0.88)
    build_audio(source_path, video_clips, audio_lanes, total_duration, audio_path, stack2_video_clips, stack2_audio_lanes)

    if progress_cb:
        progress_cb(0.95)
    mux_cmd = [
        FFMPEG, "-y",
        "-i", silent_video_path, "-i", audio_path,
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-shortest",
        out_path,
    ]
    mux = subprocess.run(mux_cmd, capture_output=True, text=True)
    if mux.returncode != 0 or not os.path.exists(out_path):
        # fail ho to temp files KAINTO mat karo — debug ke liye kaam aati hain
        raise RuntimeError(f"ffmpeg mux fail (rc={mux.returncode}): {(mux.stderr or '')[-600:]}")

    for p in (silent_video_path, audio_path):
        if os.path.exists(p):
            os.remove(p)

    if progress_cb:
        progress_cb(1.0)

    return out_path
```

### Name: backend/ffmpeg_engine.py
```python
import subprocess
import os

from ffmpeg_path import get_ffmpeg

FFMPEG = get_ffmpeg()


def generate_thumbnails(video_path, cache_dir, video_id, duration, count=12):
    thumb_names = []
    for i in range(count):
        t = max(0, (duration * i) / count)
        thumb_name = f"{video_id}_thumb_{i}.jpg"
        out_path = os.path.join(cache_dir, thumb_name)

        if not os.path.exists(out_path):
            cmd = [
                FFMPEG, "-y",
                "-ss", str(t),
                "-i", video_path,
                "-frames:v", "1",
                "-vf", "scale=160:-1",
                out_path
            ]
            subprocess.run(cmd, capture_output=True)

        thumb_names.append(thumb_name)
    return thumb_names


def generate_waveform(video_path, cache_dir, video_id, width=2000, height=120):
    waveform_name = f"{video_id}_waveform.png"
    out_path = os.path.join(cache_dir, waveform_name)

    if not os.path.exists(out_path):
        cmd = [
            FFMPEG, "-y",
            "-i", video_path,
            "-filter_complex",
            f"showwavespic=s={width}x{height}:colors=0d6efd",
            "-frames:v", "1",
            out_path
        ]
        subprocess.run(cmd, capture_output=True)

    return waveform_name
```

### Name: backend/ffmpeg_path.py
```python
"""
ffmpeg_path.py
--------------
FFmpeg ka path resolve karta hai — do jagah dekhta hai (is order mein):

1. PROJECT-LOCAL:  <project>/ffmpeg/ffmpeg.exe   (portable copy — install nahi chahiye)
2. SYSTEM PATH:    winget/installer se installed ffmpeg

Yeh isliye hai ke doosre PC par app chalane ke liye ab sirf project-folder
copy kafi hai: ffmpeg.exe ko project ke `ffmpeg/` folder mein daal do —
system-wide install ki zaroorat nahi. (App pehle local copy ko prefer karti hai.)
"""

import os
import shutil

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL_FFMPEG_DIR = _PROJECT_ROOT  # ffmpeg.exe yahan rakho: <project>/ffmpeg/ffmpeg.exe

_cached_ffmpeg = None
_searched = False


def get_ffmpeg():
    """ffmpeg executable ka best path return karta hai (result cached)."""
    global _cached_ffmpeg, _searched
    if _searched:
        return _cached_ffmpeg
    _searched = True

    # 1) project-local portable copy: <project>/ffmpeg/ffmpeg.exe
    local = os.path.join(LOCAL_FFMPEG_DIR, "ffmpeg", "ffmpeg.exe")
    if os.path.isfile(local):
        _cached_ffmpeg = local
        return _cached_ffmpeg

    # non-Windows dev-machine fallback
    local_nix = os.path.join(LOCAL_FFMPEG_DIR, "ffmpeg", "ffmpeg")
    if os.path.isfile(local_nix):
        _cached_ffmpeg = local_nix
        return _cached_ffmpeg

    # 2) system PATH
    _cached_ffmpeg = shutil.which("ffmpeg")
    if _cached_ffmpeg is None:
        print(
            "[ffmpeg] WARNING: ffmpeg NAHI mila!\n"
            "  Hal (koi ek):\n"
            "  a) winget install Gyan.FFmpeg   (system install)\n"
            f"  b) ffmpeg.exe + ffprobe.exe ko is folder mein copy kar do: {os.path.join(LOCAL_FFMPEG_DIR, 'ffmpeg')}"
        )
    return _cached_ffmpeg


def get_ffprobe():
    """ffprobe ka path — ffmpeg ke sath hi hota hai (same bin folder)."""
    ff = get_ffmpeg()
    if ff:
        sibling = os.path.join(os.path.dirname(ff), "ffprobe.exe")
        if os.path.isfile(sibling):
            return sibling
        sibling_nix = os.path.join(os.path.dirname(ff), "ffprobe")
        if os.path.isfile(sibling_nix):
            return sibling_nix
    # project-local ffmpeg folder (agar ffmpeg PATH mein ho lekin hum
    # phir bhi local ffprobe prefer karein)
    local = os.path.join(LOCAL_FFMPEG_DIR, "ffmpeg", "ffprobe.exe")
    if os.path.isfile(local):
        return local
    return shutil.which("ffprobe")
```

### Name: backend/main.py
```python
from fastapi import FastAPI, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, Response
import os, subprocess, json, uuid, threading, time, sys

from captions_engine import transcribe_words

from ffmpeg_engine import generate_thumbnails, generate_waveform
from silence_engine import detect_silence_and_fillers
from captions_engine import generate_caption_cues, build_subtitles_lines
from export_engine import render_export
from ffmpeg_path import get_ffprobe

app = FastAPI()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(os.path.dirname(BASE_DIR), "frontend")
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
CACHE_DIR = os.path.join(BASE_DIR, "cache")
DATA_DIR = os.path.join(BASE_DIR, "data")
EXPORTS_DIR = os.path.join(BASE_DIR, "exports")
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(CACHE_DIR, exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(EXPORTS_DIR, exist_ok=True)


# ===== UPLOADS AUTO-CLEANUP =====
# FIX: har uploaded video uploads/ mein permanent save ho rahi thi, jis se disk
# bhar jati thi. Ab uploads SESSION-only hain: app start hote hi pichle session
# ki sari uploads delete ho jati hain (crash-safe recovery), aur app band hone
# par current session ki uploads bhi khud delete ho jati hain (launcher.py).
# Video processing ke liye file session ke dauran disk par rehti hai — ye
# zaroori hai (thumbnails, waveform, silence-detection, export sab isi se).
def _remove_orphan_session_files():
    """uploads/ mein jo videos bachi hain unke elawa baaki sab session-artifacts
    (timeline-data JSON + thumbnails/waveform cache) delete kar deta hai."""
    known_ids = {
        os.path.splitext(f)[0]
        for f in os.listdir(UPLOAD_DIR)
        if os.path.isfile(os.path.join(UPLOAD_DIR, f))
    }
    # timeline-data orphans
    for name in os.listdir(DATA_DIR):
        if name.endswith("_timeline.json") and os.path.splitext(name)[0] not in known_ids:
            try:
                os.remove(os.path.join(DATA_DIR, name))
            except OSError:
                pass
    # cache orphans (thumbs + waveform)
    for name in os.listdir(CACHE_DIR):
        vid = name.split("_thumb_")[0].split("_waveform")[0]
        if vid not in known_ids:
            try:
                os.remove(os.path.join(CACHE_DIR, name))
            except OSError:
                pass


def cleanup_uploads_on_startup():
    """Pichle session ki uploads + unki timeline-data/caches saaf karo.
    App crash ho jaye to bhi agle start par sab saaf ho jata hai."""
    removed = 0
    for name in os.listdir(UPLOAD_DIR):
        p = os.path.join(UPLOAD_DIR, name)
        if os.path.isfile(p):
            try:
                os.remove(p)
                removed += 1
            except OSError:
                pass
    _remove_orphan_session_files()
    if removed:
        print(f"[cleanup] {removed} purani upload(s) delete ho gayi (session-reset)")


def cleanup_uploads_now():
    """App-close par call hota hai (launcher.py se): current session ki sari
    uploads + unka data delete karo."""
    for name in os.listdir(UPLOAD_DIR):
        p = os.path.join(UPLOAD_DIR, name)
        if os.path.isfile(p):
            try:
                os.remove(p)
            except OSError:
                pass
    _remove_orphan_session_files()


cleanup_uploads_on_startup()


def get_video_info(path):
    cmd = [
        get_ffprobe(), "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate",
        "-show_entries", "format=duration",
        "-of", "json", path
    ]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    data = json.loads(out)
    stream = data["streams"][0]
    duration = float(data["format"]["duration"])
    width, height = int(stream["width"]), int(stream["height"])
    num, den = stream["r_frame_rate"].split("/")
    fps = float(num) / float(den) if float(den) != 0 else 30.0
    return {"duration": duration, "width": width, "height": height, "fps": fps}


@app.post("/upload")
async def upload_video(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename)[1]
    video_id = uuid.uuid4().hex[:10]
    saved_name = f"{video_id}{ext}"
    saved_path = os.path.join(UPLOAD_DIR, saved_name)

    with open(saved_path, "wb") as f:
        content = await file.read()
        f.write(content)

    try:
        info = get_video_info(saved_path)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    return {
        "id": video_id,
        "original_name": file.filename,
        "saved_name": saved_name,
        "duration": info["duration"],
        "width": info["width"],
        "height": info["height"],
        "fps": info["fps"],
    }


@app.get("/video/{saved_name}")
def stream_video(saved_name: str):
    path = os.path.join(UPLOAD_DIR, saved_name)
    if not os.path.exists(path):
        return JSONResponse({"error": "Video not found"}, status_code=404)
    return FileResponse(path, media_type="video/mp4")


@app.get("/video/{saved_name}/timeline_assets")
def timeline_assets(saved_name: str):
    path = os.path.join(UPLOAD_DIR, saved_name)
    if not os.path.exists(path):
        return JSONResponse({"error": "Video not found"}, status_code=404)

    video_id = os.path.splitext(saved_name)[0]
    info = get_video_info(path)

    thumbs = generate_thumbnails(path, CACHE_DIR, video_id, info["duration"])
    waveform = generate_waveform(path, CACHE_DIR, video_id)

    return {
        "duration": info["duration"],
        "thumbnails": thumbs,
        "waveform": waveform,
    }


@app.get("/cache/{filename}")
def get_cache_file(filename: str):
    path = os.path.join(CACHE_DIR, filename)
    if not os.path.exists(path):
        return JSONResponse({"error": "File not found"}, status_code=404)
    return FileResponse(path)


# ===== TIMELINE DATA (segments + audio lanes) =====

def timeline_data_path(saved_name: str):
    video_id = os.path.splitext(saved_name)[0]
    return os.path.join(DATA_DIR, f"{video_id}_timeline.json")


@app.get("/video/{saved_name}/segments")
def get_timeline_data(saved_name: str):
    path = timeline_data_path(saved_name)
    if not os.path.exists(path):
        return {"segments": [], "audioLanes": [], "videoClips": [], "stack2VideoClips": [], "stack2AudioLanes": [], "stack2Segments": [], "stackCount": 1, "captionCues": [], "captionStyle": "hormozi", "captionsEnabled": True, "captionPosition": {"x": 0.5, "y": 0.86}, "captionFontScale": 1.0, "captionOverrides": None, "captionRemember": True}
    with open(path, "r") as f:
        data = json.load(f)
        data.setdefault("segments", [])
        data.setdefault("audioLanes", [])
        data.setdefault("videoClips", [])
        # STACK-2 (2-Stack Spotlight) defaults
        data.setdefault("stack2VideoClips", [])
        data.setdefault("stack2AudioLanes", [])
        data.setdefault("stack2Segments", [])
        data.setdefault("stackCount", 1)
        data.setdefault("colorGrade", None)
        data.setdefault("captionCues", [])
        data.setdefault("captionStyle", "hormozi")
        data.setdefault("captionsEnabled", True)
        data.setdefault("captionPosition", {"x": 0.5, "y": 0.86})
        data.setdefault("captionFontScale", 1.0)
        data.setdefault("captionOverrides", None)
        data.setdefault("captionRemember", True)
        # NAYE EFFECT-LAYERS (Captions / Transitions / PanZoom / Grade spans)
        data.setdefault("captionSpans", [])
        data.setdefault("transitions", [])
        data.setdefault("panZoomSpans", [])
        data.setdefault("gradeSpans", [])
        data.setdefault("shortsCanvas", None)
        # TITLES LAYER (9:16 heading-spans — caption-cues text-source ke sath)
        data.setdefault("titlesSpans", [])
        return data


@app.post("/video/{saved_name}/segments")
async def save_timeline_data(saved_name: str, payload: dict):
    path = timeline_data_path(saved_name)
    out = {
        "segments": payload.get("segments", []),
        "audioLanes": payload.get("audioLanes", []),
        "videoClips": payload.get("videoClips", []),
        # STACK-2 (2-Stack Spotlight) state bhi persist
        "stack2VideoClips": payload.get("stack2VideoClips", []),
        "stack2AudioLanes": payload.get("stack2AudioLanes", []),
        "stack2Segments": payload.get("stack2Segments", []),
        "stackCount": payload.get("stackCount", 1),
        # COLOR GRADE (global)
        "colorGrade": payload.get("colorGrade"),
        "captionCues": payload.get("captionCues", []),
        "captionStyle": payload.get("captionStyle", "hormozi"),
        "captionsEnabled": payload.get("captionsEnabled", True),
        "captionPosition": payload.get("captionPosition", {"x": 0.5, "y": 0.86}),
        "captionFontScale": payload.get("captionFontScale", 1.0),
        "captionOverrides": payload.get("captionOverrides"),
        "captionRemember": payload.get("captionRemember", True),
        # NAYE EFFECT-LAYERS
        "captionSpans": payload.get("captionSpans", []),
        "transitions": payload.get("transitions", []),
        "panZoomSpans": payload.get("panZoomSpans", []),
        "gradeSpans": payload.get("gradeSpans", []),
        # TITLES LAYER (9:16 heading-spans)
        "titlesSpans": payload.get("titlesSpans", []),
        # SHORTS CANVAS settings
        "shortsCanvas": payload.get("shortsCanvas"),
    }
    with open(path, "w") as f:
        json.dump(out, f, indent=2)
    return {"status": "ok"}


# ===== SILENCE / FILLER-WORD DETECTION =====

@app.post("/video/{saved_name}/detect_silence")
async def detect_silence(saved_name: str):
    path = os.path.join(UPLOAD_DIR, saved_name)
    if not os.path.exists(path):
        return JSONResponse({"error": "Video not found"}, status_code=404)
    try:
        ranges = detect_silence_and_fillers(path)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    return {"ranges": ranges}


# ===== AUTO CAPTIONS (word-level, style-agnostic) =====

@app.post("/video/{saved_name}/generate_captions")
async def generate_captions(saved_name: str):
    path = os.path.join(UPLOAD_DIR, saved_name)
    if not os.path.exists(path):
        return JSONResponse({"error": "Video not found"}, status_code=404)
    try:
        video_id = os.path.splitext(saved_name)[0]
        cues = generate_caption_cues(path, cache_dir=DATA_DIR, video_id=video_id)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    return {"cues": cues}


# ===== TITLES: caption-cues REUSE (AUTO-CAPTIONS ka text-source — whisper
# dobara NAHI chalta; SRT/TXT jaisa hi transcript-cachePh id reuse hota hai).
# Ye sirf TEXT+TIMING deta hai — koi style/burn-in nahi (wo front/export)."""
@app.post("/video/{saved_name}/generate_titles")
async def generate_titles(saved_name: str):
    path = os.path.join(UPLOAD_DIR, saved_name)
    if not os.path.exists(path):
        return JSONResponse({"error": "Video not found"}, status_code=404)
    try:
        video_id = os.path.splitext(saved_name)[0]
        # caption-cues reuse — faster-whisper se SAME cue-frame-generation,
        # (whisper model DOBARA nahi chalega — _transcript.json-cache se load)
        cues = generate_caption_cues(path, cache_dir=DATA_DIR, video_id=video_id)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    return {"cues": cues}


# ===== SUBTITLES (SRT/TXT export ke liye lines + transcription CACHE) =====

def _subtitles_data_path(saved_name: str):
    video_id = os.path.splitext(saved_name)[0]
    return os.path.join(DATA_DIR, f"{video_id}_subtitles.json")


def _srt_timestamp(t: float) -> str:
    """seconds -> 'HH:MM:SS,mmm' (SRT standard)"""
    t = max(0.0, t)
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    ms = int(round((t - int(t)) * 1000))
    if ms >= 1000:
        ms = 999
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


@app.post("/video/{saved_name}/generate_subtitles")
async def generate_subtitles(saved_name: str):
    """Video ki transcription (CACHE se ya fresh whisper) se readable lines
    banata hai. Response mein cached flag — frontend user ko batata hai ke
    whisper dobara nahi chala (time save)."""
    path = os.path.join(UPLOAD_DIR, saved_name)
    if not os.path.exists(path):
        return JSONResponse({"error": "Video not found"}, status_code=404)

    spath = _subtitles_data_path(saved_name)
    # pehle PERSISTED subtitles-lines check (agar pehle generate ho chuki)
    if os.path.exists(spath):
        try:
            with open(spath, "r", encoding="utf-8") as f:
                lines = json.load(f)
            if isinstance(lines, list) and lines:
                return {"cues": lines, "cached": True}
        except Exception:
            pass

    try:
        video_id = os.path.splitext(saved_name)[0]
        words = transcribe_words(path, cache_dir=DATA_DIR, video_id=video_id)
        lines = build_subtitles_lines(words)
        if lines:
            with open(spath, "w", encoding="utf-8") as f:
                json.dump(lines, f, ensure_ascii=False)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    return {"cues": lines, "cached": False}


@app.get("/video/{saved_name}/subtitles_srt")
def download_subtitles_srt(saved_name: str):
    """SRT file (timestamps ke sath) — seedha download."""
    spath = _subtitles_data_path(saved_name)
    if not os.path.exists(spath):
        return JSONResponse({"error": "Pehle Subtitles generate karo"}, status_code=404)
    try:
        with open(spath, "r", encoding="utf-8") as f:
            lines = json.load(f)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

    out = []
    for i, ln in enumerate(lines, 1):
        out.append(f"{i}\n{_srt_timestamp(ln['start'])} --> {_srt_timestamp(ln['end'])}\n{ln['text']}\n")
    srt = "\n".join(out)
    base = saved_name.rsplit(".", 1)[0]
    return Response(
        content=srt, media_type="application/x-subrip",
        headers={"Content-Disposition": f'attachment; filename="{base}.srt"'},
    )


@app.get("/video/{saved_name}/subtitles_txt")
def download_subtitles_txt(saved_name: str):
    """TXT file — har line ke sath [MM:SS - MM:SS] timestamp (user choice)."""
    spath = _subtitles_data_path(saved_name)
    if not os.path.exists(spath):
        return JSONResponse({"error": "Pehle Subtitles generate karo"}, status_code=404)
    try:
        with open(spath, "r", encoding="utf-8") as f:
            lines = json.load(f)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

    def _short(t):
        t = max(0.0, t)
        return f"{int(t // 60):02d}:{int(t % 60):02d}"

    txt = "\n".join(f"[{_short(ln['start'])} - {_short(ln['end'])}] {ln['text']}" for ln in lines)
    base = saved_name.rsplit(".", 1)[0]
    return Response(
        content=txt, media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{base}.txt"'},
    )


# ===== SUBTITLES FILE EXPORT (SRT/TXT -> exports/ folder + Explorer reveal) =====
# FIX: WebView2 (pywebview) native window mein browser-style download (blob +
# a.click) KAM NAHI KARTA — video-export mein bhi isi wajah se download-link ke
# bajaye Explorer-reveal use hota hai. Ab SRT/TXT bhi wahi pattern: backend
# backend/exports/ mein file likhta hai aur Explorer khud khul kar file ko
# select kar ke dikhata hai.

def _safe_subtitle_filename(name: str, fallback: str) -> str:
    """original video-name ko Windows-safe file-base banao."""
    name = (name or "").strip()
    name = os.path.splitext(os.path.basename(name))[0]
    for ch in '<>:"/\\|?*':
        name = name.replace(ch, "_")
    name = name.strip().strip(".")
    if not name:
        name = fallback
    return name[:80]


@app.post("/video/{saved_name}/export_subtitles/{kind}")
async def export_subtitles_file(saved_name: str, kind: str, payload: dict = None):
    """SRT ya TXT file backend/exports/ mein likh kar Explorer mein reveal karo.
    kind: "srt" (HH:MM:SS,mmm timestamps) | "txt" ([MM:SS - MM:SS] per line)."""
    if kind not in ("srt", "txt"):
        return JSONResponse({"error": "kind 'srt' ya 'txt' hona chahiye"}, status_code=400)
    spath = _subtitles_data_path(saved_name)
    if not os.path.exists(spath):
        return JSONResponse({"error": "Pehle Subtitles generate karo"}, status_code=404)
    try:
        with open(spath, "r", encoding="utf-8") as f:
            lines = json.load(f)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

    payload = payload or {}
    original = str(payload.get("original_name") or saved_name)
    video_id = os.path.splitext(saved_name)[0]
    base = _safe_subtitle_filename(original, video_id)

    if kind == "srt":
        out_lines = []
        for i, ln in enumerate(lines, 1):
            out_lines.append(f"{i}\n{_srt_timestamp(ln['start'])} --> {_srt_timestamp(ln['end'])}\n{ln['text']}\n")
        content = "\n".join(out_lines)
        out_filename = f"{base}_subtitles.srt"
    else:
        def _short(t):
            t = max(0.0, t)
            return f"{int(t // 60):02d}:{int(t % 60):02d}"
        content = "\n".join(f"[{_short(ln['start'])} - {_short(ln['end'])}] {ln['text']}" for ln in lines)
        out_filename = f"{base}_subtitles.txt"

    out_path = os.path.join(EXPORTS_DIR, out_filename)
    try:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(content)
    except Exception as e:
        return JSONResponse({"error": f"File write fail: {e}"}, status_code=500)

    # wahi reveal jo video-export use karta hai (Explorer khul kar file select karta hai)
    reveal_in_explorer(out_path)
    return {"status": "ok", "filename": out_filename, "lines": len(lines)}


# ===== EXPORT (background job, taake UI freeze na ho) =====

export_jobs = {}  # job_id -> {progress: 0..1, status: "running"|"done"|"error", filename, error}


def reveal_in_explorer(path):
    """Export complete hone par OS ka file-explorer khol deta hai, file ko
    highlight/select kiya hua — is se download-link (jo pywebview ke native
    window mein reliably kaam nahi karta) ki zaroorat nahi rehti."""
    try:
        if sys.platform == "win32":
            subprocess.run(["explorer", "/select,", os.path.normpath(path)])
        elif sys.platform == "darwin":
            subprocess.run(["open", "-R", path])
        else:
            subprocess.run(["xdg-open", os.path.dirname(path)])
    except Exception:
        pass  # folder open na ho sake to bhi export ko fail nahi maana jayega


def resolve_s2_media_paths(timeline_state):
    """S2 clips jo ALAG file se aaye hain (media-bin drag-drop) unke liye
    uploads/ mein file dhoond kar clip["_path"] set karta hai — export_engine
    per-file decoder + audio-input isi se banata hai. Missing file par clip
    ko muted skip-safe rakha jata hai (bubble black-frame dikhayega)."""
    for c in timeline_state.get("stack2VideoClips", []):
        name = c.get("savedName")
        if name:
            p = os.path.join(UPLOAD_DIR, name)
            if os.path.exists(p):
                c["_path"] = p
    for a in timeline_state.get("stack2AudioLanes", []):
        name = a.get("savedName")
        if name:
            p = os.path.join(UPLOAD_DIR, name)
            if os.path.exists(p):
                a["_path"] = p


def run_export_job(job_id, source_path, timeline_state, quality, codec, out_path):
    def progress_cb(frac):
        export_jobs[job_id]["progress"] = frac

    try:
        render_export(source_path, timeline_state, quality, codec, progress_cb, out_path)
        export_jobs[job_id]["status"] = "done"
        export_jobs[job_id]["progress"] = 1.0
        reveal_in_explorer(out_path)
    except Exception as e:
        export_jobs[job_id]["status"] = "error"
        export_jobs[job_id]["error"] = str(e)


@app.post("/video/{saved_name}/export")
async def start_export(saved_name: str, payload: dict):
    source_path = os.path.join(UPLOAD_DIR, saved_name)
    if not os.path.exists(source_path):
        return JSONResponse({"error": "Video not found"}, status_code=404)

    timeline_state = get_timeline_data(saved_name)
    resolve_s2_media_paths(timeline_state)  # S2 alag-file clips ke _path

    quality = payload.get("quality", "720p")
    codec = payload.get("codec", "h264")
    if quality not in ("test", "720p", "1080p"):
        return JSONResponse({"error": "Invalid quality"}, status_code=400)

    job_id = uuid.uuid4().hex[:10]
    video_id = os.path.splitext(saved_name)[0]
    out_filename = f"{video_id}_{quality}_{job_id}.mp4"
    out_path = os.path.join(EXPORTS_DIR, out_filename)

    export_jobs[job_id] = {"progress": 0.0, "status": "running", "filename": out_filename, "error": None}

    thread = threading.Thread(
        target=run_export_job,
        args=(job_id, source_path, timeline_state, quality, codec, out_path),
        daemon=True,
    )
    thread.start()

    return {"job_id": job_id}


@app.get("/export_status/{job_id}")
def export_status(job_id: str):
    job = export_jobs.get(job_id)
    if not job:
        return JSONResponse({"error": "Job not found"}, status_code=404)
    return job


@app.get("/exports/{filename}")
def download_export(filename: str):
    path = os.path.join(EXPORTS_DIR, filename)
    if not os.path.exists(path):
        return JSONResponse({"error": "File not found"}, status_code=404)
    return FileResponse(path, media_type="video/mp4", filename=filename)


# ===== PROJECTS (Save / Load / Rename / Delete) =====
# Main folder ke andar 'projects/' ban-ta hai. Har project = ek folder:
#   projects/<name>/project.json          -> videos list + active video + saved_at
#   projects/<name>/media/<saved_name>    -> video ki SAFE COPY (uploads session-only hain,
#                                            isliye project save par media copy zaroori hai)
#   projects/<name>/media/<id>_timeline.json -> us video ka poora timeline state
# Restore par media wapis uploads/ mein copy hoti hai (same saved_name, taake
# timeline-data aur cache links bane rahein).
PROJECTS_DIR = os.path.join(os.path.dirname(BASE_DIR), "projects")
os.makedirs(PROJECTS_DIR, exist_ok=True)


def _safe_project_name(name: str) -> str:
    name = (name or "").strip()
    if not name or name in (".", ".."):
        raise ValueError("Project name invalid hai")
    for ch in '<>:"/\\|?*':
        name = name.replace(ch, "_")
    if len(name) > 80:
        name = name[:80]
    return name


def _project_dir(name: str) -> str:
    name = _safe_project_name(name)
    path = os.path.join(PROJECTS_DIR, name)
    # path-traversal guard
    if os.path.dirname(os.path.abspath(path)) != os.path.abspath(PROJECTS_DIR):
        raise ValueError("Project name invalid hai")
    return path


@app.get("/projects")
def list_projects():
    out = []
    if os.path.isdir(PROJECTS_DIR):
        for name in sorted(os.listdir(PROJECTS_DIR)):
            pdir = os.path.join(PROJECTS_DIR, name)
            meta_path = os.path.join(pdir, "project.json")
            if not os.path.isfile(meta_path):
                continue
            try:
                with open(meta_path, "r") as f:
                    meta = json.load(f)
                out.append({
                    "name": name,
                    "saved_at": meta.get("saved_at", ""),
                    "video_count": len(meta.get("videos", [])),
                })
            except Exception:
                continue
    return {"projects": out}


@app.post("/projects/{name}/save")
async def save_project(name: str, payload: dict):
    try:
        pdir = _project_dir(name)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    media_dir = os.path.join(pdir, "media")
    os.makedirs(media_dir, exist_ok=True)

    videos_in = payload.get("videos", []) or []
    videos_out = []
    import shutil
    for v in videos_in:
        saved_name = os.path.basename(str(v.get("saved_name", "")))
        src = os.path.join(UPLOAD_DIR, saved_name)
        if not saved_name or not os.path.isfile(src):
            continue
        dst = os.path.join(media_dir, saved_name)
        try:
            shutil.copy2(src, dst)
        except Exception as e:
            return JSONResponse({"error": f"Media copy fail: {e}"}, status_code=500)

        video_id = os.path.splitext(saved_name)[0]
        # timeline state copy (agar session mein bana hai)
        tl_src = os.path.join(DATA_DIR, f"{video_id}_timeline.json")
        if os.path.isfile(tl_src):
            try:
                shutil.copy2(tl_src, os.path.join(media_dir, f"{video_id}_timeline.json"))
            except Exception:
                pass

        videos_out.append({
            "original_name": v.get("original_name", saved_name),
            "saved_name": saved_name,
            "duration": v.get("duration"),
            "width": v.get("width"),
            "height": v.get("height"),
            "fps": v.get("fps"),
        })

    if not videos_out:
        # khali project bhi allowed hai (sirf start kya hoga), par error nahi
        pass

    meta = {
        "version": 1,
        "saved_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "active_saved_name": payload.get("active_saved_name"),
        "videos": videos_out,
    }
    with open(os.path.join(pdir, "project.json"), "w") as f:
        json.dump(meta, f, indent=2)

    return {"status": "ok", "name": os.path.basename(pdir), "videos": len(videos_out)}


@app.get("/projects/{name}")
def get_project(name: str):
    try:
        pdir = _project_dir(name)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    meta_path = os.path.join(pdir, "project.json")
    if not os.path.isfile(meta_path):
        return JSONResponse({"error": "Project not found"}, status_code=404)
    with open(meta_path, "r") as f:
        meta = json.load(f)
    return meta


@app.post("/projects/{name}/restore")
async def restore_project(name: str):
    """Project ki media wapis session (uploads/) mein copy karo — same saved_name,
    taake timeline-data + thumbnails/waveform cache bhi sath restore ho sakein."""
    try:
        pdir = _project_dir(name)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    meta_path = os.path.join(pdir, "project.json")
    if not os.path.isfile(meta_path):
        return JSONResponse({"error": "Project not found"}, status_code=404)

    with open(meta_path, "r") as f:
        meta = json.load(f)

    media_dir = os.path.join(pdir, "media")
    import shutil
    restored = []
    for v in meta.get("videos", []):
        saved_name = os.path.basename(str(v.get("saved_name", "")))
        src = os.path.join(media_dir, saved_name)
        if not saved_name or not os.path.isfile(src):
            continue
        dst = os.path.join(UPLOAD_DIR, saved_name)
        if not os.path.isfile(dst):
            try:
                shutil.copy2(src, dst)
            except Exception:
                continue

        video_id = os.path.splitext(saved_name)[0]
        # timeline state wapis
        tl_src = os.path.join(media_dir, f"{video_id}_timeline.json")
        if os.path.isfile(tl_src):
            try:
                shutil.copy2(tl_src, os.path.join(DATA_DIR, f"{video_id}_timeline.json"))
            except Exception:
                pass
        # cache (thumbs/waveform) wapis — warna regenerate hoga (slow but works)
        for cname in os.listdir(media_dir):
            if cname.startswith(video_id + "_") and not cname.endswith("_timeline.json"):
                try:
                    shutil.copy2(os.path.join(media_dir, cname), os.path.join(CACHE_DIR, cname))
                except Exception:
                    pass

        restored.append(v)

    return {"status": "ok", "videos": restored, "active_saved_name": meta.get("active_saved_name")}


@app.post("/projects/{name}/rename")
async def rename_project(name: str, payload: dict):
    try:
        pdir = _project_dir(name)
        new_dir = _project_dir(payload.get("new_name", ""))
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    if not os.path.isdir(pdir):
        return JSONResponse({"error": "Project not found"}, status_code=404)
    if os.path.isdir(new_dir) and os.path.abspath(new_dir) != os.path.abspath(pdir):
        return JSONResponse({"error": "Is naam ka project pehle se mojood hai"}, status_code=400)
    import shutil
    try:
        os.rename(pdir, new_dir)
    except OSError as e:
        # Windows par rename across same dir fail nahi hota, par fallback rakho
        try:
            shutil.copytree(pdir, new_dir)
            shutil.rmtree(pdir)
        except Exception as e2:
            return JSONResponse({"error": f"Rename fail: {e2}"}, status_code=500)
    return {"status": "ok", "name": os.path.basename(new_dir)}


@app.delete("/projects/{name}")
def delete_project(name: str):
    try:
        pdir = _project_dir(name)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    if not os.path.isdir(pdir):
        return JSONResponse({"error": "Project not found"}, status_code=404)
    import shutil
    shutil.rmtree(pdir)
    return {"status": "ok"}


# (FIX) JS/CSS/HTML par NO-CACHE — WebView2 heuristic-caching stale files
# serve karta tha (user ka fix reload par bhi purana JS chal sakta tha).
class NoCacheStatic(StaticFiles):
    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        path = str(getattr(resp, "path", ""))
        if path.endswith((".js", ".css", ".html")):
            resp.headers["Cache-Control"] = "no-cache, must-revalidate"
        return resp


app.mount("/", NoCacheStatic(directory=FRONTEND_DIR, html=True), name="frontend")
```

### Name: backend/silence_engine.py
```python
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
```

### Name: frontend/app.js
```js
const fileInput = document.getElementById("fileInput");
const videoList = document.getElementById("videoList");
const mainPlayer = document.getElementById("mainPlayer");
const videoInfo = document.getElementById("videoInfo");
const playPauseBtn = document.getElementById("playPauseBtn");

let uploadedVideos = [];

fileInput.addEventListener("change", async (e) => {
    const files = Array.from(e.target.files);
    for (const file of files) {
        await uploadVideo(file);
    }
});

async function uploadVideo(file) {
    const formData = new FormData();
    formData.append("file", file);

    try {
        const res = await fetch("/upload", {
            method: "POST",
            body: formData,
        });
        const data = await res.json();

        if (data.error) {
            alert("Upload failed: " + data.error);
            return;
        }

        uploadedVideos.push(data);
        renderVideoList();
    } catch (err) {
        alert("Upload error: " + err);
    }
}

function renderVideoList() {
    videoList.innerHTML = "";
    uploadedVideos.forEach((v) => {
        const item = document.createElement("div");
        item.className = "video-item";
        item.textContent = v.original_name;
        item.draggable = true;

        item.addEventListener("click", () => selectVideo(v));

        item.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("text/plain", v.saved_name);
            // S2 DROP: stack-2 ki Video row apni ALAG file ke liye ye format check karti hai
            try { e.dataTransfer.setData("application/x-reframe-video", v.saved_name); } catch (err) {}
        });

        videoList.appendChild(item);
    });
}

async function selectVideo(v) {
    mainPlayer.src = `/video/${v.saved_name}`;
    videoInfo.textContent = `${v.original_name} | ${v.width}x${v.height} | ${v.duration.toFixed(1)}s | ${v.fps.toFixed(1)} fps`;

    document.querySelectorAll(".video-item").forEach((el) => el.classList.remove("active"));
    const items = document.querySelectorAll(".video-item");
    uploadedVideos.forEach((vid, idx) => {
        if (vid.saved_name === v.saved_name) {
            items[idx].classList.add("active");
        }
    });

    await initTimeline(v);
    initCropEditor(mainPlayer);

    playPauseBtn.textContent = "▶";
}

// Play/Pause ab mainPlayer ko seedha control nahi karta — timeline.js ka virtual
// playback engine (startPlayback/pausePlayback) drive karta hai, jo videoClips /
// audioLanes arrays ke hisaab se decide karta hai kya dikhna/sunayi dena chahiye.
function togglePlay() {
    if (typeof isPlaying !== "undefined" && isPlaying) {
        pausePlayback();
        playPauseBtn.textContent = "▶";
    } else {
        startPlayback();
        playPauseBtn.textContent = "⏸";
    }
}

// global (keybindings.js Num5/Space aur stopPlayback use karte hain)
window.togglePlay = togglePlay;

playPauseBtn.addEventListener("click", togglePlay);

const mediaBin = document.getElementById("mediaBin");
const mediaBinToggle = document.getElementById("mediaBinToggle");

mediaBinToggle.addEventListener("click", () => {
    mediaBin.classList.toggle("collapsed");
    mediaBin.classList.toggle("expanded");

    // poora left-column bhi narrow ho jaye (warna khali 240px strip reh jati hai)
    const leftCol = document.querySelector(".left-column");
    if (leftCol) leftCol.classList.toggle("bin-collapsed", mediaBin.classList.contains("collapsed"));

    // FIX: media bin collapse/expand par Captions panel ko bhi saath fold karo —
    // pehle media bin to chhota ho jata tha lekin neeche wali Captions panel
    // khuli rehti thi (column ka sara space kha jati thi)
    const cp = document.getElementById("captionsPanel");
    const cpBody = document.getElementById("cpBody");
    const cpCollapse = document.getElementById("cpCollapse");
    if (mediaBin.classList.contains("collapsed")) {
        if (cp) cp.classList.add("cp-hidden");
        if (cpBody) cpBody.style.display = "none";
        if (cpCollapse) cpCollapse.textContent = "▸";
    } else {
        if (cp) cp.classList.remove("cp-hidden");
        if (cpBody) cpBody.style.display = "";
        if (cpCollapse) cpCollapse.textContent = "▾";
    }
});

const dropZone = document.querySelector(".center-column");

dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const savedName = e.dataTransfer.getData("text/plain");
    const video = uploadedVideos.find((v) => v.saved_name === savedName);
    if (video) {
        selectVideo(video);
    }
});

// ===== JUMP TO TIME (Start / End inputs neeche player ke) =====
// Accepts "mm:ss", "mm:ss.ms", ya sirf seconds jese "12.5"
function parseTimeInput(str) {
    if (!str) return null;
    str = str.trim();
    if (!str) return null;

    let seconds;
    if (str.includes(":")) {
        const parts = str.split(":");
        const mins = parseFloat(parts[0]) || 0;
        const secs = parseFloat(parts[1]) || 0;
        seconds = mins * 60 + secs;
    } else {
        seconds = parseFloat(str);
    }
    return isNaN(seconds) ? null : seconds;
}

function jumpToInputValue(inputEl) {
    const t = parseTimeInput(inputEl.value);
    if (t === null) return;
    const clamped = Math.max(0, Math.min(t, timelineDuration || t));
    seekToTime(clamped);
}

const jumpStartInput = document.getElementById("jumpStartInput");
const jumpEndInput = document.getElementById("jumpEndInput");
const jumpStartBtn = document.getElementById("jumpStartBtn");
const jumpEndBtn = document.getElementById("jumpEndBtn");

jumpStartBtn.addEventListener("click", () => jumpToInputValue(jumpStartInput));
jumpEndBtn.addEventListener("click", () => jumpToInputValue(jumpEndInput));

[jumpStartInput, jumpEndInput].forEach((inp) => {
    inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            jumpToInputValue(inp);
        }
    });
});
```

### Name: frontend/captions.js
```js
// ===== AUTO CAPTIONS =====
// Data (captionCues) SOURCE-time mein hai (backend jo deta hai). Render
// waqt hum current active-clip ke `sourceStart+offset` (window.__activeSourceTime,
// timeline.js set karta hai) use karte hain — isse agar video edited/trimmed ho
// chuki ho, ya us waqt koi clip active hi na ho (delete/gap), caption khud sahi
// jagah dikhega ya bilkul nahi dikhega.
//
// NAYA: styles ab 26 hain aur HAR EK ka APNA unique animation + color-
// highlighting hai (koi do styles ek jaise nahi). Animation primitives:
//   box (Hormozi), pop (MrBeast), rotPop (TikTok), glowPulse (Neon),
//   doubleBox (Podcast), lineBox (Bold Highlight), stamp (Big Pop),
//   fill (Karaoke Fill), underline (Minimal), none (Classic), popBounce
//   (Viral Yellow), boxBounce (Green Screen), glowSwap (Retro Wave), boxTilt
//   (Comic), shake (Gym Beast), tickerBar (News), fillSweep (Karaoke Wave),
//   underlineFloat (Soft Pastel), rgbCycle (Gaming RGB), slide (Ocean),
//   flash (Fire), boxRounded (Bubble Gum), strike (Mono Gray), outlineBox
//   (Banana Split), squash (Whisper Small).
// Backend (export_engine.py) ka draw_captions isi ka Python mirror hai —
// styles add/change karo to DONO taraf update karna hai.
// User ke paas COLOR overrides (text/active/highlight), size slider, "remember
// my settings" checkbox aur "reset to default" button bhi hain.

let captionCues = [];              // [{start, end, words:[{text,start,end}]}] — SOURCE time
let captionsEnabled = true;
let currentCaptionStyle = "hormozi";

// User ke color/size overrides — null = style ka apna default use karo
// DYNAMIC: ab har style ke APNE color-fields override ho sakte hain (jitne
// colors style me hain utne pickers panel me aate hain). Keys style ke property
// names hain (color/activeColor/highlightBg/glow/accentColor/neonPalette/...).
// Array fields (accentColors/neonPalette) per-swatch pickers hain.
let captionOverrides = { color: null, activeColor: null, highlightBg: null };
let captionRemember = true;        // "Remember my settings" checkbox

// ===== PER-STYLE COLOR FIELDS (dynamically panel me pickers banate hain) =====
// har entry: styleProp -> {label, list} — list=true to multi-swatch picker
// (array field). Jo fields HAAN style me mojood hain wohi pickers dikhengi —
// naya style banaye to sirf ye entry (agar custom label chahiye) add hoti hai.
const CAPTION_COLOR_FIELDS = [
    { prop: "color",       label: "Text",      list: false },
    { prop: "activeColor", label: "Active",   list: false },
    { prop: "highlightBg", label: "Highlight", list: false },
    { prop: "outline",      label: "Outline",   list: false },
    { prop: "glow",         label: "Glow",      list: false },
    { prop: "accentColor", label: "Keyword",   list: false },
    { prop: "accentColors", label: "Accent",    list: true, shortLabel: (n) => "Accent " + n },
    { prop: "neonPalette",  label: "Neon",      list: true, shortLabel: (n) => "Neon " + n },
];

// style object ke liye saare color-picker fields return karta hai (sirf wo jo
// style me mojood hain) — panel build + generic override resolve dono ise
// use karte hain.
function getStyleColorFields(styleObj) {
    return CAPTION_COLOR_FIELDS.filter((f) => {
        const v = styleObj[f.prop];
        if (f.list) return Array.isArray(v) && v.length > 0;
        return typeof v === "string" && v && (v.startsWith("#") || v.startsWith("rgb"));
    });
}

// ===== Position + Size (draggable/resizable — sirf 9:16 preview canvas par) =====
let captionPosition = { x: 0.5, y: 0.86 };  // normalized center-x, baseline-y (0-1)
let captionFontScale = 1.0;                  // size slider (0.4x - 3x)
let captionDragState = null;                 // { type: "move"|"resize", ... }
window.__captionBBox = null;                 // preview-canvas bbox (hit-testing ke liye)

// Har style sirf ek CONFIG hai — naya style banane ka matlab hai yahan
// ek naya entry add karna, kahin aur kuch chhedne ki zaroorat nahi.
const CAPTION_STYLES = {
    hormozi: {
        label: "Hormozi Style",
        fontWeight: "900",
        baseFontPx: 58,
        color: "#ffffff",
        activeColor: "#111111",
        highlightBg: "#ffd42a",
        outline: "#000000",
        animation: "box",
        uppercase: true,
    },
    mrbeast: {
        label: "MrBeast Style",
        fontWeight: "900",
        baseFontPx: 56,
        color: "#ffffff",
        activeColor: "#00ff33",
        highlightBg: null,
        outline: "#000000",
        outlineWidth: 5,
        animation: "pop",
        uppercase: true,
    },
    tiktokPop: {
        label: "TikTok Pop",
        fontWeight: "900",
        baseFontPx: 54,
        color: "#ffffff",
        activeColor: "#ff2d55",
        highlightBg: null,
        outline: "#000000",
        animation: "rotPop",   // active word alternate tilt + pop (left/right)
        uppercase: true,
    },
    neonGlow: {
        label: "Neon Glow",
        fontWeight: "800",
        baseFontPx: 52,
        color: "#eaffff",
        activeColor: "#00e5ff",
        highlightBg: null,
        outline: "#1b5e7a",
        glow: "#00e5ff",          // active word par neon shadow-glow
        animation: "glowPulse",   // glow ki intensity word-duration mein pulse
        uppercase: true,
    },
    podcastBold: {
        label: "Podcast Bold",
        fontWeight: "800",
        baseFontPx: 50,
        color: "#ffffff",
        activeColor: "#ffffff",
        highlightBg: "#e63946",
        outline: "#000000",
        animation: "doubleBox",  // red box + uske bahar white border
        uppercase: true,
    },
    boldHighlight: {
        label: "Bold Highlight",
        fontWeight: "800",
        baseFontPx: 54,
        color: "#ffffff",
        activeColor: "#111111",
        highlightBg: "#ffde59",
        outline: "#000000",
        animation: "lineBox",  // POORI line ke peeche ek box + active word black
        uppercase: true,
    },
    bigPop: {
        label: "Big Pop",
        fontWeight: "900",
        baseFontPx: 60,
        color: "#ffffff",
        activeColor: "#ffde59",
        highlightBg: null,
        outline: "#000000",
        animation: "stamp",   // rubber-stamp: active word BOHOT bara (1.35x)
        uppercase: true,
    },
    karaokeFill: {
        label: "Karaoke Fill",
        fontWeight: "700",
        baseFontPx: 48,
        color: "rgba(255,255,255,0.45)",
        activeColor: "#2fb8a6",
        highlightBg: null,
        outline: "#000000",
        animation: "fill",
        uppercase: false,
    },
    minimal: {
        label: "Minimal Clean",
        fontWeight: "500",
        baseFontPx: 42,
        color: "#ffffff",
        activeColor: "#2fb8a6",
        highlightBg: null,
        outline: null,
        animation: "underline",
        uppercase: false,
    },
    classic: {
        label: "Classic Subtitle",
        fontWeight: "400",
        baseFontPx: 44,
        color: "#ffffff",
        activeColor: "#ffffff",
        highlightBg: null,
        outline: "#000000",
        animation: "none",
        uppercase: false,
    },
    // ===== NAYE 16 STYLES (total 26) =====
    viralYellow: {
        label: "Viral Yellow",
        fontWeight: "900",
        baseFontPx: 60,
        color: "#ffffff",
        activeColor: "#ffe600",
        highlightBg: null,
        outline: "#000000",
        outlineWidth: 5,
        animation: "popBounce",  // pop + upar uchhalne wala bounce
        uppercase: true,
    },
    greenScreen: {
        label: "Green Screen",
        fontWeight: "900",
        baseFontPx: 54,
        color: "#00ff00",
        activeColor: "#ffffff",
        highlightBg: "#111111",
        outline: "#000000",
        outlineWidth: 2,
        animation: "boxBounce",  // box ke andar word bounce karta hai
        uppercase: true,
    },
    retroWave: {
        label: "Retro Wave",
        fontWeight: "800",
        baseFontPx: 52,
        color: "#ff71ce",
        activeColor: "#01cdfe",
        highlightBg: null,
        outline: "#28003c",
        glow: "#b967ff",
        glow2: "#01cdfe",       // har doosre word ka glow color badalta hai
        animation: "glowSwap",
        uppercase: true,
    },
    comicPop: {
        label: "Comic Pop",
        fontWeight: "900",
        baseFontPx: 56,
        color: "#ffffff",
        activeColor: "#ff2d55",
        highlightBg: "#ffde00",
        outline: "#000000",
        outlineWidth: 4,
        animation: "boxTilt",  // comic-style tilted highlight box
        uppercase: true,
    },
    gymBeast: {
        label: "Gym Beast",
        fontWeight: "900",
        baseFontPx: 62,
        color: "#ffffff",
        activeColor: "#ff3800",
        highlightBg: "#111111",
        outline: "#000000",
        outlineWidth: 5,
        animation: "shake",   // active word shor machata hua hilta hai
        uppercase: true,
    },
    newsTicker: {
        label: "News Ticker",
        fontWeight: "700",
        baseFontPx: 42,
        color: "#000000",
        activeColor: "#000000",
        highlightBg: "#ffffff",
        outline: "#ffffff",
        outlineWidth: 2,
        animation: "tickerBar",  // full-height ticker bar active word par
        uppercase: false,
    },
    karaokeWave: {
        label: "Karaoke Wave",
        fontWeight: "800",
        baseFontPx: 50,
        color: "rgba(255,255,255,0.45)",
        activeColor: "#00e5ff",
        highlightBg: null,
        outline: "#000000",
        animation: "fillSweep",  // word left->right PROGRESSIVELY fill hota hai
        uppercase: false,
    },
    softPastel: {
        label: "Soft Pastel",
        fontWeight: "600",
        baseFontPx: 46,
        color: "#ffd1dc",
        activeColor: "#ff8fab",
        highlightBg: null,
        outline: null,
        animation: "underlineFloat",  // bar ke sath word halka upar uthta hai
        uppercase: false,
    },
    gamingRgb: {
        label: "Gaming RGB",
        fontWeight: "900",
        baseFontPx: 54,
        color: "#39ff14",
        activeColor: "#ffffff",
        highlightBg: "#111111",
        outline: "#000000",
        outlineWidth: 3,
        activePalette: ["#ff2d55", "#ffe600", "#00e5ff", "#a855f7", "#39ff14"],  // har word ka apna rang
        animation: "rgbCycle",  // active word ka rang palette se cycle hota hai
        uppercase: true,
    },
    luxuryGold: {
        label: "Luxury Gold",
        fontWeight: "800",
        baseFontPx: 52,
        color: "#d4af37",
        activeColor: "#ffffff",
        highlightBg: null,
        outline: "#000000",
        glow: "#d4af37",
        animation: "glow",
        uppercase: true,
    },
    oceanBlue: {
        label: "Ocean Blue",
        fontWeight: "800",
        baseFontPx: 52,
        color: "#ffffff",
        activeColor: "#4cc9f0",
        highlightBg: null,
        outline: "#003049",
        outlineWidth: 4,
        animation: "slide",   // active word left se slide-in + fade
        uppercase: true,
    },
    fireRed: {
        label: "Fire Red",
        fontWeight: "900",
        baseFontPx: 58,
        color: "#ffffff",
        activeColor: "#ff4d00",
        highlightBg: null,
        outline: "#200000",
        outlineWidth: 4.5,
        animation: "flash",   // aag jaisi flash: word bolne ke sath intensity badle
        uppercase: true,
    },
    bubbleGum: {
        label: "Bubble Gum",
        fontWeight: "900",
        baseFontPx: 54,
        color: "#ffffff",
        activeColor: "#ffffff",
        highlightBg: "#ff5da2",
        outline: "#000000",
        outlineWidth: 3,
        animation: "boxRounded",  // gulabi rounded-pill highlight
        uppercase: true,
    },
    monoGray: {
        label: "Mono Gray",
        fontWeight: "600",
        baseFontPx: 46,
        color: "#d0d0d0",
        activeColor: "#ffffff",
        highlightBg: null,
        outline: "#333333",
        outlineWidth: 2,
        animation: "strike",  // active word par editorial strikethrough
        uppercase: false,
    },
    bananaSplit: {
        label: "Banana Split",
        fontWeight: "900",
        baseFontPx: 56,
        color: "#111111",
        activeColor: "#111111",
        highlightBg: "#ffe135",
        outline: "#000000",
        outlineWidth: 3,
        animation: "outlineBox",  // filled box nahi — thick yellow OUTLINE box
        uppercase: true,
    },
    whisperSmall: {
        label: "Whisper Small",
        fontWeight: "400",
        baseFontPx: 34,
        color: "#eeeeee",
        activeColor: "#ffffff",
        highlightBg: null,
        outline: "#000000",
        outlineWidth: 2,
        animation: "squash",  // active word halka squash + brighten (subtle)
        uppercase: false,
    },
    // ===== "MY CAPTION" STYLES (sample-video mirror: white words + active word
    // bright-yellow + golden glow + pop; sentence case, koi box/outline nahi) =====
    myCaption1: {
        label: "My Caption 1",
        fontWeight: "900",
        baseFontPx: 58,
        color: "#ffffff",
        activeColor: "#ffe200",
        highlightBg: null,
        outline: null,
        glow: "#ffd400",
        glowAll: true,          // HARB koil — sample video look
        animation: "glowPop",   // active: golden glow + pop-scale
        uppercase: false,
    },
    myCaption2: {
        label: "My Caption 2",
        fontWeight: "800",
        baseFontPx: 54,
        color: "rgba(255,255,255,0.78)",
        activeColor: "#ffdd00",
        highlightBg: null,
        outline: null,
        glow: "#ffe63e",
        glowAll: true,
        animation: "popFill",   // active: pop + white→yellow fill
        uppercase: false,
    },
    // ===== MY CAPTION 3 — sample-video ka EXACT look =====
    // 2-words-per-line multi-line wrap; KEY words (video/editor/work/business)
    // BADE + yellow + glow hote hain, filler words (are/you/a/for/looking)
    // chhote + white; active word par extra pop.
    myCaption3: {
        label: "My Caption 3",
        fontWeight: "900",
        baseFontPx: 56,
        color: "#ffffff",
        activeColor: "#ffe200",
        highlightBg: null,
        outline: null,
        glow: "#ffd400",
        glowAll: false,
        animation: "wrapBig",   // custom multi-line renderer (neeche wrapBig branch)
        uppercase: false,
    },
    // ===== MY CAPTION 4 — mussy-style sample ka EXACT look =====
    // SINGLE line; non-active words dim (~45% opacity), jo word bolne ka time
    // hai wo SMOOTH fade-up kar ke white hota hai; REPEATER keyword (1st/last
    // word rule neeche fadeCloud branch) BLUE; word ON hone par quick pop.
    myCaption4: {
        label: "My Caption 4",
        fontWeight: "800",
        baseFontPx: 62,
        color: "#ffffff",
        activeColor: "#ffffff",
        highlightBg: null,
        outline: null,
        glow: null,
        accentColor: "#2e8bff",     // keyword color (first/clipping/followers...)
        dimOpacity: 0.42,           // baaqi words kitne faded
        fadeUp: 14,                 // ON-word smooth float-up px
        animation: "fadeCloud",     // custom renderer (neeche fadeCloud branch)
        uppercase: true,
    },
    // ===== MY CAPTION 5 — mussy full-video ka EXACT look =====
    // per-pair REVEAL: unspoken pair dim, jo pair bolne wala hai wo ACCENT
    // color (keyword-cycle: blue/purple/green/red), bol-chuka pair solid
    // WHITE; max-2-word wrap (3+ words = 2 lines); accent word par slight
    // scale-up; poore block par soft black glow-shadow (readability).
    myCaption5: {
        label: "My Caption 5",
        fontWeight: "800",
        baseFontPx: 60,
        color: "#ffffff",
        activeColor: "#ffffff",      // bol-chuka pair yahi solid white hota hai
        highlightBg: null,
        outline: null,
        glow: null,
        accentColors: ["#33b1ff", "#a34bff", "#33cc55", "#ff2d28"],  // wireless aur HAR keyword-cycle agar bole
        dimOpacity: 0.55,            // upcoming pairs ghost-kitne faded
        fadeUp: 0,                   // ye style fade only (koi move nahi)
        animScale: 1.06,             // reveal par thoda bara hota hai
        animation: "fadeSplit",      // custom renderer (neeche fadeSplit branch)
        uppercase: true,
    },
    // ===== MY CAPTION 6 — mussy NEON multi-color sample mirror =====
    // CHUNKS: (1) har phrase 2-4 WHITE words + 1-3 COLORED words — pehle white
    // phir colored; (2) chunk ka NAYA color palette se, pichle ka repeat NAHI;
    // (3) WHITE words CHHOTE (~85%), COLORED words BARE (~118% — video me
    // FOLLOWERS / MONEY ONLINE NOWADAYS / NEVER BEEN EASIER sab colored-bare);
    // (4) line 1 ~57px, line 2 ~85% (tight stacked, centers-centered);
    // (5) word apni FINAL jagah par fade-in (blur+alpha, koi slide nahi).
    myCaption6: {
        label: "My Caption 6",
        fontWeight: "700",
        baseFontPx: 57,
        color: "#ffffff",
        activeColor: "#01cdfe",
        highlightBg: null,
        outline: null,
        glow: "#01cdfe",
        neonPalette: ["#2db4ff", "#4a8cff", "#ffc21a", "#ffe600", "#1fe6f2", "#ff3de0", "#ff5ad9", "#ff1c1c", "#4dff6a", "#b36bff"],  // video palette (10 colors)
        neonChunkMax: 3,           // colored chunk kabhi 3 se zyada nahi
        animScale: 1.04,           // reveal par soft punch
        line2Ratio: 0.85,          // line-2 ~85% of line-1 (video)
        lineGapRatio: 0.7,         // tight stacking
        emphasisRed: "#ff1010",   // EMPHASIS single-huge-word color
        animation: "neonChunks",   // custom renderer (neeche neonChunks branch)
        uppercase: true,
    },
};

// Style + user-overrides merge kar ke EFFECTIVE style deta hai
// GENERIC: ab sirf fixed 3 nahi — har style-prop (dynamic fields + purane 3)
// par user override apply hota hai. Array-override: user ne poora array set
// kiya (N swatches) to replace hota hai; warna style ka apna.
function getEffectiveCaptionStyle() {
    const base = CAPTION_STYLES[currentCaptionStyle] || CAPTION_STYLES.hormozi;
    const eff0 = { ...base };                          // style-scope (panel preview value ke liye)
    const fields = getStyleColorFields(eff0);
    // PURANE 3 fixed keys bhi saath me (backward-compat: koi naya style jisme
    // color/activeColor/highlightBg string nahi hai jaise rgba default — wo bhi)
    const eff = { ...base };
    fields.forEach((f) => {
        const ov = captionOverrides[f.prop];
        if (ov == null) return;
        if (f.list) {
            if (Array.isArray(ov) && ov.length) eff[f.prop] = ov.slice();
        } else {
            eff[f.prop] = ov;
        }
    });
    // legacy flat keys (back-compat jo pehle se the):
    if (captionOverrides.color) eff.color = captionOverrides.color;
    if (captionOverrides.activeColor) eff.activeColor = captionOverrides.activeColor;
    if (captionOverrides.highlightBg !== null && captionOverrides.highlightBg !== undefined) {
        eff.highlightBg = captionOverrides.highlightBg;
    }
    return eff;
}

// Panel preview-value resolve (disabled-picker me style ka current color dikhane
// ke liye): string-color ya list-swatch at index n.
function _getPreviewColor(eff, f, idx) {
    const v = eff[f.prop];
    if (f.list) {
        if (!Array.isArray(v) || !v.length) return "#ffffff";
        return (v[idx != null ? idx : 0]) || "#ffffff";
    }
    const s = typeof v === "string" ? v : "#ffffff";
    // rgba(255,255,255,0.45) jaisa non-hex color — picker sirf readable hex dikhata hai
    if (s.startsWith("rgba") || s.startsWith("rgb")) {
        const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) return "#" + [m[1], m[2], m[3]].map((c) => parseInt(c, 10).toString(16).padStart(2, "0")).join("");
    }
    return s.startsWith("#") ? s : "#ffffff";
}

function getActiveCaptionCue() {
    if (!captionsEnabled || !captionCues.length) return null;
    const srcT = window.__activeSourceTime;
    if (srcT == null || srcT === undefined) return null;
    return captionCues.find((c) => srcT >= c.start && srcT < c.end) || null;
}

// rectX/rectY/rectW/rectH = us canvas ke andar video-frame ka area.
// isPreview = true jab preview-canvas (final 9:16 output) par draw ho raha ho.
function drawCaptionsOnCanvas(ctx, rectX, rectY, rectW, rectH, refHeightPx, isPreview) {
    const cue = getActiveCaptionCue();
    if (!cue) {
        if (isPreview) window.__captionBBox = null;
        return;
    }
    // DEFENSIVE: purane persisted state se cue aaye jis mein words hi na hon
    // (ya koi word adhoora ho) — pehle yahan seedha .map crash karta tha aur
    // render loop maar jata tha (dono canvas blank). Ab aise cues skip hote hain.
    if (!cue.words || !cue.words.length || cue.words.some((w) => !w || typeof w.text !== "string")) {
        if (isPreview) window.__captionBBox = null;
        return;
    }

    const style = getEffectiveCaptionStyle();
    const srcT = window.__activeSourceTime;
    const scale = rectH / (refHeightPx || 1080);
    // (MC6 FIX) baseFontPx per-style hota hai — jab tak style me "baseFontPx"
    // nahi hai (legacy callers), hormozi default 58 use karo.
    const fontBasePx = ((style.baseFontPx != null) ? style.baseFontPx : 58);
    const fontSize = Math.max(10, fontBasePx * scale * captionFontScale);

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${style.fontWeight} ${fontSize}px Arial, sans-serif`;

    const words = cue.words.map((w) => (style.uppercase ? w.text.toUpperCase() : w.text));
    const gap = 10 * scale;
    const widths = words.map((w) => ctx.measureText(w).width);
    const totalWidth = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, words.length - 1);

    // agar line canvas se chauri hai, font ko itna shrink karo ke fit ho jaye
    let fitScale = 1;
    if (totalWidth > rectW * 0.92) fitScale = (rectW * 0.92) / totalWidth;
    if (fitScale < 1) {
        ctx.font = `${style.fontWeight} ${fontSize * fitScale}px Arial, sans-serif`;
        for (let i = 0; i < words.length; i++) widths[i] = ctx.measureText(words[i]).width;
    }
    const finalGap = gap * fitScale;
    const finalTotalWidth = widths.reduce((a, b) => a + b, 0) + finalGap * Math.max(0, words.length - 1);
    const finalFontSize = fontSize * fitScale;

    const cxBase = rectX + rectW * captionPosition.x;

    // ===== "My Caption 6" — neonChunks renderer (mussy NEON video mirror) =====
    // PHRASE-CHUNKING: 2-4 white words + 1-3 colored (NEON) words — har colored
    // chunk ko palette se RANDOM lega DIFFERENT color (pichle color repeat nahi,
    // deterministic seed = cue-index). 2 lines: L1 ~57px (y=52%), L2 ~85% (y=58%)
    // tight stacked (~0.7 lh). Layout PRE-COMPUTED & centered — har word apni
    // FINAL jagah par fade-in hota hai (alpha+blur in, koi slide/bounce nahi).
    // Word reveal ~100ms. NEON = glow same color (6px + 14px @60%) + dark strip.
    // EMPHASIS 1-word: huge + RED + scale-punch 1.3->1 (sirf AGAR cue ka 1 hi
    // word ho aur wo 15+ sec per 1x ho — heuristically: cue.length==1).
    if (style.animation === "neonChunks") {
        const cx6 = rectX + rectW * captionPosition.x;
        // DRAG-FOLLOW: lines captionPosition.y se derive — default pos.y=.86
        // par L1=52% / L2=58% (video), drag par poora block saath move hota hai.
        const clamp01 = (v) => Math.min(0.98, Math.max(0.02, v));
        const yL1 = rectY + rectH * clamp01(captionPosition.y - 0.34);
        const yLine1 = yL1;
        const yLine2 = yL1 + rectH * 0.06;
        const ySingle = rectY + rectH * clamp01(captionPosition.y - 0.31);
        const pal = (style.neonPalette && style.neonPalette.length) ? style.neonPalette : ["#2db4ff"];
        const fs1 = fontBasePx * scale * captionFontScale;
        const fs2 = fs1 * ((style.line2Ratio != null) ? style.line2Ratio : 0.85);

        // --- cue INDEX (deterministic seed — random-color per-chunk) ---
        let cueIdx = captionCues.indexOf(cue);
        if (cueIdx < 0) cueIdx = 0;

        // --- CHUNK build: 2-4 white + 1-3 colored (seeded) ---
        // GUARANTEE: har cue me kam-az-kam 1 COLORED chunk ho (video: 3-word
        // phrases bhi colored the — NEVER BEEN EASIER). 3-word cue me white
        // chunk max 2 word, taake 1 colored bachay.
        const chunks = [];
        const W = cue.words.length;
        let wi = 0;
        let lastColor = -1;
        // colored chunk ke WORDS REQUIRED: W=3 → white max 1; W>=4 → white max W-2
        const maxWhite = (W <= 3) ? Math.max(1, W - 2) : Math.max(2, W - 2);
        while (wi < W) {
            const remains = W - wi;
            // white chunk: 2-4 words — colored ke baad W bacha to white
            let wc = 2 + Math.floor(((cueIdx * 7 + wi * 3) % 3));
            if (remains <= maxWhite + 1) wc = remains - 1;           // colored ke liye 1 word chhodo (agar W>=3)
            if (remains - wc < 1) wc = remains - 1;                  // (W=2: 1 white + 1 colored)
            wc = Math.max(1, Math.min(wc, remains));
            const white = [];
            for (let k = 0; k < wc && wi < W; k++) white.push(wi++);
            if (white.length && (white.length < W || chunks.length)) chunks.push({ idxs: white, color: null });
            // colored chunk: 1-3 words (never same color as previous)
            if (wi < W) {
                const cc = Math.min(1 + ((cueIdx + wi) % 3), W - wi);
                let ci = Math.floor(Math.abs(Math.sin(cueIdx * 17.3 + wi * 7.7)) * pal.length) % pal.length;
                if (ci === lastColor) ci = (ci + 1 + ((cueIdx + wi) % (pal.length - 1))) % pal.length;
                lastColor = ci;
                const col = [];
                for (let k = 0; k < cc && wi < W; k++) col.push(wi++);
                chunks.push({ idxs: col, color: pal[ci] });
            }
        }
        // LAST-WO: agar COLORED chunk hi nahi bana (sab white), aakhri word ko
        // forced-colored kar do (video spec: har phrase me accents hote hain)
        if (chunks.length && !chunks.some((c) => c.color)) {
            chunks[chunks.length - 1].color = pal[Math.floor(Math.abs(Math.sin(cueIdx * 17.3)) * pal.length) % pal.length];
        }

        // --- LINE BUILD: chunking se lines, 86% width par greedy wrap.
        // PER-WORD SIZE (video f001/f018/f030 ka ASLI look): WHITE words CHHOTE
        // (~85%), COLORED words BARE (~118% — video me FOLLOWERS / MONEY ONLINE
        // NOWADAYS / NEVER BEEN EASIER sab colored-bare the). Har line CENTERED.
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const ctxFont = (fs) => { ctx.font = `${style.fontWeight} ${fs}px Arial, sans-serif`; };
        const gapW = 10 * scale;
        const fsWhite = fs2;          // white words chhote (~85%)
        const fsColor = fs1 * 1.18;   // NEON words BARE
        const widthsAt = (w, fs) => { ctxFont(fs); return ctx.measureText(w).width; };

        const wordColor = [], wordFs = [];
        chunks.forEach((c) => c.idxs.forEach((i) => { wordColor[i] = c.color; wordFs[i] = c.color ? fsColor : fsWhite; }));

        const lines = [];
        let cur = [], curW = 0;
        for (let i = 0; i < W; i++) {
            const ww = widthsAt(words[i], wordFs[i]);
            if (cur.length && (curW + gapW + ww) > rectW * 0.86) {
                lines.push(cur);
                cur = []; curW = 0;
            }
            cur.push({ i, ww, fs: wordFs[i], color: wordColor[i] || null });
            curW += cur.length > 1 ? gapW + ww : ww;
        }
        if (cur.length) lines.push(cur);

        // badi line 88% ke andar squash (saare words proportional chhote)
        lines.forEach((ln) => {
            let tot = ln.reduce((a, it) => a + it.ww, 0) + gapW * (ln.length - 1);
            if (tot > rectW * 0.88) {
                const f = (rectW * 0.88) / tot;
                ln.forEach((it) => { it.ww *= f; it.fs *= f; });
                tot *= f;
            }
            ln._w = tot;
        });

        // layout: lines centered — drag-follow (pos.y=.86 → L1 52% / L2 58%)
        const layout = [];
        const lineH = fsColor * 0.62 * scale;   // tight stacking (video jaisa)
        lines.forEach((ln, li) => {
            const cy = lines.length === 1 ? ySingle : (li === 0 ? yLine1 : yLine2 + (li - 1) * lineH);
            let lx = cx6 - ln._w / 2;
            ln.forEach((it) => {
                layout.push({ i: it.i, x: lx + it.ww / 2, y: cy, fs: it.fs, color: it.color });
                lx += it.ww + gapW;
            });
        });

        // --- word reveal state (alpha+blur in ~100ms = 3 frames) ---
        layout.forEach((it) => {
            const w = cue.words[it.i];
            const act = srcT != null && srcT >= w.start && srcT < w.end;
            const spoken = srcT != null && srcT >= w.end;
            const dur = Math.min(0.1, (w.end - w.start) || 0.1);
            const tt = act ? Math.min(1, Math.max(0, (srcT - w.start) / Math.max(0.02, dur))) : (spoken ? 1 : 0);
            it.alpha = tt;
            it.blur = (1 - tt) * 4;
            it.spoken = spoken;
            const heading = (it.color && act) || (it.color && spoken);
            it.fill = it.color || style.color;
            // NEON: colored word = same-color glow (6 & 14px @60%) + dark drop
            it.neon = !!it.color;
            it.pop = act ? 1 + ((style.animScale || 1.04) - 1) * Math.sin(tt * Math.PI) : 1;
        });

        layout.forEach((it) => {
            if (it.alpha <= 0) return;
            ctx.save();
            ctx.globalAlpha = Math.max(0, Math.min(1, it.alpha));
            ctx.translate(it.x, it.y);
            ctx.scale(it.pop, it.pop);
            ctxFont(it.fs);
            if (it.neon) {
                ctx.shadowColor = it.color;
                ctx.shadowBlur = 6 * scale;
                ctx.fillStyle = it.color;
                ctx.fillText(words[it.i], 0, 0);
                ctx.shadowColor = it.color;
                ctx.shadowBlur = 14 * scale;
                ctx.globalAlpha = Math.max(0, Math.min(1, it.alpha * 0.6));
                ctx.fillText(words[it.i], 0, 0);
                ctx.globalAlpha = Math.max(0, Math.min(1, it.alpha));
            }
            // dark drop shadow har word ke peeche
            ctx.shadowColor = "rgba(0,0,0,0.5)";
            ctx.shadowBlur = 6 * scale;
            ctx.shadowOffsetY = 2 * scale;
            ctxFont(it.fs);
            ctx.fillStyle = it.fill;
            ctx.fillText(words[it.i], 0, 0);
            ctx.restore();
        });

        ctx.restore();
        if (isPreview) {
            const pad = 14 * scale;
            const minX = Math.min(...layout.map((l) => l.x), cx6), maxX = Math.max(...layout.map((l) => l.x), cx6);
            const minY = Math.min(...layout.map((l) => l.y)), maxY = Math.max(...layout.map((l) => l.y));
            window.__captionBBox = { x: minX - pad, y: minY - fs2 / 2 - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + fs2 + pad * 2 };
        }
        return;
    }

    // ===== "My Caption 5" — fadeSplit renderer (mussy full-video mirror) =====
    // MAX 2 WORDS PER LINE — 3+ words wale cues 2 lines mein bat jaate hain
    // (live video jaisa). Per-pair REVEAL: abi-nahin-bole pairs dim (ghost),
    // jo pair ABHI bole wala hai wo ACCENT COLOR mein reveal hota hai
    // (color-cycle: naya keyword naya random palet color), bol-chuka pair
    // solid WHITE. Reveal par animScale (thoda bara). Soft black shadow
    // poore text par (thick dark edge, video jaisi readability).
    if (style.animation === "fadeSplit") {
        const cxBaseL = rectX + rectW * captionPosition.x;
        const yC = rectY + rectH * captionPosition.y;
        const dim = (style.dimOpacity != null) ? style.dimOpacity : 0.55;
        const animS = (style.animScale != null) ? style.animScale : 1.06;
        const accents = (style.accentColors != null && style.accentColors.length) ? style.accentColors : ["#33b1ff"];

        // per-word reveal state: ACCENT color DETERMINISTIC — word ke pehle
        // (usi cue mein) kitne keywords aaye, us count se palette dedo; is se
        // har frame pe color flicker nahi hota (counter per-frame bug foold).
        const isKwBase = (txt) => ((txt || "").replace(/[^a-zA-Z0-9$]/g, "")).length >= 4;
        let kwBefore = 0;
        const wState = cue.words.map((w) => {
            const isKeyword = isKwBase(w.text || "");
            const accentIdx = kwBefore;
            if (isKeyword) kwBefore++;
            const act = srcT != null && srcT >= w.start && srcT < w.end;
            const dur = Math.min(0.25, (w.end - w.start) || 0.2);
            const tt = act ? Math.min(1, Math.max(0, (srcT - w.start) / Math.max(0.02, dur))) : 1;
            const reveal = act || (w.end != null && w.end <= (srcT == null ? Infinity : srcT));
            // keyword hamesha accent color (unspoken = ghost-dim accent bhi —
            // video me GATEWAYS/PAGE unspoken par bhi blue/purple tint tha)
            const accentColor = isKeyword ? accents[accentIdx % accents.length] : null;
            return {
                act, tt, reveal,
                isKeyword,
                alpha: act ? (dim + (1 - dim) * tt) : (reveal ? 1 : dim),
                accentColor,
            };
        });

        // 2-WORD LINES: max 2 words per line (3+ words = 2 lines)
        const gapW = 16 * scale;
        const linesArr = [];
        for (let i = 0; i < cue.words.length; i += 2) linesArr.push(cue.words.slice(i, i + 2));

        // per-line per-word measure (statement style per-line)
        const lw2 = [];
        const fsLine = finalFontSize;
        const lh2 = fsLine * 1.05;
        linesArr.forEach((ln) => {
            let wsum = 0;
            const ws = [];
            ln.forEach((w, j) => {
                const idx = cue.words.indexOf(w);
                ww = widths[idx] || 0;
                ws.push(ww);
                wsum += ww + (j > 0 ? gapW : 0);
            });
            lw2.push({ lineW: wsum, ws });
        });

        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        let ly = yC - (linesArr.length * lh2) / 2 + lh2 / 2;
        linesArr.forEach((ln, li) => {
            const lwid = lw2[li].lineW;
            let lx = cxBaseL - lwid / 2;
            ln.forEach((w, j) => {
                const idx = cue.words.indexOf(w);
                const st = wState[idx];
                const isAct = st.act;
                // video jaisa: keyword (chah.e GHUS bhi) = ACCENT color (dark)
                // ACTIVE keyword = accent BRIGHT; nahi keyword = white;
                // bol-chuka = solid white
                let fill;
                const accentOn = st.isKeyword && (st.act || !st.reveal);
                if (st.isKeyword && accentOn) fill = st.accentColor;
                else if (st.reveal) fill = style.activeColor;
                else fill = style.color;
                const pop = isAct ? 1 + (animS - 1) * (1 - Math.abs(2 * st.tt - 1)) : 1;
                ctx.save();
                ctx.globalAlpha = Math.max(0, Math.min(1, st.alpha));
                ctx.translate(lx + lw2[li].ws[j] / 2, ly);
                ctx.scale(pop, pop);
                ctx.font = `${style.fontWeight} ${fsLine}px Arial, sans-serif`;
                ctx.fillStyle = fill;
                // soft black shadow (video ka dark readability-edge)
                ctx.shadowColor = "rgba(0,0,0,0.55)";
                ctx.shadowBlur = 14 * scale;
                ctx.fillText(words[idx], 0, 0);
                ctx.restore();
                lx += lw2[li].ws[j] + gapW;
            });
            ly += lh2;
        });
        ctx.restore();
        if (isPreview) {
            const pad = 14 * scale;
            const maxW = Math.max(...lw2.map((o) => o.lineW));
            window.__captionBBox = {
                x: cxBaseL - maxW / 2 - pad,
                y: yC - (linesArr.length * lh2) / 2 - pad,
                w: maxW + pad * 2,
                h: linesArr.length * lh2 + pad * 2,
            };
        }
        return;
    }

    // ===== "My Caption 4" — fadeCloud renderer (mussy-sample mirror) =====
    // Ek SINGLE line (fit-scale same simple wale branch ka). Har word:
    //   - saath-baaki words: dim (style.dimOpacity ~0.45), opaque white jab bol
    //     chuka; non-repeated words ki base-color white
    //   - bolne-wala word: smooth fade-up (style.fadeUp px) + alpha 0->1
    //   - HOW/AI dimmed saaye ko — pehle words ghost-jaisa (alpha ~0.5)
    //   - PEHLA/LAST KEYWORD (ya cue ka 1st & 3rd word) -> style.accentColor
    if (style.animation === "fadeCloud") {
        const dim = (style.dimOpacity != null) ? style.dimOpacity : 0.5;
        const rise = ((style.fadeUp != null) ? style.fadeUp : 14) * scale;
        const cxBaseL = rectX + rectW * captionPosition.x;
        const yC = rectY + rectH * captionPosition.y;

        // REPEATER-keyword accent: jo word >=4 letters ka poore video mein
        // behas 2+ dafa aata hai (mussy-style: FIRST / CLIPAI / FOLLOWERS...)
        // wo accent color (blue) hota hai, baqi words white.
        let dict = null;
        try {
            if (typeof captionCues !== "undefined" && captionCues.length) {
                dict = {};
                captionCues.forEach((c) => (c.words || []).forEach((w) => {
                    const b = (w.text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
                    if (b.length >= 4) dict[b] = (dict[b] || 0) + 1;
                }));
            }
        } catch (e) { dict = null; }
        const isAccent = (txt) => {
            if (!dict) return false;
            const b = (txt || "").toLowerCase().replace(/[^a-z0-9]/g, "");
            return b.length >= 4 && dict[b] >= 2;
        };

        // per-word reveal state (active word smooth fade-up hota hai)
        const wState = cue.words.map((w) => {
            const act = srcT != null && srcT >= w.start && srcT < w.end;
            const dur = Math.min(0.22, (w.end - w.start) || 0.2);
            const tt = act ? Math.min(1, Math.max(0, (srcT - w.start) / Math.max(0.02, dur))) : 1;
            const alpha = act ? (0.3 + 0.7 * tt) : (w.end <= srcT ? 1 : dim);
            return {
                act, tt, alpha,
                dy: act ? -rise * tt : 0,
                pop: act ? 1 + 0.07 * Math.sin(tt * Math.PI) : 1,
                fill: isAccent(w.text || "") && style.accentColor ? style.accentColor : style.color,
            };
        });

        // word-WRAP: jab line 90% width bhar jaye, agla word nayi line par
        const gapW = 16 * scale;
        const linesArr = [];
        let curIdxs = [], curW = 0;
        for (let i = 0; i < cue.words.length; i++) {
            const ww = widths[i];
            if (curIdxs.length && curW + gapW + ww > rectW * 0.9) {
                linesArr.push(curIdxs); curIdxs = []; curW = 0;
            }
            curIdxs.push(i); curW += ww + (curIdxs.length > 1 ? gapW : 0);
        }
        if (curIdxs.length) linesArr.push(curIdxs);

        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const lh2 = finalFontSize * 1.12;
        let ly = yC - (linesArr.length * lh2) / 2 + lh2 / 2;
        linesArr.forEach((idxs) => {
            const lw = idxs.reduce((a, i) => a + widths[i], 0) + gapW * Math.max(0, idxs.length - 1);
            let lx = cxBaseL - lw / 2;
            idxs.forEach((i) => {
                const st = wState[i];
                ctx.save();
                ctx.globalAlpha = Math.max(0, Math.min(1, st.alpha));
                ctx.translate(lx + widths[i] / 2, ly + st.dy);
                ctx.scale(st.pop, st.pop);
                ctx.font = `${style.fontWeight} ${finalFontSize}px Arial, sans-serif`;
                ctx.fillStyle = st.fill;
                ctx.fillText(words[i], 0, 0);
                ctx.restore();
                lx += widths[i] + gapW;
            });
            ly += lh2;
        });
        ctx.restore();
        if (isPreview) {
            const pad = 12 * scale;
            window.__captionBBox = {
                x: cxBaseL - rectW * 0.45 - pad,
                y: yC - (linesArr.length * lh2) / 2 - pad,
                w: rectW * 0.9 + pad * 2,
                h: linesArr.length * lh2 + pad * 2,
            };
        }
        return;
    }

    // ===== "My Caption 3" — custom multi-line / per-word-size renderer =====
    // RULES (sample-video se): 2 words per line, centered block; KEY word =
    // len>=4 + not-stopword + not "-ing" → 1.55x size + yellow + glow;
    // filler words → normal size + white; ACTIVE word → extra 1.12 pop +
    // strong glow (deterministic, word-timings se).
    if (style.animation === "wrapBig") {
        const animW = "wrapBig";
        const yBase = rectY + rectH * captionPosition.y;
        const wProg = (w) => (srcT != null && w.end > w.start) ? Math.min(1, Math.max(0, (srcT - w.start) / (w.end - w.start))) : 0;
        const CAP_STOP = new Set(("a an the and or but for with is are was were be been am " +
            "it i you we they he she me my your our their as by from of to in on at if so do does did done " +
            "has have had not will can could should would just about out up down all any what when where who why how " +
            "than then too very also into over there here that this those these no nor yet both each other some such only own same s t don now").split(" "));
        const baseWord = (txt) => txt.toLowerCase().replace(/[^a-z0-9]/g, "");
        const isKeyWord = (txt) => { const b = baseWord(txt); return b.length >= 4 && !CAP_STOP.has(b) && !/ing$/.test(b); };

        const linesArr = [];
        for (let i = 0; i < cue.words.length; i += 2) linesArr.push(cue.words.slice(i, i + 2));
        const gapW = 14 * scale;
        let lineWs = [], lineHs = [];
        linesArr.forEach((ln) => {
            let wsum = 0, hmax = 0;
            ln.forEach((w) => {
                const act = srcT != null && srcT >= w.start && srcT < w.end;
                const key = isKeyWord(w.text || "");
                const fsz = finalFontSize * (key ? 1.55 : 1.0) * (act ? 1.12 : 1.0);
                ctx.font = `${style.fontWeight} ${fsz}px Arial, sans-serif`;
                const ww = ctx.measureText(w.text || "").width;
                w.__mw = ww; w.__fs = fsz; w.__act = act; w.__key = key;
                wsum += ww; hmax = Math.max(hmax, fsz);
            });
            wsum += gapW * Math.max(0, ln.length - 1);
            lineWs.push(wsum); lineHs.push(hmax);
        });
        const totH = lineHs.reduce((a, b) => a + b, 0) + 14 * scale * Math.max(0, linesArr.length - 1);
        let yy = yBase - totH / 2 + lineHs[0] / 2;
        linesArr.forEach((ln, li) => {
            let lx = cxBase - lineWs[li] / 2;
            const lineCy = yy;
            ln.forEach((w) => {
                const text = w.text || "";
                const fsz = w.__fs, ww = w.__mw, act = w.__act, key = w.__key;
                const prog = wProg(w);
                const pop = act ? (1 + 0.06 * (1 - Math.abs(2 * prog - 1))) : 1; // peek-pop
                ctx.save();
                ctx.translate(lx + ww / 2, lineCy);
                ctx.scale(pop, pop);
                ctx.textAlign = "center"; ctx.textBaseline = "middle";
                ctx.font = `${style.fontWeight} ${fsz}px Arial, sans-serif`;
                if ((key || act) && style.glow) { ctx.shadowColor = style.glow; ctx.shadowBlur = (act ? 34 : 20) * scale; }
                ctx.fillStyle = key ? style.activeColor : style.color;
                ctx.fillText(text, 0, 0);
                ctx.restore();
                lx += ww + gapW;
            });
            yy += lineHs[li] / 2 + lineHs[Math.min(li + 1, lineHs.length - 1)] / 2 + 14 * scale;
        });
        if (isPreview) {
            const maxW = Math.max(...lineWs);
            window.__captionBBox = { x: cxBase - maxW / 2 - 12 * scale, y: yBase - totH / 2 - 12 * scale, w: maxW + 24 * scale, h: totH + 24 * scale };
        }
        ctx.restore();
        return;
    }

    let x = rectX + rectW * captionPosition.x - finalTotalWidth / 2;
    const y = rectY + rectH * captionPosition.y;

    // ===== ANIMATION HELPERS (har style ka apna effect — deterministic,
    // frame-stable: word timings se drive hote hain, wall-clock se nahi) =====
    const wordProg = (w) => (srcT != null && w.end > w.start) ? Math.min(1, Math.max(0, (srcT - w.start) / (w.end - w.start))) : 0;
    const hs = (p) => Math.sin(p * Math.PI); // 0->1->0 smooth hump (deterministic)

    function drawBox(a, bx, by, bw2, bh2, fillStyle, opts) {
        ctx.save();
        if (opts && opts.tilt) {
            ctx.translate(bx + bw2 / 2, by + bh2 / 2);
            ctx.rotate(opts.tilt);
            ctx.translate(-(bx + bw2 / 2), -(by + bh2 / 2));
        }
        if (opts && opts.rounded) {
            const r2 = Math.min(bh2 / 2, 14 * scale * fitScale);
            ctx.beginPath();
            ctx.moveTo(bx + r2, by);
            ctx.arcTo(bx + bw2, by, bx + bw2, by + bh2, r2);
            ctx.arcTo(bx + bw2, by + bh2, bx, by + bh2, r2);
            ctx.arcTo(bx, by + bh2, bx, by, r2);
            ctx.arcTo(bx, by, bx + bw2, by, r2);
            ctx.closePath();
            if (fillStyle) { ctx.fillStyle = fillStyle; ctx.fill(); }
            if (opts.stroke) { ctx.strokeStyle = opts.stroke; ctx.lineWidth = opts.strokeW || 3; ctx.stroke(); }
        } else {
            if (fillStyle) { ctx.fillStyle = fillStyle; ctx.fillRect(bx, by, bw2, bh2); }
            if (opts && opts.stroke) { ctx.strokeStyle = opts.stroke; ctx.lineWidth = opts.strokeW || 3; ctx.strokeRect(bx, by, bw2, bh2); }
        }
        ctx.restore();
    }

    cue.words.forEach((w, i) => {
        const isActive = srcT >= w.start && srcT < w.end;
        const text = words[i];
        const wWidth = widths[i];
        const cx = x + wWidth / 2;
        const prog = wordProg(w);
        const anim = style.animation;
        const padX = 10 * scale * fitScale, padY = 6 * scale * fitScale;

        // ---------- HIGHLIGHT / BOX BACKDROPS (text se pehle) ----------
        if (isActive && style.highlightBg) {
            if (anim === "box") {
                drawBox(null, x - padX, y - finalFontSize / 2 - padY, wWidth + padX * 2, finalFontSize + padY * 2, style.highlightBg);
            } else if (anim === "doubleBox") {
                drawBox(null, x - padX - 4 * scale * fitScale, y - finalFontSize / 2 - padY - 4 * scale * fitScale,
                    wWidth + padX * 2 + 8 * scale * fitScale, finalFontSize + padY * 2 + 8 * scale * fitScale, "#ffffff");
                drawBox(null, x - padX, y - finalFontSize / 2 - padY, wWidth + padX * 2, finalFontSize + padY * 2, style.highlightBg);
            } else if (anim === "boxTilt") {
                drawBox(null, x - padX, y - finalFontSize / 2 - padY, wWidth + padX * 2, finalFontSize + padY * 2, style.highlightBg, { tilt: -0.06 });
            } else if (anim === "boxBounce") {
                const hop = -hs(prog) * 6 * scale * fitScale;
                drawBox(null, x - padX, y - finalFontSize / 2 - padY + hop, wWidth + padX * 2, finalFontSize + padY * 2, style.highlightBg);
            } else if (anim === "boxRounded") {
                drawBox(null, x - padX, y - finalFontSize / 2 - padY, wWidth + padX * 2, finalFontSize + padY * 2, style.highlightBg, { rounded: true });
            } else if (anim === "outlineBox") {
                drawBox(null, x - padX, y - finalFontSize / 2 - padY, wWidth + padX * 2, finalFontSize + padY * 2, null, { stroke: style.highlightBg, strokeW: Math.max(3, 6 * scale * fitScale), rounded: true });
            }
        }
        if (isActive && anim === "lineBox" && style.highlightBg) {
            // poori line ke peeche ek lagatar box
            drawBox(null, rectX + rectW * captionPosition.x - finalTotalWidth / 2 - padX, y - finalFontSize / 2 - padY,
                finalTotalWidth + padX * 2, finalFontSize + padY * 2, style.highlightBg);
        }
        if (isActive && anim === "tickerBar") {
            // full-height ticker bar (news style) active word ke peeche
            drawBox(null, x - padX, y - finalFontSize * 0.75, wWidth + padX * 2, finalFontSize * 1.5, style.highlightBg);
        }

        // ---------- TRANSFORM (scale/rotate/offset per-animation) ----------
        let drawScale = 1, dx = 0, dy = 0, rot = 0;
        if (isActive) {
            if (anim === "pop") drawScale = 1.15;
            else if (anim === "stamp") drawScale = 1.35;
            else if (anim === "rotPop") { drawScale = 1.12; rot = (i % 2 === 0 ? -1 : 1) * 0.09; }
            else if (anim === "popBounce") { drawScale = 1.12; dy = -hs(prog) * 10 * scale * fitScale; }
            else if (anim === "boxBounce") { dy = -hs(prog) * 6 * scale * fitScale; }
            else if (anim === "shake") { dx = Math.sin(prog * 24) * 3 * scale * fitScale; dy = Math.cos(prog * 19) * 2 * scale * fitScale; }
            else if (anim === "slide") { dx = -(1 - Math.min(1, prog * 2.2)) * 26 * scale * fitScale; }
            else if (anim === "squash") { drawScale = 1 + 0.08 * hs(prog); dy = 0.06 * hs(prog) * finalFontSize; }
            else if (anim === "underlineFloat") { dy = -hs(prog) * 4 * scale * fitScale; }
            else if (anim === "flash") drawScale = 1 + 0.1 * hs(prog);
            else if (anim === "glowPop") drawScale = 1.12;
            else if (anim === "popFill") drawScale = 1 + 0.15 * hs(prog);
        }

        ctx.save();
        ctx.translate(cx + dx, y + dy);
        if (rot) ctx.rotate(rot);
        if (drawScale !== 1) ctx.scale(drawScale, drawScale);

        // ---------- GLOW VARIANTS ----------
        // glowAll (My Caption styles): glow HARB word par — sample-video jaisa look
        if (style.glow && (isActive || style.glowAll)) {
            ctx.shadowColor = style.glow;
            if (anim === "glowPulse") ctx.shadowBlur = (10 + 22 * hs(prog)) * scale * fitScale;
            else if (anim === "glowPop") ctx.shadowBlur = 30 * scale * fitScale;
            else if (anim === "popFill") ctx.shadowBlur = 22 * scale * fitScale;
            else ctx.shadowBlur = 18 * scale * fitScale;
        }

        if (style.outline) {
            ctx.lineWidth = Math.max(1, (style.outlineWidth || 3.5) * scale * fitScale);
            ctx.strokeStyle = style.outline;
            ctx.strokeText(text, 0, 0);
        }

        // ---------- FILL COLOR (color-highlighting per style) ----------
        let fillColor = style.color;
        if (isActive) {
            fillColor = style.activeColor;
            if (anim === "rgbCycle" && style.activePalette) {
                fillColor = style.activePalette[i % style.activePalette.length];
            } else if (anim === "glowSwap" && style.glow2) {
                fillColor = (i % 2 === 0) ? style.activeColor : style.glow2;  // har word ka alag neon
            } else if (anim === "flash") {
                // base->active flash: word ke start mein BOHOT bright, phir settle
                fillColor = prog < 0.3 ? "#ffe08a" : style.activeColor;
            } else if (anim === "popFill") {
                fillColor = prog < 0.35 ? "#ffffff" : style.activeColor;
            } else if (anim === "fillSweep") {
                fillColor = style.color; // sweep neeche handle karta hai
            }
        }
        ctx.fillStyle = fillColor;
        ctx.fillText(text, 0, 0);

        // ---------- PROGRESSIVE / SWEEP FILLS (clip-based, fill ke baad) ----------
        if (isActive && anim === "fillSweep") {
            ctx.save();
            ctx.beginPath();
            ctx.rect(-wWidth / 2, -finalFontSize, wWidth * prog, finalFontSize * 2);
            ctx.clip();
            ctx.fillStyle = style.activeColor;
            ctx.fillText(text, 0, 0);
            ctx.restore();
        }
        if (isActive && anim === "fill") {
            // karaoke fill: poora word fill ho chuka (start se end tak solid)
            ctx.fillStyle = style.activeColor;
            ctx.fillText(text, 0, 0);
        }

        // ---------- OVERLAYS (underline/strike) ----------
        if (isActive && (anim === "underline" || anim === "underlineFloat")) {
            ctx.strokeStyle = style.activeColor;
            ctx.lineWidth = Math.max(1, 3 * scale * fitScale);
            ctx.beginPath();
            ctx.moveTo(-wWidth / 2, finalFontSize * 0.42);
            ctx.lineTo(wWidth / 2, finalFontSize * 0.42);
            ctx.stroke();
        }
        if (isActive && anim === "strike") {
            ctx.strokeStyle = style.activeColor;
            ctx.lineWidth = Math.max(1, 4 * scale * fitScale);
            ctx.beginPath();
            ctx.moveTo(-wWidth / 2 - 2, 0);
            ctx.lineTo(wWidth / 2 + 2, 0);
            ctx.stroke();
        }

        ctx.restore();
        x += wWidth + finalGap;
    });

    ctx.restore();

    if (isPreview) {
        const pad = 12 * scale;
        window.__captionBBox = {
            x: (rectX + rectW * captionPosition.x - finalTotalWidth / 2) - pad,
            y: y - finalFontSize / 2 - pad,
            w: finalTotalWidth + pad * 2,
            h: finalFontSize + pad * 2,
        };
    }
}

// ===== DRAG (move) + RESIZE — sirf 9:16 preview canvas par =====

function getPreviewPos(e) {
    const rect = previewCanvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function inCaptionBBox(pos) {
    const b = window.__captionBBox;
    if (!b) return false;
    return pos.x >= b.x && pos.x <= b.x + b.w && pos.y >= b.y && pos.y <= b.y + b.h;
}

function nearCaptionResizeHandle(pos) {
    const b = window.__captionBBox;
    if (!b) return false;
    const hx = b.x + b.w, hy = b.y + b.h;
    return Math.abs(pos.x - hx) < 14 && Math.abs(pos.y - hy) < 14;
}

previewCanvas.addEventListener("mousedown", (e) => {
    // SPOTLIGHT PRIORITY: bubble grab ho to caption-drag START hi mat karo
    // (dono ka drag-region overlap ho sakta hai — bubble jeetega)
    if (typeof spotlightHandleMouseDown === "function" && spotlightHandleMouseDown(e)) return;
    if (!window.__captionBBox) return;
    const pos = getPreviewPos(e);

    if (nearCaptionResizeHandle(pos)) {
        captionDragState = {
            type: "resize",
            anchorX: window.__captionBBox.x, anchorY: window.__captionBBox.y,
            startX: pos.x, startY: pos.y,
            origScale: captionFontScale,
        };
        e.stopPropagation();
        return;
    }
    if (inCaptionBBox(pos)) {
        captionDragState = {
            type: "move",
            startX: pos.x, startY: pos.y,
            origPos: { x: captionPosition.x, y: captionPosition.y },
        };
        e.stopPropagation();
    }
});

document.addEventListener("mousemove", (e) => {
    if (!captionDragState) return;
    const pos = getPreviewPos(e);

    if (captionDragState.type === "move") {
        const dx = (pos.x - captionDragState.startX) / previewCanvas.width;
        const dy = (pos.y - captionDragState.startY) / previewCanvas.height;
        captionPosition.x = Math.max(0.05, Math.min(0.95, captionDragState.origPos.x + dx));
        captionPosition.y = Math.max(0.08, Math.min(0.98, captionDragState.origPos.y + dy));
        // (FIX) DRAG KE DAURAN hi playhead-span live-update — warna layers.js ka
        // draw-wrapper har frame span ki PURANI position se draw karta hai aur
        // drag "invisible" ho jata tha (mouseup par hi copy hota tha).
        try {
            if (typeof capSpanAt === "function" && typeof virtualTime !== "undefined" && captionSpans.length) {
                const sp = capSpanAt(virtualTime);
                if (sp) sp.position = { x: captionPosition.x, y: captionPosition.y };
            }
        } catch (err) {}
    } else if (captionDragState.type === "resize") {
        const startDist = Math.hypot(
            captionDragState.startX - captionDragState.anchorX,
            captionDragState.startY - captionDragState.anchorY
        );
        const curDist = Math.hypot(
            pos.x - captionDragState.anchorX,
            pos.y - captionDragState.anchorY
        );
        const ratio = startDist > 5 ? curDist / startDist : 1;
        captionFontScale = Math.max(0.4, Math.min(3, captionDragState.origScale * ratio));
        // (FIX) resize bhi span live-update (move wale fix jaisa)
        try {
            if (typeof capSpanAt === "function" && typeof virtualTime !== "undefined" && captionSpans.length) {
                const sp2 = capSpanAt(virtualTime);
                if (sp2) sp2.fontScale = captionFontScale;
            }
        } catch (err) {}
    }
});

document.addEventListener("mouseup", () => {
    if (captionDragState) {
        // (FIX) span-copy HOOD pehle (persistCaptionsIfRemembered wrapper globals→span
        // copy karta hai) — remember-flag OFF ho to bhi TIMELINE-span to update ho.
        try {
            if (typeof capSpanAt === "function" && typeof virtualTime !== "undefined" && captionSpans.length) {
                const sp3 = capSpanAt(virtualTime);
                if (sp3) {
                    sp3.position = { x: captionPosition.x, y: captionPosition.y };
                    sp3.fontScale = captionFontScale;
                }
            }
        } catch (err) {}
        if (typeof persistCaptionsIfRemembered === "function") persistCaptionsIfRemembered();
        else if (typeof persistTimelineState === "function") persistTimelineState();
    }
    captionDragState = null;
});

// ===== CAPTIONS PANEL (media-bin ke neeche) =====

function persistCaptionsIfRemembered() {
    if (captionRemember && typeof persistTimelineState === "function") persistTimelineState();
}

function resetCaptionSettingsToDefault() {
    captionOverrides = {};  // DYNAMIC: sab color-overrides clear (style me jo bhi hain)
    captionFontScale = 1.0;
    captionPosition = { x: 0.5, y: 0.86 };
    currentCaptionStyle = "hormozi";
    buildCaptionsPanel();
    if (typeof persistTimelineState === "function") persistTimelineState();
}

function buildCaptionsPanel() {
    const wrap = document.getElementById("captionsPanel");
    if (!wrap) return;

    const eff = getEffectiveCaptionStyle();
    const baseStyle = CAPTION_STYLES[currentCaptionStyle] || CAPTION_STYLES.hormozi;
    // DYNAMIC COLOR OPTIONS: jitne color-fields is style me mojood hain, utne
    // pickers. Array-field (accentColors/neonPalette) = per-swatch pickers.
    const colorFields = getStyleColorFields(baseStyle);
    let colorOptionsHtml = "";
    colorFields.forEach((f) => {
        if (!f.list) {
            const ov = captionOverrides[f.prop];
            const preview = _getPreviewColor(eff, f, null);
            colorOptionsHtml += `
                <label class="cp-color-item"><input type="checkbox" id="cpUse_${f.prop}" ${ov ? "checked" : ""}/> ${f.label}</label>
                <input type="color" id="cpC_${f.prop}" value="${ov || preview}" ${ov ? "" : "disabled"}/>`;
        } else {
            const arr = eff[f.prop] || [];
            const ovArr = (captionOverrides[f.prop] && Array.isArray(captionOverrides[f.prop])) ? captionOverrides[f.prop] : null;
            arr.forEach((c, idx) => {
                const cur = (ovArr && ovArr[idx]) ? ovArr[idx] : c;
                const ovThis = !!(ovArr && ovArr[idx] && ovArr[idx] !== c);
                const label = f.shortLabel ? f.shortLabel(idx + 1) : (f.label + " " + (idx + 1));
                colorOptionsHtml += `
                <label class="cp-color-item"><input type="checkbox" id="cpUse_${f.prop}_${idx}" ${ovThis ? "checked" : ""}/> ${label}</label>
                <input type="color" id="cpC_${f.prop}_${idx}" value="${cur}" ${ovThis ? "" : "disabled"}/>`;
            });
        }
    });
    if (!colorOptionsHtml) colorOptionsHtml = "<span class=\"cp-hint\">(style me koi color option nahi)</span>";

    wrap.innerHTML = `
        <div class="cp-header">
            <span class="cp-title">💬 Captions</span>
            <label class="cp-enable"><input type="checkbox" id="cpEnableChk" ${captionsEnabled ? "checked" : ""}/> On</label>
            <span class="cp-toggle" id="cpCollapse">▾</span>
        </div>
        <div class="cp-body" id="cpBody">
            <label class="cp-label">Style</label>
            <select id="cpStyleSelect" class="cp-select"></select>

            <label class="cp-label">Colors <span class="cp-hint">(tick = custom, untick = style default)</span></label>
            <div class="cp-color-grid" id="cpColorGrid">
                ${colorOptionsHtml}
            </div>

            <label class="cp-label">Size <span class="cp-hint" id="cpSizeVal">${captionFontScale.toFixed(2)}x</span></label>
            <input type="range" id="cpSizeSlider" class="cp-slider" min="0.4" max="3" step="0.05" value="${captionFontScale}"/>

            <div class="cp-footer">
                <label class="cp-remember"><input type="checkbox" id="cpRememberChk" ${captionRemember ? "checked" : ""}/> Save settings</label>
                <button id="cpResetBtn" class="cp-reset-btn" title="Reset to default">↺ Reset</button>
            </div>
            <div class="cp-hint-line">9:16 preview par caption ko drag/resize kar ke position bhi set kar sakte hain</div>
        </div>
    `;

    // --- style dropdown ---
    const sel = document.getElementById("cpStyleSelect");
    Object.keys(CAPTION_STYLES).forEach((key) => {
        const opt = document.createElement("option");
        opt.value = key;
        opt.textContent = CAPTION_STYLES[key].label;
        sel.appendChild(opt);
    });
    sel.value = currentCaptionStyle;
    sel.addEventListener("change", () => {
        currentCaptionStyle = sel.value;
        // naya style = custom colors apne aap off (style ka apna look dikhe)
        captionOverrides = {};  // DYNAMIC: style ke apne marzi ke color-keys clear
        // FIX: pehle span me persist karo, PHIR panel rebuild — warna
        // buildCaptionsPanel override (layers.js) playhead-span ka PURANA style
        // wapas globals me load kar deta tha aur user ki selection swallow ho
        // jati thi (style kabhi change nahi hota tha)
        persistCaptionsIfRemembered();
        buildCaptionsPanel();
    });

    // --- enable checkbox ---
    document.getElementById("cpEnableChk").addEventListener("change", (e) => {
        captionsEnabled = e.target.checked;
        persistCaptionsIfRemembered();
    });

    // --- collapse toggle ---
    document.getElementById("cpCollapse").addEventListener("click", () => {
        const body = document.getElementById("cpBody");
        body.style.display = body.style.display === "none" ? "" : "none";
        document.getElementById("cpCollapse").textContent = body.style.display === "none" ? "▸" : "▾";
    });

    // --- color overrides (DYNAMIC: jitne colors current style me hain) ---
    // single: chk={prop}; list: per-swatch chk={prop:idx} — sirf ticked swatch poore array ko replace karta hai.
    colorFields.forEach((f) => {
        if (!f.list) {
            const chk = document.getElementById("cpUse_" + f.prop);
            const color = document.getElementById("cpC_" + f.prop);
            if (!chk || !color) return;
            const apply = () => {
                captionOverrides[f.prop] = chk.checked ? color.value : null;
                color.disabled = !chk.checked;
                persistCaptionsIfRemembered();
            };
            chk.addEventListener("change", apply);
            color.addEventListener("input", () => { if (chk.checked) apply(); });
        } else {
            const arr = (captionOverrides[f.prop] && Array.isArray(captionOverrides[f.prop])) ? captionOverrides[f.prop] : null;
            eff[f.prop].forEach((_, idx) => {
                const chk = document.getElementById("cpUse_" + f.prop + "_" + idx);
                const color = document.getElementById("cpC_" + f.prop + "_" + idx);
                if (!chk || !color) return;
                const apply = () => {
                    if (!chk.checked) {
                        // untick: agar override array hai to is index ka custom hatao
                        if (Array.isArray(captionOverrides[f.prop])) {
                            const base = CAPTION_STYLES[currentCaptionStyle] || CAPTION_STYLES.hormozi;
                            const def = base[f.prop] || [];
                            const ov = captionOverrides[f.prop].slice();
                            if (idx < ov.length && ov[idx] !== def[idx]) {
                                ov[idx] = def[idx];
                                captionOverrides[f.prop] = ov;
                            }
                            if (ov.every((c, i) => c === (def[i] || c))) captionOverrides[f.prop] = null;
                        }
                        color.disabled = true;
                        persistCaptionsIfRemembered();
                        return;
                    }
                    const cur = (captionOverrides[f.prop] && Array.isArray(captionOverrides[f.prop]))
                        ? captionOverrides[f.prop].slice()
                        : eff[f.prop].slice();
                    cur[idx] = color.value;
                    captionOverrides[f.prop] = cur;
                    color.disabled = false;
                    persistCaptionsIfRemembered();
                };
                chk.addEventListener("change", apply);
                color.addEventListener("input", () => { if (chk.checked) apply(); });
            });
        }
    });

    // --- size slider ---
    const slider = document.getElementById("cpSizeSlider");
    slider.addEventListener("input", () => {
        captionFontScale = parseFloat(slider.value);
        document.getElementById("cpSizeVal").textContent = captionFontScale.toFixed(2) + "x";
    });
    slider.addEventListener("change", () => persistCaptionsIfRemembered());

    // --- remember checkbox ---
    document.getElementById("cpRememberChk").addEventListener("change", (e) => {
        captionRemember = e.target.checked;
        persistCaptionsIfRemembered();
    });

    // --- reset button ---
    document.getElementById("cpResetBtn").addEventListener("click", resetCaptionSettingsToDefault);
}

function resetCaptionPosition() {
    captionPosition = { x: 0.5, y: 0.86 };
    captionFontScale = 1.0;
    buildCaptionsPanel();
    if (typeof persistTimelineState === "function") persistTimelineState();
}

// backward-compat (timeline.js initTimeline se call hota hai)
function refreshCaptionsUI() {
    buildCaptionsPanel();
}

// ===== CAPTION GENERATION =====

async function generateCaptions() {
    if (!currentVideoRef) return;
    const btn = document.getElementById("generateCaptionsBtn");
    const label = btn.querySelector(".tool-label");
    const original = label ? label.textContent : null;
    btn.disabled = true;
    if (label) label.textContent = "Transcribing…";

    try {
        const res = await fetch(`/video/${currentVideoRef.saved_name}/generate_captions`, { method: "POST" });
        const data = await res.json();
        if (data.error) { alert("Auto Captions failed: " + data.error); return; }

        captionCues = data.cues || [];
        captionsEnabled = true;

        // NAYA: generate hote hi panel khul kar saamne aa jata hai
        buildCaptionsPanel();
        const body = document.getElementById("cpBody");
        if (body) body.style.display = "";
        const collapse = document.getElementById("cpCollapse");
        if (collapse) collapse.textContent = "▾";

        persistTimelineState();
        alert(`${captionCues.length} caption line(s) generate ho gayi hain. Neeche Captions panel se style/colors/size badal sakte hain.`);
    } catch (err) {
        alert("Auto Captions error: " + err);
    } finally {
        btn.disabled = false;
        if (label && original) label.textContent = original;
    }
}

document.addEventListener("DOMContentLoaded", () => {
    buildCaptionsPanel();

    const genBtn = document.getElementById("generateCaptionsBtn");
    if (genBtn) genBtn.addEventListener("click", generateCaptions);
});
```

### Name: frontend/color_grade.js
```js
// ===== COLOR GRADING (Phase 1 — Filmora-style basic sliders) =====
// GLOBAL grade (poori video par) — Phase 2 mein per-clip aayega.
//
// Preview: canvas 2D ka `filter` (brightness/contrast/saturate) + temperature
// ke liye warm/cool overlay + vignette radial-gradient. Sharpen preview mein
// skip (canvas equivalent nahi — sirf export burn hota hai, warna hint dikhata hai).
// Export: export_engine.py ka grade_frame() — same params ka Python mirror.
//
// Persist: persistTimelineState payload mein colorGrade (timeline.js jodta hai)
// + project save/load sab automatically cover.
//
// UI: 🎨 Grade button (topbar, Spotlights ke sath) -> panel preview-ke-neeche
// spotlight-ctrls ke style mein. Presets + Before/After hold-toggle.

const CG_DEFAULTS = {
    brightness: 0,   // -100..100  (%)
    contrast: 0,     // -100..100  (%)
    saturation: 0,   // -100..100  (%)
    temperature: 0,  // -100(cool)..100(warm)
    sharpen: 0,      // 0..100 (sirf export burn — preview hint)
    vignette: 0,     // 0..100
};

let colorGrade = { ...CG_DEFAULTS };
let cgBeforeAfter = false; // Before/After hold (button press ke dauran)

const CG_PRESETS = {
    none:      { label: "Original",      v: {} },
    cinematic: { label: "Cinematic",     v: { contrast: 15, saturation: -10, temperature: -12, vignette: 35 } },
    vivid:     { label: "Vivid",         v: { contrast: 12, saturation: 28, brightness: 4 } },
    warm:      { label: "Warm Sunset",   v: { temperature: 32, saturation: 10, brightness: 3 } },
    cold:      { label: "Cold Blue",     v: { temperature: -32, contrast: 8, saturation: -6 } },
    bw:        { label: "Black & White", v: { saturation: -100, contrast: 14 } },
    vintage:   { label: "Vintage",       v: { contrast: -8, saturation: -22, temperature: 18, vignette: 45 } },
    fade:      { label: "Faded Film",    v: { contrast: -14, saturation: -12, brightness: 6, vignette: 20 } },
    punchy:    { label: "Punchy",        v: { contrast: 24, saturation: 18, sharpen: 30 } },
    night:     { label: "Night Mood",    v: { brightness: -18, contrast: 10, temperature: -18, vignette: 55 } },
};

function cgIsDefault() {
    return Object.keys(CG_DEFAULTS).every((k) => (colorGrade[k] || 0) === CG_DEFAULTS[k]);
}

function cgApply(presetKey) {
    const p = CG_PRESETS[presetKey];
    if (!p) return;
    colorGrade = { ...CG_DEFAULTS, ...p.v };
    cgSyncUI();
    if (typeof persistTimelineState === "function") persistTimelineState();
}

function cgReset() {
    colorGrade = { ...CG_DEFAULTS };
    cgSyncUI();
    if (typeof persistTimelineState === "function") persistTimelineState();
}

// canvas filter string (drawPlayerCanvas/drawPreview grade ON ho to ye lagayenge)
function cgCanvasFilter() {
    if (cgBeforeAfter || cgIsDefault()) return "none";
    const f = [];
    f.push(`brightness(${(100 + colorGrade.brightness) / 100})`);
    f.push(`contrast(${(100 + colorGrade.contrast) / 100})`);
    f.push(`saturate(${(100 + colorGrade.saturation) / 100})`);
    return f.join(" ");
}

function cgIsTemperature() { return !cgBeforeAfter && colorGrade.temperature !== 0; }
function cgIsVignette() { return !cgBeforeAfter && colorGrade.vignette !== 0; }

// temperature overlay — draw ke BAAD source-over se (warm = orange, cool = blue)
function cgApplyTemperatureOverlay(ctx, w, h) {
    if (!cgIsTemperature()) return;
    const t = colorGrade.temperature;
    ctx.save();
    ctx.globalCompositeOperation = "soft-light";
    ctx.globalAlpha = Math.min(0.55, Math.abs(t) / 100 * 0.55);
    ctx.fillStyle = t > 0 ? "#ff9a3c" : "#3ca8ff";
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
}

// vignette — radial gradient (center transparent -> edges dark)
function cgApplyVignette(ctx, w, h) {
    if (!cgIsVignette()) return;
    const strength = colorGrade.vignette / 100;
    const grad = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.42, w / 2, h / 2, Math.max(w, h) * 0.75);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, `rgba(0,0,0,${(0.75 * strength).toFixed(3)})`);
    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
}

// ===== UI =====
function cgSyncUI() {
    const panel = document.getElementById("cgPanel");
    if (!panel) return;
    ["brightness", "contrast", "saturation", "temperature", "sharpen", "vignette"].forEach((k) => {
        const el = document.getElementById("cg_" + k);
        const val = document.getElementById("cg_" + k + "Val");
        if (el) el.value = colorGrade[k] || 0;
        if (val) val.textContent = (colorGrade[k] || 0) + "%";
    });
    // active preset highlight (exact-match)
    document.querySelectorAll(".cg-preset-btn").forEach((b) => {
        const v = CG_PRESETS[b.dataset.preset] ? { ...CG_DEFAULTS, ...CG_PRESETS[b.dataset.preset].v } : null;
        const isMatch = v && Object.keys(CG_DEFAULTS).every((k) => (colorGrade[k] || 0) === (v[k] || 0));
        b.classList.toggle("active", !!isMatch);
    });
}

function initColorGradeUI() {
    const btn = document.getElementById("cgToggleBtn");
    const panel = document.getElementById("cgPanel");
    if (!btn || !panel) return;

    btn.addEventListener("click", () => {
        panel.style.display = panel.style.display === "block" ? "none" : "block";
    });
    const closeBtn = document.getElementById("cgCloseBtn");
    if (closeBtn) closeBtn.addEventListener("click", () => { panel.style.display = "none"; });

    ["brightness", "contrast", "saturation", "temperature", "sharpen", "vignette"].forEach((k) => {
        const el = document.getElementById("cg_" + k);
        if (!el) return;
        el.addEventListener("input", () => {
            colorGrade[k] = parseFloat(el.value);
            const val = document.getElementById("cg_" + k + "Val");
            if (val) val.textContent = el.value + "%";
            document.querySelectorAll(".cg-preset-btn").forEach((b) => b.classList.remove("active"));
            if (typeof persistTimelineState === "function") persistTimelineState();
        });
    });

    document.querySelectorAll(".cg-preset-btn").forEach((b) => {
        b.addEventListener("click", () => cgApply(b.dataset.preset));
    });

    const resetBtn = document.getElementById("cgResetBtn");
    if (resetBtn) resetBtn.addEventListener("click", cgReset);

    // Before/After: HOLD (mousedown/up + touch) — chhorte hi wapis current grade
    const baBtn = document.getElementById("cgBeforeAfterBtn");
    if (baBtn) {
        const on = () => { cgBeforeAfter = true; };
        const off = () => { cgBeforeAfter = false; };
        baBtn.addEventListener("mousedown", on);
        baBtn.addEventListener("mouseup", off);
        baBtn.addEventListener("mouseleave", off);
        baBtn.addEventListener("touchstart", on, { passive: true });
        baBtn.addEventListener("touchend", off);
    }
}

// color_grade.js load hote hi UI init (buttons HTML mein already hain)
initColorGradeUI();
```

### Name: frontend/crop_editor.js
```js

const OUTPUT_W = 1080;
const OUTPUT_H = 1920;

const LAYOUT_MODES = {
    single:     { label: "Single",     boxes: [{ slot: { x: 0, y: 0, w: 1, h: 1 } }] },
    centered:   { label: "Centered",   boxes: [{ slot: { x: 0, y: 0, w: 1, h: 1 } }] },
    dual:       { label: "Dual",       boxes: [{ slot: { x: 0, y: 0, w: 1, h: 0.5 } }, { slot: { x: 0, y: 0.5, w: 1, h: 0.5 } }] },
    trio:       { label: "Trio",       boxes: [{ slot: { x: 0, y: 0, w: 1, h: 1/3 } }, { slot: { x: 0, y: 1/3, w: 1, h: 1/3 } }, { slot: { x: 0, y: 2/3, w: 1, h: 1/3 } }] },
    spotlight:  { label: "Spotlight",  boxes: [{ slot: { x: 0, y: 0, w: 1, h: 1 } }] },  // MULTISCREEN: screens overlay par (spotlight.js) — base crop FULL-frame
    horizontal: { label: "Horizontal", boxes: [] },
};

let videoNaturalW = 0, videoNaturalH = 0;
let activeVideoEl = null;
let metadataHandler = null;
let resizeObserver = null;

let fitRect = { x: 0, y: 0, w: 0, h: 0 };
let cropDragState = null; // { seg, boxIndex, type, origBox }

const playerCanvas = document.getElementById("playerCanvas");
const playerCtx = playerCanvas.getContext("2d");
const previewCanvas = document.getElementById("previewCanvas");
const previewCtx = previewCanvas.getContext("2d");
const modeTabsEl = document.getElementById("modeTabs");

function computeDefaultBox(targetAspect, slot, isPiP) {
    if (isPiP) {
        const boxWnorm = 0.35;
        const physW = boxWnorm * videoNaturalW;
        const physH = physW / targetAspect;
        let boxHnorm = physH / videoNaturalH;
        if (boxHnorm > 1) boxHnorm = 1;
        return {
            x: Math.max(0, 1 - boxWnorm - 0.03),
            y: 0.03,
            w: boxWnorm,
            h: boxHnorm,
        };
    }

    let boxW = targetAspect * (videoNaturalH / videoNaturalW);
    let boxH = 1;
    if (boxW > 1) {
        boxW = 1;
        boxH = videoNaturalW / (targetAspect * videoNaturalH);
    }

    const slotCenter = slot.y + slot.h / 2;
    let y = slotCenter - boxH / 2;
    y = Math.max(0, Math.min(y, 1 - boxH));

    return {
        x: (1 - boxW) / 2,
        y: y,
        w: boxW,
        h: boxH,
    };
}

// Har SEGMENT apna "modeBoxState" khud rakhta hai — global nahi.
function getSegmentBoxes(seg, mode) {
    if (!seg.modeBoxState) seg.modeBoxState = {};
    if (seg.modeBoxState[mode]) return seg.modeBoxState[mode];

    const config = LAYOUT_MODES[mode];
    const boxes = config.boxes.map((b) => {
        const targetAspect = (b.slot.w * OUTPUT_W) / (b.slot.h * OUTPUT_H);
        const box = computeDefaultBox(targetAspect, b.slot, !!b.isPiP);
        box.slot = b.slot;
        box.isPiP = !!b.isPiP;
        return box;
    });
    seg.modeBoxState[mode] = boxes;
    return boxes;
}

function applyVideoMetadata(videoEl) {
    videoNaturalW = videoEl.videoWidth;
    videoNaturalH = videoEl.videoHeight;
}

function initCropEditor(videoEl) {
    if (activeVideoEl && metadataHandler) {
        activeVideoEl.removeEventListener("loadedmetadata", metadataHandler);
    }
    if (resizeObserver) {
        resizeObserver.disconnect();
    }

    activeVideoEl = videoEl;
    videoNaturalW = 0;
    videoNaturalH = 0;

    metadataHandler = () => applyVideoMetadata(videoEl);
    videoEl.addEventListener("loadedmetadata", metadataHandler);

    if (videoEl.readyState >= 1 && videoEl.videoWidth > 0) {
        applyVideoMetadata(videoEl);
    }

    resizeObserver = new ResizeObserver(() => resizeCanvas());
    resizeObserver.observe(playerCanvas.parentElement);
    resizeCanvas();

    requestAnimationFrame(renderLoop);
}

function resizeCanvas() {
    const rect = playerCanvas.parentElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    playerCanvas.width = Math.round(rect.width);
    playerCanvas.height = Math.round(rect.height);
}

function computeFitRect() {
    if (!videoNaturalW || !playerCanvas.width) {
        fitRect = { x: 0, y: 0, w: playerCanvas.width, h: playerCanvas.height };
        return;
    }
    const videoAspect = videoNaturalW / videoNaturalH;
    const canvasAspect = playerCanvas.width / playerCanvas.height;

    let w, h;
    if (videoAspect > canvasAspect) {
        w = playerCanvas.width;
        h = w / videoAspect;
    } else {
        h = playerCanvas.height;
        w = h * videoAspect;
    }
    fitRect = {
        x: (playerCanvas.width - w) / 2,
        y: (playerCanvas.height - h) / 2,
        w: w,
        h: h,
    };
}

// ===== MODE TABS =====
function handleModeTabClick(mode) {
    const seg = (typeof getActiveSegment === "function") ? getActiveSegment() : null;
    if (!seg) return; // koi active segment nahi -> tabs disabled
    seg.mode = mode;
    if (typeof persistTimelineState === "function") persistTimelineState();
    // renderAll (sirf renderSegments nahi) — selected segment S2 stack ka ho sakta hai
    if (typeof renderAll === "function") renderAll();
}

function renderModeTabs() {
    modeTabsEl.innerHTML = "";
    Object.keys(LAYOUT_MODES).forEach((mode) => {
        const btn = document.createElement("button");
        btn.className = "mode-tab";
        btn.textContent = LAYOUT_MODES[mode].label;
        btn.dataset.mode = mode;
        btn.addEventListener("click", () => handleModeTabClick(mode));
        modeTabsEl.appendChild(btn);
    });
}

// Har frame par mode-tabs ki "active"/"disabled" state update karta hai
function updateModeTabsUI() {
    const seg = (typeof getActiveSegment === "function") ? getActiveSegment() : null;
    modeTabsEl.classList.toggle("disabled", !seg);
    document.querySelectorAll(".mode-tab").forEach((btn) => {
        btn.classList.toggle("active", !!seg && btn.dataset.mode === seg.mode);
    });
}

// ===== MAIN CANVAS DRAW =====
function drawPlayerCanvas() {
    playerCtx.fillStyle = "#000";
    playerCtx.fillRect(0, 0, playerCanvas.width, playerCanvas.height);

    if (!activeVideoEl || !videoNaturalW) return;

    // NAYA: agar timeline engine keh raha hai ke is waqt koi video-clip active nahi
    // (delete ho chuki / gap hai), to canvas blank hi rehne do — video frame mat khincho.
    if (typeof window.__activeVideoClipForCanvas !== "undefined" && !window.__activeVideoClipForCanvas) return;

    // NAYA (glitch-fix): playback ke dauran seek chal rahi ho (clip boundary par
    // cut) to purane clip ka stale frame 1-2 frames ke liye mat dikhao — yahi
    // stale frame "same part bar bar play" wala visual glitch banata tha.
    if (typeof videoSeekGuard !== "undefined" && videoSeekGuard > 0) return;

    computeFitRect();
    // COLOR GRADE: canvas filter (brightness/contrast/saturate) + temp/vignette
    // overlays (color_grade.js helpers) — Before/After hold par grade bypass
    if (typeof cgCanvasFilter === "function") playerCtx.filter = cgCanvasFilter();
    playerCtx.drawImage(activeVideoEl, fitRect.x, fitRect.y, fitRect.w, fitRect.h);
    playerCtx.filter = "none";
    if (typeof cgApplyTemperatureOverlay === "function") cgApplyTemperatureOverlay(playerCtx, playerCanvas.width, playerCanvas.height);
    if (typeof cgApplyVignette === "function") cgApplyVignette(playerCtx, playerCanvas.width, playerCanvas.height);

    const seg = (typeof getActiveSegment === "function") ? getActiveSegment() : null;
    if (!seg || seg.mode === "horizontal") {
        // koi box nahi is case mein, lekin caption phir bhi dikhna chahiye
        // isPreview=false: ye player-canvas hai, drag/resize yahan nahi hoti
        if (typeof drawCaptionsOnCanvas === "function") drawCaptionsOnCanvas(playerCtx, fitRect.x, fitRect.y, fitRect.w, fitRect.h, 1080, false);
        return;
    }

    const boxes = getSegmentBoxes(seg, seg.mode);

    playerCtx.save();
    playerCtx.beginPath();
    playerCtx.rect(fitRect.x, fitRect.y, fitRect.w, fitRect.h);
    playerCtx.clip();
    playerCtx.fillStyle = "rgba(0,0,0,0.45)";
    playerCtx.fillRect(fitRect.x, fitRect.y, fitRect.w, fitRect.h);
    playerCtx.restore();

    boxes.forEach((box, idx) => {
        const px = fitRect.x + box.x * fitRect.w;
        const py = fitRect.y + box.y * fitRect.h;
        const pw = box.w * fitRect.w;
        const ph = box.h * fitRect.h;

        playerCtx.drawImage(
            activeVideoEl,
            box.x * videoNaturalW, box.y * videoNaturalH,
            box.w * videoNaturalW, box.h * videoNaturalH,
            px, py, pw, ph
        );

        playerCtx.strokeStyle = box.isPiP ? "#ffb020" : "#0d6efd";
        playerCtx.lineWidth = 2;
        playerCtx.strokeRect(px, py, pw, ph);

        playerCtx.fillStyle = box.isPiP ? "#ffb020" : "#0d6efd";
        playerCtx.font = "bold 14px Arial";
        playerCtx.fillText(`${idx + 1}`, px + 6, py + 18);

        const handleSize = 10;
        playerCtx.fillRect(px + pw - handleSize / 2, py + ph - handleSize / 2, handleSize, handleSize);
    });

    // isPreview=false: player-canvas, sirf dikhana hai, drag yahan nahi hoti
    if (typeof drawCaptionsOnCanvas === "function") drawCaptionsOnCanvas(playerCtx, fitRect.x, fitRect.y, fitRect.w, fitRect.h, 1080, false);
}

function getNormalizedPos(e) {
    const rect = playerCanvas.getBoundingClientRect();
    const canvasX = e.clientX - rect.left;
    const canvasY = e.clientY - rect.top;
    return {
        x: (canvasX - fitRect.x) / fitRect.w,
        y: (canvasY - fitRect.y) / fitRect.h,
    };
}

// NOTE: spotlight-bubble interaction PREVIEW canvas par rehti hai (spotlight.js
// khud apna mousedown listener lagati hai) — player canvas par sirf ghost guide
// draw hota hai (drawSpotlightOverlay), isliye yahan koi integration nahi.
playerCanvas.addEventListener("mousedown", (e) => {
    const seg = (typeof getActiveSegment === "function") ? getActiveSegment() : null;
    if (!seg || seg.mode === "horizontal") return; // disabled jab koi segment active nahi

    const boxes = getSegmentBoxes(seg, seg.mode);
    const rect = playerCanvas.getBoundingClientRect();
    const canvasX = e.clientX - rect.left;
    const canvasY = e.clientY - rect.top;

    // NAYA: resize-handle ka hit-test ab PIXEL-space mein hai (fitRect ke
    // percentage se nahi) — pehle 0.02 (2%) normalized tolerance thi jo
    // window/video size ke hisaab se kabhi bohat chhoti ho jati thi, isliye
    // corner-drag miss ho kar box "move" jaisa behave karta tha. Ab hit-zone
    // hamesha ek fixed, visually-drawn-handle se bara pixel-radius hai, aur
    // SAB boxes ke handles pehle check hote hain (move-check se pehle).
    const HANDLE_HIT_RADIUS = 14; // px — 10px wale drawn handle se thoda bara, aasan grab

    for (let i = boxes.length - 1; i >= 0; i--) {
        const box = boxes[i];
        const px = fitRect.x + box.x * fitRect.w;
        const py = fitRect.y + box.y * fitRect.h;
        const pw = box.w * fitRect.w;
        const ph = box.h * fitRect.h;
        const handlePx = px + pw, handlePy = py + ph;

        if (Math.abs(canvasX - handlePx) <= HANDLE_HIT_RADIUS && Math.abs(canvasY - handlePy) <= HANDLE_HIT_RADIUS) {
            cropDragState = { seg, boxIndex: i, type: "resize", origBox: { ...box } };
            return;
        }
    }

    const pos = getNormalizedPos(e);
    for (let i = boxes.length - 1; i >= 0; i--) {
        const box = boxes[i];
        if (pos.x >= box.x && pos.x <= box.x + box.w && pos.y >= box.y && pos.y <= box.y + box.h) {
            cropDragState = { seg, boxIndex: i, type: "move", startX: pos.x, startY: pos.y, origBox: { ...box } };
            return;
        }
    }
});

document.addEventListener("mousemove", (e) => {
    if (!cropDragState) return;
    const boxes = getSegmentBoxes(cropDragState.seg, cropDragState.seg.mode);
    const box = boxes[cropDragState.boxIndex];
    const pos = getNormalizedPos(e);

    if (cropDragState.type === "move") {
        const dx = pos.x - cropDragState.startX;
        const dy = pos.y - cropDragState.startY;
        let newX = cropDragState.origBox.x + dx;
        let newY = cropDragState.origBox.y + dy;
        newX = Math.max(0, Math.min(newX, 1 - box.w));
        newY = Math.max(0, Math.min(newY, 1 - box.h));
        box.x = newX;
        box.y = newY;
    } else if (cropDragState.type === "resize") {
        const aspect = cropDragState.origBox.w / cropDragState.origBox.h;
        let newW = Math.max(0.05, pos.x - box.x);
        let newH = newW / aspect;

        if (box.y + newH > 1) {
            newH = 1 - box.y;
            newW = newH * aspect;
        }
        if (box.x + newW > 1) {
            newW = 1 - box.x;
            newH = newW / aspect;
        }
        box.w = newW;
        box.h = newH;
    }
});

document.addEventListener("mouseup", () => {
    if (cropDragState) {
        if (typeof persistTimelineState === "function") persistTimelineState();
    }
    cropDragState = null;
});

// ===== PREVIEW (9:16) =====
function drawPreview() {
    previewCtx.fillStyle = "#000";
    previewCtx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);

    if (!activeVideoEl || !videoNaturalW) return;

    // NAYA: yahan bhi wahi guard — deleted/gap region par preview bhi blank rahe.
    if (typeof window.__activeVideoClipForCanvas !== "undefined" && !window.__activeVideoClipForCanvas) return;

    // seek-guard: player-canvas wala hi rule (stale frame = glitch)
    if (typeof videoSeekGuard !== "undefined" && videoSeekGuard > 0) return;

    const seg = (typeof getActiveSegment === "function") ? getActiveSegment() : null;

    const scaleX = previewCanvas.width / OUTPUT_W;
    const scaleY = previewCanvas.height / OUTPUT_H;

    // FIX: koi active segment na ho, ya mode "horizontal" ho — dono cases mein
    // poori video letterboxed dikhao (as-it-is), black/blank NAHI.
    if (!seg || seg.mode === "horizontal") {
        // SHORTS CANVAS (naya): ON ho to poori 9:16 composition yahin bana do —
        // bg blur/color + adjustable video box. Caller (caption/transforms) isi
        // composed frame par kaam karega.
        try {
            if (typeof scApplyToPreview === "function" && scApplyToPreview(previewCanvas, previewCtx, activeVideoEl, videoNaturalW, videoNaturalH)) {
                if (typeof drawCaptionsOnCanvas === "function") drawCaptionsOnCanvas(previewCtx, 0, 0, previewCanvas.width, previewCanvas.height, OUTPUT_H, true);
                try { if (typeof transApplyToCanvas === "function") transApplyToCanvas(previewCanvas, previewCtx, virtualTime); } catch (err) {}
                try { if (typeof pzApplyToCanvas === "function") pzApplyToCanvas(previewCanvas, previewCtx, virtualTime); } catch (err) {}
                return;
            }
        } catch (err) { console.warn("shorts canvas compose:", err); }
        const videoAspect = videoNaturalW / videoNaturalH;
        const canvasAspect = previewCanvas.width / previewCanvas.height;
        let dw, dh, dx, dy;
        if (videoAspect > canvasAspect) {
            dw = previewCanvas.width;
            dh = dw / videoAspect;
        } else {
            dh = previewCanvas.height;
            dw = dh * videoAspect;
        }
        dx = (previewCanvas.width - dw) / 2;
        dy = (previewCanvas.height - dh) / 2;
        // COLOR GRADE: filter + temp/vignette overlays (final 9:16 output bhi graded)
        if (typeof cgCanvasFilter === "function") previewCtx.filter = cgCanvasFilter();
        previewCtx.drawImage(activeVideoEl, 0, 0, videoNaturalW, videoNaturalH, dx, dy, dw, dh);
        previewCtx.filter = "none";
        if (typeof cgApplyTemperatureOverlay === "function") cgApplyTemperatureOverlay(previewCtx, previewCanvas.width, previewCanvas.height);
        if (typeof cgApplyVignette === "function") cgApplyVignette(previewCtx, previewCanvas.width, previewCanvas.height);
        // isPreview=true: ye asal 9:16 output hai, yahi par drag/resize hoti hai
        if (typeof drawCaptionsOnCanvas === "function") drawCaptionsOnCanvas(previewCtx, 0, 0, previewCanvas.width, previewCanvas.height, OUTPUT_H, true);
        // TITLES LAYER (9:16 headings — caption-cues text-source; captions ke baad,
        // panz/trans-transforms se PEHLE: title-grade-relevant nahi hai)
        try { if (typeof drawTitleOnCanvas === "function") drawTitleOnCanvas(previewCtx, 0, 0, previewCanvas.width, previewCanvas.height, OUTPUT_H, true); } catch (err) {}
        try { if (typeof titlesDrawOverlay === "function") titlesDrawOverlay(); } catch (err) {}
        // NAYE LAYERS: Pan&Zoom + Transition frame-transform (grade/captions ke BAAD — output-window ke andar)
        try { if (typeof transApplyToCanvas === "function") transApplyToCanvas(previewCanvas, previewCtx, virtualTime); } catch (err) {}
        try { if (typeof pzApplyToCanvas === "function") pzApplyToCanvas(previewCanvas, previewCtx, virtualTime); } catch (err) {}
        return;
    }

    // SHORTS CANVAS (naya): segment-mode par bhi shorts composition priority —
    // preview = final 9:16 output, shorts ON ho to wahi compose hota hai.
    try {
        if (typeof scApplyToPreview === "function" && scApplyToPreview(previewCanvas, previewCtx, activeVideoEl, videoNaturalW, videoNaturalH)) {
            if (typeof drawCaptionsOnCanvas === "function") drawCaptionsOnCanvas(previewCtx, 0, 0, previewCanvas.width, previewCanvas.height, OUTPUT_H, true);
            // TITLES (shorts compose path)
            try { if (typeof drawTitleOnCanvas === "function") drawTitleOnCanvas(previewCtx, 0, 0, previewCanvas.width, previewCanvas.height, OUTPUT_H, true); } catch (err) {}
            try { if (typeof titlesDrawOverlay === "function") titlesDrawOverlay(); } catch (err) {}
            try { if (typeof transApplyToCanvas === "function") transApplyToCanvas(previewCanvas, previewCtx, virtualTime); } catch (err) {}
            try { if (typeof pzApplyToCanvas === "function") pzApplyToCanvas(previewCanvas, previewCtx, virtualTime); } catch (err) {}
            return;
        }
    } catch (err) { console.warn("shorts canvas compose:", err); }

    const boxes = getSegmentBoxes(seg, seg.mode);
    if (typeof cgCanvasFilter === "function") previewCtx.filter = cgCanvasFilter();
    boxes.forEach((box) => {
        const sx = box.x * videoNaturalW, sy = box.y * videoNaturalH;
        const sw = box.w * videoNaturalW, sh = box.h * videoNaturalH;
        const dx = box.slot.x * OUTPUT_W * scaleX, dy = box.slot.y * OUTPUT_H * scaleY;
        const dw = box.slot.w * OUTPUT_W * scaleX, dh = box.slot.h * OUTPUT_H * scaleY;
        previewCtx.drawImage(activeVideoEl, sx, sy, sw, sh, dx, dy, dw, dh);
    });
    previewCtx.filter = "none";
    if (typeof cgApplyTemperatureOverlay === "function") cgApplyTemperatureOverlay(previewCtx, previewCanvas.width, previewCanvas.height);
    if (typeof cgApplyVignette === "function") cgApplyVignette(previewCtx, previewCanvas.width, previewCanvas.height);
    // caption poore 9:16 frame par fixed rehta hai — kisi ek box/slot se tied nahi
    // isPreview=true: ye asal 9:16 output hai, yahi par drag/resize hoti hai
    if (typeof drawCaptionsOnCanvas === "function") drawCaptionsOnCanvas(previewCtx, 0, 0, previewCanvas.width, previewCanvas.height, OUTPUT_H, true);
    // TITLES LAYER (segment-mode path — layer pattern shorts/no-seg jaise hi)
    try { if (typeof drawTitleOnCanvas === "function") drawTitleOnCanvas(previewCtx, 0, 0, previewCanvas.width, previewCanvas.height, OUTPUT_H, true); } catch (err) {}
    try { if (typeof titlesDrawOverlay === "function") titlesDrawOverlay(); } catch (err) {}
    // NAYE LAYERS: Pan&Zoom + Transition frame-transform (grade/captions ke BAAD — output-window ke andar)
    try { if (typeof transApplyToCanvas === "function") transApplyToCanvas(previewCanvas, previewCtx, virtualTime); } catch (err) {}
    try { if (typeof pzApplyToCanvas === "function") pzApplyToCanvas(previewCanvas, previewCtx, virtualTime); } catch (err) {}
}

// CRITICAL FIX: render loop ab exception-proof hai. Pehle agar drawPlayerCanvas/
// drawPreview/updateModeTabsUI mein KOI bhi error aati (halke caption cue ke
// words missing hona, segment ka mode undefined hona, waghera) to neeche wala
// requestAnimationFrame KABHI nahi chalta tha -> loop hamesha ke liye mar jata
// tha -> dono canvas blank/frozen aur playhead akela chalta rehta. Ab har step
// apne try/catch mein hai — error par sirf wo frame skip hota hai, loop chalta
// rehta hai aur agli frame par khud theek ho jata hai.
function renderLoop() {
    try { drawPlayerCanvas(); } catch (err) { console.warn("drawPlayerCanvas error (skipped frame):", err); }
    try { drawPreview(); } catch (err) { console.warn("drawPreview error (skipped frame):", err); }
    try { updateModeTabsUI(); } catch (err) { console.warn("updateModeTabsUI error:", err); }
    try { if (typeof drawSpotlightOverlay === "function") drawSpotlightOverlay(); } catch (err) { console.warn("spotlight overlay error (skipped frame):", err); }
    requestAnimationFrame(renderLoop);
}

renderModeTabs();
```

### Name: frontend/editor_tools.js
```js
let clipboardItems = []; // [{kind, data, offset}]
let undoStack = [];
let redoStack = [];

function snapshotState() {
    return {
        // TITLES LAYER (undo/redo mein)
        titlesSpans: JSON.parse(JSON.stringify(titlesSpans || [])),
        segments: JSON.parse(JSON.stringify(segments)),
        audioLanes: JSON.parse(JSON.stringify(audioLanes)),
        videoClips: JSON.parse(JSON.stringify(videoClips)),
        // STACK-2 bhi undo/redo mein
        stack2Segments: JSON.parse(JSON.stringify(stack2Segments || [])),
        stack2AudioLanes: JSON.parse(JSON.stringify(stack2AudioLanes || [])),
        stack2VideoClips: JSON.parse(JSON.stringify(stack2VideoClips || [])),
        stackCount: (typeof stackCount !== "undefined") ? stackCount : 1,
        // NAYE EFFECT-LAYERS bhi undo/redo mein
        captionSpans: JSON.parse(JSON.stringify(captionSpans || [])),
        transitions: JSON.parse(JSON.stringify(transitions || [])),
        panZoomSpans: JSON.parse(JSON.stringify(panZoomSpans || [])),
        gradeSpans: JSON.parse(JSON.stringify(gradeSpans || [])),
        // SHORTS CANVAS (undo/redo mein bhi)
        shortsCanvas: (typeof scPersistPayload === "function") ? scPersistPayload() : null,
    };
}

function pushHistory() {
    undoStack.push(snapshotState());
    if (undoStack.length > 50) undoStack.shift();
    redoStack = [];
}

function clearHistory() {
    undoStack = [];
    redoStack = [];
}

function restoreState(state) {
    segments = state.segments;
    audioLanes = state.audioLanes;
    videoClips = state.videoClips;
    // STACK-2 restore (purane snapshots mein nahi hota — khali reset)
    stack2Segments = state.stack2Segments || [];
    stack2AudioLanes = state.stack2AudioLanes || [];
    stack2VideoClips = state.stack2VideoClips || [];
    // NAYE EFFECT-LAYERS restore
    captionSpans = state.captionSpans || [];
    transitions = state.transitions || [];
    panZoomSpans = state.panZoomSpans || [];
    titlesSpans = state.titlesSpans || [];
    // SHORTS CANVAS restore (purane snapshots me nahi hota — skip)
    if (state.shortsCanvas !== undefined && typeof scLoadFromState === "function") { try { scLoadFromState(state.shortsCanvas); } catch (e) {} }
    gradeSpans = state.gradeSpans || [];
    if (typeof ensureStackCount === "function") {
        ensureStackCount(state.stackCount || (stack2VideoClips.length || stack2Segments.length ? 2 : 1));
    }
    if (typeof updateStackLabels === "function") updateStackLabels();
    clearSelection();
    recalcTimelineDuration();
    renderAll();
    persistTimelineState();
}

function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshotState());
    restoreState(undoStack.pop());
}

function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshotState());
    restoreState(redoStack.pop());
}

function getByKindId(kind, id) {
    if (kind === "segment") return getSegmentById(id);
    if (kind === "audio") return getAudioById(id);
    if (kind === "video") return getVideoClipById(id);
    // NAYE EFFECT-LAYERS (timeline.js getters)
    if (typeof getItemByKindId === "function") return getItemByKindId(kind, id);
    return null;
}

function arrayOfKind(kind) {
    if (kind === "segment") return segments;
    if (kind === "audio") return audioLanes;
    if (kind === "video") return videoClips;
    // NAYE EFFECT-LAYERS
    if (typeof arrayOfEffectKind === "function") {
        const arr = arrayOfEffectKind(kind);
        if (arr) return arr;
    }
    return [];
}

// ===== SPLIT — playhead (virtualTime, i.e. timeline position — NOT mainPlayer.currentTime
//        which is now the *source* position) par selected item(s) ko todna =====
// STACK-AWARE: jo item jis stack ka hai, usi stack ke array mein split hota hai.
function splitSelectedAtPlayhead() {
    if (!selectedItems.length) return;
    const t = virtualTime;

    const splittable = selectedItems.filter(({ kind, id }) => {
        const item = getByKindId(kind, id);
        return item && (t - item.start > 0.1) && (item.end - t > 0.1);
    });
    if (!splittable.length) return;

    pushHistory();

    splittable.forEach(({ kind, id }) => {
        const item = getByKindId(kind, id);
        // item jis stack ke array mein mila wahi array use hoga (S1 ya S2)
        let arr = arrayOfKind(kind);
        if (typeof isEffectKind !== "function" || !isEffectKind(kind)) {
            for (let s = 1; s <= (typeof totalStacks === "function" ? totalStacks() : 1); s++) {
                const cand = arrayOfKindInStack(kind, s);
                if (cand.some((x) => x.id === item.id)) { arr = cand; break; }
            }
        }

        // NAYE EFFECT-LAYERS: poora object deep-copy right-half mein (style/grade/box
        // sab sath jata hai) — baad mein user right piece ki settings alag badal sakta hai
        if (typeof isEffectKind === "function" && isEffectKind(kind)) {
            const rightHalf = JSON.parse(JSON.stringify(item));
            rightHalf.id = genId();
            rightHalf.start = t;
            item.end = t;
            arr.splice(arr.indexOf(item) + 1, 0, rightHalf);
            return;
        }

        if (kind === "segment") {
            const rightHalf = {
                id: genId(), start: t, end: item.end, mode: item.mode,
                modeBoxState: JSON.parse(JSON.stringify(item.modeBoxState || {})),
                muted: !!item.muted, audioDetached: !!item.audioDetached,
            };
            if (item.bubbleState) rightHalf.bubbleState = JSON.parse(JSON.stringify(item.bubbleState));
            if (item.bubbleZoom !== undefined) rightHalf.bubbleZoom = item.bubbleZoom;
            if (item.bubbleStyle) rightHalf.bubbleStyle = item.bubbleStyle;
            if (item.bubbleBorder) rightHalf.bubbleBorder = JSON.parse(JSON.stringify(item.bubbleBorder));
            if (item.bubbleShadow) rightHalf.bubbleShadow = JSON.parse(JSON.stringify(item.bubbleShadow));
            item.end = t;
            arr.splice(arr.indexOf(item) + 1, 0, rightHalf);
        } else if (kind === "audio") {
            const splitSrc = item.sourceStart + (t - item.start);
            const rightHalf = {
                id: genId(), start: t, end: item.end,
                sourceStart: splitSrc, sourceEnd: item.sourceEnd,
                muted: !!item.muted, sourceClipId: item.sourceClipId,
            };
            item.end = t;
            item.sourceEnd = splitSrc;
            arr.splice(arr.indexOf(item) + 1, 0, rightHalf);
        } else if (kind === "video") {
            const splitSrc = item.sourceStart + (t - item.start);
            const rightHalf = {
                id: genId(), start: t, end: item.end,
                sourceStart: splitSrc, sourceEnd: item.sourceEnd,
                muted: !!item.muted, audioDetached: !!item.audioDetached,
            };
            item.end = t;
            item.sourceEnd = splitSrc;
            arr.splice(arr.indexOf(item) + 1, 0, rightHalf);
        }
        // left half (original id) selected hi rehta hai — jaisa pehle hota tha
    });

    recalcTimelineDuration();
    renderAll();
    persistTimelineState();
}

// ===== COPY / PASTE — multi-select ko group ke tor par copy karta hai, relative spacing preserve hoti hai
// STACK-AWARE: copied item apna stack carry karta hai; paste usi stack ke array mein jata hai.
function copySelected() {
    if (!selectedItems.length) { clipboardItems = []; return; }
    const items = selectedItems
        .map(({ kind, id }) => ({ kind, data: getByKindId(kind, id) }))
        .filter((x) => x.data);
    if (!items.length) { clipboardItems = []; return; }

    const minStart = Math.min(...items.map((x) => x.data.start));
    clipboardItems = items.map((x) => ({
        kind: x.kind,
        data: JSON.parse(JSON.stringify(x.data)),
        offset: x.data.start - minStart,
        stack: (x.data && x.data.__stack) || (typeof getStackOf === "function" ? getStackOf(x.kind, x.data.id) : 1),
    }));
}

function pasteClipboard() {
    if (!clipboardItems.length) return;
    const t = virtualTime; // timeline position (was incorrectly mainPlayer.currentTime before)
    pushHistory();

    const newSelection = [];
    clipboardItems.forEach(({ kind, data, offset, stack }) => {
        const dur = data.end - data.start;
        const start = Math.max(0, t + offset), end = start + dur; // no upper clamp — timeline auto-extends
        const targetStack = (stack === 2) ? 2 : 1; // copied item apna stack carry karta hai
        const arrs = (typeof stackArrays === "function") ? stackArrays(targetStack) : { segment: segments, audio: audioLanes, video: videoClips };

        // NAYE EFFECT-LAYERS: poora object deep-copy + naya id
        if (typeof arrayOfEffectKind === "function") {
            const effArr = arrayOfEffectKind(kind);
            if (effArr) {
                const newItem = JSON.parse(JSON.stringify(data));
                newItem.id = genId();
                newItem.start = start;
                newItem.end = end;
                effArr.push(newItem);
                newSelection.push({ kind, id: newItem.id });
                return;
            }
        }

        let newItem = null;
        if (kind === "segment") {
            newItem = {
                id: genId(), start, end, mode: data.mode,
                modeBoxState: JSON.parse(JSON.stringify(data.modeBoxState || {})),
                muted: !!data.muted, audioDetached: !!data.audioDetached,
            };
            if (data.bubbleState) newItem.bubbleState = JSON.parse(JSON.stringify(data.bubbleState));
            if (data.bubbleZoom !== undefined) newItem.bubbleZoom = data.bubbleZoom;
            if (data.bubbleStyle) newItem.bubbleStyle = data.bubbleStyle;
            if (data.bubbleBorder) newItem.bubbleBorder = JSON.parse(JSON.stringify(data.bubbleBorder));
            if (data.bubbleShadow) newItem.bubbleShadow = JSON.parse(JSON.stringify(data.bubbleShadow));
            arrs.segment.push(newItem);
        } else if (kind === "audio") {
            newItem = {
                id: genId(), start, end,
                sourceStart: data.sourceStart, sourceEnd: data.sourceEnd,
                muted: !!data.muted, sourceClipId: data.sourceClipId,
            };
            arrs.audio.push(newItem);
        } else if (kind === "video") {
            newItem = {
                id: genId(), start, end,
                sourceStart: data.sourceStart, sourceEnd: data.sourceEnd,
                muted: !!data.muted, audioDetached: !!data.audioDetached,
            };
            arrs.video.push(newItem);
        }
        if (newItem) newSelection.push({ kind, id: newItem.id });
    });

    selectedItems = newSelection;
    syncSelectionMirrors();
    recalcTimelineDuration();
    renderAll();
    persistTimelineState();
}

// ===== DUPLICATE — har selected item apne hi end ke turant baad clone hota hai =====
function duplicateSelected() {
    if (!selectedItems.length) return;
    pushHistory();
    const newSelection = [];

    selectedItems.forEach(({ kind, id }) => {
        const item = getByKindId(kind, id);
        if (!item) return;
        // NAYE EFFECT-LAYERS: deep-copy + naya id, original ke end ke baad
        if (typeof arrayOfEffectKind === "function") {
            const effArr = arrayOfEffectKind(kind);
            if (effArr) {
                const newItem = JSON.parse(JSON.stringify(item));
                newItem.id = genId();
                newItem.start = item.end;
                newItem.end = item.end + (item.end - item.start);
                effArr.push(newItem);
                newSelection.push({ kind, id: newItem.id });
                return;
            }
        }
        const dur = item.end - item.start;
        const start = item.end, end = start + dur; // no upper clamp — timeline auto-extends
        const arrs = (typeof stackArrays === "function") ? stackArrays(getStackOf(kind, id)) : { segment: segments, audio: audioLanes, video: videoClips };

        let newItem = null;
        if (kind === "segment") {
            newItem = {
                id: genId(), start, end, mode: item.mode,
                modeBoxState: JSON.parse(JSON.stringify(item.modeBoxState || {})),
                muted: !!item.muted, audioDetached: !!item.audioDetached,
            };
            if (item.bubbleState) newItem.bubbleState = JSON.parse(JSON.stringify(item.bubbleState));
            if (item.bubbleZoom !== undefined) newItem.bubbleZoom = item.bubbleZoom;
            if (item.bubbleStyle) newItem.bubbleStyle = item.bubbleStyle;
            if (item.bubbleBorder) newItem.bubbleBorder = JSON.parse(JSON.stringify(item.bubbleBorder));
            if (item.bubbleShadow) newItem.bubbleShadow = JSON.parse(JSON.stringify(item.bubbleShadow));
            arrs.segment.push(newItem);
        } else if (kind === "audio") {
            newItem = {
                id: genId(), start, end,
                sourceStart: item.sourceStart, sourceEnd: item.sourceEnd,
                muted: !!item.muted, sourceClipId: item.sourceClipId,
            };
            arrs.audio.push(newItem);
        } else if (kind === "video") {
            newItem = {
                id: genId(), start, end,
                sourceStart: item.sourceStart, sourceEnd: item.sourceEnd,
                muted: !!item.muted, audioDetached: !!item.audioDetached,
            };
            arrs.video.push(newItem);
        }
        if (newItem) newSelection.push({ kind, id: newItem.id });
    });

    selectedItems = newSelection;
    syncSelectionMirrors();
    recalcTimelineDuration();
    renderAll();
    persistTimelineState();
}

// ===== MUTE — jo bhi selected ho (kisi bhi layer ka) uska muted flag toggle =====
function toggleMuteSelected() {
    if (!selectedItems.length) return;
    pushHistory();
    selectedItems.forEach(({ kind, id }) => {
        const item = getByKindId(kind, id);
        if (item) item.muted = !item.muted;
    });
    renderAll();
    persistTimelineState();
}

// ===== DETACH AUDIO — sirf selected VIDEO clip par kaam karta hai; naye audioLane
//        mein sourceStart/sourceEnd bhi carry hote hain (taake uska waveform sahi dikhe) =====
function toggleDetachAudioSelected() {
    const videoIds = selectedIdsOf("video");
    if (!videoIds.length) return;
    pushHistory();

    videoIds.forEach((id) => {
        const c = getVideoClipById(id);
        if (!c) return;
        c.audioDetached = !c.audioDetached;

        if (c.audioDetached) {
            audioLanes.push({
                id: genId(), start: c.start, end: c.end,
                sourceStart: c.sourceStart, sourceEnd: c.sourceEnd,
                muted: false, sourceClipId: c.id,
            });
        } else {
            audioLanes = audioLanes.filter((a) => a.sourceClipId !== c.id);
        }
    });

    renderAll();
    persistTimelineState();
}

// ===== DELETE — jo bhi selected ho, sab hat jayen =====
// NEW — RIPPLE DELETE: video-clip delete hone par baad ki clips LEFT shift ho
// kar gap ko close kar deti hain (Filmora-style). Pehle user ko gap ke baad
// clips manually drag kar ke join karni padti thi, aur wo manual join hi glitch
// ka doosra sabab tha (overlaps + drift). Ab join automatic aur exact hai — na
// gap bachta hai na overlap. NOTE: pehli clip apni jagah anchored rehti hai
// (intentionally rakha hua leading gap kharab nahi hota); sirf andar ke gaps
// close hote hain.
function rippleCloseVideoGaps() {
    rippleCloseIn(videoClips);
    rippleCloseIn(stack2VideoClips || []); // STACK-2 bhi
}

function rippleCloseIn(clipArr) {
    if (clipArr.length < 2) return;
    const sorted = [...clipArr].sort((a, b) => a.start - b.start);
    let cursor = sorted[0].start; // first clip anchored
    for (const c of sorted) {
        const dur = c.end - c.start;
        if (Math.abs(c.start - cursor) > 1e-6) {
            c.start = cursor;
            c.end = cursor + dur;
        }
        cursor = c.end;
    }
}

// ===== GAP FILL — video clips ke beech ki SARI gaps ek click par close =====
// Speed change karne par clips apni jagah shrink ho jati hain aur beech mein
// gaps reh jate hain. Ye button un sab ko left-ripple se join kar deta hai
// (wahi jo delete ke baad automatic hota hai — par yeh manual trigger hai).
function fillAllVideoGaps() {
    if (!videoClips.length) return;
    pushHistory();
    rippleCloseVideoGaps();
    recalcTimelineDuration();
    renderAll();
    persistTimelineState();
    seekVirtual(Math.min(virtualTime, timelineContentEnd));
}

function deleteSelected() {
    if (!selectedItems.length) return;
    pushHistory();
    let videoDeleted = false;

    selectedItems.forEach(({ kind, id }) => {
        // NAYE EFFECT-LAYERS delete (koi stack concept nahi)
        if (typeof arrayOfEffectKind === "function") {
            const effArr = arrayOfEffectKind(kind);
            if (effArr) {
            const idx = effArr.findIndex((x) => x.id === id);
            if (idx >= 0) effArr.splice(idx, 1);
            if (kind === "panZoom" && typeof pzOnDeleted === "function") pzOnDeleted(id);
            // (USER FIX) AAKHRI grade-span delete → global colorGrade (panel
            // working-buffer) bhi reset — warna usme pada last-preset color
            // render-fallback se video par chipak jata tha (delete kar bhi
            // color wapas aa jata tha wala bug).
            if (kind === "gradeSpan" && effArr.length === 0 && typeof colorGrade !== "undefined") {
                Object.keys(colorGrade).forEach((k) => { colorGrade[k] = 0; });
                if (typeof cgSyncUI === "function") cgSyncUI();
            }
            return;
            }
        }
        // STACK-AWARE delete: item jis stack ka hai, usi ke array se hatega
        const stack = getStackOf(kind, id);
        const arrs = stackArrays(stack);
        if (kind === "segment") {
            if (stack === 2) stack2Segments = arrs.segment.filter((s) => s.id !== id);
            else segments = arrs.segment.filter((s) => s.id !== id);
        } else if (kind === "audio") {
            if (stack === 2) stack2AudioLanes = arrs.audio.filter((a) => a.id !== id);
            else audioLanes = arrs.audio.filter((a) => a.id !== id);
        } else if (kind === "video") {
            if (stack === 2) {
                stack2VideoClips = arrs.video.filter((c) => c.id !== id);
                stack2AudioLanes = stack2AudioLanes.filter((a) => a.sourceClipId !== id);
            } else {
                videoClips = arrs.video.filter((c) => c.id !== id);
                audioLanes = audioLanes.filter((a) => a.sourceClipId !== id);
            }
            videoDeleted = true;
        }
    });

    clearSelection();
    if (videoDeleted) rippleCloseVideoGaps(); // sirf video-delete par ripple
    recalcTimelineDuration();
    renderAll();
    persistTimelineState();
    seekVirtual(virtualTime); // re-evaluate what should be playing/showing right now
}

document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey && e.key.toLowerCase() === "y") || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "z")) { e.preventDefault(); redo(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === "c") { e.preventDefault(); copySelected(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === "v") { e.preventDefault(); pasteClipboard(); return; }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "d") { e.preventDefault(); toggleDetachAudioSelected(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateSelected(); return; }
    if (!e.ctrlKey && e.key.toLowerCase() === "x") { e.preventDefault(); splitSelectedAtPlayhead(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === "t") { e.preventDefault(); splitSelectedAtPlayhead(); return; }
    if (!e.ctrlKey && e.key.toLowerCase() === "m") { e.preventDefault(); toggleMuteSelected(); return; }
    if (e.key === "Delete") { e.preventDefault(); deleteSelected(); return; }
});

document.getElementById("splitBtn").addEventListener("click", splitSelectedAtPlayhead);
document.getElementById("gapFillBtn").addEventListener("click", fillAllVideoGaps);
document.getElementById("copyBtn").addEventListener("click", copySelected);
document.getElementById("pasteBtn").addEventListener("click", pasteClipboard);
document.getElementById("duplicateBtn").addEventListener("click", duplicateSelected);
document.getElementById("deleteBtn").addEventListener("click", deleteSelected);
document.getElementById("muteBtn").addEventListener("click", toggleMuteSelected);
document.getElementById("detachAudioBtn").addEventListener("click", toggleDetachAudioSelected);
document.getElementById("undoBtn").addEventListener("click", undo);
document.getElementById("redoBtn").addEventListener("click", redo);

// ===== SILENCE / FILLER-WORD DETECTION =====
// silence_engine.py video ki ORIGINAL file ko process karta hai, isliye jo
// {start, end} ranges wapas aate hain wo hamesha SOURCE-time mein hote hain
// (0 se sourceDuration tak) — TIMELINE-position nahi. Agar clip kabhi
// move/trim/split hui ho, to source-time aur timeline-time ek jaisi nahi
// rehti. Isi liye yahan har range ko us clip ke sourceStart/sourceEnd se
// map kar ke sahi timeline-position par split karte hain.
const SILENCE_EPS = 0.02;

function splitArrayAtTimelinePos(arr, t) {
    for (let i = arr.length - 1; i >= 0; i--) {
        const item = arr[i];
        if (t - item.start > SILENCE_EPS && item.end - t > SILENCE_EPS) {
            const splitSrc = item.sourceStart + (t - item.start);
            const rightHalf = JSON.parse(JSON.stringify(item));
            rightHalf.id = genId();
            rightHalf.start = t;
            rightHalf.sourceStart = splitSrc;
            item.end = t;
            item.sourceEnd = splitSrc;
            arr.splice(i + 1, 0, rightHalf);
        }
    }
}

// Ek source-time range (srcStart..srcEnd) ko us array ke jitne bhi clips
// overlap karti hain, unke andar timeline-position par convert kar ke split
// karta hai, aur poori tarah range ke andar aane wale pieces ko selection
// mein daal deta hai.
function splitArrayAtSourceRange(arr, srcStart, srcEnd, kind, selectionOut) {
    const targets = arr.filter(
        (it) => it.sourceStart < srcEnd - SILENCE_EPS && it.sourceEnd > srcStart + SILENCE_EPS
    );
    targets.forEach((clip) => {
        const overlapStart = Math.max(srcStart, clip.sourceStart);
        const overlapEnd = Math.min(srcEnd, clip.sourceEnd);
        const tlStart = clip.start + (overlapStart - clip.sourceStart);
        const tlEnd = clip.start + (overlapEnd - clip.sourceStart);
        splitArrayAtTimelinePos(arr, tlStart);
        splitArrayAtTimelinePos(arr, tlEnd);
    });

    arr.forEach((it) => {
        if (it.sourceStart >= srcStart - SILENCE_EPS && it.sourceEnd <= srcEnd + SILENCE_EPS) {
            selectionOut.push({ kind, id: it.id });
        }
    });
}

async function detectSilenceAndFillers() {
    if (!currentVideoRef) return;
    const btn = document.getElementById("detectSilenceBtn");
    const label = btn.querySelector(".tool-label");
    const original = label ? label.textContent : null;
    btn.disabled = true;
    if (label) label.textContent = "Detecting…";

    try {
        const res = await fetch(`/video/${currentVideoRef.saved_name}/detect_silence`, { method: "POST" });
        const data = await res.json();
        if (data.error) { alert("Detect Silence failed: " + data.error); return; }

        const ranges = data.ranges || [];
        if (!ranges.length) { alert("Koi silence ya filler-word detect nahi hui."); return; }

        pushHistory();
        const newSelection = [];

        // source-time ke hisaab se descending order mein process karo —
        // taake ek range ke split-operations doosri range ki (abhi tak
        // unprocessed) source-time position ko disturb na karen
        const sorted = [...ranges].sort((a, b) => b.start - a.start);
        sorted.forEach(({ start, end }) => {
            splitArrayAtSourceRange(videoClips, start, end, "video", newSelection);
            splitArrayAtSourceRange(audioLanes, start, end, "audio", newSelection);
        });

        selectedItems = newSelection;
        syncSelectionMirrors();
        recalcTimelineDuration();
        renderAll();
        persistTimelineState();

        alert(`${ranges.length} silence/filler portions select ho gaye hain. Delete button ya Delete-key se hata dein, ya kahin aur click kar ke deselect karen.`);
    } catch (err) {
        alert("Detect Silence error: " + err);
    } finally {
        btn.disabled = false;
        if (label && original) label.textContent = original;
    }
}

document.getElementById("detectSilenceBtn").addEventListener("click", detectSilenceAndFillers);

// ===== KEYBINDING-ACTION FUNCTIONS =====
// keybindings.js inhe call karta hai (capture-phase se, double-fire guard ke saath)

// Segment START/END markers (A / D keys) — playhead position par segment banao.
// Pehli baar START, doosri baar END -> segment ready. ESC/START dobara = reset.
let __segMarkStart = null;

function setSegmentMarker(which) {
    if (typeof virtualTime === "undefined" || typeof seekVirtual !== "function") return;
    const t = virtualTime;
    if (which === "start") {
        __segMarkStart = t;
        if (typeof clearSelection === "function") clearSelection();
        if (typeof renderSegments === "function") renderSegments();
        updateMarkerOverlay(t, null);
    } else if (which === "end") {
        if (__segMarkStart === null) {
            // pehle START maarna zaroori hai
            updateMarkerOverlay(null, t);
            return;
        }
        let s = Math.min(__segMarkStart, t);
        let e2 = Math.max(__segMarkStart, t);
        if (e2 - s > 0.15) {
            if (typeof pushHistory === "function") pushHistory();
            const newSeg = {
                id: genId(),
                start: s,
                end: e2,
                mode: "single",
                modeBoxState: {},
                muted: false,
                audioDetached: false,
            };
            segments.push(newSeg);
            if (typeof selectOnly === "function") selectOnly("segment", newSeg.id);
            if (typeof recalcTimelineDuration === "function") recalcTimelineDuration();
            if (typeof renderAll === "function") renderAll();
            persistTimelineState();
        }
        __segMarkStart = null;
        updateMarkerOverlay(null, null);
    }
}

function updateMarkerOverlay(startT, endT) {
    const layer = document.getElementById("markerOverlay");
    if (!layer) return;
    layer.innerHTML = "";
    if (startT !== null && startT !== undefined) {
        const flag = document.createElement("div");
        flag.className = "seg-marker-flag start";
        flag.style.left = (startT * pixelsPerSecond) + "px";
        flag.title = "Segment START (A se set hota hai)";
        layer.appendChild(flag);
    }
    if (endT !== null && endT !== undefined) {
        const flag = document.createElement("div");
        flag.className = "seg-marker-flag end";
        flag.style.left = (endT * pixelsPerSecond) + "px";
        flag.title = "END — lekin pehle START maaro (A)";
        layer.appendChild(flag);
    }
}

// STOP (Num8): pause + playhead 0 par
function stopPlayback() {
    if (typeof pausePlayback === "function") pausePlayback();
    if (typeof seekVirtual === "function") seekVirtual(0);
    const btn = document.getElementById("playPauseBtn");
    if (btn) btn.textContent = "▶";
}
```

### Name: frontend/export_ui.js
```js
// ===== EXPORT MODAL =====

let exportPollTimer = null;

function openExportModal() {
    if (!currentVideoRef) { alert("Pehle koi video import/select karen."); return; }
    document.getElementById("exportModalOverlay").style.display = "flex";
    document.getElementById("exportProgressWrap").style.display = "none";
    document.getElementById("exportResultWrap").style.display = "none";
    document.getElementById("exportStartBtn").style.display = "inline-block";
    document.getElementById("exportStartBtn").disabled = false;
}

function closeExportModal() {
    document.getElementById("exportModalOverlay").style.display = "none";
    if (exportPollTimer) { clearInterval(exportPollTimer); exportPollTimer = null; }
}

function getSelectedRadioValue(name) {
    const el = document.querySelector(`input[name="${name}"]:checked`);
    return el ? el.value : null;
}

async function startExport() {
    const quality = getSelectedRadioValue("exportQuality") || "720p";
    const codec = getSelectedRadioValue("exportCodec") || "h264";

    const startBtn = document.getElementById("exportStartBtn");
    startBtn.disabled = true;
    startBtn.textContent = "Starting…";

    // pehle timeline save karo, taake export bilkul latest state par ho
    if (typeof persistTimelineState === "function") {
        await persistTimelineState();
    }

    try {
        const res = await fetch(`/video/${currentVideoRef.saved_name}/export`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ quality, codec }),
        });
        const data = await res.json();
        if (data.error) { alert("Export start nahi ho saka: " + data.error); resetExportStartBtn(); return; }

        startBtn.style.display = "none";
        document.getElementById("exportProgressWrap").style.display = "block";
        pollExportStatus(data.job_id);
    } catch (err) {
        alert("Export error: " + err);
        resetExportStartBtn();
    }
}

function resetExportStartBtn() {
    const startBtn = document.getElementById("exportStartBtn");
    startBtn.disabled = false;
    startBtn.textContent = "Start Export";
}

function pollExportStatus(jobId) {
    const fill = document.getElementById("exportProgressFill");
    const label = document.getElementById("exportProgressLabel");

    exportPollTimer = setInterval(async () => {
        try {
            const res = await fetch(`/export_status/${jobId}`);
            const job = await res.json();
            if (job.error) {
                clearInterval(exportPollTimer);
                alert("Export status error: " + job.error);
                closeExportModal();
                return;
            }

            const pct = Math.round((job.progress || 0) * 100);
            fill.style.width = `${pct}%`;

            if (job.status === "running") {
                label.textContent = `Rendering… ${pct}%`;
            } else if (job.status === "done") {
                clearInterval(exportPollTimer);
                label.textContent = "Done! Export folder khud khul gaya hai.";
                document.getElementById("exportProgressWrap").style.display = "none";
                document.getElementById("exportResultWrap").style.display = "block";
                const link = document.getElementById("exportDownloadLink");
                link.href = `/exports/${job.filename}`;
                link.setAttribute("download", job.filename);
                link.textContent = "⬇ Download Video (agar folder na khula ho)";
            } else if (job.status === "error") {
                clearInterval(exportPollTimer);
                alert("Export fail ho gaya: " + (job.error || "unknown error"));
                closeExportModal();
            }
        } catch (err) {
            clearInterval(exportPollTimer);
            alert("Export status check error: " + err);
        }
    }, 1000);
}

document.addEventListener("DOMContentLoaded", () => {
    const exportBtn = document.getElementById("exportBtn");
    if (exportBtn) exportBtn.addEventListener("click", openExportModal);

    const cancelBtn = document.getElementById("exportCancelBtn");
    if (cancelBtn) cancelBtn.addEventListener("click", closeExportModal);

    const startBtn = document.getElementById("exportStartBtn");
    if (startBtn) startBtn.addEventListener("click", startExport);
});
```

### Name: frontend/index.html
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Reframe Studio</title>
    <link rel="stylesheet" href="style.css?v=16">
    <link rel="stylesheet" href="style_additions.css?v=16">
</head>
<body>
    <div class="topbar">
        <div class="topbar-left">
            <span class="brand-dot"></span>
            <h2>Reframe Studio</h2>
        </div>
        <div class="topbar-right">
            <button id="keybindsBtn" class="export-btn export-btn-secondary" title="Short keys dekho aur badlo">⌨ Shortcuts</button>
            <button id="pjToggleBtn" class="export-btn export-btn-secondary" title="Projects save/open/rename">🗂 Projects</button>
            <button id="saveProjectBtn" class="export-btn export-btn-secondary" title="Project Save (Ctrl+S)">💾 Save Project</button>
            <button id="exportBtn" class="export-btn">⬆ Export</button>
        </div>
    </div>

    <div class="app-body">

        <!-- ===== LEFT COLUMN: Media Bin + Captions Panel ===== -->
        <div class="left-column">
            <div class="media-bin expanded" id="mediaBin">
                <div class="media-bin-header" id="mediaBinToggle">
                    <span class="mb-icon">📁</span>
                    <span class="mb-title">Media Bin</span>
                    <span class="mb-chevron">‹</span>
                </div>
                <div class="media-bin-content">
                    <label class="import-btn" for="fileInput">
                        <span class="import-plus">+</span> Import Media
                    </label>
                    <input type="file" id="fileInput" accept="video/*" multiple hidden />
                    <div id="videoList" class="video-list"></div>
                </div>
            </div>

            <!-- NAYA: Captions panel (media-bin ke neeche) — styles, colors, size,
                 save-settings checkbox aur reset button yahan hai -->
            <div class="captions-panel" id="captionsPanel"></div>

            <!-- ===== TITLES PANEL (media-bin ke neeche — collapsible dropdown).
                 Title = 9:16 heading-span (Auto-Captions se ALAG feature — captions
                 poori-video overlay hai, ye sirf chhote heading-blocks) ===== -->
            <div class="titles-panel" id="titlesPanel" style="display:none"></div>

            <!-- ===== TRANSITIONS PANEL (media-bin ke neeche — transition span select/create
                 karne par khulta hai; har transition ki chhoti ANIMATED DEMO preview) ===== -->
            <div class="trans-panel" id="transPanel" style="display:none">
                <div class="trans-header">
                    <span>⇄ Transition <span id="transTargetLabel" class="cg-target-label"></span></span>
                    <button id="transCloseBtn" class="cg-mini-btn">✕</button>
                </div>
                <div class="trans-type-grid" id="transTypeGrid">
                    <button class="trans-type-btn" data-type="fadein"><span class="trans-demo demo-fadein"></span>Fade In</button>
                    <button class="trans-type-btn" data-type="fadeout"><span class="trans-demo demo-fadeout"></span>Fade Out</button>
                    <button class="trans-type-btn" data-type="crossfade"><span class="trans-demo demo-crossfade"></span>Crossfade</button>
                    <button class="trans-type-btn" data-type="slideleft"><span class="trans-demo demo-slideleft"></span>Slide Left</button>
                    <button class="trans-type-btn" data-type="slideright"><span class="trans-demo demo-slideright"></span>Slide Right</button>
                    <button class="trans-type-btn" data-type="zoomin"><span class="trans-demo demo-zoomin"></span>Zoom In</button>
                </div>
                <div class="cg-row"><span class="cg-label">Duration</span><input type="range" id="transDuration" min="0.2" max="3" step="0.1" value="0.6"/><span class="cg-val" id="transDurationVal">0.6s</span></div>
                <div class="cg-row"><span class="cg-label">Intensity</span><input type="range" id="transIntensity" min="10" max="100" step="5" value="60"/><span class="cg-val" id="transIntensityVal">60%</span></div>
                <div class="trans-actions">
                    <button id="transAddBtn" class="trans-add-btn" title="Playhead par naya transition span banao">＋ Transition add karo (playhead par)</button>
                </div>
                <div class="trans-hint">Transition segment click karo → yahan options khulenge. Clip-cut span ke andar ho to crossfade dono clips ko mila kar chalta hai.</div>
            </div>

            <!-- ===== SUBTITLES PANEL (media-bin ke neeche, collapsible) ===== -->
            <div class="subtitles-panel" id="subtitlesPanel" style="display:none">
                <div class="sub-header">
                    <span class="sub-title">📄 Subtitles</span>
                    <span class="sub-toggle" id="subCollapse">▾</span>
                </div>
                <div class="sub-body" id="subBody">
                    <div class="sub-list" id="subList"></div>
                    <div class="sub-actions">
                        <button id="subDownloadSrt" class="sub-dl-btn">⬇ SRT</button>
                        <button id="subDownloadTxt" class="sub-dl-btn">⬇ TXT</button>
                    </div>
                    <div class="sub-hint" id="subHint">Same video ki transcription cache hoti hai — dobara generate fast hoga.</div>
                </div>
            </div>

            <!-- ===== SHORTS CANVAS PANEL (media-bin ke neeche — captions/subtitles jaisi window) ===== -->
            <div class="shorts-panel" id="shortsPanel" style="display:none">
                <div class="shorts-header">
                    <span>📱 Shorts Canvas <span id="shortsStateLabel" class="cg-target-label"></span></span>
                    <button id="shortsCollapseBtn" class="cg-mini-btn" title="Menu collapse/expand (captions jaisa dropdown)">▾</button>
                </div>
                <div id="shortsBody">
                <!-- NUMERIC READOUT: size/position ke EXACT digits — EDITABLE bhi
                     (number type karo + Enter = exact size/position apply) -->
                <div class="sc-readout" id="scReadout">
                    <div class="sc-ro-row"><span class="sc-ro-label">Size W × H</span>
                        <span class="sc-ro-edit"><input type="number" id="scRoW" min="10" max="100" step="1" value="100" />% ×
                        <input type="number" id="scRoH" min="5" max="100" step="1" value="100" />%</span></div>
                    <div class="sc-ro-row"><span class="sc-ro-label">Position X · Y</span>
                        <span class="sc-ro-edit"><input type="number" id="scRoX" min="0" max="100" step="1" value="50" />% ·
                        <input type="number" id="scRoY" min="0" max="100" step="1" value="50" />%</span></div>
                </div>
                <div class="sc-modes">
                    <button id="shortsModeBlur" class="sc-mode-btn">Canvas 1 · Blur BG</button>
                    <button id="shortsModeColor" class="sc-mode-btn">Canvas 2 · Color BG</button>
                </div>
                <div class="cg-row" id="shortsBlurRow"><span class="cg-label">Blur level</span><input type="range" id="shortsBlur" min="0" max="30" step="1" value="14"/><span class="cg-val" id="shortsBlurVal">14</span></div>
                <div class="cg-row" id="shortsColorRow"><span class="cg-label">BG color</span><input type="color" id="shortsColor" value="#000000"/><span class="cg-val" id="shortsColorVal">#000000</span></div>
                <div class="cg-row"><span class="cg-label">Size</span><input type="range" id="shortsSize" min="30" max="100" step="1" value="100"/><span class="cg-val" id="shortsSizeVal">100%</span></div>
                <div class="cg-row"><span class="cg-label">Pos X</span><input type="range" id="shortsPosX" min="0" max="100" step="1" value="50"/><span class="cg-val" id="shortsPosXVal">50%</span></div>
                <div class="cg-row"><span class="cg-label">Pos Y</span><input type="range" id="shortsPosY" min="0" max="100" step="1" value="50"/><span class="cg-val" id="shortsPosYVal">50%</span></div>
                <div class="shorts-actions">
                    <button id="shortsSaveSizeBtn" class="trans-add-btn" title="Sirf SIZE save karo — agli dafa Shorts Canvas ON hote hi auto-apply">💾 Save Size</button>
                    <button id="shortsSavePosBtn" class="trans-add-btn" title="Sirf POSITION save karo — agli dafa Shorts Canvas ON hote hi auto-apply">💾 Save Position</button>
                </div>
                <div class="shorts-actions">
                    <button id="shortsResetBtn" class="pz-danger-btn" title="Size + Position saved settings dono delete kar ke defaults par wapas">↺ Reset to default</button>
                </div>
                <div class="trans-hint">Preview par video-box ko direct DRAG/RESIZE bhi kar sakte ho (har corner se). Save settings par agla project apne aap place ho jayega.</div>
                </div><!-- /shortsBody -->
            </div>
        </div>

        <!-- ===== CENTER COLUMN ===== -->
        <div class="center-column">
            <div class="mode-tabs" id="modeTabs"></div>

            <div class="player-row">
                <div class="video-wrapper">
                    <video id="mainPlayer" style="display:none;"></video>
                    <canvas id="playerCanvas"></canvas>
                </div>
            </div>

            <div class="player-footer">
                <div class="video-info-row" id="videoInfoRow">
                    <div id="videoInfo" class="video-info"></div>
                </div>
                <div class="jump-controls">
                    <span class="jump-label">Jump to</span>
                    <span class="jump-field">
                        <span class="jump-tag">Start</span>
                        <input type="text" id="jumpStartInput" class="time-input" placeholder="00:00.000" />
                    </span>
                    <button id="jumpStartBtn" class="jump-go" title="Go to start time">Go</button>
                    <span class="jump-field">
                        <span class="jump-tag">End</span>
                        <input type="text" id="jumpEndInput" class="time-input" placeholder="00:00.000" />
                    </span>
                    <button id="jumpEndBtn" class="jump-go" title="Go to end time">Go</button>
                </div>
            </div>

            <div class="tools-row">
                <!-- LINE 1: Play → Auto Captions (timeline controls) -->
                <div class="tools-line">
                    <button id="playPauseBtn" class="tool-btn tool-btn-primary"><span class="tool-icon">▶</span></button>
                    <span class="tool-sep"></span>
                    <button id="zoomOut" class="tool-btn"><span class="tool-icon">🔍-</span></button>
                    <button id="zoomIn" class="tool-btn"><span class="tool-icon">🔍+</span></button>
                    <span class="tool-sep"></span>
                    <button id="detectSilenceBtn" class="tool-btn"><span class="tool-icon">🔇</span><span class="tool-label">Detect Silence</span></button>
                    <button id="spotlightBtn" class="tool-btn" title="Spotlight: multi-screen zoom bubbles + vertical screens (segment ke spotlight mode mein)"><span class="tool-icon">◎</span><span class="tool-label">Spotlight</span></button>
                    <button id="cgToggleBtn" class="tool-btn" title="Color Grading: brightness/contrast/saturation/temperature/vignette + presets"><span class="tool-icon">🎨</span><span class="tool-label">Grade</span></button>
                    <button id="splitBtn" class="tool-btn"><span class="tool-icon">✂</span><span class="tool-label">Split</span></button>
                    <button id="copyBtn" class="tool-btn"><span class="tool-icon">📋</span><span class="tool-label">Copy</span></button>
                    <button id="pasteBtn" class="tool-btn"><span class="tool-icon">📥</span><span class="tool-label">Paste</span></button>
                    <button id="duplicateBtn" class="tool-btn"><span class="tool-icon">⧉</span><span class="tool-label">Duplicate</span></button>
                    <button id="deleteBtn" class="tool-btn"><span class="tool-icon">🗑</span><span class="tool-label">Delete</span></button>
                    <button id="muteBtn" class="tool-btn"><span class="tool-icon">🔇</span><span class="tool-label">Mute</span></button>
                    <button id="detachAudioBtn" class="tool-btn"><span class="tool-icon">🎧</span><span class="tool-label">Detach Audio</span></button>
                    <span class="tool-sep"></span>
                </div>

                <!-- LINE 2: SHORTS CANVAS / Undo / Redo / GAP FILL / Speed -->
                <div class="tools-line">
                    <button id="generateCaptionsBtn" class="tool-btn"><span class="tool-icon">💬</span><span class="tool-label">Auto Captions</span></button>
                    <button id="titlesToggleBtn" class="tool-btn" title="Titles: 9:16 window me heading-spans — 10 animated templates, captions transcript se ya manual text"><span class="tool-icon">🅣</span><span class="tool-label">Titles</span></button>
                    <button id="generateSubtitlesBtn" class="tool-btn" title="Subtitles with timestamps — SRT/TXT download"><span class="tool-icon">📄</span><span class="tool-label">Subtitles</span></button>
                    <button id="shortsToggleBtn" class="tool-btn" title="Shorts Canvas: 16:9 video ko 9:16 me place karo (blur/color background, size/position adjustable)"><span class="tool-icon">📱</span><span class="tool-label">Shorts Canvas</span></button>
                    <button id="undoBtn" class="tool-btn"><span class="tool-icon">↶</span><span class="tool-label">Undo</span></button>
                    <button id="redoBtn" class="tool-btn"><span class="tool-icon">↷</span><span class="tool-label">Redo</span></button>
                    <button id="gapFillBtn" class="tool-btn" title="Video clips ke beech ke sari gaps khud close karo (left-ripple join)"><span class="tool-icon">⇥</span><span class="tool-label">Gap Fill</span></button>
                    <div class="speed-control speed-disabled" id="speedControl" title="Drag left/right to change speed, or click to type — SARI selected clips par apply hota hai"><span class="speed-icon">⏱</span><span class="speed-value" id="speedValue">1.00x</span></div>
                    <span id="timeDisplay" class="time-display">00:00 (f0) / 00:00 (f0)</span>
                </div>
            </div>

            <!-- ===== TIMELINE ===== -->
            <div class="timeline-panel">
                <div class="timeline-body">

                    <!-- fixed left label column: Video / Audio / Segments -->
                    <div class="timeline-labels" id="timelineLabels">
                        <div class="label-spacer">                        </div>

                        <div class="label-row" data-for="trackCaptionLayer">
                            <span class="label-dot label-dot-captions"></span>Captions
                            <button class="layer-add-btn" data-layer-kind="captionSpan" title="Playhead par captions span banao">＋</button>
                        </div>
                        <div class="label-resize-spacer"></div>
                        <div class="label-row" data-for="trackTitlesLayer">
                            <span class="label-dot label-dot-titles">🅣</span>Titles
                            <button class="layer-add-btn" data-layer-kind="titleSpan" title="Playhead par title span banao (3s)">＋</button>
                        </div>
                        <div class="label-resize-spacer"></div>
                        <div class="label-row" data-for="trackTransitionsLayer">
                            <span class="label-dot label-dot-transitions"></span>Transitions
                            <button class="layer-add-btn" data-layer-kind="transition" title="Playhead par transition span banao">＋</button>
                        </div>
                        <div class="label-resize-spacer"></div>
                        <div class="label-row" data-for="trackPzLayer">
                            <span class="label-dot label-dot-pz"></span>Crop and Zoom
                            <button class="layer-add-btn" data-layer-kind="panZoom" title="Playhead par Crop-and-Zoom span banao">＋</button>
                        </div>
                        <div class="label-resize-spacer"></div>
                        <div class="label-row" data-for="trackGradeLayer">
                            <span class="label-dot label-dot-grade"></span>Color Grade
                            <button class="layer-add-btn" data-layer-kind="gradeSpan" title="Playhead par grade span banao">＋</button>
                        </div>
                        <div class="label-resize-spacer"></div>
                        <div class="label-row" data-for="trackVideo">
                            <span class="label-dot label-dot-video"></span>Video
                        </div>
                        <div class="label-resize-spacer"></div>
                        <div class="label-row" data-for="trackAudioCombined">
                            <span class="label-dot label-dot-audio"></span>Audio
                        </div>
                        <div class="label-resize-spacer"></div>
                        <div class="label-row" data-for="segmentsLayer">
                            <span class="label-dot label-dot-segment"></span>Segments
                        </div>
                    </div>

                    <!-- scrollable area: ruler + tracks, horizontal + vertical scroll -->
                    <div class="timeline-scroll" id="timelineScroll">
                        <div class="timeline-track" id="timelineTrack">

                            <div class="ruler-frames" id="rulerFrames"></div>
                            <div class="ruler-seconds" id="rulerSeconds"></div>
                            <div class="tracks-area" id="tracksArea">
                                <div class="scrub-area" id="scrubArea">
                                    <!-- ===== NAYE LAYER ROWS (upar se neeche: Captions / Transitions / CropZoom / Grade) ===== -->
                                    <div class="track-row track-layer track-captions" id="trackCaptionLayer">
                                        <div class="layer-spans" id="captionSpansLayer"></div>
                                    </div>
                                    <div class="track-resize-handle" data-target="trackCaptionLayer"></div>

                                    <div class="track-row track-layer track-titles" id="trackTitlesLayer">
                                        <div class="layer-spans" id="titlesSpansLayer"></div>
                                    </div>
                                    <div class="track-resize-handle" data-target="trackTitlesLayer"></div>

                                    <div class="track-row track-layer track-transitions" id="trackTransitionsLayer">
                                        <div class="layer-spans" id="transitionSpansLayer"></div>
                                    </div>
                                    <div class="track-resize-handle" data-target="trackTransitionsLayer"></div>

                                    <div class="track-row track-layer track-pz" id="trackPzLayer">
                                        <div class="layer-spans" id="pzSpansLayer"></div>
                                    </div>
                                    <div class="track-resize-handle" data-target="trackPzLayer"></div>

                                    <div class="track-row track-layer track-grade" id="trackGradeLayer">
                                        <div class="layer-spans" id="gradeSpansLayer"></div>
                                    </div>
                                    <div class="track-resize-handle" data-target="trackGradeLayer"></div>

                                    <div class="track-row track-video" id="trackVideo">
                                        <div class="filmstrip" id="filmstrip"></div>
                                        <div class="track-videoblocks" id="videoBlocksLayer"></div>
                                    </div>

                                    <div class="track-resize-handle" data-target="trackVideo"></div>

                                    <div class="track-row track-audio" id="trackAudioCombined">
                                        <img class="waveform-img" id="waveformImg" />
                                        <div class="track-audiolane" id="audioLayer"></div>
                                    </div>

                                    <div class="track-resize-handle" data-target="trackAudioCombined"></div>

                                    <div class="track-row track-segments" id="segmentsLayer"></div>

                                    <!-- A/D segment-marker flags yahan render hote hain -->
                                    <div class="marker-overlay" id="markerOverlay"></div>
                                </div>

                                <div class="playhead" id="playhead"><div class="playhead-flag"></div></div>
                            </div>

                        </div>
                    </div>

                </div>

                <!-- CUSTOM horizontal scrollbar (native WebView2 overlay-bars par
                     depend nahi kar sakte — ye apna bar HAMESHA visible rehta hai) -->
                <div class="h-scroll-bar" id="hScrollBar">
                    <div class="h-scroll-thumb" id="hScrollThumb"></div>
                </div>
            </div>
        </div>

        <!-- ===== PREVIEW PANEL ===== -->
        <div class="preview-panel">
            <h3>9:16 Preview</h3>
            <canvas id="previewCanvas" width="270" height="480"></canvas>

            <!-- ===== COLOR GRADE PANEL (Phase 1) ===== -->
            <div class="cg-panel" id="cgPanel" style="display:none">
                <div class="cg-header">
                    <span>🎨 Color Grade <span id="cgTargetLabel" class="cg-target-label"></span></span>
                    <button id="cgCloseBtn" class="cg-mini-btn">✕</button>
                </div>
                <div class="cg-presets">
                    <button class="cg-preset-btn active" data-preset="none">Original</button>
                    <button class="cg-preset-btn" data-preset="cinematic">Cinematic</button>
                    <button class="cg-preset-btn" data-preset="vivid">Vivid</button>
                    <button class="cg-preset-btn" data-preset="warm">Warm</button>
                    <button class="cg-preset-btn" data-preset="cold">Cold</button>
                    <button class="cg-preset-btn" data-preset="bw">B&W</button>
                    <button class="cg-preset-btn" data-preset="vintage">Vintage</button>
                    <button class="cg-preset-btn" data-preset="fade">Faded</button>
                    <button class="cg-preset-btn" data-preset="punchy">Punchy</button>
                    <button class="cg-preset-btn" data-preset="night">Night</button>
                </div>
                <div class="cg-row"><span class="cg-label">Brightness</span><input type="range" id="cg_brightness" min="-100" max="100" step="1" value="0"/><span class="cg-val" id="cg_brightnessVal">0%</span></div>
                <div class="cg-row"><span class="cg-label">Contrast</span><input type="range" id="cg_contrast" min="-100" max="100" step="1" value="0"/><span class="cg-val" id="cg_contrastVal">0%</span></div>
                <div class="cg-row"><span class="cg-label">Saturation</span><input type="range" id="cg_saturation" min="-100" max="100" step="1" value="0"/><span class="cg-val" id="cg_saturationVal">0%</span></div>
                <div class="cg-row"><span class="cg-label">Temperature</span><input type="range" id="cg_temperature" min="-100" max="100" step="1" value="0"/><span class="cg-val" id="cg_temperatureVal">0%</span></div>
                <div class="cg-row"><span class="cg-label">Sharpen</span><input type="range" id="cg_sharpen" min="0" max="100" step="1" value="0"/><span class="cg-val" id="cg_sharpenVal">0%</span></div>
                <div class="cg-row"><span class="cg-label">Vignette</span><input type="range" id="cg_vignette" min="0" max="100" step="1" value="0"/><span class="cg-val" id="cg_vignetteVal">0%</span></div>
                <div class="cg-footer">
                    <button id="cgBeforeAfterBtn" class="cg-ba-btn" title="Dabaye rakho = original, chhodo = graded">👁 Before / After (hold)</button>
                    <button id="cgResetBtn" class="cg-reset-btn">↺ Reset</button>
                </div>
            </div>

            <!-- ===== CROP AND ZOOM (PAN & ZOOM) PANEL ===== -->
            <div class="pz-panel" id="pzPanel" style="display:none">
                <div class="pz-header">
                    <span>🔍 Crop and Zoom</span>
                    <button id="pzCloseBtn" class="cg-mini-btn">✕</button>
                </div>
                <div class="pz-modes" id="pzModeRow">
                    <button class="pz-mode-btn active" data-pzmode="static">Static</button>
                    <button class="pz-mode-btn" data-pzmode="in">Zoom In</button>
                    <button class="pz-mode-btn" data-pzmode="out">Zoom Out</button>
                </div>
                <div class="cg-row"><span class="cg-label">Zoom</span><input type="range" id="pzZoom" min="1" max="4" step="0.05" value="1"/><span class="cg-val" id="pzZoomVal">1.00x</span></div>
                <div class="pz-hint">BOX = wo area jo screen par bharega (box drag/resize karo). Zoom slider se usi box ke andar manual zoom-in/out set karo (1x = sirf crop, 2x = 2 guna andar). Zoom In/Out mode mein layer ki lambai = zoom ki speed.</div>
                <div class="pz-actions">
                    <button id="pzDeleteBtn" class="pz-danger-btn" title="Selected PanZoom layer delete karo">🗑 Delete Layer</button>
                </div>
            </div>

            <!-- ===== SPOTLIGHT CONTROLS (multi-screen) ===== -->
            <div class="spotlight-ctrls" id="spotlightCtrls" style="display:none">
                <div class="sp-screen-list" id="spScreenList"></div>
                <div class="sp-row sp-actions">
                    <button id="spAddSpot" class="sp-btn" title="Nayi shape-screen add karo">+ Screen</button>
                    <button id="spAddVertical" class="sp-btn" title="Full-height vertical (9:16) crop screen add karo">+ Vertical</button>
                    <button id="spDupScreen" class="sp-btn" title="Selected screen ki copy banao">⧉ Dup</button>
                    <button id="spDelScreen" class="sp-btn sp-danger" title="Selected screen delete karo">✕ Del</button>
                </div>
                <div class="sp-row">
                    <span class="sp-label">Zoom</span>
                    <input type="range" id="spZoom" min="1" max="4" step="0.05" value="1.6" />
                    <span class="sp-val" id="spZoomVal">1.60x</span>
                </div>
                <div class="sp-row">
                    <span class="sp-label">Size</span>
                    <input type="range" id="spSize" min="0.05" max="0.45" step="0.01" value="0.17" />
                    <span class="sp-val" id="spSizeVal">17%</span>
                </div>
                <div class="sp-row sp-styles" id="spStyleRow">
                    <button class="sp-style-btn active" data-style="circle" title="Circle">●</button>
                    <button class="sp-style-btn" data-style="square" title="Square box">■</button>
                    <button class="sp-style-btn" data-style="star" title="Star">★</button>
                    <button class="sp-style-btn" data-style="heart" title="Heart">♥</button>
                    <button class="sp-style-btn" data-style="hexagon" title="Hexagon">⬡</button>
                    <button class="sp-style-btn" data-style="diamond" title="Diamond">◆</button>
                    <button class="sp-style-btn" data-style="ring" title="Ring (sirf guide — export mein burn nahi hota)">◌</button>
                </div>
                <div class="sp-row" id="spBorderRow">
                    <span class="sp-label">Border</span>
                    <input type="range" id="spBorderW" min="0" max="24" step="1" value="8" />
                    <input type="color" id="spBorderColor" value="#ffffff" style="width:28px;height:22px;padding:0;border:none;background:none" />
                    <span class="sp-val" id="spBorderWVal">8px</span>
                </div>
                <div class="sp-row">
                    <label class="sp-label" style="display:flex;align-items:center;gap:6px;cursor:pointer">
                        <input type="checkbox" id="spShadow" checked /> Shadow</label>
                </div>
            </div>
        </div>

    </div>

    <!-- ===== KEYBINDINGS PANEL ===== -->
    <div class="keybind-panel" id="keybindPanel">
        <div class="keybind-header">
            <span>⌨ Shortcuts</span>
            <div class="keybind-header-actions">
                <button id="kbResetBtn" class="kb-mini-btn" title="Sab keys default par wapis">Reset</button>
                <button id="kbCloseBtn" class="kb-mini-btn">✕</button>
            </div>
        </div>
        <div class="keybind-hint">Naya key assign karne ke liye button par click karo aur key dabao (Esc = cancel)</div>
        <div class="keybind-list" id="kbActionList"></div>
    </div>

    <!-- ===== PROJECTS PANEL (Save/Load/Rename) ===== -->
    <div class="projects-panel" id="projectsPanel">
        <div class="projects-header">
            <span>🗂 Projects</span>
            <button id="pjCloseBtn" class="pj-mini-btn">✕</button>
        </div>
        <div class="projects-actions">
            <input type="text" id="pjNameInput" class="pj-name-input" placeholder="Project ka naam…" />
            <button id="pjSaveBtn" class="pj-action-btn pj-save">Save</button>
        </div>
        <div class="projects-hint" id="pjHint"></div>
        <div class="projects-list" id="pjList"></div>
    </div>

    <!-- ===== EXPORT MODAL ===== -->
    <div class="modal-overlay" id="exportModalOverlay" style="display:none;">
        <div class="modal-box">
            <h3>Export Video</h3>

            <div class="modal-field">
                <label>Quality</label>
                <div class="modal-radio-row" id="exportQualityRow">
                    <label><input type="radio" name="exportQuality" value="test" /> Test (fast, low quality)</label>
                    <label><input type="radio" name="exportQuality" value="720p" checked /> 720p</label>
                    <label><input type="radio" name="exportQuality" value="1080p" /> 1080p</label>
                </div>
            </div>

            <div class="modal-field">
                <label>Codec</label>
                <div class="modal-radio-row" id="exportCodecRow">
                    <label><input type="radio" name="exportCodec" value="h264" checked /> H.264 (fast, compatible)</label>
                    <label><input type="radio" name="exportCodec" value="h265" /> H.265 (smaller file, slower)</label>
                </div>
            </div>

            <div class="modal-progress" id="exportProgressWrap" style="display:none;">
                <div class="modal-progress-bar"><div class="modal-progress-fill" id="exportProgressFill"></div></div>
                <div class="modal-progress-label" id="exportProgressLabel">Rendering… 0%</div>
            </div>

            <div class="modal-result" id="exportResultWrap" style="display:none;">
                <a id="exportDownloadLink" href="#" download class="export-download-btn">⬇ Download Video</a>
            </div>

            <div class="modal-actions">
                <button id="exportCancelBtn" class="tool-btn">Cancel</button>
                <button id="exportStartBtn" class="tool-btn tool-btn-primary">Start Export</button>
            </div>
        </div>
    </div>

    <script src="timeline.js?v=16"></script>
    <script src="crop_editor.js?v=16"></script>
    <script src="spotlight.js?v=16"></script>
    <script src="color_grade.js?v=16"></script>
    <script src="captions.js?v=24"></script>
    <script src="titles.js?v=18"></script>
    <script src="shorts_canvas.js?v=16"></script>
    <script src="layers.js?v=18"></script>
    <script src="editor_tools.js?v=16"></script>
    <script src="speed_control.js?v=16"></script>
    <script src="export_ui.js?v=16"></script>
    <script src="app.js?v=16"></script>
    <script src="projects.js?v=16"></script>
    <script src="keybindings.js?v=16"></script>
</body>
</html>
```

### Name: frontend/keybindings.js
```js
// ============================================================================
// KEYBINDINGS ENGINE — short-keys + custom assignment + persistence
//
// User ke diye hue DEFAULTS (sab numpad keys par):
//   Num1  <- 5s      Ctrl+Num1  <- 5ms
//   Num3  -> 5s      Ctrl+Num3  -> 5ms
//   Num4  <- 1s      Ctrl+Num4  <- 1ms
//   Num6  -> 1s      Ctrl+Num6  -> 1ms
//   Num7  <- 10s     Ctrl+Num7  <- 20s
//   Num9  -> 10s     Ctrl+Num9  -> 20s
//   Num5  Play/Pause (Long Space bar bhi)
//   Num8  STOP (pause + seek 0)
//   Num2  -> 1 frame   Ctrl+Num2 -> 5f   Shift+Num2 -> 10f
//   Num0  <- 1 frame   Ctrl+Num0 <- 5f   Shift+Num0 <- 10f
//   Ctrl+S  Project Save
//   A  Segment START, D  Segment END (crop segment)
//   F  Split, K  Split
//   Ctrl+C Copy, Ctrl+V Paste, Ctrl+Z Undo, Ctrl+X REDO
// ============================================================================

// ---- Default bindings (user-specified) ----
const KB_DEFAULT_BINDINGS = {
    "kb_seek_back_5s":    { code: "Numpad1", ctrl: false, shift: false },
    "kb_seek_back_5ms":   { code: "Numpad1", ctrl: true,  shift: false },
    "kb_seek_fwd_5s":     { code: "Numpad3", ctrl: false, shift: false },
    "kb_seek_fwd_5ms":    { code: "Numpad3", ctrl: true,  shift: false },
    "kb_seek_back_1s":    { code: "Numpad4", ctrl: false, shift: false },
    "kb_seek_back_1ms":   { code: "Numpad4", ctrl: true,  shift: false },
    "kb_seek_fwd_1s":     { code: "Numpad6", ctrl: false, shift: false },
    "kb_seek_fwd_1ms":    { code: "Numpad6", ctrl: true,  shift: false },
    "kb_seek_back_10s":   { code: "Numpad7", ctrl: false, shift: false },
    "kb_seek_back_20s":   { code: "Numpad7", ctrl: true,  shift: false },
    "kb_seek_fwd_10s":    { code: "Numpad9", ctrl: false, shift: false },
    "kb_seek_fwd_20s":    { code: "Numpad9", ctrl: true,  shift: false },
    "kb_play_pause":      { code: "Numpad5", ctrl: false, shift: false },
    "kb_stop":            { code: "Numpad8", ctrl: false, shift: false },
    "kb_frame_fwd":       { code: "Numpad2", ctrl: false, shift: false },
    "kb_frame_fwd_5":     { code: "Numpad2", ctrl: true,  shift: false },
    "kb_frame_fwd_10":    { code: "Numpad2", ctrl: false, shift: true  },
    "kb_frame_back":      { code: "Numpad0", ctrl: false, shift: false },
    "kb_frame_back_5":    { code: "Numpad0", ctrl: true,  shift: false },
    "kb_frame_back_10":   { code: "Numpad0", ctrl: false, shift: true  },
    "kb_project_save":    { code: "KeyS",    ctrl: true,  shift: false },
    "kb_seg_start":       { code: "KeyA",    ctrl: false, shift: false },
    "kb_seg_end":         { code: "KeyD",    ctrl: false, shift: false },
    "kb_split_f":         { code: "KeyF",    ctrl: false, shift: false },
    "kb_split_k":         { code: "KeyK",    ctrl: false, shift: false },
    "kb_copy":            { code: "KeyC",    ctrl: true,  shift: false },
    "kb_paste":           { code: "KeyV",    ctrl: true,  shift: false },
    "kb_undo":            { code: "KeyZ",    ctrl: true,  shift: false },
    "kb_redo":            { code: "KeyX",    ctrl: true,  shift: false }
};

// split ke liye REAL function ka naam (splitAtPlayhead exist nahi karta —
// asli naam splitSelectedAtPlayhead hai, editor_tools.js mein)
function kbCall(fnName, ...args) {
    const fn = window[fnName];
    if (typeof fn === "function") { fn(...args); return true; }
    console.warn("Keybinding: function missing:", fnName);
    return false;
}

// ---- Action registry: har action ka label + handler ----
const KB_ACTIONS = {
    "kb_seek_back_5s":  { label: "\u2190 5 sec", run: () => kbNudge(-5) },
    "kb_seek_back_5ms": { label: "\u2190 5 ms",  run: () => kbNudge(-0.005) },
    "kb_seek_fwd_5s":   { label: "5 sec \u2192", run: () => kbNudge(5) },
    "kb_seek_fwd_5ms":  { label: "5 ms \u2192",  run: () => kbNudge(0.005) },
    "kb_seek_back_1s":  { label: "\u2190 1 sec", run: () => kbNudge(-1) },
    "kb_seek_back_1ms": { label: "\u2190 1 ms",  run: () => kbNudge(-0.001) },
    "kb_seek_fwd_1s":   { label: "1 sec \u2192", run: () => kbNudge(1) },
    "kb_seek_fwd_1ms":  { label: "1 ms \u2192",  run: () => kbNudge(0.001) },
    "kb_seek_back_10s": { label: "\u2190 10 sec", run: () => kbNudge(-10) },
    "kb_seek_back_20s": { label: "\u2190 20 sec", run: () => kbNudge(-20) },
    "kb_seek_fwd_10s":  { label: "10 sec \u2192", run: () => kbNudge(10) },
    "kb_seek_fwd_20s":  { label: "20 sec \u2192", run: () => kbNudge(20) },
    "kb_play_pause":    { label: "Play / Pause", run: () => { if (typeof togglePlay === "function") togglePlay(); } },
    "kb_stop":          { label: "Stop", run: () => { if (typeof stopPlayback === "function") stopPlayback(); } },
    "kb_frame_fwd":     { label: "\u2192 1 Frame",  run: () => kbFrame(1) },
    "kb_frame_fwd_5":   { label: "\u2192 5 Frames", run: () => kbFrame(5) },
    "kb_frame_fwd_10":  { label: "\u2192 10 Frames", run: () => kbFrame(10) },
    "kb_frame_back":    { label: "\u2190 1 Frame",  run: () => kbFrame(-1) },
    "kb_frame_back_5":  { label: "\u2190 5 Frames", run: () => kbFrame(-5) },
    "kb_frame_back_10": { label: "\u2190 10 Frames", run: () => kbFrame(-10) },
    "kb_project_save":  { label: "Project Save", run: () => { if (typeof saveCurrentProject === "function") saveCurrentProject(); } },
    "kb_seg_start":     { label: "Segment START", run: () => kbCall("setSegmentMarker", "start") },
    "kb_seg_end":       { label: "Segment END", run: () => kbCall("setSegmentMarker", "end") },
    "kb_split_f":       { label: "Split (F)", run: () => kbCall("splitSelectedAtPlayhead") },
    "kb_split_k":       { label: "Split (K)", run: () => kbCall("splitSelectedAtPlayhead") },
    "kb_copy":          { label: "Copy", run: () => kbCall("copySelected") },
    "kb_paste":         { label: "Paste", run: () => kbCall("pasteClipboard") },
    "kb_undo":          { label: "Undo", run: () => kbCall("undo") },
    "kb_redo":          { label: "RE-DO", run: () => kbCall("redo") }
};

// ---- state ----
let kbBindings = {};          // actionId -> {keys: [{code, ctrl, shift}, ...]} (multi-key)
let kbCaptureTarget = null;   // actionId jiske liye user naya key press kar raha hai
let kbLastEventTs = 0;        // keyauto-repeat throttle

function kbDeepCopy(o) { return JSON.parse(JSON.stringify(o)); }

// purana single-key format {code,ctrl,shift} -> naya multi-key {keys:[...]}
function kbNormalizeBinding(b) {
    if (b && Array.isArray(b.keys)) {
        return { keys: b.keys.filter(k => k && k.code).map(k => ({ code: k.code, ctrl: !!k.ctrl, shift: !!k.shift })) };
    }
    if (b && b.code) return { keys: [{ code: b.code, ctrl: !!b.ctrl, shift: !!b.shift }] };
    return { keys: [] };
}

function kbLoadBindings() {
    kbBindings = {};
    Object.keys(KB_DEFAULT_BINDINGS).forEach(id => {
        kbBindings[id] = kbNormalizeBinding(KB_DEFAULT_BINDINGS[id]);
    });
    try {
        const raw = localStorage.getItem("reframe_keybindings");
        if (raw) {
            const saved = JSON.parse(raw);
            Object.keys(saved).forEach(id => {
                if (kbBindings[id] && saved[id]) kbBindings[id] = kbNormalizeBinding(saved[id]);
            });
        }
    } catch (e) {}
}

function kbSaveBindings() {
    try { localStorage.setItem("reframe_keybindings", JSON.stringify(kbBindings)); } catch (e) {}
}

function kbResetToDefaults() {
    Object.keys(KB_DEFAULT_BINDINGS).forEach(id => {
        kbBindings[id] = kbNormalizeBinding(KB_DEFAULT_BINDINGS[id]);
    });
    kbSaveBindings();
    kbRenderPanel();
}

// ---- helper: binding ko readable label ----
function kbBindingLabel(b) {
    if (!b || !b.code) return "not set";
    let key = b.code;
    if (key.startsWith("Numpad")) key = "Num" + key.slice(6);
    else if (key.startsWith("Key")) key = key.slice(3);
    else if (key.startsWith("Digit")) key = key.slice(5);
    let s = "";
    if (b.ctrl) s += "Ctrl+";
    if (b.shift) s += "Shift+";
    return s + key;
}

// ---- main keydown handler ----
function kbHandleKeydown(e) {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
    const inField = tag === "input" || tag === "textarea" || tag === "select" ||
        (e.target && e.target.isContentEditable);
    if (inField) return;

    const code = e.code || "";
    if (!code) return;
    if (code === "Escape" && kbCaptureTarget) { kbCancelCapture(); e.preventDefault(); return; }
    // Space ko browser-page-scroll se roko (play/pause hum karenge)
    if (code === "Space") e.preventDefault();

    const now = Date.now();
    const isAutoRepeat = now - kbLastEventTs < 30; // held-key throttle
    if (isAutoRepeat && !code.startsWith("Numpad")) return;
    kbLastEventTs = now;

    // capture mode: user naya key assign kar raha hai
    if (kbCaptureTarget) {
        if (code === "Escape") { kbCancelCapture(); return; }
        kbAssignCaptured(code, e.ctrlKey, e.shiftKey);
        e.preventDefault();
        return;
    }

    // binding match: kisi bhi assigned key par chalega (MULTI-KEY support)
    for (const actionId of Object.keys(kbBindings)) {
        const keys = kbBindings[actionId].keys || [];
        const hit = keys.find(k => k.code === code && !!k.ctrl === e.ctrlKey && !!k.shift === e.shiftKey);
        if (hit) {
            const action = KB_ACTIONS[actionId];
            if (action && typeof action.run === "function") {
                // Text-copy ko kharab na karein: agar Ctrl+C system text-selection par mara
                // to bhi humara copy chalega (app mein text selection critical nahi hai)
                e.preventDefault();
                e.stopPropagation();
                try { action.run(); } catch (err) { console.error("Keybinding action failed:", actionId, err); }
            }
            return;
        }
    }
}

// ---- transport helpers ----
function kbNudge(delta) {
    if (typeof seekVirtual !== "function") return;
    const cur = (typeof virtualTime !== "undefined") ? virtualTime : 0;
    seekVirtual(cur + delta);
    if (typeof updatePlayheadPosition === "function") updatePlayheadPosition(cur + delta);
    if (typeof renderSegments === "function") renderSegments();
}

function kbFrame(frames) {
    if (typeof seekVirtual !== "function") return;
    const fps = (typeof currentFps === "function") ? currentFps() : 25;
    const cur = (typeof virtualTime !== "undefined") ? virtualTime : 0;
    seekVirtual(cur + frames / fps);
    if (typeof updatePlayheadPosition === "function") updatePlayheadPosition(cur + frames / fps);
    if (typeof renderSegments === "function") renderSegments();
}

// Long Space bar bhi Play/Pause (user request)
function kbHandleSpaceRepeat(e) {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if (e.code !== "Space") return;
    e.preventDefault();
    if (Date.now() - kbLastEventTs < 25) return;
    kbLastEventTs = Date.now();
    if (kbCaptureTarget) { kbAssignCaptured("Space", e.ctrlKey, e.shiftKey); return; }
    const b = kbBindings["kb_play_pause"];
    if (b && (b.keys || []).some(k => k.code === "Space") && typeof togglePlay === "function") togglePlay();
}

// ---- capture (re-assign) flow ----
function kbStartCapture(actionId) {
    kbCaptureTarget = actionId;
    const el = document.querySelector(`[data-kb-capture="${actionId}"]`);
    if (el) { el.textContent = "key dabao..."; el.classList.add("capturing"); }
}
function kbCancelCapture() {
    const prev = kbCaptureTarget;
    kbCaptureTarget = null;
    if (prev) {
        const el = document.querySelector(`[data-kb-capture="${prev}"]`);
        if (el) {
            const keys = (kbBindings[prev] && kbBindings[prev].keys) || [];
            el.textContent = keys.length ? keys.map(kbBindingLabel).join(" / ") : "not set";
            el.classList.remove("capturing");
        }
    }
}
function kbAssignCaptured(code, ctrl, shift) {
    const actionId = kbCaptureTarget;
    if (!actionId) return;
    // conflict check: yeh combination kisi AUR action ke paas hai to wahan se hata do
    // (naya assignment jeet gaya — purana action us key se mehroom)
    Object.keys(kbBindings).forEach(id => {
        if (id === actionId) return;
        const ks = kbBindings[id].keys || [];
        kbBindings[id].keys = ks.filter(k => !(k.code === code && !!k.ctrl === !!ctrl && !!k.shift === !!shift));
    });
    // ADD (replace nahi!) — ek action par multiple keys (max 4)
    const keys = kbBindings[actionId].keys || [];
    const dup = keys.some(k => k.code === code && !!k.ctrl === !!ctrl && !!k.shift === !!shift);
    if (!dup) {
        keys.push({ code, ctrl: !!ctrl, shift: !!shift });
        if (keys.length > 4) keys.shift();
    }
    kbBindings[actionId] = { keys };
    kbCaptureTarget = null;
    kbSaveBindings();
    kbRenderPanel();
}

// ---- UI panel ----
// Har action: label + assigned-keys CHIPS (right-click = remove) + "+ key" add-button
function kbRenderPanel() {
    const list = document.getElementById("kbActionList");
    if (!list) return;
    list.innerHTML = "";
    Object.keys(KB_ACTIONS).forEach(actionId => {
        const row = document.createElement("div");
        row.className = "kb-action-row";

        const label = document.createElement("span");
        label.className = "kb-action-label";
        label.textContent = KB_ACTIONS[actionId].label;

        const keysWrap = document.createElement("span");
        keysWrap.className = "kb-keys-wrap";

        const keys = (kbBindings[actionId] && kbBindings[actionId].keys) || [];
        if (!keys.length) {
            const none = document.createElement("span");
            none.className = "kb-key-chip empty";
            none.textContent = "not set";
            keysWrap.appendChild(none);
        }
        keys.forEach((k, idx) => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "kb-key-chip";
            chip.title = "Right-click se ye key hatao";
            chip.textContent = kbBindingLabel(k);
            chip.addEventListener("contextmenu", (ev) => {
                ev.preventDefault();
                kbBindings[actionId].keys.splice(idx, 1);
                kbSaveBindings();
                kbRenderPanel();
            });
            keysWrap.appendChild(chip);
        });

        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "kb-key-add" + (kbCaptureTarget === actionId ? " capturing" : "");
        addBtn.setAttribute("data-kb-capture", actionId);
        addBtn.textContent = (kbCaptureTarget === actionId) ? "key dabao..." : "+ key";
        addBtn.title = "Nayi key assign karo (ek action par 4 tak) — purani key nahi mitegi";
        addBtn.addEventListener("click", () => kbStartCapture(actionId));

        row.appendChild(label);
        row.appendChild(keysWrap);
        row.appendChild(addBtn);
        list.appendChild(row);
    });
}

function kbTogglePanel() {
    const panel = document.getElementById("keybindPanel");
    if (!panel) return;
    panel.classList.toggle("open");
    if (panel.classList.contains("open")) kbRenderPanel();
    else kbCancelCapture();
}

function kbInit() {
    kbLoadBindings();
    window.addEventListener("keydown", kbHandleKeydown, true);   // capture-phase: app se pehle
    window.addEventListener("keyup", kbHandleSpaceRepeat, false);
    const openBtn = document.getElementById("keybindsBtn");
    if (openBtn) openBtn.addEventListener("click", kbTogglePanel);
    const closeBtn = document.getElementById("kbCloseBtn");
    if (closeBtn) closeBtn.addEventListener("click", kbTogglePanel);
    const resetBtn = document.getElementById("kbResetBtn");
    if (resetBtn) resetBtn.addEventListener("click", kbResetToDefaults);
}

// auto-init (script app.js ke baad load hoti hai)
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", kbInit);
} else {
    kbInit();
}
```

### Name: frontend/layers.js
```js
// ===== EFFECT-LAYERS ENGINE (layers.js) =====
// Timeline ki 4 NAYI layers: Captions / Transitions / Crop and Zoom (Pan&Zoom) /
// Color Grade — sab SPAN-based (jahan tak layer, wahan tak effect).
//
// Design-notes:
// - Har layer ka data timeline.js ke global arrays mein hai (captionSpans,
//   transitions, panZoomSpans, gradeSpans) — persist/save/undo/split/drag sab
//   existing engine use karta hai (editor_tools.js + timeline.js).
// - Render: renderEffectLayers() — timeline.js ka renderAll() ise call karta hai.
// - Captions: jab captions generate hon → full-span layer banti hai; split karne
//   par har piece ka apna style/position/size. Panel se change = PLAYHEAD wale
//   piece par apply hota hai (user choice).
// - Grade: purana GLOBAL grade load par ek full-span layer mein migrate hota hai
//   (user choice); Grade panel edits selected/playhead grade-span par lagte hain.
// - Pan&Zoom: 9:16 preview canvas ke andar resizable box; mode = static/in/out.
// - Transitions: 6 types, koi keyframing nahi; span ke andar clip-cut ho to
//   crossfade wahan smart-auto lagta hai.
// - Subtitles: media-bin ke neeche panel + SRT/TXT download (timestamps ke sath);
//   backend transcription cache reuse (dobara whisper nahi chalega).
//
// IMPORTANT: ye file crop_editor.js/color_grade.js/captions.js ke BAAD load hoti
// hai (index.html script order) — isliye yahan ke function-declarations unke
// globals ko override kar ke time-aware wrappers laga sakti hain.

/* eslint-disable no-redeclare */

// ===== SMALL UTILS =====
function _layersClamp01(v) { return Math.max(0, Math.min(1, v)); }

let __layersScratchCanvas = null;
let __layersSnapKey = null;
// PERF FIX (BUG 7): pehle HAR call par naya canvas banta tha — pz/trans
// apply har-frame chalte hain -> 60fps par GC/memory pressure -> lambi
// session me crash/freeze. Ab: EK shared scratch-canvas reuse + PARAM-KEY
// cache (jab tak canvas-dims + span-params + time-bucket same, wahi snapshot).
// SPAN-AWARE: pzSpanAt/trans ka active span bhi key me — span badle to turant
// naya snapshot.
function snapshotCanvas(canvas, spanChanged) {
    if (!__layersScratchCanvas) __layersScratchCanvas = document.createElement("canvas");
    const c = __layersScratchCanvas;
    const key = canvas.width + "x" + canvas.height + "|" + (typeof virtualTime === "number" ? Math.round(virtualTime * 30) : 0) + "|" + (spanChanged || "");
    if (key !== __layersSnapKey) {
        if (c.width !== canvas.width || c.height !== canvas.height) { c.width = canvas.width; c.height = canvas.height; }
        c.getContext("2d").drawImage(canvas, 0, 0);
        __layersSnapKey = key;
    }
    return c;
}
// naya draw-cycle shuru — snapshot cache invalidate (renderAll se pehle call)
function invalidateSnapshot() { __layersSnapKey = null; }

function _layersSameJson(a, b) {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
}

// ===== 1) ROW RENDERING =====

const TRANS_LABELS = {
    fadein: "Fade In", fadeout: "Fade Out", crossfade: "Crossfade",
    slideleft: "Slide Left", slideright: "Slide Right", zoomin: "Zoom In",
};

function _effectLayerDefs() {
    return [
        { kind: "captionSpan", arr: captionSpans, layerEl: captionSpansLayer, cls: "cap-span", label: () => "💬 captions" },
        { kind: "titleSpan", arr: (typeof titlesSpans !== "undefined") ? titlesSpans : [], layerEl: (typeof titlesSpansLayer !== "undefined") ? titlesSpansLayer : null, cls: "title-span", label: (s) => "🅣 " + (s.text || s.template || "title") },
        { kind: "transition", arr: transitions, layerEl: transitionSpansLayer, cls: "trans-span", label: (s) => "⇄ " + (TRANS_LABELS[s.type] || s.type) },
        { kind: "panZoom", arr: panZoomSpans, layerEl: pzSpansLayer, cls: "pz-span", label: (s) => "🔍 " + (s.mode === "in" ? "zoom-in" : s.mode === "out" ? "zoom-out" : "pan&zoom") },
        { kind: "gradeSpan", arr: gradeSpans, layerEl: gradeSpansLayer, cls: "grade-span", label: () => "🎨 grade" },
    ];
}

function renderEffectLayers() {
    if (typeof captionSpansLayer === "undefined" || !captionSpansLayer) return;
    _effectLayerDefs().forEach((def) => {
        if (!def.layerEl) return;
        def.layerEl.innerHTML = "";
        (def.arr || []).forEach((item) => {
            const el = document.createElement("div");
            el.className = "layer-span " + def.cls + ((typeof isSelected === "function" && isSelected(def.kind, item.id)) ? " selected" : "");
            el.style.left = `${item.start * pixelsPerSecond}px`;
            el.style.width = `${(item.end - item.start) * pixelsPerSecond}px`;
            el.dataset.id = item.id;
            el.innerHTML = `<span class="seg-label">${def.label(item)}</span>
                             <div class="seg-handle seg-handle-left" data-id="${item.id}"></div>
                             <div class="seg-handle seg-handle-right" data-id="${item.id}"></div>`;
            def.layerEl.appendChild(el);
        });
    });
    syncPanelsToSelection();
}

// Naye layers ke kinaron par bhi magnetic snap (timeline.js getSnapCandidates)
// — arrays yahan se juri hain.

// ===== 2) ROW INTERACTIONS (select / move / resize / create-drag) =====

function setupEffectRow(rowEl, kind, allowCreate) {
    if (!rowEl) return;
    rowEl.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        pausePlayback();
        if (playPauseBtnEl) playPauseBtnEl.textContent = "▶";
        const target = e.target;

        // "＋" CREATE BUTTON (BUG 1 FIX): user ne click-drag-create band manga tha —
        // ab segment sirf BUTTON PRESS se banta hai (playhead se 2s)
        if (target.classList.contains("layer-add-btn")) {
            e.preventDefault();
            e.stopPropagation();
            const base = (typeof virtualTime === "number" && isFinite(virtualTime)) ? virtualTime : 0;
            createEffectSpan(kind, base, base + 2);
            return;
        }

        if (target.classList.contains("seg-handle-left") || target.classList.contains("seg-handle-right")) {
            const id = target.dataset.id;
            const it = getItemByKindId(kind, id);
            if (!it) return;
            if (e.ctrlKey) toggleSelectItem(kind, id); else selectOnly(kind, id);
            dragState = {
                kind,
                type: target.classList.contains("seg-handle-left") ? "resize-left" : "resize-right",
                id, origStart: it.start, origEnd: it.end,
            };
            renderAll();
            return;
        }

        const blockEl = target.closest(".layer-span");
        if (blockEl) {
            const id = blockEl.dataset.id;
            if (e.ctrlKey) {
                if (isSelected(kind, id) && selectedItems.length > 1) {
                    dragState = buildMoveDragState(e.clientX, kind, id);
                    dragState.pendingCtrlToggle = { kind, id };
                } else {
                    toggleSelectItem(kind, id);
                }
            } else {
                if (!isSelected(kind, id) || selectedItems.length <= 1) {
                    selectOnly(kind, id);
                }
                dragState = buildMoveDragState(e.clientX, kind, id);
            }
            renderAll();
            return;
        }

        // EMPTY AREA (BUG 1 FIX): drag-create BAND — sirf selection clear hota hai
        if (!e.ctrlKey) clearSelection();
        renderAll();
    });
}

setupEffectRow(document.getElementById("trackCaptionLayer"), "captionSpan", false);
setupEffectRow(document.getElementById("trackTitlesLayer"), "titleSpan", false);
setupEffectRow(document.getElementById("trackTransitionsLayer"), "transition", false);
setupEffectRow(document.getElementById("trackPzLayer"), "panZoom", false);
setupEffectRow(document.getElementById("trackGradeLayer"), "gradeSpan", false);

// "＋" BUTTONS (BUG 1) — ye LABELS column me hain (track-rows ke bahar), isliye
// DOCUMENT-level handler (row-handlers in tak nahi pohanchte)
document.addEventListener("mousedown", (e) => {
    const btn = e.target.closest ? e.target.closest(".layer-add-btn") : null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const kind = btn.dataset.layerKind;
    if (!kind || typeof createEffectSpan !== "function") return;
    if (typeof pausePlayback === "function") pausePlayback();
    if (typeof playPauseBtnEl !== "undefined" && playPauseBtnEl) playPauseBtnEl.textContent = "▶";
    const base = (typeof virtualTime === "number" && isFinite(virtualTime)) ? virtualTime : 0;
    createEffectSpan(kind, base, base + 2);
});

// mouseup-create: effect-kind spans (timeline.js ka create-branch effectKind
// ho to createEffectSpan() call karta hai)
function createEffectSpan(kind, start, end, opts) {
    // (BUG 1) fromDrag: purani drag-created chhoti spans ke liye 0.15 guard;
    // BUTTON creates ab hamesha full 2s banti hain (min-length guard skip)
    if (!(opts && opts.fromDrag) && end - start <= 0.15) return;
    if (end - start <= 0.05) return;
    pushHistory();
    let newId = null;
    if (kind === "transition") {
        newId = genId();
        transitions.push({ id: newId, start, end, type: "crossfade", duration: 0.6, intensity: 60 });
    } else if (kind === "panZoom") {
        newId = genId();
        // (USER FIX) default zoom ab 1.0 — box pehle screen ko BHAR deta hai
        // (sirf crop); zoom slider se manual zoom-in/out karo jitna chaho
        panZoomSpans.push({ id: newId, start, end, mode: "static", zoom: 1, box: { x: 0.2, y: 0.1, w: 0.6, h: 0.8 } });
    } else if (kind === "gradeSpan") {
        newId = genId();
        gradeSpans.push({ id: newId, start, end, grade: { ...CG_DEFAULTS } });
    } else if (kind === "titleSpan") {
        // TITLES: default heading-span — selected template + panel se text.
        // (GLITCH FIX) pehle tpText DOM-read + template/align invisible_state
        // thhi — ab opts renderer se (tpAddBtn) + align-preset/position ko
        // SPAN-CREATION par lock karte hain (baad me selection-sync of any kind
        // us position ko rewrite NAHI karega).
        newId = genId();
        const t = (typeof titlesDefaultSpanData === "function") ? titlesDefaultSpanData(start, end, (opts || {})) : {
            id: newId, start, end,
            template: (opts && opts.template) || (typeof titlesSelectedTemplate !== "undefined" ? titlesSelectedTemplate || "boldPop" : "boldPop"),
            text: (opts && opts.text) || "",
            align: (opts && opts.align) || "center",
            position: { x: 0.5, y: 0.22 },
            scale: 1.0,
        };
        t.id = newId;
        titlesSpans.push(t);
    } else if (kind === "captionSpan") {
        // CAPTIONS layer: playhead par 2s default caption-span (Select karke
        // panel se style/size/position change karo — pehle ye branch tha hi nahi
        // isliye "＋" button click par span hi nahi banta tha → panel size/position
        // changes kaam nahi kar pa rahe the (span-less globals hi bante rehte the).
        newId = genId();
        captionSpans.push({
            id: newId, start, end,
            style: currentCaptionStyle,
            position: { ...captionPosition },
            fontScale: captionFontScale,
            overrides: { ...captionOverrides },
            remember: captionRemember,
        });
    }
    if (newId && typeof selectOnly === "function") selectOnly(kind, newId);
    recalcTimelineDuration();
    renderAll();
    persistTimelineState();
}

// PanZoom span delete hua to drag/panel clear
function pzOnDeleted() {
    pzDrag = null;
    const panel = document.getElementById("pzPanel");
    if (panel) panel.style.display = "none";
}

// ===== 3) CAPTIONS LAYER =====

function capSpanAt(t) {
    for (const s of captionSpans) if (t >= s.start && t < s.end) return s;
    return null;
}

// Captions generate hone par full-span layer banao (agar pehle se nahi hai)
function syncCaptionLayerFromCues(contentEnd) {
    if (!captionCues || !captionCues.length) return;
    if (captionSpans.length) return; // already layer hai
    let end = contentEnd || 0;
    if (!end && typeof timelineContentEnd !== "undefined") end = timelineContentEnd;
    if (!end && typeof sourceDuration !== "undefined") end = sourceDuration;
    if (!end) return;
    // GUARD (BUG 9 family): timelineContentEnd kabhi NaN/undefined aa jaye to
    // span end=NaN — baad me sab span-lookups NaN par fail hoti thin. Ab
    // NaN ho to cues ka SABSE LAMBA end hi span-end bana lo (hamesha valid).
    if (typeof end !== "number" || !isFinite(end)) {
        end = 0;
        (captionCues || []).forEach((c) => { if (typeof c.end === "number" && isFinite(c.end)) end = Math.max(end, c.end); });
        if (!end) return;
    }
    captionSpans.push({
        id: genId(), start: 0, end,
        style: currentCaptionStyle,
        position: { ...captionPosition },
        fontScale: captionFontScale,
        overrides: { ...captionOverrides },
        remember: captionRemember,
    });
    if (typeof persistTimelineState === "function") persistTimelineState();
}

// playhead-span ke params → globals (panel wahi dikhaye)
// (USER FIX) SELECTED caption segment playhead-span se zyada priority — user
// layer ko split kar ke alag-alag segments me alag style lagata hai; segment
// select karte hi panel usi segment ka style/size dikhaye (warna pichle
// segment/playhead ka stale style-name dropdown me reh jata tha)
function capSelectedSpan() {
    if (typeof selectedItems === "undefined" || !selectedItems.length) return null;
    for (let i = selectedItems.length - 1; i >= 0; i--) {
        const s = selectedItems[i];
        if (s && s.kind === "captionSpan") return captionSpans.find((x) => x.id === s.id) || null;
    }
    return null;
}

function capLoadPlayheadSpanToGlobals() {
    if (!captionSpans.length || typeof virtualTime === "undefined") return;
    const span = capSelectedSpan() || capSpanAt(virtualTime);
    if (!span) return;
    currentCaptionStyle = span.style || currentCaptionStyle;
    captionPosition = { ...(span.position || captionPosition) };
    captionFontScale = (span.fontScale != null) ? span.fontScale : captionFontScale;
    captionOverrides = { ...(span.overrides || {}) };
    captionRemember = (span.remember !== undefined) ? span.remember : captionRemember;
}

// ---- OVERRIDE: captions.js ka drawCaptionsOnCanvas — per-span params ke sath ----
// NOTE (HOISTING-TRAP): function-declaration se re-declare KARTE to hoisted shadow
// original ko replace kar deta aur __orig capture khud ko pakar leta (infinite
// recursion). Isliye CAPTURE + ASSIGNMENT pattern — originals pehle pakro, phir
// global name par wrapper assign karo.
const __origDrawCaptionsOnCanvas = (typeof drawCaptionsOnCanvas === "function") ? drawCaptionsOnCanvas : null;

var drawCaptionsOnCanvas = function (ctx, rectX, rectY, rectW, rectH, refHeightPx, isPreview) {
    if (!__origDrawCaptionsOnCanvas) return;
    if (!captionSpans.length || typeof virtualTime === "undefined") {
        __origDrawCaptionsOnCanvas(ctx, rectX, rectY, rectW, rectH, refHeightPx, isPreview);
        return;
    }
    const p = capEffectiveParamsAt(virtualTime);
    const save = {
        style: currentCaptionStyle, position: captionPosition,
        fontScale: captionFontScale, overrides: captionOverrides,
    };
    currentCaptionStyle = p.style;
    captionPosition = { x: p.position.x, y: p.position.y };
    captionFontScale = p.fontScale;
    captionOverrides = p.overrides || {};
    try {
        __origDrawCaptionsOnCanvas(ctx, rectX, rectY, rectW, rectH, refHeightPx, isPreview);
    } finally {
        currentCaptionStyle = save.style;
        captionPosition = save.position;
        captionFontScale = save.fontScale;
        captionOverrides = save.overrides;
    }
}

function capEffectiveParamsAt(t) {
    const span = capSpanAt(t);
    if (!span) {
        return {
            style: currentCaptionStyle, position: captionPosition,
            fontScale: captionFontScale, overrides: captionOverrides, fromSpan: false,
        };
    }
    return {
        style: span.style || currentCaptionStyle,
        position: span.position || captionPosition,
        fontScale: (span.fontScale != null) ? span.fontScale : captionFontScale,
        overrides: span.overrides || {},
        fromSpan: true,
    };
}

// ---- OVERRIDE: captions panel — playhead-piece editing (user choice) ----
const __origBuildCaptionsPanel = (typeof buildCaptionsPanel === "function") ? buildCaptionsPanel : null;

var buildCaptionsPanel = function () {
    if (!__origBuildCaptionsPanel) return;
    capLoadPlayheadSpanToGlobals(); // panel controls playhead-span ki values dikhayen
    __origBuildCaptionsPanel();
};

const __origPersistCaptions = (typeof persistCaptionsIfRemembered === "function") ? persistCaptionsIfRemembered : null;

var persistCaptionsIfRemembered = function () {
    // panel se koi bhi edit → SELECTED segment me copy (warna playhead-span)
    if (captionSpans.length && typeof virtualTime !== "undefined") {
        const span = capSelectedSpan() || capSpanAt(virtualTime);
        if (span) {
            span.style = currentCaptionStyle;
            span.position = { ...captionPosition };
            span.fontScale = captionFontScale;
            span.overrides = { ...captionOverrides };
            span.remember = captionRemember;
            if (typeof renderEffectLayers === "function") renderEffectLayers();
        }
    }
    if (__origPersistCaptions) __origPersistCaptions();
}

// generateCaptions ke baad layer sync (wrapper — original captions.js ka hai)
const __origGenerateCaptions = (typeof generateCaptions === "function") ? generateCaptions : null;
if (__origGenerateCaptions) {
    // function-declaration override (window property)
    generateCaptions = async function () {
        const __focus = (typeof document !== "undefined") ? document.activeElement : null;
        try { await __origGenerateCaptions(); } finally {
            // FOCUS FIX (BUG 9 ka blank-crash): captions.js alert() focus dialog
            // par chhod deta tha — phir Space/A/D dialog-button par jaate the
            // (aage-peeche samajh kar Space dabata rehta = screen par kuch nahi
            // hota + keybinding-parser crash -> poora app "hang" jaisa).
            try { if (__focus && typeof __focus.focus === "function") __focus.focus(); else if (typeof document !== "undefined" && document.body) document.body.focus(); } catch (e0) {}
        }
        try { syncCaptionLayerFromCues(); if (typeof renderAll === "function") renderAll(); } catch (e) { console.warn("caption layer sync:", e); }
    };
}

// ===== 4) COLOR GRADE LAYER =====

function gradeSpanAt(t) {
    for (const s of gradeSpans) if (t >= s.start && t < s.end) return s;
    return null;
}

// Grade panel ka edit-target: selected gradeSpan, warna playhead-span, warna global
function cgTargetSpan() {
    if (typeof selectedItems !== "undefined" && selectedItems.length) {
        for (let i = selectedItems.length - 1; i >= 0; i--) {
            if (selectedItems[i].kind === "gradeSpan") {
                const it = gradeSpans.find((g) => g.id === selectedItems[i].id);
                if (it) return it;
            }
        }
    }
    if (typeof virtualTime !== "undefined") return gradeSpanAt(virtualTime);
    return null;
}

// kis time par kaunsa grade effective hai (span > global)
function cgEffectiveGrade(t) {
    const tt = (t !== undefined && t !== null) ? t : (typeof virtualTime !== "undefined" ? virtualTime : undefined);
    if (typeof tt === "number" && isFinite(tt)) {
        const span = gradeSpanAt(tt);
        if (span) return span.grade || CG_DEFAULTS;
        // (USER FIX) Layer-workflow: grade-layers exist hain to unke BAHAR koi
        // grade NAHI lagta. Purana global-fallback yahan panel-ke last-edited
        // colorGrade (preset click se bhara hua) poore video par jala deta tha
        // — yehi reported bug tha. Global fallback sirf purane legacy saves ke
        // liye: jab koi grade-span hi na ho.
        if (gradeSpans && gradeSpans.length) return CG_DEFAULTS;
    }
    return (typeof colorGrade !== "undefined") ? colorGrade : CG_DEFAULTS;
}

// temp-swap wrappers: color_grade.js ke functions effective-grade ke sath chalein
// (CAPTURE + ASSIGNMENT — hoisting-trap se bachne ke liye, upar note dekho)
const __origCgCanvasFilter = (typeof cgCanvasFilter === "function") ? cgCanvasFilter : null;
var cgCanvasFilter = function () {
    if (!__origCgCanvasFilter) return "none";
    const eff = cgEffectiveGrade(typeof virtualTime !== "undefined" ? virtualTime : 0);
    const saved = colorGrade;
    colorGrade = (eff && typeof eff === "object") ? { ...eff } : { ...CG_DEFAULTS };
    try { return __origCgCanvasFilter(); } finally { colorGrade = saved; }
}

const __origCgTemp = (typeof cgApplyTemperatureOverlay === "function") ? cgApplyTemperatureOverlay : null;
var cgApplyTemperatureOverlay = function (ctx, w, h) {
    if (!__origCgTemp) return;
    const eff = cgEffectiveGrade(typeof virtualTime !== "undefined" ? virtualTime : 0);
    const saved = colorGrade;
    colorGrade = (eff && typeof eff === "object") ? { ...eff } : { ...CG_DEFAULTS };
    try { __origCgTemp(ctx, w, h); } finally { colorGrade = saved; }
}

const __origCgVig = (typeof cgApplyVignette === "function") ? cgApplyVignette : null;
var cgApplyVignette = function (ctx, w, h) {
    if (!__origCgVig) return;
    const eff = cgEffectiveGrade(typeof virtualTime !== "undefined" ? virtualTime : 0);
    const saved = colorGrade;
    colorGrade = (eff && typeof eff === "object") ? { ...eff } : { ...CG_DEFAULTS };
    try { __origCgVig(ctx, w, h); } finally { colorGrade = saved; }
}

// Grade panel edits → target span (selected/playhead)
function wireGradePanelToSpans() {
    const keys = ["brightness", "contrast", "saturation", "temperature", "sharpen", "vignette"];
    const copyToSpan = () => {
        const span = cgTargetSpan();
        if (span) {
            span.grade = { ...colorGrade };
            if (typeof persistTimelineState === "function") persistTimelineState();
        }
    };
    keys.forEach((k) => {
        const el = document.getElementById("cg_" + k);
        if (el) el.addEventListener("input", copyToSpan);
    });
    document.querySelectorAll(".cg-preset-btn").forEach((b) => b.addEventListener("click", copyToSpan));
    const rb = document.getElementById("cgResetBtn");
    if (rb) rb.addEventListener("click", copyToSpan);
}
if (typeof document !== "undefined" && document.getElementById("cg_brightness")) {
    wireGradePanelToSpans();
}

// panel header ka target-label: "layer span" ya "poori video"
function cgUpdateTargetLabel() {
    const el = document.getElementById("cgTargetLabel");
    if (!el) return;
    const span = (typeof cgTargetSpan === "function") ? cgTargetSpan() : null;
    el.textContent = span ? "— layer span" : "— poori video";
}

// (USER FIX) 🎨 topbar button ab LAYER-WORKFLOW follow karta hai:
// - agar selected/playhead grade-span hai → wahi select kar ke panel khulao
// - agar KOI span nahi → content-END tak FULL-SPAN layer ban kar select ho
//   ("puri video par color + koi layer nahi banti" wala masla khatam — ab
//   har grade ek layer-span mein rehta hai, global fallback sirf purane saves)
(function wireCgToggleSpanWorkflow() {
    const btn = document.getElementById("cgToggleBtn");
    if (!btn) return;
    btn.addEventListener("click", () => {
        try {
            const panel = document.getElementById("cgPanel");
            const isOpenNow = panel && panel.style.display === "block";
            if (!isOpenNow) { // color_grade.js ka toggle pehle chala = user CLOS kar raha hai
                if (panel) delete panel.dataset.autoForSpan;
                return;
            }
            let target = null;
            if (typeof selectedItems !== "undefined" && selectedItems.length) {
                const last = selectedItems[selectedItems.length - 1];
                if (last.kind === "gradeSpan") target = gradeSpans.find((g) => g.id === last.id) || null;
            }
            if (!target && typeof virtualTime !== "undefined") target = gradeSpanAt(virtualTime);
            if (!target) {
                let end = (typeof timelineContentEnd === "number" && isFinite(timelineContentEnd) && timelineContentEnd > 0) ? timelineContentEnd : 0;
                if (!end && typeof sourceDuration !== "undefined" && isFinite(sourceDuration)) end = sourceDuration;
                if (!end || end <= 0) end = 2;
                if (typeof pushHistory === "function") pushHistory();
                const nid = genId();
                gradeSpans.push({ id: nid, start: 0, end, grade: { ...CG_DEFAULTS } });
                target = gradeSpans[gradeSpans.length - 1];
                if (typeof selectOnly === "function") selectOnly("gradeSpan", nid);
                if (typeof recalcTimelineDuration === "function") recalcTimelineDuration();
                if (typeof renderAll === "function") renderAll();
                persistTimelineState();
            } else if (typeof selectOnly === "function") {
                selectOnly("gradeSpan", target.id);
                if (typeof renderAll === "function") renderAll();
            }
            if (panel) {
                panel.style.display = "block";
                panel.dataset.autoForSpan = "1";
            }
            if (target && typeof colorGrade !== "undefined" && !_layersSameJson(target.grade, colorGrade)) {
                colorGrade = { ...target.grade };
                if (typeof cgSyncUI === "function") cgSyncUI();
            }
            cgUpdateTargetLabel();
        } catch (e) { console.warn("cg toggle span-workflow:", e); }
    });
})();

// ===== 5) CROP AND ZOOM (PAN & ZOOM) =====

function pzSpanAt(t) {
    if (typeof t !== "number") return null;
    for (const s of panZoomSpans) if (t >= s.start && t < s.end) return s;
    return null;
}

function pzEditSpan() {
    if (typeof selectedItems !== "undefined" && selectedItems.length) {
        for (let i = selectedItems.length - 1; i >= 0; i--) {
            if (selectedItems[i].kind === "panZoom") {
                const it = panZoomSpans.find((s) => s.id === selectedItems[i].id);
                if (it) return it;
            }
        }
    }
    return (typeof virtualTime !== "undefined") ? pzSpanAt(virtualTime) : null;
}

function pzZoomAt(span, t) {
    const z = Math.max(1, span.zoom || 1);
    if (span.mode === "in" || span.mode === "out") {
        const dur = Math.max(0.01, span.end - span.start);
        const p = _layersClamp01((t - span.start) / dur);
        const e = p * p * (3 - 2 * p); // smoothstep ease
        return span.mode === "in" ? (1 + (z - 1) * e) : (z - (z - 1) * e);
    }
    return z;
}

// 9:16 output ke andar crop-region (normalized) — zoom jitna zyada, region utna chhota
function pzRegionAt(span, t) {
    const z = pzZoomAt(span, t);
    const b = span.box || { x: 0, y: 0, w: 1, h: 1 };
    let w = Math.min(1, b.w / z);
    let h = Math.min(1, b.h / z);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const x = Math.max(0, Math.min(cx - w / 2, 1 - w));
    const y = Math.max(0, Math.min(cy - h / 2, 1 - h));
    return { x, y, w, h };
}

// preview-canvas par zoom apply (compose ke BAAD, captions se PEHLE —
// crop_editor.js drawPreview se call hota hai)
function pzApplyToCanvas(canvas, ctx, t) {
    // NaN/undefined time par koi span nahi — warna pzSpanAt loop me t>=s.start
    // false dega (theek) magar snapshot key NaN ban sakta tha
    if (typeof t !== "number" || !isFinite(t)) return;
    const span = pzSpanAt(t);
    if (!span || !canvas || !ctx) return;
    const W = canvas.width, H = canvas.height;
    const r = pzRegionAt(span, t);
    if (r.w >= 0.999 && r.h >= 0.999 && (r.x <= 0.001) && (r.y <= 0.001)) return;
    const tmp = snapshotCanvas(canvas, "pz:" + span.id);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(tmp, r.x * W, r.y * H, r.w * W, r.h * H, 0, 0, W, H);
    // (HANG FIX) pehle yahan HAR FRAME par pzOnDeleted() chal raha tha —
    // 60fps par panel style write + pzDrag null = DOM thrash + panel foran
    // chhup jata tha. Cleanup sirf delete-flow (editor_tools pzOnDeleted) me.
}

// box overlay (editing handles) — preview par
function pzDrawOverlay() {
    const span = pzEditSpan();
    if (!span || typeof previewCtx === "undefined" || !previewCtx) return;
    const b = span.box || { x: 0, y: 0, w: 1, h: 1 };
    const W = previewCanvas.width, H = previewCanvas.height;
    previewCtx.save();
    previewCtx.strokeStyle = "#66d9ff";
    previewCtx.lineWidth = 2;
    previewCtx.setLineDash([6, 4]);
    previewCtx.strokeRect(b.x * W, b.y * H, b.w * W, b.h * H);
    previewCtx.setLineDash([]);
    const hs = 9;
    [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].forEach(([hx, hy]) => {
        previewCtx.fillStyle = "#66d9ff";
        previewCtx.fillRect(hx * W - hs / 2, hy * H - hs / 2, hs, hs);
    });
    previewCtx.fillStyle = "#66d9ff";
    previewCtx.font = "bold 11px Arial";
    previewCtx.fillText("Pan & Zoom", b.x * W + 4, Math.max(12, b.y * H - 6));
    previewCtx.restore();
}

// ---- box drag/resize (capture-phase: caption-drag se priority) ----
let pzDrag = null;

document.addEventListener("mousedown", (e) => {
    if (e.target !== previewCanvas) return;
    const span = pzEditSpan();
    if (!span) return;
    // (FIX) click CAPTION ke bbox ke andar hai to CAPTION drag ko jeetne do —
    // pz capture-handler caption ke move/resize drags chura raha tha (pz span
    // selected/active hone par). Caption priority — pz baad mein check hoga.
    try {
        if (typeof inCaptionBBox === "function" && window.__captionBBox) {
            const r2 = previewCanvas.getBoundingClientRect();
            const cpx = (e.clientX - r2.left) * (previewCanvas.width / r2.width);
            const cpy = (e.clientY - r2.top) * (previewCanvas.height / r2.height);
            if (inCaptionBBox({ x: cpx, y: cpy })) return;
        }
    } catch (err) {}
    const rect = previewCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    const b = span.box || { x: 0, y: 0, w: 1, h: 1 };
    const tol = 0.035;
    const corners = { tl: [b.x, b.y], tr: [b.x + b.w, b.y], bl: [b.x, b.y + b.h], br: [b.x + b.w, b.y + b.h] };
    let corner = null;
    for (const k in corners) {
        const [cx2, cy2] = corners[k];
        if (Math.abs(px - cx2) < tol && Math.abs(py - cy2) < tol) { corner = k; break; }
    }
    if (corner) {
        pzDrag = { span, type: "resize-" + corner, startPx: px, startPy: py, orig: { ...b } };
        e.stopPropagation();
        e.preventDefault();
        return;
    }
    if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) {
        pzDrag = { span, type: "move", startPx: px, startPy: py, orig: { ...b } };
        e.stopPropagation();
        e.preventDefault();
    }
}, true);

document.addEventListener("mousemove", (e) => {
    if (!pzDrag) return;
    const rect = previewCanvas.getBoundingClientRect();
    let px = (e.clientX - rect.left) / rect.width;
    let py = (e.clientY - rect.top) / rect.height;
    px = _layersClamp01(px);
    py = _layersClamp01(py);
    const b = pzDrag.span.box;
    if (pzDrag.type === "move") {
        b.x = Math.max(0, Math.min(1 - b.w, pzDrag.orig.x + (px - pzDrag.startPx)));
        b.y = Math.max(0, Math.min(1 - b.h, pzDrag.orig.y + (py - pzDrag.startPy)));
    } else {
        const anchorKey = pzDrag.type.slice(7); // "resize-" ke baad: "tl"/"tr"/"bl"/"br"
        const anchors = {
            tl: [pzDrag.orig.x + pzDrag.orig.w, pzDrag.orig.y + pzDrag.orig.h],
            tr: [pzDrag.orig.x, pzDrag.orig.y + pzDrag.orig.h],
            bl: [pzDrag.orig.x + pzDrag.orig.w, pzDrag.orig.y],
            br: [pzDrag.orig.x, pzDrag.orig.y],
        };
        const [ax, ay] = anchors[anchorKey];
        let x1 = Math.min(ax, px), x2 = Math.max(ax, px);
        let y1 = Math.min(ay, py), y2 = Math.max(ay, py);
        if (x2 - x1 < 0.05) x2 = x1 + 0.05;
        if (y2 - y1 < 0.05) y2 = y1 + 0.05;
        if (x2 > 1) { x2 = 1; x1 = Math.min(x1, x2 - 0.05); }
        if (y2 > 1) { y2 = 1; y1 = Math.min(y1, y2 - 0.05); }
        b.x = x1; b.y = y1; b.w = x2 - x1; b.h = y2 - y1;
    }
    // (HANG FIX) renderAll() yahan PER-MOUSEMOVE full-DOM rebuild kar raha tha.
    // Preview renderLoop 60fps par khud redraw karta hai (box span par live hai)
    // isliye yahan DOM render ki zaroorat nahi — sirf persist mouseup par.
});

document.addEventListener("mouseup", () => {
    if (pzDrag) {
        pzDrag = null;
        if (typeof persistTimelineState === "function") persistTimelineState();
    }
});

// ===== 6) TRANSITIONS =====

function findActiveTransition(t) {
    if (typeof t !== "number") return null;
    for (const tr of transitions) if (t >= tr.start && t < tr.end) return tr;
    return null;
}

// span ke andar video clip-boundary (end == next.start) — crossfade ke liye
function findBoundaryInSpan(tr) {
    const mid = (tr.start + tr.end) / 2;
    let best = null;
    for (const c of videoClips) {
        const nxt = videoClips.find((x) => Math.abs(x.start - c.end) < 0.02);
        if (!nxt) continue;
        const b = c.end;
        if (b > tr.start && b < tr.end) {
            if (best === null || Math.abs(b - mid) < Math.abs(best - mid)) best = b;
        }
    }
    return best;
}

// preview par transition effect apply (current-frame approximation — export
// mein real crossfade hota hai)
function transApplyToCanvas(canvas, ctx, t) {
    const tr = findActiveTransition(t);
    if (!tr || !canvas || !ctx) return;
    const dur = tr.duration || 0.6;
    const k = (tr.intensity || 60) / 100;
    const W = canvas.width, H = canvas.height;

    if (tr.type === "fadein") {
        const p = _layersClamp01((t - tr.start) / dur);
        if (p < 1) {
            ctx.fillStyle = `rgba(0,0,0,${((1 - p) * k).toFixed(3)})`;
            ctx.fillRect(0, 0, W, H);
        }
    } else if (tr.type === "fadeout") {
        const p = _layersClamp01((tr.end - t) / dur);
        if (p < 1) {
            ctx.fillStyle = `rgba(0,0,0,${((1 - p) * k).toFixed(3)})`;
            ctx.fillRect(0, 0, W, H);
        }
    } else if (tr.type === "crossfade") {
        const b = findBoundaryInSpan(tr);
        if (b !== null) {
            const a = _layersClamp01((t - (b - dur / 2)) / dur);
            // preview approximation: dip-through-dark (export mein A+B blend hai)
            ctx.fillStyle = `rgba(0,0,0,${(Math.sin(a * Math.PI) * 0.85 * k).toFixed(3)})`;
            ctx.fillRect(0, 0, W, H);
        }
    } else if (tr.type === "slideleft" || tr.type === "slideright" || tr.type === "zoomin") {
        const p = _layersClamp01((t - tr.start) / dur);
        if (p < 1) {
            const tmp = snapshotCanvas(canvas, "trans:" + tr.id);
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, W, H);
            if (tr.type === "slideleft") {
                const off = (1 - p) * W * k;
                ctx.drawImage(tmp, -off, 0);
            } else if (tr.type === "slideright") {
                const off = (1 - p) * W * k;
                ctx.drawImage(tmp, off, 0);
            } else {
                const s = 1 + (1 - p) * 0.5 * k;
                const dw = W * s, dh = H * s;
                ctx.drawImage(tmp, (W - dw) / 2, (H - dh) / 2, dw, dh);
            }
        }
    }
}

// ===== 7) PANELS SYNC (selection ke hisaab se show/hide + values load) =====

function hideEffectPanels() {
    const tp = document.getElementById("transPanel");
    const pp = document.getElementById("pzPanel");
    if (tp) tp.style.display = "none";
    if (pp) pp.style.display = "none";
    const ttl = document.getElementById("titlesPanel");
    // (TITLES) titlesPanel auto-hide hota hai — selected title-span nahi ho to
    // (sirf panel-data show karo OPEN button se band);
}

function syncPanelsToSelection() {
    if (typeof selectedItems === "undefined") return;
    const sel = selectedItems[selectedItems.length - 1] || null;

    // ---- TRANSITIONS PANEL ----
    const tp = document.getElementById("transPanel");
    if (tp) {
        const tr = (sel && sel.kind === "transition") ? transitions.find((x) => x.id === sel.id) : null;
        if (tr) {
            tp.style.display = "block";
            // (NEW) type-grid highlight + target label (media-bin gallery panel)
            const tl = document.getElementById("transTargetLabel");
            if (tl) tl.textContent = `(${tr.start.toFixed(1)}s – ${tr.end.toFixed(1)}s)`;
            document.querySelectorAll(".trans-type-btn").forEach((b) => {
                b.classList.toggle("active", b.dataset.type === (tr.type || "crossfade"));
            });
            const typeEl = document.getElementById("transType");
            const durEl = document.getElementById("transDuration");
            const durVal = document.getElementById("transDurationVal");
            const intEl = document.getElementById("transIntensity");
            const intVal = document.getElementById("transIntensityVal");
            if (typeEl && document.activeElement !== typeEl) typeEl.value = tr.type || "crossfade";
            if (durEl && document.activeElement !== durEl) {
                durEl.value = tr.duration != null ? tr.duration : 0.6;
                if (durVal) durVal.textContent = (tr.duration != null ? tr.duration : 0.6) + "s";
            }
            if (intEl && document.activeElement !== intEl) {
                intEl.value = tr.intensity != null ? tr.intensity : 60;
                if (intVal) intVal.textContent = (tr.intensity != null ? tr.intensity : 60) + "%";
            }
        } else {
            tp.style.display = "none";
        }
    }

    // ---- TITLES PANEL sync (selected title-span → template/text values) ----
    // (USER FIX) title-span select karne par Titles panel AUTO-OPEN ho — pehle
    // sirf rebuild-hot-ho-state tha (panel pe se khula nahi to kuch nahi dikhta); 
    // ab jaise grade-panel wala auto-open pattern hai: open + values load. 
    // input-focus-loss guard: har render par sirf tab rebuild jis span ki id nai. 
    if (sel && sel.kind === "titleSpan") {
        const ts = (typeof titlesSpans !== "undefined") ? titlesSpans.find((s) => s.id === sel.id) : null;
        const wrap2 = document.getElementById("titlesPanel");
        if (ts && wrap2 && typeof buildTitlesPanel === "function") {
            if (wrap2.style.display !== "block") wrap2.style.display = "block";
            wrap2.dataset.autoForSpan = "1";
            if (__ttlPanelSyncId !== ts.id) {
                __ttlPanelSyncId = ts.id;
                if (typeof titlesPanelOpen !== "undefined") titlesPanelOpen = true; // button active-hover ke liye
                buildTitlesPanel();
            }
        }
    } else if (typeof __ttlPanelSyncId !== "undefined" && __ttlPanelSyncId) {
        __ttlPanelSyncId = null;
        // deselect → auto-open kiya hua panel band karo (user ne manually open 
        // kiya ho to rehne do — dataset se pata chal jata hai)
        const wrap2 = document.getElementById("titlesPanel");
        if (wrap2 && wrap2.dataset.autoForSpan === "1") {
            wrap2.style.display = "none";
            delete wrap2.dataset.autoForSpan;
            if (typeof titlesPanelOpen !== "undefined") titlesPanelOpen = false;
        }
    }

    // ---- PAN & ZOOM PANEL ----
    const pp = document.getElementById("pzPanel");
    if (pp) {
        const pz = (sel && sel.kind === "panZoom") ? panZoomSpans.find((x) => x.id === sel.id) : null;
        if (pz) {
            pp.style.display = "block";
            document.querySelectorAll(".pz-mode-btn").forEach((btn) => {
                btn.classList.toggle("active", btn.dataset.pzmode === (pz.mode || "static"));
            });
            // (NEW) zoom slider ko span ki value se sync (manual zoom control)
            const zz = document.getElementById("pzZoom");
            const zv = document.getElementById("pzZoomVal");
            if (zz && document.activeElement !== zz) {
                const z = (pz.zoom != null) ? pz.zoom : 1;
                zz.value = z;
                if (zv) zv.textContent = z.toFixed(2) + "x";
            }
        } else {
            pp.style.display = "none";
        }
    }

    // ---- GRADE PANEL panel-values ko selected span se sync ----
    // (USER FIX) gradeSpan select hote hi cgPanel AUTO-OPEN ho — pehle panel
    // kabhi khulta hi nahi tha (sirf topbar button se), isliye "options nahi
    // aate" + "kuch change nahi hota" lagta tha. Deselect par auto-hide.
    const cgPanel = document.getElementById("cgPanel");
    if (sel && sel.kind === "gradeSpan") {
        const span = gradeSpans.find((g) => g.id === sel.id);
        if (span) {
            if (cgPanel) {
                if (cgPanel.style.display !== "block") cgPanel.style.display = "block";
                cgPanel.dataset.autoForSpan = "1";
            }
            if (typeof colorGrade !== "undefined" && !_layersSameJson(span.grade, colorGrade)) {
                colorGrade = { ...span.grade };
                if (typeof cgSyncUI === "function") cgSyncUI();
            }
        }
    } else if (cgPanel && cgPanel.dataset.autoForSpan === "1") {
        cgPanel.style.display = "none";
        delete cgPanel.dataset.autoForSpan;
    }
    if (typeof cgUpdateTargetLabel === "function") cgUpdateTargetLabel();

    // ---- CAPTIONS PANEL: selected segment ke values se sync ----
    // (USER FIX) caption segment select → panel usi segment ka style/size/colors
    // dikhaye (multi-split layers me har segment ki apni style hoti hai).
    // Guard: sirf jab SELECTED SPAN BADLE — har render par rebuild se input
    // focus toot jata.
    if (sel && sel.kind === "captionSpan") {
        const cs = captionSpans.find((x) => x.id === sel.id);
        if (cs && __capPanelSyncId !== cs.id) {
            __capPanelSyncId = cs.id;
            if (typeof buildCaptionsPanel === "function") buildCaptionsPanel();
        }
    } else if (__capPanelSyncId) {
        // deselect → panel wapas playhead-span ke values par
        __capPanelSyncId = null;
        if (typeof buildCaptionsPanel === "function") buildCaptionsPanel();
    }
}
let __capPanelSyncId = null;
let __ttlPanelSyncId = null;

function wireEffectPanels() {
    // ---- transitions panel ----
    const tp = document.getElementById("transPanel");
    if (tp) {
        const closeBtn = document.getElementById("transCloseBtn");
        if (closeBtn) closeBtn.addEventListener("click", () => { tp.style.display = "none"; });
        const typeEl = document.getElementById("transType");
        const durEl = document.getElementById("transDuration");
        const intEl = document.getElementById("transIntensity");
        const commit = () => {
            if (typeof selectedItems === "undefined" || !selectedItems.length) return;
            const sel = selectedItems[selectedItems.length - 1];
            if (sel.kind !== "transition") return;
            const tr = transitions.find((x) => x.id === sel.id);
            if (!tr) return;
            if (typeEl) tr.type = typeEl.value;
            if (durEl) tr.duration = parseFloat(durEl.value);
            if (intEl) tr.intensity = parseFloat(intEl.value);
            if (typeof renderAll === "function") renderAll();
            persistTimelineState();
        };
        // (NEW) TYPE-GALLERY: har type-button click = selected transition span ka
        // type badlo (select-dropdown ki jagah — user ko visual options chahiye)
        document.querySelectorAll(".trans-type-btn").forEach((b) => {
            b.addEventListener("click", () => {
                if (typeof selectedItems === "undefined" || !selectedItems.length) return;
                const sel = selectedItems[selectedItems.length - 1];
                if (sel.kind !== "transition") return;
                const tr = transitions.find((x) => x.id === sel.id);
                if (!tr) return;
                tr.type = b.dataset.type;
                document.querySelectorAll(".trans-type-btn").forEach((x) => x.classList.toggle("active", x === b));
                if (typeof renderAll === "function") renderAll();
                persistTimelineState();
            });
        });
        // (NEW) panel ke andar bhi "+" — playhead par foran naya transition span
        const addBtn = document.getElementById("transAddBtn");
        if (addBtn) addBtn.addEventListener("click", () => {
            if (typeof createEffectSpan !== "function") return;
            if (typeof pausePlayback === "function") pausePlayback();
            if (typeof playPauseBtnEl !== "undefined" && playPauseBtnEl) playPauseBtnEl.textContent = "▶";
            const base = (typeof virtualTime === "number" && isFinite(virtualTime)) ? virtualTime : 0;
            createEffectSpan("transition", base, base + 2);
        });
        if (typeEl) typeEl.addEventListener("change", commit);
        if (durEl) durEl.addEventListener("input", () => {
            const v = document.getElementById("transDurationVal");
            if (v) v.textContent = parseFloat(durEl.value).toFixed(1) + "s";
            commit();
        });
        if (intEl) intEl.addEventListener("input", () => {
            const v = document.getElementById("transIntensityVal");
            if (v) v.textContent = durEl && false ? "" : parseInt(intEl.value, 10) + "%";
            commit();
        });
    }

    // ---- pz panel ----
    const pp = document.getElementById("pzPanel");
    if (pp) {
        const closeBtn = document.getElementById("pzCloseBtn");
        if (closeBtn) closeBtn.addEventListener("click", () => { pp.style.display = "none"; });
        document.querySelectorAll(".pz-mode-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                if (typeof selectedItems === "undefined" || !selectedItems.length) return;
                const sel = selectedItems[selectedItems.length - 1];
                if (sel.kind !== "panZoom") return;
                const pz = panZoomSpans.find((x) => x.id === sel.id);
                if (!pz) return;
                pz.mode = btn.dataset.pzmode;
                document.querySelectorAll(".pz-mode-btn").forEach((b) => b.classList.toggle("active", b === btn));
                if (typeof renderAll === "function") renderAll();
                persistTimelineState();
            });
        });
        const delBtn = document.getElementById("pzDeleteBtn");
        if (delBtn) delBtn.addEventListener("click", () => {
            if (typeof deleteSelected === "function") deleteSelected();
        });
        // (NEW) MANUAL ZOOM SLIDER — box ke andar zoom amount user khud set kare
        const pzZoomEl = document.getElementById("pzZoom");
        if (pzZoomEl) pzZoomEl.addEventListener("input", () => {
            if (typeof selectedItems === "undefined" || !selectedItems.length) return;
            const sel = selectedItems[selectedItems.length - 1];
            if (sel.kind !== "panZoom") return;
            const pz = panZoomSpans.find((x) => x.id === sel.id);
            if (!pz) return;
            pz.zoom = parseFloat(pzZoomEl.value);
            const zv = document.getElementById("pzZoomVal");
            if (zv) zv.textContent = pz.zoom.toFixed(2) + "x";
            if (typeof invalidateSnapshot === "function") invalidateSnapshot();
            persistTimelineState();
        });
    }
}
wireEffectPanels();

// ===== 8) DRAW WRAPPERS (preview par pz/trans overlay order theek karne ke liye) =====
// NOTE: pz/trans ka FRAME-transform crop_editor.js ke drawPreview ke andar se
// (captions se pehle) call hota hai — pzApplyToCanvas/transApplyToCanvas.
// Ye wrapper sirf BOX-OVERLAY (editing handles) draw karta hai.
const __origDrawPreview = (typeof drawPreview === "function") ? drawPreview : null;
if (__origDrawPreview) {
    drawPreview = function () {        __origDrawPreview();
        try {
            if (typeof pzDrawOverlay === "function") pzDrawOverlay();
        } catch (e) { console.warn("pz overlay error:", e); }
        // SHORTS CANVAS: edit-handles overlay (sab se upar — sirf panel khula ho)
        try {
            if (typeof scDrawOverlay === "function") scDrawOverlay(previewCtx);
        } catch (e) { console.warn("shorts overlay error:", e); }
    };
}

// ===== 9) INIT MIGRATION (purane saves → naye layers) =====
function migrateEffectLayers(stateData) {
    // (a) purana GLOBAL color grade → full-span grade layer (user choice)
    try {
        const g = stateData.colorGrade;
        const hasGrade = g && Object.keys(g).some((k) => (g[k] || 0) !== 0);
        if (hasGrade && (!gradeSpans || gradeSpans.length === 0)) {
            let end = 0;
            (stateData.videoClips || []).forEach((c) => { end = Math.max(end, c.end || 0); });
            (stateData.audioLanes || []).forEach((c) => { end = Math.max(end, c.end || 0); });
            if (end > 0) {
                gradeSpans = [{ id: genId(), start: 0, end, grade: { ...g } }];
                // global grade reset (ab layer-based hai)
                if (typeof colorGrade !== "undefined") {
                    Object.keys(colorGrade).forEach((k) => { colorGrade[k] = 0; });
                    if (typeof cgSyncUI === "function") cgSyncUI();
                }
            }
        }
    } catch (e) { console.warn("grade migrate:", e); }

    // (b) captions cues bina layer ke → auto full-span captions layer
    try {
        if ((stateData.captionCues || []).length && captionSpans.length === 0) {
            let end = 0;
            (stateData.videoClips || []).forEach((c) => { end = Math.max(end, c.end || 0); });
            syncCaptionLayerFromCues(end);
        }
    } catch (e) { console.warn("captions migrate:", e); }
}

// ===== 10) SUBTITLES PANEL (SRT / TXT download) =====

let subtitleCues = [];
let subPanelGenerated = false;

function subFmtSrt(t) {
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const ms = Math.round((t - Math.floor(t)) * 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function subFmtShort(t) {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function renderSubtitlesList(cached) {
    const list = document.getElementById("subList");
    const hint = document.getElementById("subHint");
    if (!list) return;
    list.innerHTML = "";
    subtitleCues.forEach((c) => {
        const row = document.createElement("div");
        row.className = "sub-cue";
        const time = document.createElement("span");
        time.className = "sub-cue-time";
        time.textContent = `[${subFmtShort(c.start)} → ${subFmtShort(c.end)}]`;
        const txt = document.createElement("span");
        txt.textContent = c.text;
        row.appendChild(time);
        row.appendChild(txt);
        list.appendChild(row);
    });
    if (hint) {
        hint.textContent = subtitleCues.length
            ? (cached ? `⚡ Transcription CACHE se load hua (${subtitleCues.length} lines) — whisper dobara nahi chala.`
                      : `${subtitleCues.length} subtitle lines generated — agli dafa same video par cache se load hoga.`)
            : "Koi subtitle nahi mili — video mein clear audio honi chahiye.";
    }
}

async function generateSubtitles() {
    if (!currentVideoRef) return;
    const btn = document.getElementById("generateSubtitlesBtn");
    const label = btn ? btn.querySelector(".tool-label") : null;
    const original = label ? label.textContent : null;
    if (btn) btn.disabled = true;
    if (label) label.textContent = "Making…";

    try {
        const res = await fetch(`/video/${currentVideoRef.saved_name}/generate_subtitles`, { method: "POST" });
        const data = await res.json();
        if (data.error) { alert("Subtitles failed: " + data.error); return; }

        subtitleCues = (data.cues || []).map((c) => ({ start: c.start, end: c.end, text: c.text }));
        subPanelGenerated = true;

        const panel = document.getElementById("subtitlesPanel");
        if (panel) {
            panel.style.display = "block";
            const body = document.getElementById("subBody");
            const tog = document.getElementById("subCollapse");
            if (body) body.style.display = "";
            if (tog) tog.textContent = "▾";
        }
        renderSubtitlesList(!!data.cached);
    } catch (err) {
        alert("Subtitles error: " + err);
    } finally {
        if (btn) btn.disabled = false;
        if (label && original) label.textContent = original;
    }
}

// FIX: WebView2 (pywebview) native window mein blob-download (a.click) kaam
// nahi karta — video-export mein bhi isi liye Explorer-reveal pattern hai.
// Ab SRT/TXT bhi backend se exports/ folder mein file bana kar Explorer mein
// REVEAL hoti hai (folder khul kar file select hoti hai).
async function downloadSubtitlesFile(kind) {
    if (!subtitleCues.length) { alert("Pehle Subtitles generate karo."); return; }
    if (!currentVideoRef) return;
    try {
        const res = await fetch(`/video/${currentVideoRef.saved_name}/export_subtitles/${kind}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ original_name: currentVideoRef.original_name || "" }),
        });
        const data = await res.json();
        if (data.error) { alert("Download fail: " + data.error); return; }
    } catch (err) {
        alert("Download error: " + err);
    }
}

function wireSubtitlesPanel() {
    const btn = document.getElementById("generateSubtitlesBtn");
    if (btn) btn.addEventListener("click", generateSubtitles);

    const srtBtn = document.getElementById("subDownloadSrt");
    if (srtBtn) srtBtn.addEventListener("click", () => downloadSubtitlesFile("srt"));
    const txtBtn = document.getElementById("subDownloadTxt");
    if (txtBtn) txtBtn.addEventListener("click", () => downloadSubtitlesFile("txt"));

    // collapse toggle
    const header = document.querySelector("#subtitlesPanel .sub-header");
    if (header) {
        header.addEventListener("click", () => {
            const body = document.getElementById("subBody");
            const tog = document.getElementById("subCollapse");
            if (body) body.style.display = body.style.display === "none" ? "" : "none";
            if (tog) tog.textContent = (body && body.style.display === "none") ? "▸" : "▾";
        });
    }

    // media-bin collapse par subtitles panel bhi fold (app.js wala pattern)
    const mediaBin = document.getElementById("mediaBin");
    if (mediaBin) {
        mediaBin.addEventListener("click", () => {
            setTimeout(() => {
                const panel = document.getElementById("subtitlesPanel");
                if (!panel) return;
                if (mediaBin.classList.contains("collapsed")) panel.style.display = "none";
                else if (subPanelGenerated) panel.style.display = "block";
            }, 0);
        });
    }
}
wireSubtitlesPanel();
```

### Name: frontend/main.py
```python
from fastapi import FastAPI, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
import os, subprocess, json, uuid

from ffmpeg_engine import generate_thumbnails, generate_waveform

app = FastAPI()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(os.path.dirname(BASE_DIR), "frontend")
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
CACHE_DIR = os.path.join(BASE_DIR, "cache")
DATA_DIR = os.path.join(BASE_DIR, "data")
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(CACHE_DIR, exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)


def get_video_info(path):
    cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate",
        "-show_entries", "format=duration",
        "-of", "json", path
    ]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    data = json.loads(out)
    stream = data["streams"][0]
    duration = float(data["format"]["duration"])
    width, height = int(stream["width"]), int(stream["height"])
    num, den = stream["r_frame_rate"].split("/")
    fps = float(num) / float(den) if float(den) != 0 else 30.0
    return {"duration": duration, "width": width, "height": height, "fps": fps}


@app.post("/upload")
async def upload_video(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename)[1]
    video_id = uuid.uuid4().hex[:10]
    saved_name = f"{video_id}{ext}"
    saved_path = os.path.join(UPLOAD_DIR, saved_name)

    with open(saved_path, "wb") as f:
        content = await file.read()
        f.write(content)

    try:
        info = get_video_info(saved_path)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    return {
        "id": video_id,
        "original_name": file.filename,
        "saved_name": saved_name,
        "duration": info["duration"],
        "width": info["width"],
        "height": info["height"],
        "fps": info["fps"],
    }


@app.get("/video/{saved_name}")
def stream_video(saved_name: str):
    path = os.path.join(UPLOAD_DIR, saved_name)
    if not os.path.exists(path):
        return JSONResponse({"error": "Video not found"}, status_code=404)
    return FileResponse(path, media_type="video/mp4")


@app.get("/video/{saved_name}/timeline_assets")
def timeline_assets(saved_name: str):
    path = os.path.join(UPLOAD_DIR, saved_name)
    if not os.path.exists(path):
        return JSONResponse({"error": "Video not found"}, status_code=404)

    video_id = os.path.splitext(saved_name)[0]
    info = get_video_info(path)

    thumbs = generate_thumbnails(path, CACHE_DIR, video_id, info["duration"])
    waveform = generate_waveform(path, CACHE_DIR, video_id)

    return {
        "duration": info["duration"],
        "thumbnails": thumbs,
        "waveform": waveform,
    }


@app.get("/cache/{filename}")
def get_cache_file(filename: str):
    path = os.path.join(CACHE_DIR, filename)
    if not os.path.exists(path):
        return JSONResponse({"error": "File not found"}, status_code=404)
    return FileResponse(path)


# ===== TIMELINE DATA (segments + audio lanes) =====

def timeline_data_path(saved_name: str):
    video_id = os.path.splitext(saved_name)[0]
    return os.path.join(DATA_DIR, f"{video_id}_timeline.json")


@app.get("/video/{saved_name}/segments")
def get_timeline_data(saved_name: str):
    path = timeline_data_path(saved_name)
    if not os.path.exists(path):
        return {"segments": [], "audioLanes": [], "videoClips": []}
    with open(path, "r") as f:
        data = json.load(f)
        data.setdefault("segments", [])
        data.setdefault("audioLanes", [])
        data.setdefault("videoClips", [])
        return data


@app.post("/video/{saved_name}/segments")
async def save_timeline_data(saved_name: str, payload: dict):
    path = timeline_data_path(saved_name)
    out = {
        "segments": payload.get("segments", []),
        "audioLanes": payload.get("audioLanes", []),
        "videoClips": payload.get("videoClips", []),
    }
    with open(path, "w") as f:
        json.dump(out, f, indent=2)
    return {"status": "ok"}


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
```

### Name: frontend/projects.js
```js
// ============================================================================
// PROJECTS — Save / Load / Rename / Delete system
// Main folder ke andar `projects/` ban-ta hai. Har project folder mein:
//   project.json + media/ (videos ki SAFE copies + timeline JSONs)
// Uploads session-only hain (app close par delete), isliye save par media copy
// hoti hai aur restore par wapis uploads/ mein aati hai.
// ============================================================================

let pjOpen = false;

function pjEl(id) { return document.getElementById(id); }

function pjShowHint(msg, isErr) {
    const h = pjEl("pjHint");
    if (!h) return;
    h.textContent = msg || "";
    h.classList.toggle("error", !!isErr);
    if (msg) setTimeout(() => { if (h.textContent === msg) h.textContent = ""; }, 4000);
}

async function pjListProjects() {
    try {
        const res = await fetch("/projects");
        const data = await res.json();
        return data.projects || [];
    } catch (e) { return []; }
}

async function pjRenderList() {
    const list = pjEl("pjList");
    if (!list) return;
    const projects = await pjListProjects();
    list.innerHTML = "";

    if (!projects.length) {
        const empty = document.createElement("div");
        empty.className = "pj-empty";
        empty.textContent = "Koi project saved nahi hai — upar naam likh kar Save dabao.";
        list.appendChild(empty);
        return;
    }

    projects.forEach(p => {
        const row = document.createElement("div");
        row.className = "pj-row";

        const info = document.createElement("div");
        info.className = "pj-row-info";
        const nm = document.createElement("div");
        nm.className = "pj-row-name";
        nm.textContent = p.name;
        const sub = document.createElement("div");
        sub.className = "pj-row-sub";
        sub.textContent = `${p.video_count || 0} video(s) • ${p.saved_at || ""}`;
        info.appendChild(nm);
        info.appendChild(sub);

        const actions = document.createElement("div");
        actions.className = "pj-row-actions";

        const openB = document.createElement("button");
        openB.className = "pj-mini-btn pj-open";
        openB.textContent = "Open";
        openB.title = "Is project ko kholo (media wapis load hoti hai)";
        openB.addEventListener("click", () => pjOpenProject(p.name));

        const renB = document.createElement("button");
        renB.className = "pj-mini-btn";
        renB.textContent = "Rename";
        renB.addEventListener("click", async () => {
            const nn = prompt("Naya naam:", p.name);
            if (!nn || nn.trim() === "" || nn === p.name) return;
            const res = await fetch(`/projects/${encodeURIComponent(p.name)}/rename`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ new_name: nn.trim() })
            });
            const d = await res.json().catch(() => ({}));
            if (d.error) { pjShowHint("Rename fail: " + d.error, true); return; }
            pjShowHint(`Project rename ho gaya: ${d.name}`);
            pjRenderList();
        });

        const delB = document.createElement("button");
        delB.className = "pj-mini-btn pj-danger";
        delB.textContent = "Del";
        delB.title = "Project delete (media copies bhi)";
        delB.addEventListener("click", async () => {
            if (!confirm(`"${p.name}" delete kar dein? Media copies bhi delete hongi.`)) return;
            await fetch(`/projects/${encodeURIComponent(p.name)}`, { method: "DELETE" });
            pjShowHint("Project delete ho gaya");
            pjRenderList();
        });

        actions.appendChild(openB);
        actions.appendChild(renB);
        actions.appendChild(delB);
        row.appendChild(info);
        row.appendChild(actions);
        list.appendChild(row);
    });
}

async function pjSaveProject(name) {
    name = (name || "").trim();
    if (!name) { pjShowHint("Pehle project ka naam likho", true); return; }
    if (typeof uploadedVideos === "undefined" || !uploadedVideos.length) {
        pjShowHint("Koi video loaded nahi hai — pehle media import karo", true);
        return;
    }
    const active = (typeof currentVideoRef !== "undefined" && currentVideoRef)
        ? currentVideoRef.saved_name : null;
    // timeline state ko pehle flush karo (persistTimelineState async hai)
    if (typeof persistTimelineState === "function") {
        try { await persistTimelineState(); } catch (e) {}
    }
    try {
        const res = await fetch(`/projects/${encodeURIComponent(name)}/save`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                videos: uploadedVideos,
                active_saved_name: active
            })
        });
        const d = await res.json().catch(() => ({}));
        if (d.error) { pjShowHint("Save fail: " + d.error, true); return; }
        pjShowHint(`Project "${d.name}" save ho gaya (${d.videos} video, media copy bhi)`);
        pjRenderList();
    } catch (e) {
        pjShowHint("Save fail: " + e, true);
    }
}

async function pjOpenProject(name) {
    try {
        const res = await fetch(`/projects/${encodeURIComponent(name)}/restore`, { method: "POST" });
        const d = await res.json().catch(() => ({}));
        if (d.error) { pjShowHint("Open fail: " + d.error, true); return; }
        if (!d.videos || !d.videos.length) {
            pjShowHint("Project khali hai (media missing)", true);
            return;
        }
        // frontend state refresh
        if (typeof uploadedVideos !== "undefined") {
            uploadedVideos.length = 0;
            d.videos.forEach(v => uploadedVideos.push(v));
        }
        if (typeof renderVideoList === "function") renderVideoList();
        const activeName = d.active_saved_name || (d.videos[0] && d.videos[0].saved_name);
        const active = d.videos.find(v => v.saved_name === activeName) || d.videos[0];
        if (active && typeof selectVideo === "function") await selectVideo(active);
        pjShowHint(`Project "${name}" khul gaya (${d.videos.length} video)`);
        pjToggle(); // panel band kar do
    } catch (e) {
        pjShowHint("Open fail: " + e, true);
    }
}

function pjToggle() {
    const panel = pjEl("projectsPanel");
    if (!panel) return;
    pjOpen = !pjOpen;
    panel.classList.toggle("open", pjOpen);
    if (pjOpen) pjRenderList();
}

// auto-init
(function pjInit() {
    function wire() {
        const btn = pjEl("pjToggleBtn");
        if (btn) btn.addEventListener("click", pjToggle);
        const closeB = pjEl("pjCloseBtn");
        if (closeB) closeB.addEventListener("click", pjToggle);
        const saveB = pjEl("pjSaveBtn");
        if (saveB) saveB.addEventListener("click", () => pjSaveProject(pjEl("pjNameInput") ? pjEl("pjNameInput").value : ""));
        const input = pjEl("pjNameInput");
        if (input) input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") pjSaveProject(input.value);
        });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
    else wire();
})();

// saveCurrentProject global (Ctrl+S keybinding isi ko call karta hai)
window.saveCurrentProject = function () {
    if (!pjOpen) pjToggle();
    const input = pjEl("pjNameInput");
    if (input && !input.value.trim()) {
        input.focus();
        pjShowHint("Project ka naam likh kar Enter dabao (ya Save dabao)", false);
    } else if (input) {
        pjSaveProject(input.value);
    }
};
```

### Name: frontend/shorts_canvas.js
```js
// ===== SHORTS CANVAS ENGINE (shorts_canvas.js) =====
// 16:9 video ko 9:16 (shorts) window me place karna:
//   Canvas 1 = background me SAME video blur hui (blur level adjustable)
//   Canvas 2 = background me solid COLOR (color picker)
// Video ka SIZE aur POSITION adjustable (sliders + preview par direct drag/resize
// — sab corners se). SIZE aur POSITION ki saved settings ALAG-ALAG save hoti hain
// (Save Size / Save Position) — Shorts Canvas ON hote hi dono auto-apply.
//
// Integration:
// - crop_editor.js drawPreview -> scApplyToPreview(...) (9:16 output canvas)
// - layers.js drawPreview wrapper -> scDrawOverlay(...) (edit handles)
// - persistence: persistTimelineState payload "shortsCanvas" + localStorage

/* eslint-disable no-redeclare */

// ===== STATE =====
const SC_DEFAULTS = {
    mode: "blur",        // "blur" (Canvas 1) | "color" (Canvas 2)
    blurLevel: 14,       // 0-30 (Canvas 1)
    bgColor: "#000000",  // (Canvas 2)
    size: 1.0,           // 0.3-1.0 — video box scale (fit-width = 1.0)
    posX: 0.5,           // 0-1 — video box center
    posY: 0.5,
    wS: 1.0,             // width-stretch (edge-handles se single-edge resize)
    hS: 1.0,             // height-stretch
};
const SC_STORAGE_KEY = "scSavedSettings_v2"; // v2: size/pos ALAG saved

let scCur = { ...SC_DEFAULTS };
let scSavedSize = null;          // { size } ya null
let scSavedPos = null;           // { posX, posY } ya null
let shortsOn = false;
let scDrag = null;

// Load par saved size/pos uthao — "Shorts Canvas active hote hi saved settings
// ke mutabiq video place ho jaye"
try {
    const raw = localStorage.getItem(SC_STORAGE_KEY);
    if (raw) {
        const p = JSON.parse(raw);
        if (p) {
            if (p.size) scSavedSize = { ...p.size };
            if (p.pos) scSavedPos = { ...p.pos };
            if (p.cur) scCur = { ...SC_DEFAULTS, ...p.cur };
            shortsOn = !!p.enabled;
        }
    }
} catch (e) { /* corrupt storage — ignore */ }

function _scClamp01(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }
function _scMarkDirty() {
    try { if (typeof persistTimelineState === "function") persistTimelineState(); } catch (e) {}
}

// ===== PANEL UI =====

function scSyncPanel() {
    const panel = document.getElementById("shortsPanel");
    if (!panel) return;
    const blurRow = document.getElementById("shortsBlurRow");
    const colorRow = document.getElementById("shortsColorRow");
    const modeBlur = document.getElementById("shortsModeBlur");
    const modeColor = document.getElementById("shortsModeColor");
    if (blurRow) blurRow.style.display = (scCur.mode === "blur") ? "flex" : "none";
    if (colorRow) colorRow.style.display = (scCur.mode === "color") ? "flex" : "none";
    if (modeBlur) modeBlur.classList.toggle("active", scCur.mode === "blur");
    if (modeColor) modeColor.classList.toggle("active", scCur.mode === "color");

    const blurEl = document.getElementById("shortsBlur");
    const blurVal = document.getElementById("shortsBlurVal");
    if (blurEl && document.activeElement !== blurEl) blurEl.value = scCur.blurLevel;
    if (blurVal) blurVal.textContent = scCur.blurLevel;
    const colorEl = document.getElementById("shortsColor");
    const colorVal = document.getElementById("shortsColorVal");
    if (colorEl && document.activeElement !== colorEl) colorEl.value = scCur.bgColor;
    if (colorVal) colorVal.textContent = scCur.bgColor;
    // EFFECTIVE digits: actual box se (size slider base dikhata tha — edge-stretch
    // ke baad user ko asli size/position ke numbers nazar nahi aate the)
    let sizePct = Math.round(scCur.size * 100);
    let hPct = sizePct;
    let xPct = Math.round(scCur.posX * 100);
    let yPct = Math.round(scCur.posY * 100);
    const pvC = document.getElementById("previewCanvas");
    if (pvC && pvC.width) {
        const eb = scBoxNormalized(pvC);
        sizePct = Math.round((eb.w / pvC.width) * 100);
        hPct = Math.round((eb.h / pvC.height) * 100);
        xPct = Math.round(((eb.x + eb.w / 2) / pvC.width) * 100);
        yPct = Math.round(((eb.y + eb.h / 2) / pvC.height) * 100);
    }
    // READOUT — EDITABLE inputs (number type karo + Enter = exact apply).
    // Jab tak user field me type kar raha hai, values overwrite NAHI karte.
    const roW = document.getElementById("scRoW");
    const roH = document.getElementById("scRoH");
    const roX = document.getElementById("scRoX");
    const roY = document.getElementById("scRoY");
    if (roW && document.activeElement !== roW) roW.value = sizePct;
    if (roH && document.activeElement !== roH) roH.value = hPct;
    if (roX && document.activeElement !== roX) roX.value = xPct;
    if (roY && document.activeElement !== roY) roY.value = yPct;
    const sizeEl = document.getElementById("shortsSize");
    const sizeVal = document.getElementById("shortsSizeVal");
    if (sizeEl && document.activeElement !== sizeEl) sizeEl.value = Math.max(30, Math.min(100, sizePct));
    if (sizeVal) sizeVal.textContent = sizePct + "%" + (scSavedSize ? " ●" : "");
    const pxEl = document.getElementById("shortsPosX");
    const pxVal = document.getElementById("shortsPosXVal");
    if (pxEl && document.activeElement !== pxEl) pxEl.value = xPct;
    if (pxVal) pxVal.textContent = xPct + "%";
    const pyEl = document.getElementById("shortsPosY");
    const pyVal = document.getElementById("shortsPosYVal");
    if (pyEl && document.activeElement !== pyEl) pyEl.value = yPct;
    if (pyVal) pyVal.textContent = yPct + "%" + (scSavedPos ? " ●" : "");

    const lbl = document.getElementById("shortsStateLabel");
    if (lbl) {
        const modeTxt = scCur.mode === "blur" ? "Canvas 1 · Blur" : "Canvas 2 · Color";
        const sv = [];
        if (scSavedSize) sv.push("size");
        if (scSavedPos) sv.push("pos");
        lbl.textContent = `(${modeTxt}${sv.length ? " · saved: " + sv.join("+") : ""})`;
    }
}

function scTogglePanel(force) {
    const panel = document.getElementById("shortsPanel");
    if (!panel) return;
    const show = (typeof force === "boolean") ? force : panel.style.display !== "block";
    panel.style.display = show ? "block" : "none";
    if (show) { scSetCollapsed(false); scSyncPanel(); }
}

// captions-panel jaisa collapse: sirf body fold, header bana rehta hai
function scSetCollapsed(collapsed) {
    const body = document.getElementById("shortsBody");
    const tog = document.getElementById("shortsCollapseBtn");
    if (body) body.style.display = collapsed ? "none" : "";
    if (tog) tog.textContent = collapsed ? "▸" : "▾";
}
function scToggleCollapse() {
    const body = document.getElementById("shortsBody");
    scSetCollapsed(!(body && body.style.display === "none"));
}

// Shorts Canvas ON hote hi media-bin EXPAND karo (warna panel column me
// dab jata tha / button chhup jata tha — user report)
function scEnsureBinExpanded() {
    try {
        const mediaBin = document.getElementById("mediaBin");
        if (!mediaBin) return;
        if (mediaBin.classList.contains("collapsed")) {
            mediaBin.classList.remove("collapsed");
            mediaBin.classList.add("expanded");
            const leftCol = document.querySelector(".left-column");
            if (leftCol) leftCol.classList.remove("bin-collapsed");
            const cp = document.getElementById("captionsPanel");
            const cpBody = document.getElementById("cpBody");
            const cpCollapse = document.getElementById("cpCollapse");
            if (cp) cp.classList.remove("cp-hidden");
            if (cpBody) cpBody.style.display = "";
            if (cpCollapse) cpCollapse.textContent = "▾";
        }
    } catch (e) {}
}

function wireShortsCanvas() {
    const toggleBtn = document.getElementById("shortsToggleBtn");
    if (toggleBtn) {
        toggleBtn.addEventListener("click", () => {
            shortsOn = !shortsOn;
            toggleBtn.classList.toggle("active", shortsOn);
            if (shortsOn) {
                // SAVED SETTINGS AUTO-APPLY (size aur pos alag-alag)
                if (scSavedSize) scCur.size = scSavedSize.size;
                if (scSavedPos) { scCur.posX = scSavedPos.posX; scCur.posY = scSavedPos.posY; }
                scEnsureBinExpanded();
                scTogglePanel(true);
            } else {
                scTogglePanel(false);
            }
            _scMarkDirty();
            scSyncPanel();
        });
        toggleBtn.classList.toggle("active", shortsOn);
    }
    const closeBtn = document.getElementById("shortsCloseBtn");
    if (closeBtn) closeBtn.addEventListener("click", () => scTogglePanel(false));

    // DROPDOWN-STYLE (captions menu jaisa): header collapse button — body fold
    // hota hai magar panel (slim header) media-bin me visible rehta hai; menu
    // kabhi "direct close" nahi hota jab tak Shorts Canvas ON hai
    const collapseBtn = document.getElementById("shortsCollapseBtn");
    if (collapseBtn) collapseBtn.addEventListener("click", () => scToggleCollapse());
    const headerEl = document.getElementById("shortsPanel");
    const header = headerEl ? headerEl.querySelector(".shorts-header") : null;
    if (header) header.addEventListener("click", (e) => {
        if (e.target === collapseBtn) return; // button ka apna handler
        scToggleCollapse();
    });

    const modeBlur = document.getElementById("shortsModeBlur");
    const modeColor = document.getElementById("shortsModeColor");
    if (modeBlur) modeBlur.addEventListener("click", () => { scCur.mode = "blur"; scSyncPanel(); _scMarkDirty(); });
    if (modeColor) modeColor.addEventListener("click", () => { scCur.mode = "color"; scSyncPanel(); _scMarkDirty(); });

    const bind = (id, fn) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("input", () => { fn(el); _scMarkDirty(); });
    };
    bind("shortsBlur", (el) => { scCur.blurLevel = parseInt(el.value, 10) || 0; const v = document.getElementById("shortsBlurVal"); if (v) v.textContent = scCur.blurLevel; });
    bind("shortsColor", (el) => { scCur.bgColor = el.value; const v = document.getElementById("shortsColorVal"); if (v) v.textContent = el.value; });
    bind("shortsSize", (el) => { scCur.size = parseInt(el.value, 10) / 100; scCur.wS = 1; scCur.hS = 1; const v = document.getElementById("shortsSizeVal"); if (v) v.textContent = el.value + "%" + (scSavedSize ? " ●" : ""); });
    bind("shortsPosX", (el) => { scCur.posX = parseInt(el.value, 10) / 100; const v = document.getElementById("shortsPosXVal"); if (v) v.textContent = el.value + "%"; });
    bind("shortsPosY", (el) => { scCur.posY = parseInt(el.value, 10) / 100; const v = document.getElementById("shortsPosYVal"); if (v) v.textContent = el.value + "%" + (scSavedPos ? " ●" : ""); });

    // ALAG-ALAG SAVE (user requirement): 1 size k liye, 1 position k liye
    // READOUT inputs: manually type karo → exact size/position apply
    const applyReadout = () => {
        const pvC2 = document.getElementById("previewCanvas");
        if (!pvC2 || !pvC2.width) return;
        const base = scBaseBox(pvC2);
        const W = pvC2.width, H = pvC2.height;
        const w = document.getElementById("scRoW");
        const h = document.getElementById("scRoH");
        const x = document.getElementById("scRoX");
        const y = document.getElementById("scRoY");
        if (w && w.value !== "") {
            const effW = (Math.max(5, Math.min(100, parseFloat(w.value) || 100)) / 100) * W;
            scCur.wS = Math.max(0.05, Math.min(4, effW / base.bw0));
        }
        if (h && h.value !== "") {
            const effH = (Math.max(5, Math.min(100, parseFloat(h.value) || 100)) / 100) * H;
            scCur.hS = Math.max(0.05, Math.min(4, effH / base.bh0));
        }
        if (x && x.value !== "") scCur.posX = _scClamp01((parseFloat(x.value) || 50) / 100);
        if (y && y.value !== "") scCur.posY = _scClamp01((parseFloat(y.value) || 50) / 100);
        _scMarkDirty();
        scSyncPanel();
    };
    ["scRoW", "scRoH", "scRoX", "scRoY"].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener("change", applyReadout);
        el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); applyReadout(); el.blur(); } });
    });

    const saveSizeBtn = document.getElementById("shortsSaveSizeBtn");
    if (saveSizeBtn) saveSizeBtn.addEventListener("click", () => {
        scSavedSize = { size: scCur.size };
        _scStoreSaved();
        scSyncPanel();
    });
    const savePosBtn = document.getElementById("shortsSavePosBtn");
    if (savePosBtn) savePosBtn.addEventListener("click", () => {
        scSavedPos = { posX: scCur.posX, posY: scCur.posY };
        _scStoreSaved();
        scSyncPanel();
    });
    const resetBtn = document.getElementById("shortsResetBtn");
    if (resetBtn) resetBtn.addEventListener("click", () => {
        const mode = scCur.mode; // mode rehne do — sirf size/pos default
        scCur = { ...SC_DEFAULTS, mode };
        scSavedSize = null;
        scSavedPos = null;
        try { localStorage.removeItem(SC_STORAGE_KEY); } catch (e) {}
        scSyncPanel();
        _scMarkDirty();
    });

    scSyncPanel();
}

function _scStoreSaved() {
    try {
        const out = { enabled: shortsOn, cur: scCur };
        if (scSavedSize) out.size = scSavedSize;
        if (scSavedPos) out.pos = scSavedPos;
        localStorage.setItem(SC_STORAGE_KEY, JSON.stringify(out));
    } catch (e) {}
}

// ===== PREVIEW DRAG/RESIZE =====
// CAPTURE-phase (shorts_canvas.js layers.js se PEHLE load hota hai, isliye iska
// document-capture listener pz ke capture-handler se pehle chalta hai) — jab
// shorts-box pakra jaye to stopImmediatePropagation se pz-drag ko roko, warna
// active pz-span shorts drag chura leta tha (user report: size/position change
// nahi ho rahi thi).
function scSetupCanvasDrag() {
    const previewCanvas = document.getElementById("previewCanvas");
    if (!previewCanvas) return;

    document.addEventListener("mousedown", (e) => {
        if (!shortsOn || e.target !== previewCanvas) return;
        // caption-drag priority (caption bbox ke andar click = caption jeete)
        try {
            if (typeof inCaptionBBox === "function" && window.__captionBBox) {
                const r0 = previewCanvas.getBoundingClientRect();
                const cpx0 = (e.clientX - r0.left) * (previewCanvas.width / r0.width);
                const cpy0 = (e.clientY - r0.top) * (previewCanvas.height / r0.height);
                if (inCaptionBBox({ x: cpx0, y: cpy0 })) return;
            }
        } catch (err) {}
        const rect = previewCanvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        // CANVAS-PIXEL coords (box bhi canvas-px me hai — normalized me compare
        // karna hi wo bug tha jis se drag kabhi hit hi nahi hota tha)
        const px = ((e.clientX - rect.left) / rect.width) * previewCanvas.width;
        const py = ((e.clientY - rect.top) / rect.height) * previewCanvas.height;
        const b = scBoxNormalized(previewCanvas);
        const tolX = 0.06 * previewCanvas.width;   // aasan corner-grab
        const tolY = 0.06 * previewCanvas.height;
        const corners = { tl: [b.x, b.y], tr: [b.x + b.w, b.y], bl: [b.x, b.y + b.h], br: [b.x + b.w, b.y + b.h] };
        let corner = null;
        for (const k in corners) {
            const [cx, cy] = corners[k];
            if (Math.abs(px - cx) < tolX && Math.abs(py - cy) < tolY) { corner = k; break; }
        }
        // EDGE-CENTER handles: tc/bc = sirf height, lc/rc = sirf width (single-edge)
        const edges = { tc: [b.x + b.w / 2, b.y], bc: [b.x + b.w / 2, b.y + b.h], lc: [b.x, b.y + b.h / 2], rc: [b.x + b.w, b.y + b.h / 2] };
        let edge = null;
        if (!corner) {
            for (const k in edges) {
                const [ex, ey] = edges[k];
                if (Math.abs(px - ex) < tolX && Math.abs(py - ey) < tolY) { edge = k; break; }
            }
        }
        if (corner) {
            scDrag = { type: "resize-" + corner, startPx: px, startPy: py, orig: { ...b } };
            e.stopImmediatePropagation();
            e.preventDefault();
        } else if (edge) {
            scDrag = { type: "edge-" + edge, orig: { ...b } };
            e.stopImmediatePropagation();
            e.preventDefault();
        } else if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) {
            scDrag = { type: "move", startPx: px, startPy: py, orig: { ...b } };
            e.stopImmediatePropagation();
            e.preventDefault();
        }
    }, true);

    document.addEventListener("mousemove", (e) => {
        if (!scDrag) return;
        const rect = previewCanvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const W = previewCanvas.width, H = previewCanvas.height;
        const px = ((e.clientX - rect.left) / rect.width) * W;
        const py = ((e.clientY - rect.top) / rect.height) * H;
        const va = scVideoAspect();
        const o = scDrag.orig;
        if (scDrag.type === "move") {
            const dx = px - scDrag.startPx;
            const dy = py - scDrag.startPy;
            scCur.posX = _scClamp01((o.x + o.w / 2 + dx) / W);
            scCur.posY = _scClamp01((o.y + o.h / 2 + dy) / H);
        } else if (scDrag.type.startsWith("edge-")) {
            // SINGLE-EDGE resize: sirf pakri hui edge move karti hai, doosri
            // edge + doosri dimension ki position FIX rehti hai.
            const base = scBaseBox(previewCanvas);
            if (scDrag.type === "edge-tc" || scDrag.type === "edge-bc") {
                // top/bottom-center: sirf HEIGHT (top edge upar = lambi, niche = chhoti)
                let ny, nh;
                if (scDrag.type === "edge-tc") { ny = Math.max(0, Math.min(py, o.y + o.h - 20)); nh = o.y + o.h - ny; }
                else { ny = o.y; nh = Math.max(20, Math.min(py, H) - o.y); }
                nh = Math.min(nh, H);
                scCur.hS = Math.max(0.05, nh / base.bh0);
                scCur.posY = _scClamp01((ny + nh / 2) / H);
            } else {
                // left/right-center: sirf WIDTH
                let nx, nw;
                if (scDrag.type === "edge-lc") { nx = Math.max(0, Math.min(px, o.x + o.w - 20)); nw = o.x + o.w - nx; }
                else { nx = o.x; nw = Math.max(20, Math.min(px, W) - o.x); }
                nw = Math.min(nw, W);
                scCur.wS = Math.max(0.05, nw / base.bw0);
                scCur.posX = _scClamp01((nx + nw / 2) / W);
            }
        } else {
            // resize: grabbed corner ko cursor tak kheencho — video-aspect
            // bachao, doosra corner anchor rehta hai (sab canvas-px me)
            const anchor = (scDrag.type === "resize-tl") ? [o.x + o.w, o.y + o.h]
                : (scDrag.type === "resize-tr") ? [o.x, o.y + o.h]
                : (scDrag.type === "resize-bl") ? [o.x + o.w, o.y]
                : [o.x, o.y];
            let nw = Math.max(0.12 * W, Math.abs(px - anchor[0]));
            let nh = nw / va;
            if (nh > H) { nh = H; nw = nh * va; }
            let nx = (scDrag.type === "resize-tr" || scDrag.type === "resize-br") ? anchor[0] : anchor[0] - nw;
            let ny = (scDrag.type === "resize-bl" || scDrag.type === "resize-br") ? anchor[1] : anchor[1] - nh;
            nx = Math.max(0, Math.min(nx, W - nw));
            ny = Math.max(0, Math.min(ny, H - nh));
            // CORNER = proportional (poora box eik sath) — stretch reset
            scCur.wS = 1; scCur.hS = 1;
            scCur.size = Math.max(0.3, Math.min(1, nw / W));
            scCur.posX = _scClamp01((nx + nw / 2) / W);
            scCur.posY = _scClamp01((ny + nh / 2) / H);
        }
        scSyncPanel();
    });

    document.addEventListener("mouseup", () => {
        if (!scDrag) return;
        scDrag = null;
        _scMarkDirty();
        _scStoreSaved();
    });
}

// ===== GEOMETRY =====

function scVideoAspect() {
    const v = document.getElementById("mainPlayer");
    return (v && v.videoWidth && v.videoHeight) ? (v.videoWidth / v.videoHeight) : (16 / 9);
}

// size-derived ASPECT-LOCKED base box (stretch iske UPAR multiply hota hai)
function scBaseBox(canvas) {
    const W = canvas.width, H = canvas.height;
    const va = scVideoAspect();
    const target = W / H;
    let bw0, bh0;
    if (va > target) { bw0 = W * scCur.size; bh0 = bw0 / va; }
    else { bh0 = H * scCur.size; bw0 = bh0 * va; }
    return { bw0: Math.max(20, Math.min(bw0, W)), bh0: Math.max(20, Math.min(bh0, H)) };
}

// video box — CANVAS-PIXEL space (0..W, 0..H); wS/hS = edge-handle stretch
function scBoxNormalized(canvas) {
    const W = canvas.width, H = canvas.height;
    const base = scBaseBox(canvas);
    const bw = Math.max(20, Math.min(base.bw0 * (scCur.wS || 1), W));
    const bh = Math.max(20, Math.min(base.bh0 * (scCur.hS || 1), H));
    const cx = _scClamp01(scCur.posX) * W;
    const cy = _scClamp01(scCur.posY) * H;
    let x = cx - bw / 2;
    let y = cy - bh / 2;
    x = Math.max(0, Math.min(x, W - bw));
    y = Math.max(0, Math.min(y, H - bh));
    return { x, y, w: bw, h: bh };
}

// ===== RENDER — PREVIEW canvas (9:16 OUTPUT) =====
// (PLAYER canvas source-monitor rehta hai — shorts composition sirf 9:16
// output-preview par, wahi final result hai)
// returns true agar isne frame compose kar diya (caller caption/transform usi par
// chalaye), false agar shorts OFF (caller apna letterbox compose kare)

function scApplyToPreview(canvas, ctx, videoEl, vw, vh) {
    if (!shortsOn || !canvas || !ctx) return false;
    const W = canvas.width, H = canvas.height;
    // BACKGROUND — poori 9:16 window
    if (scCur.mode === "blur") {
        const lvl = Math.max(0, Number(scCur.blurLevel) || 0);
        if (lvl > 0) {
            const sigma = lvl * (W / 1080) * 1.2;
            ctx.save();
            ctx.filter = `blur(${sigma.toFixed(1)}px)`;
            // OVERSCAN: blur-filter ke edges transparent hote hain (kernel bahar
            // sample karta hai) — thoda bara draw karke falloff canvas se bahar
            // rakho, warna edges par niche wala content jhalakta hai.
            const pad = sigma * 2.5;
            ctx.drawImage(videoEl, 0, 0, vw, vh, -pad, -pad, W + pad * 2, H + pad * 2);
            ctx.restore();
        }
    } else {
        ctx.fillStyle = scCur.bgColor || "#000000";
        ctx.fillRect(0, 0, W, H);
    }
    // FOREGROUND — adjustable video box (aspect preserve)
    const b = scBoxNormalized(canvas);
    ctx.drawImage(videoEl, 0, 0, vw, vh, b.x, b.y, b.w, b.h);
    return true;
}

// edit-overlay (panel khula ho to handles dikhao — layers.js wrapper se call)
function scDrawOverlay(ctx) {
    if (!shortsOn || !ctx) return;
    const panel = document.getElementById("shortsPanel");
    if (!panel || panel.style.display !== "block") return;
    const canvas = ctx.canvas;
    const b = scBoxNormalized(canvas);
    ctx.save();
    ctx.strokeStyle = "#2fd07a";
    ctx.lineWidth = 2;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = "#2fd07a";
    const hs = 9;
    // 4 CORNERS (poora box proportional) + 4 EDGE-CENTERS (single-edge stretch)
    [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].forEach(([hx, hy]) => {
        ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
    });
    const er = 5;
    [[b.x + b.w / 2, b.y], [b.x + b.w / 2, b.y + b.h], [b.x, b.y + b.h / 2], [b.x + b.w, b.y + b.h / 2]].forEach(([hx, hy]) => {
        ctx.beginPath();
        ctx.arc(hx, hy, er, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.restore();
}

// ===== PERSISTENCE (timeline state ke sath) =====

function scPersistPayload() {
    if (!shortsOn) return null;
    return JSON.parse(JSON.stringify({
        enabled: true, mode: scCur.mode, blurLevel: scCur.blurLevel, bgColor: scCur.bgColor,
        size: scCur.size, posX: scCur.posX, posY: scCur.posY, wS: scCur.wS, hS: scCur.hS,
        savedSize: scSavedSize, savedPos: scSavedPos,
    }));
}

function scLoadFromState(sc) {
    if (!sc || typeof sc !== "object") return;
    shortsOn = !!sc.enabled;
    if (sc.mode) scCur.mode = sc.mode;
    if (sc.blurLevel != null) scCur.blurLevel = sc.blurLevel;
    if (sc.bgColor) scCur.bgColor = sc.bgColor;
    if (sc.size != null) scCur.size = sc.size;
    if (sc.posX != null) scCur.posX = sc.posX;
    if (sc.posY != null) scCur.posY = sc.posY;
    if (sc.wS != null) scCur.wS = sc.wS;
    if (sc.hS != null) scCur.hS = sc.hS;
    // saved size/pos alag-alag restore (per-project)
    if (sc.savedSize && sc.savedSize.size != null) scSavedSize = { size: sc.savedSize.size };
    if (sc.savedPos && sc.savedPos.posX != null) scSavedPos = { posX: sc.savedPos.posX, posY: sc.savedPos.posY };
    const toggleBtn = document.getElementById("shortsToggleBtn");
    if (toggleBtn) toggleBtn.classList.toggle("active", shortsOn);
    scSyncPanel();
}

// ===== INIT =====
try { wireShortsCanvas(); } catch (e) { console.warn("shorts canvas wire:", e); }
try { scSetupCanvasDrag(); } catch (e) { console.warn("shorts canvas drag:", e); }
```

### Name: frontend/speed_control.js
```js
// ===== SPEED CONTROL (Filmora-style digital speed meter) =====
// video-wrapper ke top-right corner par floating widget. Selected video-clip
// (ya, agar kuch select nahi hai, playhead ke neeche wali clip) ki speed
// change karta hai — drag se fine-adjust (0.01 steps), ya click kar ke type.
//
// Data-model: videoClips[i].speed (default 1). Speed badalne par clip ki
// TIMELINE duration recompute hoti hai (source-content ki lambai fixed
// rehti hai, timeline par wo lambai speed ke hisaab se chhoti/badi dikhti
// hai) — bilkul Filmora jaisa behavior.

const SPEED_MIN = 0.1;
const SPEED_MAX = 4.0;
const SPEED_DRAG_SENSITIVITY = 0.005; // per pixel horizontal drag

let speedDragState = null; // { startClientX, origSpeed, clip }
let speedEditingInput = false;

function getSpeedTargetClips() {
    // FIX: ab MULTI-SELECT support hai — jitni video-clips selected hain SAB ki
    // speed ek sath change hoti hai (pehle sirf playhead-wali clip ki hoti thi).
    const selVideo = (typeof selectedIdsOf === "function") ? selectedIdsOf("video") : [];
    if (selVideo.length) {
        const clips = selVideo.map((id) => getVideoClipById(id)).filter(Boolean);
        if (clips.length) return clips;
    }
    // warna, playhead ke neeche wali active clip
    if (typeof findActiveVideoClip === "function" && typeof virtualTime !== "undefined") {
        const c = findActiveVideoClip(virtualTime);
        if (c) return [c];
    }
    return [];
}

function getSpeedTargetClip() {
    const clips = getSpeedTargetClips();
    return clips.length ? clips[0] : null; // backward-compat (UI display ke liye)
}

function formatSpeed(v) {
    return v.toFixed(2) + "x";
}

function applySpeedToClip(clip, newSpeed) {
    return applySpeedToClips([clip], newSpeed);
}

function applySpeedToClips(clips, newSpeed) {
    if (!clips || !clips.length) return newSpeed;
    newSpeed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, newSpeed));
    newSpeed = Math.round(newSpeed * 100) / 100;

    clips.forEach((clip) => {
        clip.speed = newSpeed;
        const sourceLen = (clip.sourceEnd - clip.sourceStart);
        const newDuration = Math.max(0.1, sourceLen / newSpeed);
        clip.end = clip.start + newDuration;
    });

    // FIX: multi-clip speed-change par clips apni jagah shrink/badhti hain —
    // beech mein gaps reh jate the. Agar selected clips CONTIGUOUS chain banati
    // hain (typical: sab select kar ke speed badli) to gaps khud close kar do
    // (wahi ripple-join jo delete par hota hai). Non-contiguous selection par
    // user ke intentional gaps preserve rehte hain.
    if (clips.length > 1 && typeof rippleCloseVideoGaps === "function") {
        const byStart = [...clips].sort((a, b) => a.start - b.start);
        const contiguous = byStart.every((c, i) =>
            i === 0 || Math.abs(byStart[i - 1].end - c.start) < 0.05
        );
        if (contiguous) rippleCloseVideoGaps();
    }

    if (typeof recalcTimelineDuration === "function") recalcTimelineDuration();
    if (typeof renderAll === "function") renderAll();
    if (typeof persistTimelineState === "function") persistTimelineState();

    return newSpeed;
}

function updateSpeedControlUI() {
    if (speedDragState || speedEditingInput) return; // drag/typing ke waqt UI ko khud se overwrite mat karo

    const wrap = document.getElementById("speedControl");
    const valueEl = document.getElementById("speedValue");
    if (!wrap || !valueEl) return;

    const clip = getSpeedTargetClip();
    if (!clip) {
        wrap.classList.add("speed-disabled");
        valueEl.textContent = "1.00x";
        return;
    }
    wrap.classList.remove("speed-disabled");
    const speed = clip.speed === undefined ? 1 : clip.speed;
    valueEl.textContent = formatSpeed(speed);
}

function startSpeedInlineEdit() {
    const clip = getSpeedTargetClip();
    if (!clip) return;
    const valueEl = document.getElementById("speedValue");
    if (!valueEl) return;

    speedEditingInput = true;
    const current = (clip.speed === undefined ? 1 : clip.speed).toFixed(2);

    valueEl.contentEditable = "true";
    valueEl.textContent = current;
    valueEl.classList.add("speed-editing");

    // select all text taake user seedha type kar sake
    const range = document.createRange();
    range.selectNodeContents(valueEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    valueEl.focus();

    function commit() {
        speedEditingInput = false;
        valueEl.contentEditable = "false";
        valueEl.classList.remove("speed-editing");
        const parsed = parseFloat(valueEl.textContent.replace(/[^0-9.]/g, ""));
        if (!isNaN(parsed) && parsed > 0) {
            applySpeedToClips(getSpeedTargetClips(), parsed); // FIX: SARI selected clips
        }
        updateSpeedControlUI();
        valueEl.removeEventListener("blur", commit);
        valueEl.removeEventListener("keydown", onKeyDown);
    }
    function onKeyDown(e) {
        if (e.key === "Enter") { e.preventDefault(); valueEl.blur(); }
        else if (e.key === "Escape") { valueEl.textContent = current; valueEl.blur(); }
    }
    valueEl.addEventListener("blur", commit);
    valueEl.addEventListener("keydown", onKeyDown);
}

document.addEventListener("DOMContentLoaded", () => {
    const wrap = document.getElementById("speedControl");
    const valueEl = document.getElementById("speedValue");
    if (!wrap || !valueEl) return;

    let dragMoved = false;

    wrap.addEventListener("mousedown", (e) => {
        if (speedEditingInput) return;
        const clips = getSpeedTargetClips();
        if (!clips.length) return;
        const clip = clips[0];
        dragMoved = false;
        speedDragState = {
            startClientX: e.clientX,
            origSpeed: clip.speed === undefined ? 1 : clip.speed,
            clips,
        };
        e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
        if (!speedDragState) return;
        const dx = e.clientX - speedDragState.startClientX;
        if (Math.abs(dx) > 2) dragMoved = true;
        const newSpeed = speedDragState.origSpeed + dx * SPEED_DRAG_SENSITIVITY;
        const clamped = Math.min(SPEED_MAX, Math.max(SPEED_MIN, newSpeed));
        valueEl.textContent = formatSpeed(Math.round(clamped * 100) / 100);
        wrap.classList.toggle("speed-fast", clamped > 1);
        wrap.classList.toggle("speed-slow", clamped < 1);
    });

    document.addEventListener("mouseup", () => {
        if (!speedDragState) return;
        const dx_present = dragMoved;
        const clips = speedDragState.clips;

        if (dx_present) {
            const parsed = parseFloat(valueEl.textContent.replace(/[^0-9.]/g, ""));
            if (!isNaN(parsed)) applySpeedToClips(clips, parsed); // FIX: SARI selected clips
        }
        speedDragState = null;

        if (!dx_present) {
            // ye plain click tha (drag nahi hua) -> inline type-edit shuru karo
            startSpeedInlineEdit();
        } else {
            updateSpeedControlUI();
        }
    });

    // continuous UI sync (selection badalne par, playhead move hone par, etc.)
    function loop() {
        updateSpeedControlUI();
        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
});
```

### Name: frontend/spotlight.js
```js
// ===== SPOTLIGHT MULTI-SCREEN =====
// Spotlight segment ke andar N screens hote hain (seg.screens[]). Har screen
// 9:16 OUTPUT-frame ke normalized coords par hai:
//   - SPOT shapes (circle/square/star/heart/hexagon/diamond/ring):
//     center (x,y) + radius r (out-width fraction) + zoom — content = S2 video
//     ka S1-spotlight-base-box ka ZOOMED square crop.
//   - "vertical" screen: FULL-HEIGHT vertical (9:16) crop screen — S2 video ka
//     vertical region, width = w (out-width fraction), height auto = w*16/9.
// Screens preview (9:16) par interactive hain: drag = move, knob = resize.
// Delete / Duplicate / Add Screen panel se. Player-canvas par sirf ghost guide.
//
// LEGACY: purane bubble params (bubbleState/bubbleZoom/...) wale segments ko
// load par 1 screen mein convert kar dete hain — koi purana project toota nahi.

const SPOTLIGHT_OUT_W = 1080;
const SPOTLIGHT_OUT_H = 1920;
const SPOT_HANDLE_HIT = 16; // px — resize-knob ka hit radius
const SPOT_SHAPES = ["circle", "square", "star", "heart", "hexagon", "diamond", "ring"];

let spotDrag = null; // { seg, screenId, type: "move"|"resize", grabDx, grabDy }
let spotSelectedScreenId = null;

function spotGenId() {
    return "scr_" + Math.random().toString(36).slice(2, 10);
}

// ===== SHAPE PATHS (7 designs) =====
// Preview (canvas) isi geometry se clip/draw karta hai; export_engine.py ka
// spot_shape_mask() isi ka numpy-mirror hai — dono EXACT match hone chahiye.
function spotShapePath(ctx, style, cx, cy, r) {
    ctx.beginPath();
    switch (style) {
        case "square":
            ctx.rect(cx - r, cy - r, r * 2, r * 2);
            break;
        case "star": {
            const Ri = r * 0.42;
            for (let i = 0; i < 10; i++) {
                const ang = -Math.PI / 2 + i * Math.PI / 5;
                const rad = (i % 2 === 0) ? r : Ri;
                const x = cx + Math.cos(ang) * rad;
                const y = cy + Math.sin(ang) * rad;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.closePath();
            break;
        }
        case "heart": {
            const K = r / 16;
            ctx.moveTo(cx, cy + 0.5 * K);
            ctx.bezierCurveTo(cx, cy - 2.5 * K, cx - 7 * K, cy - 12.5 * K, cx - 12 * K, cy - 9.5 * K);
            ctx.bezierCurveTo(cx - 16 * K, cy - 6.5 * K, cx - 14 * K, cy + 0.5 * K, cx - 8 * K, cy + 5.5 * K);
            ctx.bezierCurveTo(cx - 4.5 * K, cy + 9 * K, cx, cy + 11.5 * K, cx, cy + 12.5 * K);
            ctx.bezierCurveTo(cx, cy + 11.5 * K, cx + 4.5 * K, cy + 9 * K, cx + 8 * K, cy + 5.5 * K);
            ctx.bezierCurveTo(cx + 14 * K, cy + 0.5 * K, cx + 16 * K, cy - 6.5 * K, cx + 12 * K, cy - 9.5 * K);
            ctx.bezierCurveTo(cx + 7 * K, cy - 12.5 * K, cx, cy - 2.5 * K, cx, cy + 0.5 * K);
            ctx.closePath();
            break;
        }
        case "hexagon": {
            for (let i = 0; i < 6; i++) {
                const ang = -Math.PI / 2 + i * Math.PI / 3;
                const x = cx + Math.cos(ang) * r;
                const y = cy + Math.sin(ang) * r;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.closePath();
            break;
        }
        case "diamond":
            ctx.moveTo(cx, cy - r);
            ctx.lineTo(cx + r * 0.7, cy);
            ctx.lineTo(cx, cy + r);
            ctx.lineTo(cx - r * 0.7, cy);
            ctx.closePath();
            break;
        case "ring":
        case "circle":
        default:
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            break;
    }
    ctx.closePath();
}

function findSpotlightSeg() {
    if (typeof virtualTime !== "undefined") {
        for (const s of segments) {
            if (s.mode === "spotlight" && virtualTime >= s.start && virtualTime < s.end) return s;
        }
    }
    if (typeof selectedSegmentId !== "undefined" && selectedSegmentId) {
        const sel = (typeof getSegmentById === "function") ? getSegmentById(selectedSegmentId) : null;
        if (sel && sel.mode === "spotlight") return sel;
    }
    return null;
}

function spotMainVideoEl() {
    // S2 SOURCE SYSTEM REMOVED (user ka model): "jo bhi cropping hogi wo 16:9
    // ki video par hogi" — screens MAIN video se crop hoti hain, koi alag S2
    // video element nahi.
    if (typeof getBaseVideoElement === "function") {
        const el = getBaseVideoElement();
        if (el) return el;
    }
    return (typeof mainPlayer !== "undefined") ? mainPlayer : null;
}

function spotlightNeedsSource() {
    // S2 hidden-video system khatam — main video hi source hai
    return false;
}

function isSpotlightActive() {
    return !!findSpotlightSeg();
}

// ===== SCREENS MODEL + LEGACY MIGRATION =====
function defaultScreen(x, y, r) {
    return {
        id: spotGenId(),
        kind: "spot",            // "spot" (shape) | "vertical" (full-height vertical crop)
        shape: "circle",         // spot shapes
        x, y, r,                 // center + radius (out-width fraction)
        w: 0.45,                 // vertical screen width (out-width fraction)
        srcX: x,                 // vertical: SOURCE-crop center (16:9 window par drag hota hai)
        zoom: 1.6,
        border: { color: "#ffffff", width: 8 },
        shadow: { enabled: true },
    };
}

function ensureScreens(seg) {
    if (!seg.screens || !seg.screens.length) {
        // FIX: 0 screens after user-delete ab RESURRECT nahi hoti — spotlight
        // mode hi switch ho jata hai (deleteScreen me). Legacy bubbles hi yahan
        // migrate hote hain.
        if (seg.bubbleState) {
            seg.screens = [{
                ...defaultScreen(seg.bubbleState.x, seg.bubbleState.y, seg.bubbleState.r),
                id: spotGenId(),
                shape: seg.bubbleStyle && SPOT_SHAPES.includes(seg.bubbleStyle) ? seg.bubbleStyle : "circle",
                zoom: (seg.bubbleZoom !== undefined) ? seg.bubbleZoom : 1.6,
                border: seg.bubbleBorder || { color: "#ffffff", width: 8 },
                shadow: seg.bubbleShadow || { enabled: true },
            }];
        } else {
            seg.screens = [defaultScreen(0.5, 0.38, 0.17)];
        }
    }
    // migrate: srcX backfill — vertical screens ka source-crop ab 16:9 window
    // par drag hota hai (pehle output-x hi source tha, ab dono alag hain)
    seg.screens.forEach((scr) => {
        if (scr.srcX === undefined) scr.srcX = scr.x;
        if (scr.srcY === undefined) scr.srcY = 0.5;
        // SHAPE MODEL (user ka final): shape 16:9 par PLACE hoti hai (srcX/srcY/
        // srcR = crop-area selection) -> wahi shape-area usi shape mein 9:16 par
        // dikhta hai. srcW/srcR backfill defaults.
        if (scr.srcW === undefined) scr.srcW = 0.25;
        if (scr.srcR === undefined && scr.kind !== "vertical") scr.srcR = 0.15;
        // VERTICAL BORDER-LESS (user): vertical screens par koi border nahi
        if (scr.kind === "vertical" && scr.border && scr.border.width === undefined) scr.border.width = 0;
    });
    return seg.screens;
}

function getSelectedScreen(seg) {
    // FIX: pehle ensureScreens(seg) ka ARRAY yahan pass hota tha -> andar phir
    // ensureScreens chalte huye THROWAWAY screen banti thi (asli screen kabhi
    // update nahi hoti thi). Ab array ho to direct list, warna seg.
    const list = Array.isArray(seg) ? seg : ensureScreens(seg);
    let s = list.find((x) => x.id === spotSelectedScreenId);
    if (!s) { s = list[0]; spotSelectedScreenId = s.id; }
    return s;
}

// ===== S2 SOURCE (hidden video element) =====
// S2 ab UI mein koi ALAG row nahi hai — ye sirf SPOTLIGHT ka source hai.
// Stack-2 data auto-full ho jata hai: koi S2 clip na ho to poori video
// duplicate hoti hai (start=0, end=sourceDuration), extra disk-copy nahi.
function ensureSpotlightSource() {
    // NO-OP: S2 auto-duplicate system removed — screens main video se crop
    // hoti hain (koi stack-2 clip/element nahi banta)
}

// ===== ONE-CLICK SETUP =====
// '◎ Spotlight' button: active segment = spotlight mode (+ default screen).
function setupSpotlight() {
    if (typeof currentVideoRef === "undefined" || !currentVideoRef) { alert("Pehle video upload karo!"); return; }
    if (typeof pushHistory === "function") pushHistory();
    ensureSpotlightSource();

    let seg = (typeof getActiveSegment === "function") ? getActiveSegment() : null;
    if (!seg) {
        const t = typeof virtualTime !== "undefined" ? virtualTime : 0;
        seg = { id: (typeof genId === "function") ? genId() : spotGenId(), start: t, end: Math.min(sourceDuration, t + 5), mode: "single", modeBoxState: {}, muted: false, audioDetached: false };
        segments.push(seg);
        if (typeof selectOnly === "function") selectOnly("segment", seg.id);
    }
    seg.mode = "spotlight";
    ensureScreens(seg);
    spotSelectedScreenId = seg.screens[0].id;

    if (typeof renderAll === "function") renderAll();
    if (typeof persistTimelineState === "function") persistTimelineState();
}

// ===== DRAW (crop_editor renderLoop har frame call karta hai) =====
function drawSpotlightOverlay() {
    const panel = document.getElementById("spotlightCtrls");
    const active = isSpotlightActive();
    if (panel) panel.style.display = active ? "block" : "none";
    if (!active) return;
    if (typeof videoSeekGuard !== "undefined" && videoSeekGuard > 0) return;

    // FIX: ensureScreens() screens-ARRAY return karta hai (segment NAHI) —
    // pehle ye seg = array ho jata tha -> seg.screens undefined -> har-frame
    // crash -> POORA spotlight (draw/drag/panel) dead. Ab seg pehle lo:
    const seg = findSpotlightSeg();
    if (!seg) return;
    ensureScreens(seg);

    // S2 REMOVED: content MAIN video se aata hai
    const s2el = spotMainVideoEl();
    const hasS2 = !!(s2el && s2el.readyState >= 2 && s2el.videoWidth > 0);

    renderScreensList(seg);

    // Preview: vertical strips ke beech magnet-guide (jab snap ho raha ho)
    if (window.__spotSnapEdge != null) {
        previewCtx.save();
        previewCtx.strokeStyle = "rgba(143, 123, 255, 0.9)";
        previewCtx.lineWidth = 1.5;
        previewCtx.setLineDash([4, 4]);
        const sx = window.__spotSnapEdge * previewCanvas.width;
        previewCtx.beginPath(); previewCtx.moveTo(sx, 0); previewCtx.lineTo(sx, previewCanvas.height); previewCtx.stroke();
        previewCtx.restore();
    }

    // base box AB sirf LEGACY fallback hai — shape content ab scr.src* se aata hai
    const boxes = (typeof getSegmentBoxes === "function") ? getSegmentBoxes(seg, "spotlight") : null;
    const baseBox = (boxes && boxes[0]) ? boxes[0] : { x: 0.22, y: 0, w: 0.56, h: 1 };

    // ---------- PREVIEW CANVAS: SCREENS ----------
    seg.screens.forEach((scr, idx) => {
        const selected = scr.id === spotSelectedScreenId;
        if (scr.kind === "vertical") {
            drawVerticalScreen(scr, idx, selected, s2el, hasS2);
        } else {
            drawSpotScreen(scr, idx, selected, s2el, hasS2, baseBox, seg);
        }
        // NEW MODEL: vertical screen ka SOURCE-box 16:9 window par bhi dikhe
        // (wahan drag hota hai — ye crop REGION hai, 9:16 usi se bharta hai)
    });

    // ---------- PLAYER CANVAS (16:9) — SOURCE-PLACE WINDOW ----------
    // USER MODEL: 16:9 par DONO tarah ki screens place hoti hain:
    //   - vertical: portrait source-box (srcX/srcY/srcW)
    //   - shapes: SHAPE outline hi 16:9 par place/resize hoti hai (srcX/srcY/
    //     srcR) — jo area shape ke andar select hoga WAHI shape mein 9:16 par
    //     dikhega. 6-point resize handles (2 top + 2 center + 2 bottom).
    computeFitRect();
    if (fitRect.w > 0) {
        seg.screens.forEach((scr, vIdx) => {
            const sel = scr.id === spotSelectedScreenId;
            const stroke = sel ? "#2f7bff" : "rgba(47,123,255,0.55)";
            playerCtx.save();
            playerCtx.lineWidth = sel ? 2.5 : 1.5;
            playerCtx.strokeStyle = stroke;
            if (!sel) playerCtx.setLineDash([7, 6]);
            playerCtx.fillStyle = sel ? "#2f7bff" : "rgba(47,123,255,0.8)";
            playerCtx.font = "bold 12px Arial";
            if (scr.kind === "vertical") {
                const { x0, y0, w, h } = srcBoxPx(scr, fitRect);
                playerCtx.strokeRect(x0, y0, w, h);
                playerCtx.setLineDash([]);
                playerCtx.fillText("SRC " + (vIdx + 1), x0 + 5, y0 + 15);
            } else {
                const { cx, cy, r } = srcShapePx(scr, fitRect);
                spotShapePath(playerCtx, scr.shape, cx, cy, r);
                playerCtx.stroke();
                playerCtx.setLineDash([]);
                playerCtx.fillText("SRC " + (vIdx + 1), cx - r + 5, cy - r + 15);
            }
            playerCtx.setLineDash([]);
            // 6-point resize handles (sirf selected par)
            if (sel) {
                const pts = (scr.kind === "vertical") ? srcBoxHandlePoints(scr, fitRect) : srcShapeHandlePoints(scr, fitRect);
                playerCtx.fillStyle = "#2f7bff";
                pts.forEach((p) => {
                    playerCtx.beginPath();
                    playerCtx.arc(p.px, p.py, 5, 0, Math.PI * 2);
                    playerCtx.fill();
                });
            }
            playerCtx.restore();
        });
    }

    // ---------- PANEL SYNC ----------
    syncScreenControls(getSelectedScreen(seg));
}

// vertical screen = FULL-HEIGHT strip (user ka V1 + V1-dup layout):
// x = strip center (adjustable), y = FIXED 0.5, height = poori 9:16 output.
// Content = S2 video ka full-height portrait window (strip-aspect-correct),
// jiska center scr.x par hai — strip drag karo to crop window bhi chalti hai.
function stripRect(scr) {
    const w = scr.w * previewCanvas.width;
    const cx = scr.x * previewCanvas.width;
    return { x0: cx - w / 2, y0: 0, w, h: previewCanvas.height, cx };
}

function drawVerticalScreen(scr, idx, selected, s2el, hasS2) {
    const R = stripRect(scr);
    const cy = previewCanvas.height / 2;

    // content: MAIN video ka source-crop (scr.srcX/srcY = 16:9 window par jo
    // area select hua hai) — 9:16 strip usi se bharta hai
    if (hasS2) {
        const srcW = s2el.videoWidth, srcH = s2el.videoHeight;
        // SOURCE-CROP (user ka model): 16:9 video par jo portrait area select
        // hua (center scr.srcX/srcY) — wahi 9:16 strip ko full fill karta hai.
        // Aspect-correct fill: crop-AR (px) = strip-AR (px).
        const stripAR = R.w / previewCanvas.height;          // w_px/h_px
        let cW = scr.srcW || 0.25;                            // crop width (source-frac)
        let cH = cW * (srcW / srcH) / stripAR;                // aspect-correct height
        if (cH > 1) { cH = 1; cW = cH * stripAR * (srcH / srcW); }
        const cxs = Math.max(0, Math.min(scr.srcX - cW / 2, 1 - cW));
        const cys = Math.max(0, Math.min((scr.srcY || 0.5) - cH / 2, 1 - cH));
        previewCtx.save();
        try {
            previewCtx.drawImage(s2el, cxs * srcW, cys * srcH, cW * srcW, cH * srcH, R.x0, R.y0, R.w, R.h);
        } catch (e) { /* frame ready nahi */ }
        previewCtx.restore();
        // BORDER-LESS (user): vertical screen par koi white border nahi
    } else {
        previewCtx.save();
        previewCtx.fillStyle = "rgba(20,20,28,0.85)";
        previewCtx.fillRect(R.x0, R.y0, R.w, R.h);
        previewCtx.strokeStyle = "#ff6b6b";
        previewCtx.setLineDash([6, 4]);
        previewCtx.strokeRect(R.x0, R.y0, R.w, R.h);
        previewCtx.setLineDash([]);
        previewCtx.fillStyle = "#ff6b6b";
        previewCtx.font = "bold 11px Arial";
        previewCtx.textAlign = "center";
        previewCtx.fillText("V" + (idx + 1) + " — video loading...", R.cx, cy);
        previewCtx.textAlign = "left";
        previewCtx.restore();
    }

    // selection chrome + 6-point resize handles (2 top + 2 center + 2 bottom)
    if (selected) {
        previewCtx.save();
        previewCtx.lineWidth = 2;
        previewCtx.setLineDash([5, 4]);
        previewCtx.strokeStyle = "#ffb020";
        previewCtx.strokeRect(R.x0 - 3, R.y0 + 3, R.w + 6, R.h - 6);
        previewCtx.setLineDash([]);
        previewCtx.fillStyle = "#ffb020";
        outStripHandlePoints(scr).forEach((p) => {
            previewCtx.beginPath();
            previewCtx.arc(p.px, p.py, 5, 0, Math.PI * 2);
            previewCtx.fill();
        });
        previewCtx.restore();
    }
}

function drawSpotScreen(scr, idx, selected, s2el, hasS2, baseBox, seg) {
    const cx = scr.x * previewCanvas.width;
    const cy = scr.y * previewCanvas.height;
    const r = scr.r * previewCanvas.width;
    const isRing = scr.shape === "ring";

    if (hasS2 && !isRing) {
        // USER MODEL (final): shape 16:9 par PLACE hui thi (srcX/srcY/srcR) —
        // jo area shape ke andar select hua WAHI shape mein 9:16 par dikhta hai.
        // (base-box zoom legacy fallback hai — sirf jab srcR set hi na ho)
        const srcW = videoNaturalW || s2el.videoWidth, srcH = videoNaturalH || s2el.videoHeight;
        let sqX, sqY, side;
        if (scr.srcR !== undefined) {
            // PLAYER par circle = center (srcX, srcY) + radius srcR (width-frac);
            // fitRect aspect-fit hai isliye video-px me radius isotropic =
            // srcR*srcW. Sample-square = usi circle ka bounding square.
            // (Purani formula me Y-offset me OUT_W/OUT_H = 9/16 ka ghalat
            // factor tha — 9:16 content select-kiya-hua area nahi dikhata tha)
            const R = scr.srcR || 0.15;
            side = Math.min(2 * R * srcW, srcW, srcH);
            sqX = scr.srcX * srcW - side / 2;
            sqY = ((scr.srcY != null) ? scr.srcY : 0.5) * srcH - side / 2;
            sqX = Math.max(0, Math.min(sqX, srcW - side));
            sqY = Math.max(0, Math.min(sqY, srcH - side));
        } else {
            const zoom = Math.max(1, scr.zoom || 1.6);
            const zw = baseBox.w / zoom, zh = baseBox.h / zoom;
            const zx = baseBox.x + baseBox.w / 2 - zw / 2;
            const zy = baseBox.y + baseBox.h / 2 - zh / 2;
            side = Math.min(zw * srcW, zh * srcH);
            sqX = Math.max(0, Math.min(zx * srcW + (zw * srcW - side) / 2, srcW - side));
            sqY = Math.max(0, Math.min(zy * srcH + (zh * srcH - side) / 2, srcH - side));
        }

        // shadow
        if (scr.shadow && scr.shadow.enabled) {
            previewCtx.save();
            previewCtx.shadowColor = "rgba(0,0,0,0.5)";
            previewCtx.shadowBlur = 16;
            previewCtx.shadowOffsetY = 6;
            previewCtx.fillStyle = "rgba(0,0,0,0.01)";
            spotShapePath(previewCtx, scr.shape, cx, cy + 0.5, r);
            previewCtx.fill();
            previewCtx.restore();
        }
        // content
        previewCtx.save();
        spotShapePath(previewCtx, scr.shape, cx, cy, r);
        previewCtx.clip();
        try {
            previewCtx.drawImage(s2el, sqX, sqY, side, side, cx - r, cy - r, r * 2, r * 2);
        } catch (e) { /* frame ready nahi */ }
        previewCtx.restore();
        // border
        // border — ZERO bhi valid value hai (0 || 8 falsy bug: 0 par 8px draw
        // hota tha — user 0 set karta tha phir bhi border dikhta tha)
        const bw = (scr.border && scr.border.width != null) ? Number(scr.border.width) : 8;
        if (bw > 0) {
            previewCtx.save();
            previewCtx.lineWidth = bw;
            previewCtx.strokeStyle = (scr.border && scr.border.color) || "#ffffff";
            spotShapePath(previewCtx, scr.shape, cx, cy, r);
            previewCtx.stroke();
            previewCtx.restore();
        }
    } else if (!isRing) {
        previewCtx.save();
        previewCtx.fillStyle = "rgba(20,20,28,0.85)";
        spotShapePath(previewCtx, scr.shape, cx, cy, r);
        previewCtx.fill();
        previewCtx.strokeStyle = "#ff6b6b";
        previewCtx.setLineDash([6, 4]);
        previewCtx.stroke();
        previewCtx.setLineDash([]);
        previewCtx.fillStyle = "#ff6b6b";
        previewCtx.font = "bold 11px Arial";
        previewCtx.textAlign = "center";
        previewCtx.fillText("video loading...", cx, cy);
        previewCtx.textAlign = "left";
        previewCtx.restore();
    }

    // selection chrome + resize knob (45°)
    if (selected) {
        previewCtx.save();
        previewCtx.lineWidth = isRing ? 3 : 2;
        previewCtx.setLineDash(isRing ? [8, 6] : [4, 4]);
        previewCtx.strokeStyle = isRing ? "#00e5ff" : "rgba(255, 176, 32, 0.9)";
        spotShapePath(previewCtx, scr.shape, cx, cy, r * 1.06);
        previewCtx.stroke();
        previewCtx.setLineDash([]);
        const kx = cx + r * 0.7071, ky = cy + r * 0.7071;
        previewCtx.fillStyle = "#ffb020";
        previewCtx.beginPath();
        previewCtx.arc(kx, ky, 5, 0, Math.PI * 2);
        previewCtx.fill();
        previewCtx.restore();
    } else {
        // non-selected spot shapes: halka number tag (screen identify karne ke liye)
        previewCtx.save();
        previewCtx.fillStyle = "rgba(255,176,32,0.9)";
        previewCtx.beginPath();
        previewCtx.arc(cx, cy - (scr.r * previewCanvas.width) - 10, 8, 0, Math.PI * 2);
        previewCtx.fill();
        previewCtx.fillStyle = "#1a1a24";
        previewCtx.font = "bold 9px Arial";
        previewCtx.textAlign = "center";
        previewCtx.fillText(String(idx + 1), cx, cy - (scr.r * previewCanvas.width) - 7);
        previewCtx.textAlign = "left";
        previewCtx.restore();
    }
}

// ===== SCREENS LIST PANEL =====
function renderScreensList(seg) {
    const listEl = document.getElementById("spScreenList");
    if (!listEl || !seg || !seg.screens) return;
    const key = seg.id + ":" + seg.screens.map((s) => s.id).join(",");
    if (listEl.dataset.key === key) return;
    listEl.dataset.key = key;
    listEl.innerHTML = "";
    seg.screens.forEach((scr, i) => {
        const row = document.createElement("div");
        row.className = "sp-screen-row" + (scr.id === spotSelectedScreenId ? " selected" : "");
        const icon = scr.kind === "vertical" ? "▤" : ({ circle: "●", square: "■", star: "★", heart: "♥", hexagon: "⬡", diamond: "◆", ring: "◌" }[scr.shape] || "●");
        row.innerHTML = `<span class="sp-screen-ic">${icon}</span><span class="sp-screen-name">Screen ${i + 1}${scr.kind === "vertical" ? " (Vertical)" : ""}</span>`;
        row.addEventListener("click", () => { spotSelectedScreenId = scr.id; listEl.dataset.key = null; });
        const del = document.createElement("button");
        del.className = "sp-screen-del";
        del.title = "Screen delete";
        del.textContent = "✕";
        del.addEventListener("click", (e) => { e.stopPropagation(); deleteScreen(seg, scr.id); });
        row.appendChild(del);
        listEl.appendChild(row);
    });
    const empty = document.createElement("div");
    empty.className = "sp-screen-empty";
    empty.textContent = seg.screens.length ? "" : "Koi screen nahi — Add Screen dabao";
    listEl.appendChild(empty);
}

function addScreen(kind) {
    const seg = findSpotlightSeg();
    if (!seg) return;
    ensureScreens(seg);
    const last = seg.screens[seg.screens.length - 1];
    const scr = defaultScreen(
        last ? Math.min(0.92, last.x + 0.18) : 0.5,
        last ? Math.min(0.85, last.y + 0.12) : 0.38,
        last ? last.r : 0.17
    );
    // 16:9 SOURCE-PLACE defaults (user model): shape 16:9 par center-place
    scr.srcX = 0.5; scr.srcY = 0.5; scr.srcR = 0.15;
    if (kind === "vertical") {
        scr.kind = "vertical";
        scr.w = 0.45;
        scr.x = 0.5; scr.y = 0.5;
        // source-crop (16:9 window par): default center portrait area
        scr.srcX = 0.5; scr.srcY = 0.5; scr.srcW = 0.25;
        scr.border = { color: "#ffffff", width: 0 }; // BORDER-LESS (user)
    }
    seg.screens.push(scr);
    spotSelectedScreenId = scr.id;
    if (typeof persistTimelineState === "function") persistTimelineState();
}

function duplicateScreen() {
    const seg = findSpotlightSeg();
    if (!seg) return;
    ensureScreens(seg);
    const src = getSelectedScreen(seg);
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = spotGenId();
    copy.x = Math.min(0.95, copy.x + 0.12);
    copy.y = Math.min(0.92, copy.y + 0.08);
    // V1+V1Dup (user): duplicate SAME source-area share kare — srcX/srcY/srcW
    // aur vertical-dup mein 16:9 box sath chalta hai (ya khud drag karo)
    if (src.kind === "vertical") copy.srcX = src.srcX, copy.srcY = src.srcY, copy.srcW = src.srcW;
    seg.screens.push(copy);
    spotSelectedScreenId = copy.id;
    if (typeof persistTimelineState === "function") persistTimelineState();
}

function deleteScreen(seg, screenId) {
    ensureScreens(seg);
    seg.screens = seg.screens.filter((s) => s.id !== screenId);
    if (spotSelectedScreenId === screenId) spotSelectedScreenId = seg.screens.length ? seg.screens[0].id : null;
    // FIX (user bug): AAKHRI screen delete karne par drawSpotlightOverlay ke
    // har-frame ensureScreens() TURANT nayi default screen bana deta tha —
    // isliye "Screen 1 delete nahi hoti, background me kaam karti rehti hai".
    // Ab: 0 screens = spotlight OFF (segment single-mode par wapas — duration
    ///barabar bache, dobara Spotlight button dabao to fresh screen banti hai).
    if (!seg.screens.length) {
        seg.mode = "single";
        spotSelectedScreenId = null;
        if (typeof renderAll === "function") { try { renderAll(); } catch (e) {} }
    }
    if (typeof persistTimelineState === "function") persistTimelineState();
}

// ===== MOUSE: 16:9 SOURCE-box drag/resize (playerCanvas) + 9:16 screen drag/resize (previewCanvas) =====
function screenGeometry(scr) {
    return {
        cx: scr.x * previewCanvas.width,
        cy: (scr.kind === "vertical") ? previewCanvas.height / 2 : scr.y * previewCanvas.height,
        r: scr.r * previewCanvas.width,
        w: scr.w * previewCanvas.width,
        h: (scr.kind === "vertical") ? previewCanvas.height : 0,
    };
}

// vertical screen ka source-box geometry (player/16:9 canvas px)
function srcBoxGeometry(scr) {
    const srcW = (spotMainVideoEl() && spotMainVideoEl().videoWidth) || 1280;
    const srcH = (spotMainVideoEl() && spotMainVideoEl().videoHeight) || 720;
    const stripAR = (scr.w * SPOTLIGHT_OUT_W) / SPOTLIGHT_OUT_H;
    let cW = scr.srcW || 0.25;
    let cH = cW * (srcW / srcH) / stripAR;
    if (cH > 1) { cH = 1; cW = cH * stripAR * (srcH / srcW); }
    return { cW, cH };
}

// PLAYER canvas (16:9): SOURCE-PLACE (vertical box + SHAPES dono) —
// capture-phase (crop-editor ke handler se pehle). Move + 6-point resize.
playerCanvas.addEventListener("mousedown", (e) => {
    if (!isSpotlightActive()) return;
    const seg = findSpotlightSeg();
    if (!seg) return;
    ensureScreens(seg);
    computeFitRect();
    if (!fitRect.w) return;
    const rect = playerCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return; // collapsed/hidden player guard
    const mx = (e.clientX - rect.left) * (playerCanvas.width / rect.width);
    const my = (e.clientY - rect.top) * (playerCanvas.height / rect.height);
    const nx = (mx - fitRect.x) / fitRect.w;
    const ny = (my - fitRect.y) / fitRect.h;
    const HIT = 9 / fitRect.w; // ~9px normalized hit-radius

    // handles PEHLE (6-point), phir body hit
    for (const scr of seg.screens) {
        const pts = (scr.kind === "vertical") ? srcBoxHandlePoints(scr, fitRect) : srcShapeHandlePoints(scr, fitRect);
        for (const p of pts) {
            const pxN = (p.px - fitRect.x) / fitRect.w;
            const pyN = (p.py - fitRect.y) / fitRect.h;
            if (Math.hypot(nx - pxN, ny - pyN) <= HIT) {
                spotSelectedScreenId = scr.id;
                window.__spotSrcDrag = { scr, type: "resize", handle: p.key, orig: JSON.parse(JSON.stringify(scr)) };
                e.stopPropagation();
                e.preventDefault();
                return;
            }
        }
    }
    for (const scr of seg.screens) {
        let inside = false;
        if (scr.kind === "vertical") {
            const { cW, cH } = srcBoxGeometry(scr);
            inside = Math.abs(nx - scr.srcX) <= cW / 2 && Math.abs(ny - (scr.srcY || 0.5)) <= cH / 2;
        } else {
            const r = scr.srcR || 0.15;
            inside = Math.hypot(nx - scr.srcX, ny - (scr.srcY || 0.5)) <= r;
        }
        if (inside) {
            spotSelectedScreenId = scr.id;
            window.__spotSrcDrag = { scr, type: "move", grabDx: nx - scr.srcX, grabDy: ny - (scr.srcY || 0.5) };
            e.stopPropagation();
            e.preventDefault();
            return;
        }
    }
}, true); // capture: crop-editor ke handler se PEHLE

document.addEventListener("mousemove", (e) => {
    const d = window.__spotSrcDrag;
    if (!d) return;
    computeFitRect();
    const rect = playerCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return; // collapsed player — drag skip
    const mx = (e.clientX - rect.left) * (playerCanvas.width / rect.width);
    const my = (e.clientY - rect.top) * (playerCanvas.height / rect.height);
    const nx = Math.max(0, Math.min(1, (mx - fitRect.x) / fitRect.w));
    const ny = Math.max(0, Math.min(1, (my - fitRect.y) / fitRect.h));
    const scr = d.scr;
    if (d.type === "move") {
        let halfW;
        if (scr.kind === "vertical") {
            const { cW } = srcBoxGeometry(scr);
            halfW = cW / 2;
        } else {
            halfW = (scr.srcR || 0.15);
        }
        scr.srcX = Math.max(halfW, Math.min(1 - halfW, nx - d.grabDx));
        scr.srcY = Math.max(0, Math.min(1, ny - d.grabDy));
        // MAGNETIC SOURCE SNAP (user join-request ka dusra hissa): jab do
        // vertical screens ka 16:9 source-box edges Touch karte hain, unhe
        // snap kar do — 9:16 output me strips naturally flush join hoti hain.
        if (scr.kind === "vertical") {
            const SNAPS = 12 / fitRect.w;
            const tTargets = [0, 1];
            for (const o of seg.screens) {
                if (o.id === scr.id || o.kind !== "vertical") continue;
                tTargets.push(o.srcX - (o.srcW || 0.25) / 2, o.srcX + (o.srcW || 0.25) / 2);
            }
            const myL2 = scr.srcX - halfW, myR2 = scr.srcX + halfW;
            let bBest = null, bBestD = SNAPS;
            for (const t of tTargets) {
                const dL = Math.abs(myL2 - t), dR = Math.abs(myR2 - t);
                if (dL < bBestD) { bBestD = dL; bBest = t + halfW; }
                if (dR < bBestD) { bBestD = dR; bBest = t - halfW; }
            }
            if (bBest != null) scr.srcX = Math.max(halfW, Math.min(1 - halfW, bBest));
        }
    } else {
        // 6-POINT RESIZE: drag hue point ka opposite-edge FIXED rehta hai
        const o = d.orig;
        const k = d.handle;
        const fromLeft = k[1] === "L";      // L handle => RIGHT edge fixed
        const oHalf = (scr.kind === "vertical") ? (o.srcW || 0.25) / 2 : (o.srcR || 0.15);
        const fixedEdge = fromLeft ? (o.srcX + oHalf) : (o.srcX - oHalf);
        const dxN = Math.abs(nx - fixedEdge);
        if (scr.kind === "vertical") {
            // box handles edges PAR hain => newWidth = distance to fixed edge
            scr.srcW = Math.max(0.06, Math.min(1.5, dxN));
            scr.srcX = fromLeft ? Math.min(1, nx + scr.srcW / 2) : Math.max(0, nx - scr.srcW / 2);
            // T/B handles: crop-window upar/neeche bhi move hoti hai
            if (k[0] === "T" || k[0] === "B") {
                const oNy = Math.max(0, Math.min(1, o.srcY));
                scr.srcY = Math.max(0, Math.min(1, o.srcY + (ny - oNy)));
            }
        } else {
            // shape corner handles r*0.5 par hain (CL/CR r par) => / (1 + K)
            const K = (k === "CL" || k === "CR") ? 1 : 0.5;
            scr.srcR = Math.max(0.04, Math.min(0.8, dxN / (1 + K)));
            scr.srcX = fromLeft ? Math.min(1, nx + scr.srcR) : Math.max(0, nx - scr.srcR);
            scr.srcY = Math.max(0, Math.min(1, o.srcY + (ny - Math.max(0, Math.min(1, o.srcY))) * ((k === "CL" || k === "CR") ? 0 : 1)));
        }
    }
    e.preventDefault();
});

document.addEventListener("mouseup", () => {
    if (window.__spotSrcDrag) {
        window.__spotSrcDrag = null;
        if (typeof persistTimelineState === "function") persistTimelineState();
    }
});

// ===== 16:9 SOURCE-PLACE GEOMETRY (6-point model) =====
// Vertical: portrait source-box (center srcX/srcY, width srcW — aspect strip
// ke sath locked). Shape: circle-ish region (center srcX/srcY, radius srcR).
// Dono 16:9 player ke video-area (fitRect) ke normalized coords mein hain.
function srcBoxPx(scr, fr) {
    const srcW = (spotMainVideoEl() && spotMainVideoEl().videoWidth) || 1280;
    const srcH = (spotMainVideoEl() && spotMainVideoEl().videoHeight) || 720;
    const stripAR = (scr.w * SPOTLIGHT_OUT_W) / SPOTLIGHT_OUT_H;
    let cW = scr.srcW || 0.25;
    let cH = cW * (srcW / srcH) / stripAR;
    if (cH > 1) { cH = 1; cW = cH * stripAR * (srcH / srcW); }
    const bw = cW * fr.w, bh = cH * fr.h;
    return { x0: fr.x + scr.srcX * fr.w - bw / 2, y0: fr.y + (scr.srcY || 0.5) * fr.h - bh / 2, w: bw, h: bh };
}

function srcShapePx(scr, fr) {
    return {
        cx: fr.x + scr.srcX * fr.w,
        cy: fr.y + (scr.srcY || 0.5) * fr.h,
        r: (scr.srcR || 0.15) * fr.w,
    };
}

// 6 resize points: 2 TOP (L/R) + 2 CENTER (L/R) + 2 BOTTOM (L/R)
function srcBoxHandlePoints(scr, fr) {
    const { x0, y0, w, h } = srcBoxPx(scr, fr);
    return [
        { px: x0, py: y0, key: "TL" }, { px: x0 + w, py: y0, key: "TR" },
        { px: x0, py: y0 + h / 2, key: "CL" }, { px: x0 + w, py: y0 + h / 2, key: "CR" },
        { px: x0, py: y0 + h, key: "BL" }, { px: x0 + w, py: y0 + h, key: "BR" },
    ];
}

function srcShapeHandlePoints(scr, fr) {
    const { cx, cy, r } = srcShapePx(scr, fr);
    const K = 0.5;
    return [
        { px: cx - r * K, py: cy - r * 0.866, key: "TL" }, { px: cx + r * K, py: cy - r * 0.866, key: "TR" },
        { px: cx - r, py: cy, key: "CL" }, { px: cx + r, py: cy, key: "CR" },
        { px: cx - r * K, py: cy + r * 0.866, key: "BL" }, { px: cx + r * K, py: cy + r * 0.866, key: "BR" },
    ];
}

// 9:16 preview ke 6 resize points (vertical strip par)
function outStripHandlePoints(scr) {
    const R = stripRect(scr);
    return [
        { px: R.x0, py: 0, key: "TL" }, { px: R.x0 + R.w, py: 0, key: "TR" },
        { px: R.x0, py: previewCanvas.height / 2, key: "CL" }, { px: R.x0 + R.w, py: previewCanvas.height / 2, key: "CR" },
        { px: R.x0, py: previewCanvas.height, key: "BL" }, { px: R.x0 + R.w, py: previewCanvas.height, key: "BR" },
    ];
}

// shape ka 6-point radius: us point ka current radius (resize ke liye)
function spotShapeRadiusAt(scr, key) {
    const r = scr.r * previewCanvas.width;
    const { cx, cy } = (() => ({ cx: scr.x * previewCanvas.width, cy: scr.y * previewCanvas.height }))();
    const K = { TL: 0.5, TR: 0.5, CL: 1, CR: 1, BL: 0.5, BR: 0.5 }[key] || 1;
    const ys = { TL: 0.866, TR: 0.866, CL: 0, CR: 0, BL: 0.866, BR: 0.866 }[key] || 0;
    return { cx, cy, px: cx + (key[1] === "L" ? -1 : 1) * r * K, py: cy + r * ys * (key[0] === "B" ? 1 : key[0] === "T" ? -1 : 0), K };
}

function spotHitScreen(seg, mx, my) {
    // selected pehle (topmost draw order ke sath consistent)
    const order = [...seg.screens].sort((a, b) => (a.id === spotSelectedScreenId ? -1 : 0) - (b.id === spotSelectedScreenId ? -1 : 0));
    for (const scr of order) {
        const { cx, cy, r, w, h } = screenGeometry(scr);
        if (scr.kind === "vertical") {
            if (mx >= cx - w / 2 - 6 && mx <= cx + w / 2 + 14 && my >= 0 && my <= previewCanvas.height) return scr;
        } else {
            const dx = mx - cx, dy = my - cy;
            let inside;
            switch (scr.shape) {
                case "square": inside = Math.abs(dx) <= r && Math.abs(dy) <= r; break;
                case "diamond": inside = (Math.abs(dx) / (r * 0.7) + Math.abs(dy) / r) <= 1; break;
                case "hexagon": inside = Math.abs(dx) <= 0.866 * r && Math.abs(dy) <= r * (1 - Math.abs(dx) / (1.732 * r)); break;
                default: inside = Math.hypot(dx, dy) <= r; break;
            }
            if (inside) return scr;
        }
    }
    return null;
}

function spotlightHandleMouseDown(e) {
    if (!isSpotlightActive()) return false;
    const seg = findSpotlightSeg();
    if (!seg) return false;
    ensureScreens(seg);
    const rect = previewCanvas.getBoundingClientRect();
    const scaleX = previewCanvas.width / rect.width;
    const scaleY = previewCanvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;

    // resize handles pehle: vertical = 6-point, shapes = 45° knob
    for (const scr of seg.screens) {
        const g = screenGeometry(scr);
        if (scr.kind === "vertical") {
            // 6-POINT (user): 2 top + 2 center + 2 bottom (left/right edges)
            for (const p of outStripHandlePoints(scr)) {
                if (Math.hypot(mx - p.px, my - p.py) <= SPOT_HANDLE_HIT) {
                    spotDrag = { seg, screenId: scr.id, type: "resize", handle: p.key };
                    spotSelectedScreenId = scr.id;
                    e.stopPropagation();
                    return true;
                }
            }
        } else {
            const kx = g.cx + g.r * 0.7071, ky = g.cy + g.r * 0.7071;
            if (Math.hypot(mx - kx, my - ky) <= SPOT_HANDLE_HIT) {
                spotDrag = { seg, screenId: scr.id, type: "resize" };
                spotSelectedScreenId = scr.id;
                e.stopPropagation();
                return true;
            }
        }
    }
    const scr = spotHitScreen(seg, mx, my);
    if (scr) {
        spotSelectedScreenId = scr.id;
        spotDrag = { seg, screenId: scr.id, type: "move", grabDx: (mx - scr.x * previewCanvas.width) / previewCanvas.width, grabDy: (my - scr.y * previewCanvas.height) / previewCanvas.height };
        e.stopPropagation();
        return true;
    }
    return false;
}

previewCanvas.addEventListener("mousedown", (e) => {
    spotlightHandleMouseDown(e);
});

document.addEventListener("mousemove", (e) => {
    if (!spotDrag) return;
    const seg = spotDrag.seg;
    if (!getSegmentById(seg.id)) { spotDrag = null; return; } // segment delete ho gaya
    const scr = seg.screens.find((s) => s.id === spotDrag.screenId);
    if (!scr) { spotDrag = null; return; }
    const rect = previewCanvas.getBoundingClientRect();
    const scaleX = previewCanvas.width / rect.width;
    const scaleY = previewCanvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;

    if (spotDrag.type === "move") {
        let nx = mx / previewCanvas.width - spotDrag.grabDx;
        let ny = my / previewCanvas.height - spotDrag.grabDy;
        if (scr.kind === "vertical") {
            // strip: sirf horizontal move (height poori fixed hai), y locked 0.5
            const halfW = scr.w / 2;
            nx = Math.max(halfW, Math.min(1 - halfW, nx));
            ny = 0.5;
            // MAGNETIC SNAP (user): strips ki edges doosri vertical strips ke
            // edges par SACPAK jitne hain (12px) — side-by-side flush join.
            const SNAP = 12 / previewCanvas.width;
            const targets = [0, 1]; // canvas edges bhi snap hote hain
            for (const o of seg.screens) {
                if (o.id === scr.id || o.kind !== "vertical") continue;
                targets.push(o.x - o.w / 2, o.x + o.w / 2);
            }
            const myL = nx - halfW, myR = nx + halfW;
            let best = null, bestD = SNAP, bestEdge = null;
            for (const t of targets) {
                const dL = Math.abs(myL - t), dR = Math.abs(myR - t);
                if (dL < bestD) { bestD = dL; best = t + halfW; bestEdge = t; }
                if (dR < bestD) { bestD = dR; best = t - halfW; bestEdge = t; }
            }
            if (best != null) {
                nx = Math.max(halfW, Math.min(1 - halfW, best));
                window.__spotSnapEdge = bestEdge; // draw par purple guide line
            } else {
                window.__spotSnapEdge = null;
            }
        } else {
            const rr = scr.r;
            const rH = rr * SPOTLIGHT_OUT_W / SPOTLIGHT_OUT_H;
            nx = Math.max(rr, Math.min(1 - rr, nx));
            ny = Math.max(rH, Math.min(1 - rH, ny));
        }
        scr.x = nx;
        scr.y = ny;
    } else if (spotDrag.type === "resize") {
        const g = screenGeometry(scr);
        if (scr.kind === "vertical") {
            // 6-POINT RESIZE: opposite-edge FIXED, dragged-edge mouse ko follow
            const o = spotDrag.orig || (spotDrag.orig = { w: scr.w, x: scr.x });
            const k = spotDrag.handle || "CR";
            const fromLeft = k[1] === "L";
            const fixedEdge = fromLeft ? (o.x + o.w / 2) : (o.x - o.w / 2);
            const fixedEdgePx = fixedEdge * previewCanvas.width;
            const newW = Math.max(0.06, Math.min(1, Math.abs(mx - fixedEdgePx) / previewCanvas.width));
            scr.w = newW;
            scr.x = fromLeft ? Math.min(1, mx / previewCanvas.width + newW / 2) : Math.max(0, mx / previewCanvas.width - newW / 2);
        } else {
            const dist = Math.hypot(mx - g.cx, my - g.cy) / previewCanvas.width;
            scr.r = Math.max(0.05, Math.min(0.45, dist));
        }
    }
});

document.addEventListener("mouseup", () => {
    if (spotDrag) {
        spotDrag = null;
        window.__spotSnapEdge = null;
        if (typeof persistTimelineState === "function") persistTimelineState();
    }
});

// ===== CONTROLS PANEL =====
function syncScreenControls(scr) {
    if (!scr) return;
    const isV = scr.kind === "vertical";
    const zoomRow = document.getElementById("spZoomRow");
    const styleRow = document.getElementById("spStyleRow");
    const borderRow = document.getElementById("spBorderRow");
    if (zoomRow) zoomRow.style.display = isV ? "none" : "";
    if (styleRow) styleRow.style.display = isV ? "none" : "";
    // BORDER-LESS vertical: border controls sirf shapes par
    if (borderRow) borderRow.style.display = isV ? "none" : "";

    const zoomEl = document.getElementById("spZoom");
    const sizeEl = document.getElementById("spSize");
    const zv = document.getElementById("spZoomVal");
    const sz = document.getElementById("spSizeVal");
    if (zoomEl && document.activeElement !== zoomEl) zoomEl.value = scr.zoom;
    if (sizeEl && document.activeElement !== sizeEl) sizeEl.value = isV ? scr.w : scr.r;
    if (zv) zv.textContent = (scr.zoom || 1.6).toFixed(2) + "x";
    if (sz) sz.textContent = Math.round((isV ? scr.w : scr.r) * 100) + "%";
    document.querySelectorAll(".sp-style-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.style === scr.shape);
    });
    const bwEl = document.getElementById("spBorderW");
    const bcolEl = document.getElementById("spBorderColor");
    const shEl = document.getElementById("spShadow");
    if (bwEl && document.activeElement !== bwEl) bwEl.value = (scr.border && scr.border.width !== undefined) ? scr.border.width : 8;
    if (bcolEl) bcolEl.value = (scr.border && scr.border.color) || "#ffffff";
    if (shEl) shEl.checked = !!(scr.shadow && scr.shadow.enabled);
    const bv2 = document.getElementById("spBorderWVal");
    if (bv2 && document.activeElement !== bwEl) bv2.textContent = ((scr.border && scr.border.width != null) ? Number(scr.border.width) : 8) + "px";
    const vertCb = document.getElementById("spVertical");
    if (vertCb) vertCb.checked = isV;
}

function initSpotlightUI() {
    const btn = document.getElementById("spotlightBtn");
    if (btn) btn.addEventListener("click", setupSpotlight);

    const zoomEl = document.getElementById("spZoom");
    const sizeEl = document.getElementById("spSize");
    if (zoomEl) {
        zoomEl.addEventListener("input", () => {
            const seg = findSpotlightSeg();
            if (!seg) return;
            const scr = getSelectedScreen(seg);
            if (scr.kind === "vertical") return;
            scr.zoom = parseFloat(zoomEl.value);
            const zv = document.getElementById("spZoomVal");
            if (zv) zv.textContent = scr.zoom.toFixed(2) + "x";
        });
        zoomEl.addEventListener("change", () => { if (typeof persistTimelineState === "function") persistTimelineState(); });
    }
    if (sizeEl) {
        sizeEl.addEventListener("input", () => {
            const seg = findSpotlightSeg();
            if (!seg) return;
            const scr = getSelectedScreen(seg);
            const v = parseFloat(sizeEl.value);
            if (scr.kind === "vertical") scr.w = v; else scr.r = v;
            const sz = document.getElementById("spSizeVal");
            if (sz) sz.textContent = Math.round(v * 100) + "%";
        });
        sizeEl.addEventListener("change", () => { if (typeof persistTimelineState === "function") persistTimelineState(); });
    }
    document.querySelectorAll(".sp-style-btn").forEach((b) => {
        b.addEventListener("click", () => {
            const seg = findSpotlightSeg();
            if (!seg) return;
            const scr = getSelectedScreen(seg);
            if (scr.kind === "vertical") return;
            scr.shape = b.dataset.style;
            if (typeof persistTimelineState === "function") persistTimelineState();
        });
    });

    const bwEl = document.getElementById("spBorderW");
    const bcolEl = document.getElementById("spBorderColor");
    const shEl = document.getElementById("spShadow");
    if (bwEl) {
        bwEl.addEventListener("input", () => {
            const seg = findSpotlightSeg();
            if (!seg) return;
            const scr = getSelectedScreen(seg);
            scr.border.width = parseFloat(bwEl.value);
            const bv = document.getElementById("spBorderWVal");
            if (bv) bv.textContent = bwEl.value + "px";
        });
        bwEl.addEventListener("change", () => { if (typeof persistTimelineState === "function") persistTimelineState(); });
    }
    if (bcolEl) {
        bcolEl.addEventListener("input", () => {
            const seg = findSpotlightSeg();
            if (!seg) return;
            const scr = getSelectedScreen(seg);
            scr.border.color = bcolEl.value;
        });
        bcolEl.addEventListener("change", () => { if (typeof persistTimelineState === "function") persistTimelineState(); });
    }
    if (shEl) {
        shEl.addEventListener("change", () => {
            const seg = findSpotlightSeg();
            if (!seg) return;
            const scr = getSelectedScreen(seg);
            scr.shadow.enabled = shEl.checked;
            if (typeof persistTimelineState === "function") persistTimelineState();
        });
    }
    const vertCb = document.getElementById("spVertical");
    if (vertCb) {
        vertCb.addEventListener("change", () => {
            const seg = findSpotlightSeg();
            if (!seg) return;
            const scr = getSelectedScreen(seg);
            if (vertCb.checked) {
                scr.kind = "vertical";
                scr.w = Math.max(0.12, Math.min(0.6, scr.r * 2));
                scr.y = 0.5; // strip: y fixed (height = poori output)
                scr.border = { color: (scr.border && scr.border.color) || "#ffffff", width: 0 }; // border-less
            } else {
                scr.kind = "spot";
                scr.shape = "square";
                scr.r = Math.max(0.05, scr.w / 2);
                if (scr.srcR === undefined) scr.srcR = 0.15;
            }
            if (typeof persistTimelineState === "function") persistTimelineState();
        });
    }
    const addSpot = document.getElementById("spAddSpot");
    if (addSpot) addSpot.addEventListener("click", () => addScreen("spot"));
    const addVert = document.getElementById("spAddVertical");
    if (addVert) addVert.addEventListener("click", () => addScreen("vertical"));
    const dupBtn = document.getElementById("spDupScreen");
    if (dupBtn) dupBtn.addEventListener("click", duplicateScreen);
    const delBtn = document.getElementById("spDelScreen");
    if (delBtn) {
        delBtn.addEventListener("click", () => {
            const seg = findSpotlightSeg();
            if (!seg) return;
            ensureScreens(seg);
            const scr = getSelectedScreen(seg);
            deleteScreen(seg, scr.id);
        });
    }
}

initSpotlightUI();
```

### Name: frontend/style.css
```css
* { box-sizing: border-box; }

:root {
    --bg-app: #1b1b1d;
    --bg-panel: #202023;
    --bg-panel-2: #26262a;
    --bg-panel-3: #2c2c31;
    --border: #34343a;
    --text: #e8e8ea;
    --text-dim: #98989f;
    --accent: #2fb8a6;
    --accent-strong: #22a390;
    --selected: #ffb020;
    --playhead: #ff4d4f;
}

body {
    margin: 0;
    font-family: "Segoe UI", Roboto, Arial, sans-serif;
    background: var(--bg-app);
    color: var(--text);
    overflow: hidden;
}

.topbar {
    background: var(--bg-panel);
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
}
.topbar-left { display: flex; align-items: center; gap: 8px; }
.brand-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--accent);
}
.topbar h2 { margin: 0; font-size: 14px; font-weight: 600; }

.app-body {
    display: flex;
    height: calc(100vh - 39px);
}

/* ===== MEDIA BIN ===== */
.media-bin {
    width: 240px;
    background: var(--bg-panel);
    border-right: 1px solid var(--border);
    overflow-y: auto;
    overflow-x: hidden;
    transition: width 0.16s ease;
    flex-shrink: 0;
}
.media-bin.collapsed { width: 42px; }
.media-bin.collapsed .mb-title,
.media-bin.collapsed .media-bin-content { display: none; }
.media-bin.collapsed .mb-chevron { transform: rotate(180deg); }

.media-bin-header {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    padding: 12px 10px;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
}
.mb-icon { font-size: 15px; }
.mb-title { font-weight: 600; font-size: 13px; flex: 1; }
.mb-chevron { font-size: 12px; color: var(--text-dim); transition: transform 0.16s ease; }

.media-bin-content { padding: 10px; }

.import-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    background: var(--accent);
    color: #0d1f1c;
    font-weight: 600;
    font-size: 12px;
    padding: 8px 10px;
    border-radius: 5px;
    cursor: pointer;
    margin-bottom: 10px;
    user-select: none;
}
.import-btn:hover { background: var(--accent-strong); }
.import-plus { font-size: 14px; line-height: 1; }

.video-list { display: flex; flex-direction: column; gap: 4px; }
.video-list .video-item {
    background: var(--bg-panel-2);
    padding: 7px 9px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    border: 1px solid transparent;
}
.video-list .video-item:hover { background: var(--bg-panel-3); }
.video-list .video-item.active { background: var(--accent); color: #0d1f1c; font-weight: 600; }

/* ===== CENTER COLUMN ===== */
.center-column {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
}
.center-column.drag-over { outline: 2px dashed var(--accent); outline-offset: -2px; }

.mode-tabs {
    display: flex;
    gap: 6px;
    padding: 8px 10px;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border);
}
.mode-tab {
    background: var(--bg-panel-2);
    color: var(--text-dim);
    border: 1px solid var(--border);
    padding: 6px 14px;
    border-radius: 5px;
    cursor: pointer;
    font-size: 12px;
}
.mode-tab:hover { background: var(--bg-panel-3); }
.mode-tab.active { background: var(--accent); border-color: var(--accent); color: #0d1f1c; font-weight: 600; }
.mode-tabs.disabled { opacity: 0.35; pointer-events: none; }

.player-row {
    flex: 1;
    display: flex;
    justify-content: center;
    align-items: center;
    background: #000;
    min-height: 0;
    position: relative;
}
.video-wrapper { width: 100%; height: 100%; position: relative; }
#playerCanvas { width: 100%; height: 100%; display: block; }

.player-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 5px 10px;
    background: var(--bg-panel);
    border-top: 1px solid var(--border);
    flex-wrap: wrap;
}

/* ===== NAYA: video-info-row — speed badge + "|" + filename, sab ek line mein ===== */
.video-info-row {
    display: flex;
    align-items: center;
    gap: 8px;
}
.info-separator {
    color: var(--text-dim);
    font-size: 11px;
}
.video-info { font-size: 11px; color: var(--text-dim); white-space: nowrap; }

/* speed-control: ab inline pill hai (player-footer ke andar), koi absolute/overlay nahi */
.speed-control {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    background: var(--bg-panel-2);
    border: 1px solid var(--border);
    border-radius: 12px;
    cursor: ew-resize;
    user-select: none;
    transition: background 0.15s, border-color 0.15s;
}
.speed-control:hover {
    background: var(--bg-panel-3);
    border-color: #454550;
}
.speed-control .speed-icon {
    font-size: 11px;
    opacity: 0.8;
}
.speed-control .speed-value {
    font-size: 11px;
    font-weight: 700;
    color: var(--text);
    min-width: 38px;
    text-align: center;
    outline: none;
    font-variant-numeric: tabular-nums;
}
.speed-control.speed-fast .speed-value { color: var(--selected); }
.speed-control.speed-slow .speed-value { color: var(--accent); }
.speed-control .speed-value.speed-editing {
    cursor: text;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    padding: 0 4px;
}
.speed-control.speed-disabled {
    opacity: 0.4;
    cursor: default;
    pointer-events: none;
}

.jump-controls { display: flex; align-items: center; gap: 6px; }
.jump-label { font-size: 11px; color: var(--text-dim); margin-right: 2px; }
.jump-field {
    display: flex; align-items: center; gap: 4px;
    background: var(--bg-panel-2);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 2px 6px;
}
.jump-tag { font-size: 10px; color: var(--text-dim); }
.time-input {
    width: 78px;
    background: transparent;
    border: none;
    color: var(--text);
    font-size: 11px;
    outline: none;
    font-variant-numeric: tabular-nums;
}
.jump-go {
    background: var(--bg-panel-3);
    border: 1px solid var(--border);
    color: var(--text);
    font-size: 11px;
    padding: 3px 9px;
    border-radius: 4px;
    cursor: pointer;
}
.jump-go:hover { background: var(--accent); border-color: var(--accent); color: #0d1f1c; }

.tools-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 10px;
    background: var(--bg-panel);
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
}
.tool-sep {
    width: 1px;
    align-self: stretch;
    background: var(--border);
    margin: 2px 4px;
}
.tool-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    background: var(--bg-panel-2);
    color: var(--text);
    border: 1px solid var(--border);
    padding: 5px 9px;
    border-radius: 5px;
    cursor: pointer;
    font-size: 10px;
    line-height: 1.1;
    min-width: 34px;
}
.tool-btn:hover { background: var(--bg-panel-3); border-color: #454550; }
.tool-btn:active { background: var(--accent); border-color: var(--accent); color: #0d1f1c; }
.tool-icon { font-size: 14px; }
.tool-label { font-size: 10px; color: var(--text-dim); white-space: nowrap; }
.tool-btn:hover .tool-label { color: var(--text); }
.tool-btn-primary { background: var(--accent); border-color: var(--accent); color: #0d1f1c; }
.tool-btn-primary:hover { background: var(--accent-strong); }

.time-display {
    margin-left: auto;
    font-size: 11px;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}

/* ===== TIMELINE ===== */
.timeline-panel {
    height: 236px;
    background: #131315;
    flex-shrink: 0;
}
.timeline-body {
    display: flex;
    height: 100%;
}

/* --- left frozen label column --- */
.timeline-labels {
    width: 84px;
    flex-shrink: 0;
    background: var(--bg-panel);
    border-right: 1px solid var(--border);
    overflow-y: scroll;
    overflow-x: hidden;
    scrollbar-width: none;
}
.timeline-labels::-webkit-scrollbar { display: none; }
.label-spacer { height: 36px; flex-shrink: 0; }
.label-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px;
    font-size: 11px;
    color: var(--text-dim);
    border-top: 1px solid var(--border);
    font-weight: 600;
}
/* ALignment FIX (BUG 2): resize-handles (5px) sirf TRACKS side par hain —
   labels column me unke barabar SPACER rows (borders ke sath) add kiye,
   warna har row ke baad 5px ka offset jama hota jata tha (labels neeche
   khisakte jate the). Ye rows KOI height add nahi karti — sirf 5px handle
   ki jagah bhar ti hain. + "＋" add-button (BUG 1) label-row ke andar. */
.label-resize-spacer {
    height: 5px;
    flex-shrink: 0;
    border-top: 1px solid var(--border);
}
.layer-add-btn {
    margin-left: auto;
    width: 16px; height: 16px;
    line-height: 1;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: #1c1c20;
    color: var(--text-dim);
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    flex-shrink: 0;
}
.layer-add-btn:hover { background: var(--accent); color: #0d1f1c; border-color: var(--accent); }
.label-dot { width: 7px; height: 7px; border-radius: 2px; flex-shrink: 0; }
.label-dot-video { background: #4aa8ff; }
.label-dot-audio { background: #35d0a8; }
.label-dot-segment { background: var(--selected); }

/* --- scrollable ruler + tracks area --- */
.timeline-scroll {
    flex: 1;
    overflow: auto;
    position: relative;
}
.timeline-track {
    position: relative;
    min-width: 100%;
}

.ruler-frames {
    position: sticky;
    top: 0;
    left: 0;
    height: 16px;
    background: #202024;
    border-bottom: 1px solid var(--border);
    position: relative;
    z-index: 5;
}
.ruler-frames.hidden-ruler { background: #1a1a1d; }
.frame-tick {
    position: absolute;
    top: 0;
    height: 100%;
    border-left: 1px solid #3a3a41;
    padding-left: 3px;
    display: flex;
    align-items: center;
}
.frame-label { font-size: 9px; color: #6c6c74; white-space: nowrap; }

.ruler-seconds {
    position: sticky;
    top: 16px;
    left: 0;
    height: 20px;
    background: #26262a;
    border-bottom: 1px solid var(--border);
    z-index: 5;
}
.ruler-tick {
    position: absolute;
    top: 0;
    height: 100%;
    border-left: 1px solid #46464e;
    padding-left: 4px;
    display: flex;
    align-items: center;
}
.tick-label { font-size: 10px; color: var(--text-dim); white-space: nowrap; font-variant-numeric: tabular-nums; }

/* NOTE: the sticky rulers stick within #timelineScroll while it scrolls vertically;
   they still move left/right with horizontal scroll since only `top` is pinned. */

.tracks-area { position: relative; }
.scrub-area { display: flex; flex-direction: column; cursor: pointer; }

.track-row {
    position: relative;
    border-top: 1px solid var(--border);
}
.track-video { background: #17171a; }
.track-audio { background: #14201c; }
.track-segments { background: #1a1a1d; }

.track-resize-handle {
    height: 5px;
    background: transparent;
    cursor: row-resize;
    position: relative;
    z-index: 6;
}
.track-resize-handle::after {
    content: "";
    position: absolute;
    left: 0; right: 0; top: 2px;
    height: 1px;
    background: var(--border);
}
.track-resize-handle:hover::after,
.track-resize-handle.active::after { background: var(--accent); height: 2px; }

.filmstrip { display: flex; height: 100%; }
.filmstrip img { height: 100%; object-fit: cover; flex-shrink: 0; border-right: 1px solid #000; }

/* video/audio block-layers: sirf blocks click-capture karein, khali jaga se click
   neeche scrubArea tak "fall through" ho kar playhead seek kare */
.track-videoblocks { position: absolute; inset: 0; pointer-events: none; }
.track-audiolane { position: absolute; inset: 0; pointer-events: none; }

.waveform-img {
    position: absolute;
    top: 0; left: 0;
    height: 100%;
    opacity: 0.85;
    pointer-events: none;
}

.playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--playhead);
    pointer-events: none;
    z-index: 10;
}
.playhead-flag {
    position: absolute;
    top: -1px;
    left: -4px;
    width: 10px;
    height: 8px;
    background: var(--playhead);
    clip-path: polygon(0 0, 100% 0, 100% 60%, 50% 100%, 0 60%);
}

/* ===== SEGMENT / AUDIO / VIDEO BLOCKS ===== */
.segment-block {
    position: absolute;
    top: 3px;
    bottom: 3px;
    background: #0d47a1;
    border: 1px solid #2f7dff;
    border-radius: 4px;
    cursor: grab;
    display: flex;
    align-items: center;
    padding: 0 6px;
    overflow: hidden;
}
.segment-block.selected { background: #d4b100; border-color: #ffe066; box-shadow: 0 0 0 1px #ffe066; }
.segment-block.selected .seg-label { color: #1b1b1d; }
.segment-block.creating { background: rgba(47, 125, 255, 0.25); border: 1px dashed #2f7dff; }
.seg-label { font-size: 11px; color: #fff; white-space: nowrap; pointer-events: none; }
.seg-handle { position: absolute; top: 0; bottom: 0; width: 6px; cursor: ew-resize; pointer-events: auto; }
.seg-handle-left { left: 0; }
.seg-handle-right { right: 0; }

.video-block {
    position: absolute;
    top: 3px;
    bottom: 3px;
    background: #2a4f7c;
    border: 1px solid #4d86c9;
    border-radius: 4px;
    cursor: grab;
    display: flex;
    align-items: center;
    padding: 0 6px;
    overflow: hidden;
    pointer-events: auto;
}
.video-block.selected { background: #d4b100; border-color: #ffe066; box-shadow: 0 0 0 1px #ffe066; }
.video-block.selected .seg-label { color: #1b1b1d; }
.video-handle { position: absolute; top: 0; bottom: 0; width: 6px; cursor: ew-resize; pointer-events: auto; }
.video-handle-left { left: 0; }
.video-handle-right { right: 0; }

.audio-block {
    position: absolute;
    top: 3px;
    bottom: 3px;
    background: #14523f;
    border: 1px solid var(--accent);
    border-radius: 4px;
    cursor: grab;
    display: flex;
    align-items: center;
    padding: 0 6px;
    overflow: hidden;
    z-index: 1;
    pointer-events: auto;
}
.audio-block.selected { background: #d4b100; border-color: #ffe066; box-shadow: 0 0 0 1px #ffe066; }
.audio-block.selected .seg-label { color: #1b1b1d; }
.audio-handle { position: absolute; top: 0; bottom: 0; width: 6px; cursor: ew-resize; pointer-events: auto; }
.audio-handle-left { left: 0; }
.audio-handle-right { right: 0; }

/* scrollbar styling (webkit) for a slimmer Filmora-like look */
.timeline-scroll::-webkit-scrollbar { width: 11px; height: 11px; }
.timeline-scroll::-webkit-scrollbar-track { background: #1a1a1d; }
.timeline-scroll::-webkit-scrollbar-thumb { background: #3c3c44; border-radius: 6px; border: 2px solid #1a1a1d; }
.timeline-scroll::-webkit-scrollbar-thumb:hover { background: #4c4c56; }
.timeline-scroll::-webkit-scrollbar-corner { background: #1a1a1d; }

.media-bin::-webkit-scrollbar { width: 8px; }
.media-bin::-webkit-scrollbar-thumb { background: #3c3c44; border-radius: 4px; }

/* ===== PREVIEW PANEL ===== */
.preview-panel {
    width: 300px;
    flex-shrink: 0;
    background: var(--bg-panel);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 10px;
}
.preview-panel h3 { font-size: 12px; margin: 0 0 10px 0; color: var(--text-dim); font-weight: 600; }
#previewCanvas { background: #000; border: 1px solid var(--border); border-radius: 3px; }

/* ===== NEW (Phase 5/6 fixes): per-clip filmstrip, audio-shadow, marquee-select ===== */

/* per-clip filmstrip (replaces the old single global .filmstrip render) */
.clip-filmstrip {
    position: absolute;
    inset: 0;
    display: flex;
    overflow: hidden;
    pointer-events: none;
    z-index: 0;
    border-radius: 3px;
}
.clip-filmstrip img { height: 100%; object-fit: cover; flex-shrink: 0; border-right: 1px solid #000; }

/* keep label + handles above the filmstrip */
.video-block .seg-label,
.video-block .video-handle { position: relative; z-index: 1; }

/* shadow waveform = a video clip's own embedded audio (non-interactive, follows the clip) */
.audio-shadow {
    position: absolute;
    top: 3px;
    bottom: 3px;
    border-radius: 4px;
    opacity: 0.55;
    background-color: rgba(20, 82, 63, 0.55);
    pointer-events: none;
    z-index: 0;
}
.audio-shadow.muted { opacity: 0.15; }

/* keep audio-block label + handles above shadows */
.audio-block { z-index: 2; }

/* press-and-hold marquee (rubber-band) selection */
.marquee-box {
    position: absolute;
    border: 1px solid var(--accent);
    background: rgba(47, 184, 166, 0.15);
    z-index: 8;
    pointer-events: none;
}
```

### Name: frontend/style_additions.css
```css
/* ===== NAYA: Export button (topbar) + Export modal (append to end of style.css) ===== */

.topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
}

.topbar-right {
    display: flex;
    align-items: center;
}

.export-btn {
    background: #0d6efd;
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 8px 18px;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    transition: background 0.15s;
}

.export-btn:hover {
    background: #0b5ed7;
}

/* Save Project (secondary topbar button) */
.export-btn-secondary {
    background: #2a2f3a;
    color: #e6e9ef;
    border: 1px solid #3a4150;
    margin-right: 8px;
    font-weight: 600;
}
.export-btn-secondary:hover {
    background: #343b49;
}

.topbar-right {
    gap: 8px;
}

/* ============================================================
   PROJECTS PANEL (right side slide-in)
   ============================================================ */
.projects-panel {
    position: fixed;
    top: 56px;
    right: 12px;
    width: 320px;
    max-height: calc(100vh - 80px);
    background: #1b1f27;
    border: 1px solid #3a4150;
    border-radius: 10px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
    display: none;
    flex-direction: column;
    z-index: 1200;
    overflow: hidden;
}
.projects-panel.open {
    display: flex;
}
.projects-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    font-weight: 700;
    font-size: 14px;
    color: #e6e9ef;
    border-bottom: 1px solid #2a2f3a;
    background: #222734;
}
.projects-actions {
    display: flex;
    gap: 8px;
    padding: 10px 12px;
}
.pj-name-input {
    flex: 1;
    background: #12151c;
    border: 1px solid #3a4150;
    border-radius: 6px;
    color: #e6e9ef;
    padding: 7px 10px;
    font-size: 13px;
    outline: none;
}
.pj-name-input:focus {
    border-color: #2fb8a6;
}
.pj-action-btn {
    border: none;
    border-radius: 6px;
    padding: 7px 14px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
}
.pj-action-btn.pj-save {
    background: #2fb8a6;
    color: #08211d;
}
.pj-action-btn.pj-save:hover {
    background: #35cdb8;
}
.projects-hint {
    padding: 0 12px 6px;
    font-size: 12px;
    color: #8fd3c8;
    min-height: 18px;
}
.projects-hint.error {
    color: #ff6b6b;
}
.projects-list {
    overflow-y: auto;
    padding: 4px 8px 10px;
}
.pj-empty {
    padding: 14px 8px;
    font-size: 12px;
    color: #9aa3b2;
    text-align: center;
}
.pj-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px;
    border-radius: 8px;
    border: 1px solid transparent;
}
.pj-row:hover {
    background: #222734;
    border-color: #2a2f3a;
}
.pj-row-info {
    min-width: 0;
    flex: 1;
}
.pj-row-name {
    font-size: 13px;
    font-weight: 700;
    color: #e6e9ef;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.pj-row-sub {
    font-size: 11px;
    color: #9aa3b2;
    margin-top: 2px;
}
.pj-row-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
}
.pj-mini-btn,
.kb-mini-btn {
    background: #2a2f3a;
    color: #cfd6e0;
    border: 1px solid #3a4150;
    border-radius: 5px;
    font-size: 11px;
    padding: 4px 8px;
    cursor: pointer;
}
.pj-mini-btn:hover,
.kb-mini-btn:hover {
    background: #343b49;
}
.pj-mini-btn.pj-open {
    background: #2fb8a6;
    color: #08211d;
    border-color: transparent;
    font-weight: 700;
}
.pj-mini-btn.pj-open:hover {
    background: #35cdb8;
}
.pj-mini-btn.pj-danger:hover {
    background: #7a2e2e;
    color: #ffd9d9;
    border-color: #a33;
}

/* ============================================================
   KEYBINDINGS PANEL
   ============================================================ */
.keybind-panel {
    position: fixed;
    top: 56px;
    right: 12px;
    width: 340px;
    max-height: calc(100vh - 80px);
    background: #1b1f27;
    border: 1px solid #3a4150;
    border-radius: 10px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
    display: none;
    flex-direction: column;
    z-index: 1200;
    overflow: hidden;
}
.keybind-panel.open {
    display: flex;
}
.keybind-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    font-weight: 700;
    font-size: 14px;
    color: #e6e9ef;
    border-bottom: 1px solid #2a2f3a;
    background: #222734;
}
.keybind-header-actions {
    display: flex;
    gap: 6px;
}
.keybind-hint {
    padding: 8px 12px 4px;
    font-size: 11px;
    color: #9aa3b2;
}
.keybind-list {
    overflow-y: auto;
    padding: 6px 8px 10px;
}
.kb-action-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 5px 6px;
    border-radius: 6px;
}
.kb-action-row:hover {
    background: #222734;
}
.kb-action-label {
    font-size: 12.5px;
    color: #cfd6e0;
}
.kb-key-btn {
    display: inline-flex; align-items: center;
    padding: 2px 8px; border-radius: 6px;
    background: #2a2a35; color: #e8e8f0;
    border: 1px solid #3d3d4d; font-size: 11px; font-weight: 600;
    cursor: pointer; white-space: nowrap;
}
/* multi-key chips + add-button (naye panel) */
.kb-keys-wrap { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; min-width: 0; }
.kb-key-chip {
    display: inline-flex; align-items: center;
    padding: 2px 8px; border-radius: 6px;
    background: #2a2a35; color: #e8e8f0;
    border: 1px solid #3d3d4d; font-size: 11px; font-weight: 600;
    cursor: pointer; white-space: nowrap;
}
.kb-key-chip:hover { background: #3a3a4a; border-color: #5a5a7a; }
.kb-key-chip.empty { color: #666; font-style: italic; cursor: default; }
.kb-key-add {
    padding: 2px 8px; border-radius: 6px;
    background: transparent; color: #8f8ff0;
    border: 1px dashed #5a5a8a; font-size: 11px; font-weight: 600;
    cursor: pointer; white-space: nowrap;
}
.kb-key-add:hover { background: rgba(120, 120, 255, 0.12); }
.kb-key-add.capturing { color: #ffd166; border-color: #ffd166; animation: kb-pulse 0.9s infinite; }
.kb-action-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.kb-action-label { flex: 0 0 auto; min-width: 40%; }
    background: #12151c;
    border: 1px solid #3a4150;
    border-radius: 5px;
    color: #8fd3c8;
    font-family: monospace;
    font-size: 12px;
    padding: 3px 10px;
    min-width: 90px;
    cursor: pointer;
}
.kb-key-btn:hover {
    border-color: #2fb8a6;
}
.kb-key-btn.capturing {
    border-color: #f0b429;
    color: #f0b429;
    animation: kb-pulse 1s infinite;
}
@keyframes kb-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
}

/* ===== A/D segment-marker flags ===== */
.marker-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 55;
}
.seg-marker-flag {
    position: absolute;
    top: 0;
    width: 2px;
    height: 100%;
}
.seg-marker-flag.start {
    background: #f0b429;
    box-shadow: 0 0 6px rgba(240, 180, 41, 0.8);
}
.seg-marker-flag.start::before {
    content: "S";
    position: absolute;
    top: 2px;
    left: 3px;
    font-size: 9px;
    font-weight: 800;
    color: #f0b429;
}
.seg-marker-flag.end {
    background: #ff6b6b;
    box-shadow: 0 0 6px rgba(255, 107, 107, 0.8);
}
.seg-marker-flag.end::before {
    content: "E";
    position: absolute;
    top: 2px;
    left: 3px;
    font-size: 9px;
    font-weight: 800;
    color: #ff6b6b;
}

.modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
}

.modal-box {
    background: var(--bg-panel, #1e1e1e);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 10px;
    padding: 24px;
    width: 380px;
    max-width: 90vw;
    color: #fff;
    font-family: Arial, sans-serif;
}

.modal-box h3 {
    margin: 0 0 16px 0;
}

.modal-field {
    margin-bottom: 16px;
}

.modal-field > label {
    display: block;
    font-size: 13px;
    opacity: 0.8;
    margin-bottom: 6px;
}

.modal-radio-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.modal-radio-row label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    cursor: pointer;
}

.modal-progress {
    margin: 16px 0;
}

.modal-progress-bar {
    width: 100%;
    height: 10px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    overflow: hidden;
}

.modal-progress-fill {
    height: 100%;
    width: 0%;
    background: #0d6efd;
    transition: width 0.3s;
}

.modal-progress-label {
    margin-top: 8px;
    font-size: 13px;
    opacity: 0.8;
    text-align: center;
}

.modal-result {
    margin: 16px 0;
    text-align: center;
}

.export-download-btn {
    display: inline-block;
    background: #2fb8a6;
    color: #fff;
    text-decoration: none;
    padding: 10px 20px;
    border-radius: 6px;
    font-weight: 700;
}

.modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
}

/* ===== FIX: Tools-row ab 2 fixed rows mein hai =====
   Line 1: Play → Auto Captions tak ke buttons (scroll without wrap)
   Line 2: Undo / Redo / GAP FILL / Speed
   Pehle flex-wrap sab kuch random jagah todta tha (Undo/Redo/Speed neeche
   idhar-udhar gir jate the) */
.tools-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 10px 4px 10px;
    background: var(--bg-panel);
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
}

.tools-line {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
}
.tools-line::-webkit-scrollbar { height: 5px; }
.tools-line::-webkit-scrollbar-thumb { background: #3c3c44; border-radius: 3px; }
.tools-line::-webkit-scrollbar-track { background: transparent; }

.tools-line .time-display { margin-left: auto; }

/* ===== FIX: Timeline scrollbars HAMESHA visible (horizontal + vertical) =====
   IMPORTANT: standard `scrollbar-width/scrollbar-color` properties use MAT karo —
   naye Chromium/WebView2 mein ye Fluent OVERLAY scrollbars on kar dete hain jis
   se ::-webkit-scrollbar rules ignore ho jati hain aur bars gayab ho jati hain.
   Classic hamesha-dikhnе wali bars ke liye: sirf ::-webkit-scrollbar styling +
   overflow ko `scroll` par force karo (auto ki jagah, taake gutters hamesha
   render hon). */
.timeline-scroll {
    overflow-x: scroll;   /* horizontal bar HAMESHA */
    overflow-y: scroll;   /* vertical bar HAMESHA (layers resize par) */
}

.timeline-scroll::-webkit-scrollbar {
    -webkit-appearance: none;
    width: 12px;    /* vertical bar */
    height: 12px;   /* horizontal bar */
}

.timeline-scroll::-webkit-scrollbar-track {
    background: #1a1a1d;
    border-left: 1px solid #2a2a30;
    border-top: 1px solid #2a2a30;
}

.timeline-scroll::-webkit-scrollbar-thumb {
    background: #55555e;
    border-radius: 3px;
    border: 2px solid #1a1a1d;
}

.timeline-scroll::-webkit-scrollbar-thumb:hover {
    background: #6c6c78;
}

.timeline-scroll::-webkit-scrollbar-corner {
    background: #1a1a1d;
}

/* ===== LEFT COLUMN (media-bin + captions panel stack) ===== */
.left-column {
    width: 240px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.left-column .media-bin {
    flex: 1 1 55%;
    min-height: 0;
}

/* FIX: media-bin collapse hone par Captions panel bhi poora chhup jata hai
   aur left-column bhi narrow (42px) ho jata hai */
.captions-panel.cp-hidden { display: none; }
.left-column.bin-collapsed { width: 42px; }
.left-column.bin-collapsed .media-bin { border-right: none; }

/* ===== CAPTIONS PANEL (media-bin ke neeche) ===== */
.captions-panel {
    flex: 1 1 45%;
    min-height: 130px;
    background: var(--bg-panel);
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.cp-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
}
.cp-title { font-weight: 600; font-size: 13px; flex: 1; }
.cp-enable { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-dim); cursor: pointer; }
.cp-toggle { cursor: pointer; color: var(--text-dim); font-size: 13px; padding: 0 4px; }

.cp-body {
    padding: 10px 12px;
    overflow-y: auto;
    font-size: 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.cp-body::-webkit-scrollbar { width: 8px; }
.cp-body::-webkit-scrollbar-thumb { background: #3c3c44; border-radius: 4px; }

.cp-label {
    display: block;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-dim);
    margin-top: 6px;
}
.cp-hint { font-weight: 400; opacity: 0.7; }

.cp-select {
    width: 100%;
    background: var(--bg-panel-3);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 6px 8px;
    font-size: 12px;
}

.cp-color-grid {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 4px 8px;
    align-items: center;
}
.cp-color-item {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    cursor: pointer;
}
.cp-color-grid input[type="color"] {
    width: 44px;
    height: 24px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-panel-3);
    cursor: pointer;
}
.cp-color-grid input[type="color"]:disabled { opacity: 0.35; cursor: not-allowed; }

.cp-slider { width: 100%; accent-color: #2fb8a6; }

.cp-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 8px;
}
.cp-remember { display: flex; align-items: center; gap: 5px; font-size: 11px; cursor: pointer; }
.cp-reset-btn {
    background: var(--bg-panel-3);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 4px 10px;
    font-size: 11px;
    cursor: pointer;
}
.cp-reset-btn:hover { background: #3a3a41; }

.cp-hint-line { font-size: 10px; color: var(--text-dim); opacity: 0.75; margin-top: 4px; }

/* ===== CUSTOM HORIZONTAL SCROLLBAR =====
   WebView2/Chromium ki native overlay-scrollbar par depend karna unreliable
   hai (kabhi render hoti kabhi nahi). Ye apna bar hai — HAMESHA visible,
   click + drag dono se kaam karta hai. JS iski thumb position khud update
   karta hai (updateCustomHScrollbar). */
.h-scroll-bar {
    height: 12px;
    background: #1a1a1d;
    border-top: 1px solid #2a2a30;
    position: relative;
    flex-shrink: 0;
    cursor: pointer;
    user-select: none;
}
.h-scroll-thumb {
    position: absolute;
    top: 2px;
    bottom: 2px;
    min-width: 36px;
    background: #55555e;
    border-radius: 4px;
    cursor: grab;
}
.h-scroll-thumb:hover { background: #6c6c78; }
.h-scroll-thumb.dragging { background: #7c7c88; cursor: grabbing; }

/* panel ko flex-column banao taake .timeline-body upar flex:1 le aur scrollbar
   ke liye neeche 12px hamesha bache (warna bar panel se bahar chali jati) */
.timeline-panel {
    display: flex;
    flex-direction: column;
}
.timeline-panel .timeline-body {
    flex: 1 1 auto;
    min-height: 0;
    height: auto;
}

/* ============================================================
   2-STACK SPOTLIGHT (Add Stack)
   ============================================================ */

/* Stack-2 rows: sirf stack2-active body par dikhte hain (dropdown style) */
.stack2-track,
.stack2-label { display: none; }
body.stack2-active .stack2-track,
body.stack2-active .stack2-label { display: flex; }
body.stack2-active .track-row.stack2-track { display: block; }
.stack2-label { color: #b9a7ff; }
.stack2-label em {
    font-style: normal;
    font-size: 9px;
    background: #6c5ce7;
    color: #fff;
    border-radius: 3px;
    padding: 1px 4px;
    margin-left: 4px;
}
.stack2-label .label-dot { opacity: 0.85; }

/* S2 blocks ka alag tint — turant pata chale ke ye doosri stack hai */
.video-block.stack2 { box-shadow: inset 0 0 0 2px rgba(108, 92, 231, 0.85); }
.video-block.stack2 .seg-label { color: #b9a7ff; }
.segment-block.stack2 { box-shadow: inset 0 0 0 2px rgba(108, 92, 231, 0.85); }
.segment-block.stack2 .seg-label { color: #b9a7ff; }
.audio-block.stack2 { box-shadow: inset 0 0 0 2px rgba(108, 92, 231, 0.85); }
.audio-block.stack2 .seg-label { color: #b9a7ff; }

/* S2 video-row drag-drop hover state */
.stack2-track.drop-hover {
    outline: 2px dashed #8f7bff;
    outline-offset: -2px;
    background: rgba(108, 92, 231, 0.15);
}

/* Add-Stack toggle button active state */
.tool-btn.stack2-toggle-btn.active {
    background: #6c5ce7;
    border-color: #8f7bff;
    color: #fff;
}

/* Spotlight controls (preview panel ke neeche) */
.spotlight-ctrls {
    margin-top: 8px;
    padding: 10px;
    background: #1d1d22;
    border: 1px solid #6c5ce7;
    border-radius: 8px;
    display: none;
    /* FIX: options kat rahe the — panel scrollable + hamesha saare options */
    max-height: 46vh;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: thin;
    scrollbar-color: #6c5ce7 #26262c;
}
.spotlight-ctrls::-webkit-scrollbar { width: 8px; }
.spotlight-ctrls::-webkit-scrollbar-track { background: #26262c; border-radius: 4px; }
.spotlight-ctrls::-webkit-scrollbar-thumb { background: #6c5ce7; border-radius: 4px; }
.spotlight-ctrls::-webkit-scrollbar-thumb:hover { background: #8f7bff; }
.spotlight-ctrls .sp-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
}
.spotlight-ctrls .sp-row:last-child { margin-bottom: 0; }
.spotlight-ctrls .sp-label { font-size: 11px; color: #b9a7ff; min-width: 38px; }
.spotlight-ctrls .sp-val { font-size: 11px; color: #fff; min-width: 44px; text-align: right; }
.spotlight-ctrls input[type="range"] { flex: 1; accent-color: #8f7bff; }
.spotlight-ctrls .sp-styles { gap: 6px; flex-wrap: wrap; }
.sp-style-btn {
    flex: 1 1 30px;
    min-width: 34px;
    background: #2a2a30;
    color: #ccc;
    border: 1px solid #3a3a42;
    border-radius: 6px;
    font-size: 14px;
    line-height: 1;
    padding: 6px 4px;
    cursor: pointer;
}
.sp-style-btn:hover { background: #35353d; }
.sp-style-btn.active {
    background: #6c5ce7;
    border-color: #8f7bff;
    color: #fff;
}

/* ============================================================
   TITLES LAYER (9:16 heading engine) — panel + timeline layer row
   ============================================================ */
.titles-panel {
    margin-top: 8px;
    padding: 10px;
    background: #1d1d22;
    border: 1px solid #ff7ab8;
    border-radius: 8px;
    max-height: 46vh;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: thin;
    scrollbar-color: #ff7ab8 #26262c;
}
.titles-panel .cp-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.titles-panel .cp-title { color: #ff7ab8; font-size: 12px; font-weight: 700; }
.titles-panel .cp-toggle { cursor: pointer; color: #999; font-size: 12px; }
.titles-panel .cp-body .cp-label { display: block; font-size: 11px; color: #b9a7ff; margin-top: 6px; }
.titles-panel .cp-body .cp-hint { color: #777; font-size: 10px; }
.titles-panel .tp-text-input {
    width: 100%;
    box-sizing: border-box;
    margin-top: 4px;
    background: #2a2a30;
    color: #fff;
    border: 1px solid #3a3a42;
    border-radius: 6px;
    font-size: 12px;
    padding: 6px 8px;
}
.titles-panel .tp-template-grid { display: flex; flex-wrap: wrap; gap: 5px; }
.titles-panel .tp-template-btn {
    background: #2a2a30;
    color: #ccc;
    border: 1px solid #3a3a42;
    border-radius: 6px;
    font-size: 10.5px;
    padding: 5px 8px;
    cursor: pointer;
}
.titles-panel .tp-template-btn:hover { background: #35353d; }
.titles-panel .tp-template-btn.active { background: #ff7ab8; border-color: #ffa8cd; color: #2a0a18; font-weight: 600; }
/* align-buttons (Left/Center/Right) — template-buttons jaisa look, chhota */
.titles-panel .tp-align-btn { min-width: 0; padding: 4px 6px; font-size: 11px; }
.titles-panel .tp-align-btn.active { background: #ff7ab8; border-color: #ffa8cd; color: #2a0a18; font-weight: 700; }
.titles-panel .cp-hint-line { margin-top: 8px; font-size: 10px; color: #777; }

/* timeline: titles layer-row + spans (pink heading-tint — captions wale se alag) */
.track-titles { background: rgba(255, 122, 184, 0.04); }
.title-span {
    background: linear-gradient(180deg, #7a2c4e, #5a1e38);
    border: 1px solid #ff7ab8;
    border-radius: 4px;
}
.title-span.selected { border-color: #ffd42a; box-shadow: 0 0 0 1px #ffd42a; }
.label-dot-titles { color: #ff7ab8; font-size: 10px; }

/* ============================================================
   COLOR GRADE PANEL (Phase 1)
   ============================================================ */
.cg-panel {
    margin-top: 8px;
    padding: 10px;
    background: #1d1d22;
    border: 1px solid #2fb8a6;
    border-radius: 8px;
    display: none;
}
.cg-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    color: #7fe0d3;
    font-size: 12px;
    font-weight: 700;
}
.cg-mini-btn {
    background: #2a2a30;
    color: #ccc;
    border: 1px solid #3a3a42;
    border-radius: 5px;
    font-size: 11px;
    padding: 2px 8px;
    cursor: pointer;
}
.cg-presets {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-bottom: 10px;
}
.cg-preset-btn {
    background: #2a2a30;
    color: #ccc;
    border: 1px solid #3a3a42;
    border-radius: 6px;
    font-size: 10.5px;
    padding: 4px 8px;
    cursor: pointer;
}
.cg-preset-btn:hover { background: #35353d; }
.cg-preset-btn.active {
    background: #2fb8a6;
    border-color: #57d6c4;
    color: #fff;
}
.cg-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 7px;
}
.cg-label { font-size: 11px; color: #7fe0d3; min-width: 72px; }
.cg-val { font-size: 11px; color: #fff; min-width: 40px; text-align: right; }
.cg-row input[type="range"] { flex: 1; accent-color: #2fb8a6; }
.cg-footer {
    display: flex;
    gap: 6px;
    margin-top: 8px;
}
.cg-ba-btn {
    flex: 1;
    background: #2a2a30;
    color: #ccc;
    border: 1px solid #3a3a42;
    border-radius: 6px;
    font-size: 11px;
    padding: 6px;
    cursor: pointer;
    user-select: none;
}
.cg-ba-btn:active { background: #2fb8a6; color: #fff; }
.cg-reset-btn {
    background: #2a2a30;
    color: #ccc;
    border: 1px solid #3a3a42;
    border-radius: 6px;
    font-size: 11px;
    padding: 6px 10px;
    cursor: pointer;
}
.cg-reset-btn:hover { background: #35353d; }

/* ======================================================================
   NAYE TIMELINE LAYERS (Captions / Transitions / Crop and Zoom / Grade)
   ====================================================================== */
.track-layer { background: #191922; }
.track-captions { background: #1a1a24; }
.track-titles { background: #221a20; }
.track-transitions { background: #201a12; }
.track-pz { background: #141a22; }
.track-grade { background: #1a1620; }

.label-dot-captions { background: #e8a0ff; }
.label-dot-titles { background: #ff7ab8; }
.label-dot-transitions { background: #ffcc66; }
.label-dot-pz { background: #66d9ff; }
.label-dot-grade { background: #ff9a7a; }

/* span blocks — sab naye layers ka common block (segment-block jaisa) */
.layer-span {
    position: absolute;
    top: 3px;
    bottom: 3px;
    border-radius: 4px;
    cursor: grab;
    display: flex;
    align-items: center;
    padding: 0 6px;
    overflow: hidden;
    pointer-events: auto;
    border: 1px solid #666;
    background: #333;
}
.layer-span.selected { background: #d4b100 !important; border-color: #ffe066 !important; box-shadow: 0 0 0 1px #ffe066; }
.layer-span.selected .seg-label { color: #1b1b1d; }
.layer-span .seg-handle { position: absolute; top: 0; bottom: 0; width: 6px; cursor: ew-resize; pointer-events: auto; }
.layer-span .seg-handle-left { left: 0; }
.layer-span .seg-handle-right { right: 0; }

/* per-layer tints */
.layer-span.cap-span { background: #5a2d7a; border-color: #b06ee0; }
.layer-span.title-span { background: #7a2c4e; border-color: #ff7ab8; }
.layer-span.trans-span { background: #7a5a1f; border-color: #e0b25a; }
.layer-span.pz-span { background: #1f4a5a; border-color: #5ab0e0; }
.layer-span.grade-span { background: #6a3a2d; border-color: #e08a5a; }

.layer-spans { position: absolute; inset: 0; }

/* ===== SUBTITLES PANEL ===== */
.subtitles-panel {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
    margin-top: 6px;
    overflow: hidden;
    flex-shrink: 0;
}
.sub-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 7px 10px; cursor: pointer; user-select: none;
    font-weight: 700; font-size: 12px;
}
.sub-toggle { color: var(--text-dim); }
.sub-body { padding: 0 10px 8px; }
.sub-list {
    max-height: 180px; overflow-y: auto;
    background: #141416; border: 1px solid var(--border); border-radius: 4px;
    font-size: 11px; padding: 6px;
}
.sub-cue { padding: 3px 4px; border-bottom: 1px solid #232327; display: flex; gap: 8px; }
.sub-cue-time { color: #7ab7ff; font-variant-numeric: tabular-nums; white-space: nowrap; }
.sub-actions { display: flex; gap: 8px; margin-top: 8px; }
.sub-dl-btn {
    flex: 1; padding: 7px 10px; border-radius: 5px; border: 1px solid var(--border);
    background: #2c5a8f; color: #fff; font-weight: 700; cursor: pointer; font-size: 12px;
}
.sub-dl-btn:hover { background: #3a6fab; }
.sub-hint { font-size: 10px; color: var(--text-dim); margin-top: 6px; }

/* ===== SHORTS CANVAS PANEL (media-bin — captions/subtitles jaisi window) ===== */
.shorts-panel {
    border: 1px solid #2f7a4f; border-radius: 6px;
    background: var(--bg-panel); padding: 8px 10px; margin-top: 8px;
    position: relative; z-index: 40;
    flex-shrink: 0;
    max-height: 72%;
    overflow-y: auto;
    box-shadow: 0 4px 18px rgba(0,0,0,0.55);
}
/* Media-bin COLLAPSE ho to bhi shorts-panel dikhe — strip ke baghair float */
.left-column { position: relative; }
.left-column.bin-collapsed { overflow: visible; } /* floating panel clip na ho */
.left-column.bin-collapsed .shorts-panel {
    position: absolute;
    bottom: 6px;
    left: 46px;
    width: 230px;
    max-height: 80%;
    z-index: 80;
}
.shorts-header { display: flex; justify-content: space-between; align-items: center; font-weight: 700; margin-bottom: 6px; }
/* NUMERIC READOUT — size/position ke exact digits (hamesha visible) */
.sc-readout {
    background: #101014; border: 1px solid #2f7a4f; border-radius: 5px;
    padding: 6px 8px; margin-bottom: 8px;
}
.sc-ro-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.sc-ro-row + .sc-ro-row { margin-top: 4px; }
.sc-ro-label { font-size: 10px; color: var(--text-dim); white-space: nowrap; }
.sc-ro-edit { display: flex; align-items: center; gap: 3px; font-size: 11px; color: #7dffb8; font-family: Consolas, monospace; }
.sc-ro-edit input {
    width: 44px; background: #0a0a0c; border: 1px solid #2f7a4f; border-radius: 4px;
    color: #7dffb8; font-family: Consolas, monospace; font-size: 12px; font-weight: 700;
    padding: 2px 4px; text-align: center;
}
.sc-ro-edit input:focus { outline: none; border-color: #2fd07a; box-shadow: 0 0 0 1px #2fd07a; }
/* number-input spinners chhupo (chhoti fields) */
.sc-ro-edit input::-webkit-outer-spin-button,
.sc-ro-edit input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.sc-modes { display: flex; gap: 6px; margin-bottom: 6px; }
.sc-mode-btn {
    flex: 1; padding: 6px 8px; border-radius: 5px; border: 1px solid var(--border);
    background: #1c1c20; color: var(--text-dim); cursor: pointer; font-size: 11px; font-weight: 600;
}
.sc-mode-btn.active { background: #1f5a35; color: #fff; border-color: #2fd07a; }
.shorts-actions { display: flex; gap: 6px; }
.shorts-actions .trans-add-btn { flex: 1; }
.shorts-actions .pz-danger-btn { flex: 1; }

/* ===== TRANSITIONS PANEL ===== */
.trans-panel {
    border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg-panel); padding: 8px 10px; margin-top: 8px;
}
.trans-header { display: flex; justify-content: space-between; align-items: center; font-weight: 700; margin-bottom: 6px; }
.trans-select { flex: 1; background: #1c1c20; color: #fff; border: 1px solid var(--border); border-radius: 4px; padding: 3px 6px; font-size: 12px; }
.trans-hint { font-size: 10px; color: var(--text-dim); margin-top: 6px; }

/* ===== CROP AND ZOOM (PAN & ZOOM) PANEL ===== */
.pz-panel {
    border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg-panel); padding: 8px 10px; margin-top: 8px;
}
.pz-header { display: flex; justify-content: space-between; align-items: center; font-weight: 700; margin-bottom: 6px; }
.pz-modes { display: flex; gap: 6px; margin-bottom: 6px; }
.pz-mode-btn {
    flex: 1; padding: 5px 8px; border-radius: 5px; border: 1px solid var(--border);
    background: #1c1c20; color: var(--text-dim); cursor: pointer; font-size: 11px; font-weight: 600;
}
.pz-mode-btn.active { background: #1f4a5a; color: #fff; border-color: #5ab0e0; }
.pz-hint { font-size: 10px; color: var(--text-dim); margin-bottom: 6px; }
.pz-actions { display: flex; gap: 6px; }
.pz-danger-btn {
    flex: 1; padding: 6px; border-radius: 5px; border: 1px solid #7a2d2d;
    background: #5a1f1f; color: #ffb0b0; cursor: pointer; font-size: 11px; font-weight: 700;
}

/* ===== TRANSITIONS GALLERY (media-bin panel — animated type previews) ===== */
.trans-panel { border-color: #8a6a2f; }
.cg-target-label { font-weight: 400; font-size: 10px; color: var(--text-dim); }
.trans-type-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    margin-bottom: 8px;
}
.trans-type-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 6px 4px;
    border-radius: 6px;
    border: 1px solid #3a3a42;
    background: #1c1c20;
    color: #ccc;
    font-size: 10px;
    font-weight: 600;
    cursor: pointer;
}
.trans-type-btn:hover { background: #26262c; }
.trans-type-btn.active { background: #7a5a1f; border-color: #e0b25a; color: #fff; }

/* mini demo — dono clips ka fake crossfade loop */
.trans-demo {
    position: relative;
    width: 100%;
    max-width: 64px;
    height: 30px;
    border-radius: 4px;
    overflow: hidden;
    background: #30363f;
}
.trans-demo::before {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, #2fb8a6 0%, #1f6f8f 100%);
}
.trans-demo::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, #8f5a2f 0%, #b03a6a 100%);
    animation: demoCycle 2.4s infinite;
}
.demo-fadein::after { background: #000; animation-name: demoFadeIn; }
.demo-fadeout::after { background: #000; animation-name: demoFadeOut; }
.demo-crossfade::after { animation-name: demoCrossfade; }
.demo-slideleft::after { animation-name: demoSlideLeft; }
.demo-slideright::after { animation-name: demoSlideRight; }
.demo-zoomin::after { animation-name: demoZoomIn; }

@keyframes demoFadeIn     { 0%, 20% { opacity: 1; } 60%, 100% { opacity: 0; } }
@keyframes demoFadeOut    { 0%, 20% { opacity: 0; } 60%, 100% { opacity: 1; } }
@keyframes demoCrossfade  { 0%, 15% { opacity: 0; } 50% { opacity: 0.5; } 85%, 100% { opacity: 1; } }
@keyframes demoSlideLeft  { 0%, 20% { transform: translateX(100%); } 70%, 100% { transform: translateX(0); } }
@keyframes demoSlideRight { 0%, 20% { transform: translateX(-100%); } 70%, 100% { transform: translateX(0); } }
@keyframes demoZoomIn     { 0%, 20% { transform: scale(1); opacity: 1; } 70%, 100% { transform: scale(1.7); opacity: 0.85; } }

.trans-actions { display: flex; margin-top: 2px; }
.trans-add-btn {
    flex: 1;
    padding: 6px;
    border-radius: 5px;
    border: 1px solid #8a6a2f;
    background: #4a3a15;
    color: #ffd98a;
    font-weight: 700;
    font-size: 11px;
    cursor: pointer;
}
.trans-add-btn:hover { background: #5a4820; }
```

### Name: frontend/timeline.js
```js
const timelineScroll = document.getElementById("timelineScroll");
const timelineTrack = document.getElementById("timelineTrack");
const timelineLabels = document.getElementById("timelineLabels");
const scrubArea = document.getElementById("scrubArea");
const tracksArea = document.getElementById("tracksArea");
const playhead = document.getElementById("playhead");
const timeDisplay = document.getElementById("timeDisplay");
const zoomInBtn = document.getElementById("zoomIn");
const zoomOutBtn = document.getElementById("zoomOut");
const videoBlocksLayer = document.getElementById("videoBlocksLayer");
const segmentsLayer = document.getElementById("segmentsLayer");
const audioLayer = document.getElementById("audioLayer");
const rulerFramesEl = document.getElementById("rulerFrames");
const rulerSecondsEl = document.getElementById("rulerSeconds");
const playPauseBtnEl = document.getElementById("playPauseBtn");
const hScrollBarEl = document.getElementById("hScrollBar");
const hScrollThumbEl = document.getElementById("hScrollThumb");
// ===== NAYE LAYER ROWS (Captions / Transitions / CropZoom(PanZoom) / Grade) =====
const captionSpansLayer = document.getElementById("captionSpansLayer");
const transitionSpansLayer = document.getElementById("transitionSpansLayer");
const pzSpansLayer = document.getElementById("pzSpansLayer");
const gradeSpansLayer = document.getElementById("gradeSpansLayer");
const titlesSpansLayer = document.getElementById("titlesSpansLayer"); // TITLES layer row
// STACK-2 rows (Add-Stack ke baad dikhne lagti hain)
// STACK-2 REMOVED: Add-Stack UI hata di gayi — spotlight ab MULTI-SCREEN hai
// (spotlight.js, segment ke andar N screens). Ye legacy vars sirf purane saved
// data + undo/redo snapshots ka compatibility ke liye hain (UI rows nahi).
const stack2VideoBlocksLayer = null;
const stack2SegmentsLayer = null;
const stack2AudioLayer = null;

// ===== SOURCE vs TIMELINE (the core fix) =====
// sourceDuration : original uploaded file's real length (NEVER changes)
// timelineDuration: current editable timeline length (grows automatically, Filmora-style)
let sourceDuration = 0;
let timelineDuration = 0;
let timelineContentEnd = 0; // asal content ka end (playback yahin rukta hai — padding nahi)
let pixelsPerSecond = 100;
let isDraggingPlayhead = false;
let currentVideoRef = null;

let allThumbnails = [];   // filenames covering the whole sourceDuration
let waveformFile = null;  // waveform PNG covering the whole sourceDuration

// ===== 3 independent layers =====
// videoClips: {id, start, end, sourceStart, sourceEnd, muted, audioDetached, speed}
// audioLanes: {id, start, end, sourceStart, sourceEnd, muted, sourceClipId}
// segments  : {id, start, end, mode, modeBoxState, muted, audioDetached}  (crop layer, no source concept)
let videoClips = [];
let audioLanes = [];
let segments = [];

// ===== EFFECT-LAYERS (span-based, koi source concept nahi) =====
// captionSpans : {id, start, end, style, position:{x,y}, fontScale, overrides, remember}  — per-piece caption look
// transitions  : {id, start, end, type, duration, intensity}                              — no keyframing
// panZoomSpans : {id, start, end, mode:"static"|"in"|"out", zoom, box:{x,y,w,h}}           — 9:16 window ke andar box
// gradeSpans   : {id, start, end, grade:{...CG_DEFAULTS}}                                 — per-span color grade
let captionSpans = [];
let transitions = [];
let panZoomSpans = [];
let gradeSpans = [];
// TITLES LAYER (9:16 heading-spans — caption-cues text-source, manual text)
let titlesSpans = [];

// ===== MULTI-STACK (2-Stack Spotlight) =====
// Har timeline-item par OPTIONAL `stack` field hota hai (1 = base stack, 2 = doosri
// stack). Purani saves mein field nahi hoti — wahan stack=1 assume hota hai, isliye
// purana behavior 100% waise ka waisa rehta hai. Base stack (1) hamesha mainPlayer
// element use karta hai; stack-2 ka video ek SEPARATE hidden <video> element par
// chalta hai (same file ka doosra decoder, ek hi disk-copy). Stack-2 ki video
// stack-1 ki video ke NICHE layer hai: spotlight segment (mode=spotlight) neeche
// wali video ko circle ring ke andar ZOOM kar ke dikhata hai (zoom-bubble mode).
let stackCount = 1;
let baseVideoEl = null;      // mainPlayer — initTimeline par set hota hai
let stackAudioEls = {};      // stackN -> <audio> element (embedded-audio sync, playback hi ke liye)
let stackVideoEls = {};      // savedName -> <video> element (S2 MULTI-SOURCE: har file ka apna decoder)

let selectedItems = [];
let selectedSegmentId = null;
let selectedAudioId = null;
let dragState = null;
let marqueeState = null;

// ===== STACK-2 ARRAYS (2-Stack Spotlight) =====
// Base arrays (upar) stack-1 ke hain. Stack-2 ka apna poora 3-layer group hai —
// Video / Audio / Segment — bilkul same shape. Stack-1 ka spotlight segment
// stack-2 ki video ke upar zoom-ring dikhata hai (spotlight.js).
let stack2VideoClips = [];
let stack2AudioLanes = [];
let stack2Segments = [];

// ===== VIRTUAL PLAYBACK ENGINE =====
let isPlaying = false;
let virtualTime = 0;
let lastFrameTs = null;
let rafId = null;
let extraAudioEl = null; // plays detached audio lanes (separate from mainPlayer)

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatTimeMs(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function currentFps() {
    return (currentVideoRef && currentVideoRef.fps) ? currentVideoRef.fps : 25;
}

function genId() {
    return "id_" + Math.random().toString(36).slice(2, 10);
}

// ===== STACK HELPERS (multi-stack engine) =====
// Sab jagah seedhe videoClips/audioLanes/segments use karne ki jagah ye getters
// use karo — har stack ka apna independent group banta hai. stack=1 (default,
// purani data) => base arrays; stack>=2 => `stack2*` arrays.
function stackArrays(n) {
    if (n === 2) return { video: stack2VideoClips, audio: stack2AudioLanes, segment: stack2Segments };
    return { video: videoClips, audio: audioLanes, segment: segments };
}
function totalStacks() {
    return stackCount;
}
function ensureStackCount(n) {
    stackCount = Math.max(1, Math.min(2, n)); // abhi 2 stacks tak
    const body = document.body;
    if (body) body.classList.toggle("stack2-active", stackCount >= 2);
}
function getDefaultStack(item) {
    if (!item) return 1;
    return item.stack === 2 ? 2 : 1;
}
function getStackOf(kind, id) {
    if (getStackOf._cache && getStackOf._cache.kind === kind && getStackOf._cache.id === id) return getStackOf._cache.stack;
    for (let s = 1; s <= stackCount; s++) {
        const arrs = stackArrays(s);
        const arr = kind === "segment" ? arrs.segment : kind === "audio" ? arrs.audio : arrs.video;
        if (arr.some((it) => it.id === id)) {
            getStackOf._cache = { kind, id, stack: s };
            return s;
        }
    }
    return 1;
}
function getItemInStack(kind, id) {
    // FIX (BUG 5/6): EFFECT-KINDS (captionSpan/transition/panZoom/gradeSpan)
    // stacks ke bahar hain — pehle ye video-fallback me chale jate the ->
    // undefined -> move/resize SILENTLY fail (transition/grade length change
    // nahi hoti thi). Ab apne arrays se lookup.
    if (typeof isEffectKind === "function" && isEffectKind(kind)) {
        const arr = arrayOfEffectKind(kind) || [];
        return arr.find((x) => x.id === id) || null;
    }
    for (let s = 1; s <= stackCount; s++) {
        const arrs = stackArrays(s);
        const arr = kind === "segment" ? arrs.segment : kind === "audio" ? arrs.audio : arrs.video;
        const it = arr.find((x) => x.id === id);
        if (it) return it;
    }
    return null;
}
// Base video element — stack-2 ho to uska apna hidden <video> (sirf 1x, stack-2
// clips par speed abhi burn-in-only hai, warna do playback rates sync karna
// thread-expensive hota).
function getBaseVideoElement() {
    if (baseVideoEl) return baseVideoEl;
    if (typeof mainPlayer !== "undefined" && mainPlayer) return mainPlayer;
    return null;
}
function ensureStackVideoElement(n, savedName) {
    if (n < 2) return null;
    const key = savedName || (currentVideoRef && currentVideoRef.saved_name) || "_main";
    if (!stackVideoEls[key]) {
        const el = document.createElement("video");
        el.style.display = "none";
        el.preload = "auto";
        el.muted = true;
        el.src = `/video/${key}`;
        document.body.appendChild(el);
        stackVideoEls[key] = el;
    }
    return stackVideoEls[key];
}
function pauseAllStackVideoEls(exceptEl) {
    Object.values(stackVideoEls).forEach((el) => {
        if (el !== exceptEl && !el.paused) el.pause();
    });
}

function ensureStackAudioElement(n) {
    if (n < 2) return null;
    if (!stackAudioEls[n]) {
        const el = document.createElement("audio");
        el.style.display = "none";
        el.muted = true; // preview mein sirf base-stack ki audio sunai deti hai
        document.body.appendChild(el);
        stackAudioEls[n] = el;
    }
    return stackAudioEls[n];
}

// ===== SELECTION HELPERS =====

function isSelected(kind, id) {
    return selectedItems.some((s) => s.kind === kind && s.id === id);
}

function selectOnly(kind, id) {
    selectedItems = [{ kind, id }];
    syncSelectionMirrors();
}

function toggleSelectItem(kind, id) {
    const idx = selectedItems.findIndex((s) => s.kind === kind && s.id === id);
    if (idx >= 0) selectedItems.splice(idx, 1);
    else selectedItems.push({ kind, id });
    syncSelectionMirrors();
}

function clearSelection() {
    selectedItems = [];
    syncSelectionMirrors();
}

function selectedIdsOf(kind) {
    return selectedItems.filter((s) => s.kind === kind).map((s) => s.id);
}

function syncSelectionMirrors() {
    const segIds = selectedIdsOf("segment");
    const audIds = selectedIdsOf("audio");
    selectedSegmentId = segIds.length ? segIds[segIds.length - 1] : null;
    selectedAudioId = audIds.length ? audIds[audIds.length - 1] : null;
}

// crop_editor.js is the only external consumer of this function — kept same contract.
// NOTE: uses virtualTime (timeline position), NOT mainPlayer.currentTime (source position) —
// these are now two different things.
function getActiveSegment() {
    if (selectedSegmentId) {
        const seg = getSegmentById(selectedSegmentId);
        if (seg) return seg;
    }
    const t = virtualTime;
    return segments.find((s) => t >= s.start && t < s.end) || null;
}

function getVideoClipById(id) { return getItemInStack("video", id); }
function getSegmentById(id) { return getItemInStack("segment", id); }
function getAudioById(id) { return getItemInStack("audio", id); }

// Stack-2 ke apna render function (spotlight.js use karta hai)
function renderStack2() {
    if (typeof window.__renderStack2UI === "function") window.__renderStack2UI();
}

function getItemByKindId(kind, id) {
    if (kind === "segment") return getSegmentById(id);
    if (kind === "audio") return getAudioById(id);
    if (kind === "captionSpan") return captionSpans.find((x) => x.id === id) || null;
    if (kind === "transition") return transitions.find((x) => x.id === id) || null;
    if (kind === "panZoom") return panZoomSpans.find((x) => x.id === id) || null;
    if (kind === "gradeSpan") return gradeSpans.find((x) => x.id === id) || null;
    if (kind === "titleSpan") return titlesSpans.find((x) => x.id === id) || null;
    return getVideoClipById(id);
}

// Naye layers ke arrays kind se — drag/copy/split generic engine isi use karega
function arrayOfEffectKind(kind) {
    if (kind === "captionSpan") return captionSpans;
    if (kind === "transition") return transitions;
    if (kind === "panZoom") return panZoomSpans;
    if (kind === "gradeSpan") return gradeSpans;
    if (kind === "titleSpan") return titlesSpans;
    return null;
}
function isEffectKind(kind) { return !!arrayOfEffectKind(kind); }
function arrayOfKindTL(kind) {
    // STACK-AWARE: drag/marquee engine isi se item dhoondta hai. Selection ek
    // time par ek hi stack se aati hai (Add-Stack button doosri stack ki video
    // uthata hai; clipboard cross-stack paste kar deta hai — items us stack ke
    // array mein jate hain jahan paste button/shortcut use hua... asal mein
    // clipboard items apna stack carry karte hain, pasteClipboard dekho).
    if (kind === "segment") return segments;
    if (kind === "audio") return audioLanes;
    return videoClips;
}
function arrayOfKindInStack(kind, stack) {
    const arrs = stackArrays(stack);
    if (kind === "segment") return arrs.segment;
    if (kind === "audio") return arrs.audio;
    return arrs.video;
}

// Jab multi-select ke kisi item ko drag kiya jaye (bina Ctrl), poori selection
// (chahe alag-alag layers se ho — video+audio+segment sab) ek rigid group ke
// tor par saath move hoti hai. "primary" wo item hai jo asal mein grab hua tha —
// sirf uske kinaron par snap check hoti hai, baaki sab same delta se shift hote hain.
function buildMoveDragState(clientX, primaryKind, primaryId) {
    return {
        type: "move",
        startClientX: clientX,
        primaryKind, primaryId,
        items: selectedItems
            .map(({ kind, id }) => {
                const it = getItemByKindId(kind, id);
                return it ? { kind, id, origStart: it.start, origEnd: it.end } : null;
            })
            .filter(Boolean),
    };
}

function findActiveVideoClip(t, stack) {
    // last match in array = "on top" for overlaps (matches DOM stacking order)
    const arr = (stack === 2) ? stack2VideoClips : videoClips;
    let found = null;
    for (const c of arr) if (t >= c.start && t < c.end) found = c;
    return found;
}
function findActiveAudioLane(t, stack) {
    const arr = (stack === 2) ? stack2AudioLanes : audioLanes;
    let found = null;
    for (const a of arr) if (t >= a.start && t < a.end) found = a;
    return found;
}

// ===== VIDEO OVERLAP GUARD =====
// Video-layer par do clips kabhi overlap nahi honi chahiye: playback engine
// overlap par sirf top-most clip dikhata hai, jo "same part bar bar play"
// jaisa glitch ban jata hai (manually drag kar ke join karte waqt ye aksar
// hota tha). Ye helper overlaps khud resolve kar deta hai — later clip ko
// pichli clip ke end par push kar ke. Saved/broken projects bhi load par
// theek ho jate hain.
function resolveVideoClipOverlaps() {
    resolveVideoClipOverlapsIn(videoClips);
    resolveVideoClipOverlapsIn(stack2VideoClips); // dono stacks independent
}

function resolveVideoClipOverlapsIn(clipArr) {
    if (clipArr.length < 2) return;

    // active drag ke dauran dragged items exclude — warna doosri clips drag
    // ke waqt hi idhar-udhar dhakelne lagti hain; final resolve mouseup par hota hai
    let excludeIds = null;
    if (dragState) {
        if (dragState.type === "move") {
            excludeIds = new Set(dragState.items.filter((x) => x.kind === "video").map((x) => x.id));
        } else if ((dragState.type === "resize-left" || dragState.type === "resize-right") && dragState.kind === "video") {
            excludeIds = new Set([dragState.id]);
        }
    }
    const fixed = excludeIds && excludeIds.size ? clipArr.filter((c) => !excludeIds.has(c.id)) : clipArr;
    if (fixed.length < 2) return;

    const sorted = [...fixed].sort((a, b) => a.start - b.start || a.end - b.end);
    let prevEnd = -Infinity;
    for (const c of sorted) {
        if (c.start < prevEnd - 1e-6) {
            const dur = c.end - c.start;
            c.start = prevEnd;
            c.end = c.start + dur;
        }
        prevEnd = c.end;
    }
}

// ===== TIMELINE LENGTH vs PLAYBACK LIMIT (2 alag cheezein) =====
// 1) PLAYBACK LIMIT (timelineContentEnd): sirf VIDEO + AUDIO content jitna.
//    Crop-segments playback limit nahi badhate — warna koi segment door right
//    par drag ho to playhead khali/black area mein chala jata tha. Video aur
//    audio jahan khatam, playback wahin khatam.
// 2) TIMELINE LENGTH (timelineDuration): SAB layers (segments included) + 15s
//    extra room — taake video/audio/crop-segment ko aage-peeche drag karne ke
//    liye timeline hamesha lambi bani rahe.
function recalcTimelineDuration() {
    resolveVideoClipOverlaps();
    // EFFECT-LAYERS: timeline lamba karte hain (playback limit NAHI badhate)

    let playEnd = 0;
    videoClips.forEach((c) => { playEnd = Math.max(playEnd, c.end); });
    audioLanes.forEach((a) => { playEnd = Math.max(playEnd, a.end); });
    // STACK-2: doosri stack ka content bhi timeline lamba karta hai aur playback
    // limit badhata hai (spotlight usi video par hota hai — content ke baghair
    // stack-2 khali hai hi)
    stack2VideoClips.forEach((c) => { playEnd = Math.max(playEnd, c.end); });
    stack2AudioLanes.forEach((a) => { playEnd = Math.max(playEnd, a.end); });
    timelineContentEnd = playEnd; // playback YAHIN rukega (video/audio end)

    let farthest = playEnd;
    segments.forEach((s) => { farthest = Math.max(farthest, s.end); });
    stack2Segments.forEach((s) => { farthest = Math.max(farthest, s.end); });
    // NAYE LAYERS: timeline-length mein count (playback-limit nahi)
    captionSpans.forEach((s) => { farthest = Math.max(farthest, s.end); });
    transitions.forEach((s) => { farthest = Math.max(farthest, s.end); });
    panZoomSpans.forEach((s) => { farthest = Math.max(farthest, s.end); });
    gradeSpans.forEach((s) => { farthest = Math.max(farthest, s.end); }); // FIX: ye line 01-Oct wale add me reh gayi thi
    gradeSpans.forEach((s) => { farthest = Math.max(farthest, s.end); });
    timelineDuration = farthest + 15; // extra room to drop/drag clips further right
    timelineTrack.style.width = `${timelineDuration * pixelsPerSecond}px`;
    updateCustomHScrollbar();
}

// ===== CUSTOM HORIZONTAL SCROLLBAR (native overlay-bars par bharosa nahi) =====
// WebView2 ki native scrollbar kabhi-kabhi render hi nahi hoti — isliye apna
// bar hai jo HAMESHA dikhta hai. Thumb ka size/position scroll-content ke
// mutabiq sync rehta hai; click + drag dono se scroll hota hai.
function updateCustomHScrollbar() {
    if (!hScrollBarEl || !hScrollThumbEl) return;
    const scrollW = timelineScroll.scrollWidth;
    const clientW = timelineScroll.clientWidth;
    const barW = hScrollBarEl.clientWidth;
    if (!scrollW || !clientW || !barW) return;

    const overflow = scrollW - clientW;
    if (overflow <= 2) {
        // koi overflow nahi — poori width ka thumb (bar phir bhi visible)
        hScrollThumbEl.style.width = `${barW - 4}px`;
        hScrollThumbEl.style.left = "2px";
        return;
    }

    const thumbW = Math.max(36, (clientW / scrollW) * barW);
    const maxScroll = overflow;
    const maxThumb = barW - thumbW - 4;
    const frac = Math.min(1, timelineScroll.scrollLeft / maxScroll);

    hScrollThumbEl.style.width = `${thumbW}px`;
    hScrollThumbEl.style.left = `${2 + frac * maxThumb}px`;
}

let hScrollDrag = null; // { startX, startScrollLeft }

if (hScrollBarEl && hScrollThumbEl) {
    hScrollThumbEl.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        hScrollDrag = {
            startX: e.clientX,
            startScrollLeft: timelineScroll.scrollLeft,
        };
        hScrollThumbEl.classList.add("dragging");
    });

    hScrollBarEl.addEventListener("mousedown", (e) => {
        // track par click (thumb ke ilawa) -> us position par jump
        if (e.target === hScrollThumbEl) return;
        const rect = hScrollBarEl.getBoundingClientRect();
        const frac = (e.clientX - rect.left) / rect.width;
        timelineScroll.scrollLeft = frac * (timelineScroll.scrollWidth - timelineScroll.clientWidth);
        updateCustomHScrollbar();
    });

    document.addEventListener("mousemove", (e) => {
        if (!hScrollDrag) return;
        const dx = e.clientX - hScrollDrag.startX;
        const thumbW = hScrollThumbEl.offsetWidth;
        const barW = hScrollBarEl.clientWidth;
        const scrollable = timelineScroll.scrollWidth - timelineScroll.clientWidth;
        const thumbTrack = Math.max(1, barW - thumbW - 4);
        timelineScroll.scrollLeft = hScrollDrag.startScrollLeft + (dx / thumbTrack) * scrollable;
        updateCustomHScrollbar();
    });

    document.addEventListener("mouseup", () => {
        if (hScrollDrag) {
            hScrollDrag = null;
            hScrollThumbEl.classList.remove("dragging");
        }
    });

    window.addEventListener("resize", updateCustomHScrollbar);
}

// ===== RULERS (frame-numbers row + seconds row) =====

function niceSecondsStep(pxPerSec) {
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900];
    for (const s of steps) {
        if (s * pxPerSec >= 55) return s;
    }
    return steps[steps.length - 1];
}

function renderSecondsRuler() {
    rulerSecondsEl.innerHTML = "";
    const width = timelineDuration * pixelsPerSecond;
    rulerSecondsEl.style.width = `${width}px`;
    if (!timelineDuration) return;

    const step = niceSecondsStep(pixelsPerSecond);
    for (let t = 0; t <= timelineDuration + 0.0001; t += step) {
        const tick = document.createElement("div");
        tick.className = "ruler-tick";
        tick.style.left = `${t * pixelsPerSecond}px`;
        const label = step < 1 ? formatTimeMs(t) : formatTime(t);
        tick.innerHTML = `<span class="tick-label">${label}</span>`;
        rulerSecondsEl.appendChild(tick);
    }
}

function renderFramesRuler() {
    rulerFramesEl.innerHTML = "";
    const width = timelineDuration * pixelsPerSecond;
    rulerFramesEl.style.width = `${width}px`;

    const fps = currentFps();
    const framePx = pixelsPerSecond / fps;

    let step = null;
    if (framePx >= 18) step = 1;
    else if (framePx >= 9) step = 5;
    else if (framePx >= 4) step = 10;

    if (!step || !timelineDuration) {
        rulerFramesEl.classList.add("hidden-ruler");
        return;
    }
    rulerFramesEl.classList.remove("hidden-ruler");

    const totalFrames = Math.ceil(timelineDuration * fps);
    for (let f = 0; f <= totalFrames; f += step) {
        const t = f / fps;
        if (t > timelineDuration) break;
        const tick = document.createElement("div");
        tick.className = "frame-tick";
        tick.style.left = `${t * pixelsPerSecond}px`;
        tick.innerHTML = `<span class="frame-label">${f}</span>`;
        rulerFramesEl.appendChild(tick);
    }
}

function renderRulers() {
    renderSecondsRuler();
    renderFramesRuler();
}

// ===== RESIZABLE TRACK HEIGHTS =====

const trackHeights = {
    trackVideo: 62, trackAudioCombined: 72, segmentsLayer: 36,
    trackCaptionLayer: 36, trackTitlesLayer: 36,
    trackTransitionsLayer: 36, trackPzLayer: 36, trackGradeLayer: 36,
};

function applyTrackHeight(key) {
    const trackEl = document.getElementById(key);
    const labelEl = document.querySelector(`.label-row[data-for="${key}"]`);
    if (trackEl) trackEl.style.height = `${trackHeights[key]}px`;
    if (labelEl) labelEl.style.height = `${trackHeights[key]}px`;
}

Object.keys(trackHeights).forEach(applyTrackHeight);

// ===== ADD-STACK BUTTON (2-Stack Spotlight) =====
// Stack-2 rows enable/disable karta hai. Video stack-2 mein 3 tareeqon se aati
// hai: (1) media-bin item ko stack-2 video row par DRAG-DROP, (2) stack-1 clip
// select kar ke '⧉ Stack 2' button (duplicate), (3) clipboard paste.
// (Add-Stack feature REMOVED — spotlight ab multi-screen engine hai)

function updateStackLabels() {
    document.body.classList.toggle("stack2-active", stackCount >= 2);
    // Spotlight button sirf tab useful hai jab stack-2 ho
    const spotBtn = document.getElementById("stack2SpotBtn");
    if (spotBtn) spotBtn.style.display = stackCount >= 2 ? "" : "none";
}

// ===== S2 DRAG-DROP (media bin -> Video S2 row = ALAG file stack-2 mein) =====
// Media-bin item ka saved_name "application/x-reframe-video" format mein aata
// hai (app.js dragstart). Drop par S2 video-clip ban jata hai jo us FILE se
// chalta hai — MULTI-SOURCE: preview mein us file ka apna hidden <video>
// element (ensureStackVideoElement savedName-map), export mein us file ka apna
// decoder + audio-input. Bubble isi file ke frames se banta hai.
function setupS2DragDrop() {
    // S2 rows UI se hat gayi — drag-drop na hi kare to koi dikkat nahi
    if (!stack2VideoBlocksLayer) return;
    const row = stack2VideoBlocksLayer;
    row.addEventListener("dragover", (e) => {
        if (!e.dataTransfer.types.includes("application/x-reframe-video")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        row.classList.add("drop-hover");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-hover"));
    row.addEventListener("drop", (e) => {
        row.classList.remove("drop-hover");
        const savedName = e.dataTransfer.getData("application/x-reframe-video");
        if (!savedName) return;
        e.preventDefault();
        e.stopPropagation();
        const meta = (typeof uploadedVideos !== "undefined") ? uploadedVideos.find((v) => v.saved_name === savedName) : null;
        const dur = (meta && meta.duration) ? meta.duration : 10;
        if (typeof pushHistory === "function") pushHistory();
        const x = timeFromClientX(e.clientX);
        const start = Math.max(0, x - 2);
        stack2VideoClips.push({
            id: genId(), start, end: start + dur,
            sourceStart: 0, sourceEnd: dur,
            muted: true, stack: 2, savedName,
        });
        if (stackCount < 2) { ensureStackCount(2); updateStackLabels(); }
        recalcTimelineDuration();
        renderAll();
        persistTimelineState();
    });
}
setupS2DragDrop();

document.querySelectorAll(".track-resize-handle").forEach((handle) => {
    handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const key = handle.dataset.target;
        const startY = e.clientY;
        const startH = trackHeights[key];
        handle.classList.add("active");

        function onMove(ev) {
            const dy = ev.clientY - startY;
            const newH = Math.max(MIN_TRACK_H, Math.min(MAX_TRACK_H, startH + dy));
            trackHeights[key] = newH;
            applyTrackHeight(key);
        }
        function onUp() {
            handle.classList.remove("active");
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        }
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    });
});

timelineScroll.addEventListener("scroll", () => {
    timelineLabels.scrollTop = timelineScroll.scrollTop;
    updateCustomHScrollbar(); // thumb position live sync
});

// ===== MOUSE WHEEL over timeline =====
// FIX: wheel ab HORIZONTAL scroll karta hai (timeline lambi hoti hai, vertical
// scroll ka koi faida nahi jab tak layer heights badli na hon). Agar layers
// itni bari hain ke vertical overflow hai to wheel pehle jaisa vertical hi
// rahega. Ctrl+wheel = zoom in/out (Photo-shop/Filmora style).
timelineScroll.addEventListener("wheel", (e) => {
    if (e.ctrlKey) {
        e.preventDefault();
        pixelsPerSecond = Math.min(500, Math.max(20, pixelsPerSecond + (e.deltaY < 0 ? 40 : -40)));
        rezoomTimeline();
        return;
    }
    const canScrollVertically = timelineScroll.scrollHeight > timelineScroll.clientHeight + 2;
    if (canScrollVertically) return; // default (vertical) behavior rehne do
    if (e.deltaY !== 0) {
        e.preventDefault();
        timelineScroll.scrollLeft += e.deltaY;
    }
}, { passive: false });

// ===== VIRTUAL PLAYBACK ENGINE =====
// mainPlayer plays the raw uploaded file. The canvas (crop_editor.js) is what the
// user actually sees, so we control what's drawn based on which clip (if any) is
// "active" at the current virtual timeline position. This is what makes
// move/delete actually affect what plays — before, mainPlayer just played the raw
// file start-to-end regardless of the videoClips/audioLanes arrays.
//
// CLOCK RULE (core glitch fix): virtualTime hi MASTER clock hai (rAF se chalta
// hai). Video element sirf SLAVE hai — hum uski currentTime SET karte hain,
// uski apni clock se virtualTime KABHI nahi chalate. Pehle sirf 0.25s+ drift
// par re-sync hoti thi, isliye clip-boundary par seek-hiccup video ko purani
// source-position par chhodi rehta tha aur playhead aage badhte hue bhi WOHI
// PART bar bar play hota dikhta tha. Ab: (1) clip change par HAMESHA hard-seek,
// (2) same-clip drift 0.35s se bara ho to re-seek, (3) seek ke dauran canvas
// par purana frame nahi dikhta (black frame = clean cut).

const SEEK_RESYNC_THRESHOLD = 0.35; // sec
let videoSeekGuard = 0;        // >0 => seek in-progress, canvas blank frame dikhata hai
let lastAppliedClipKey = null; // kaunsi clip ki last frame apply hui thi
let lastAppliedLaneKey = null;

function ensurePlayerSeekGuard() {
    if (!mainPlayer || ensurePlayerSeekGuard.done) return;
    ensurePlayerSeekGuard.done = true;
    // CRITICAL: guard ab sirf 4 frames (~66ms) — stale-frame glitch sirf 1-2
    // frames hota hai, 30 frames (0.5s) ka blank har boundary par flicker ban
    // jata tha. Aur 'seeked' ke sath canplay/playing par bhi clear — WebView2
    // mein rapid seeks par 'seeked' kabhi kabhi MISS hota hai (yehi guard ko
    // hamesha ke liye phansa deta tha → dono canvas blank). Triple fail-safe.
    mainPlayer.addEventListener("seeking", () => {
        if (isPlaying) videoSeekGuard = 4;
    });
    mainPlayer.addEventListener("seeked", () => { videoSeekGuard = 0; });
    mainPlayer.addEventListener("canplay", () => { videoSeekGuard = 0; });
    mainPlayer.addEventListener("playing", () => { videoSeekGuard = 0; });
}

function applyVirtualTime(t, playing) {
    ensurePlayerSeekGuard();

    // ---- video ----
    const vc = findActiveVideoClip(t);
    window.__activeVideoClipForCanvas = vc || null;

    if (vc && mainPlayer) {
        const speed = vc.speed === undefined ? 1 : vc.speed;
        const srcT = vc.sourceStart + (t - vc.start) * speed;   // speed-aware mapping
        const clampedSrcT = Math.max(0, Math.min(srcT, sourceDuration));

        mainPlayer.muted = !!vc.muted || !!vc.audioDetached;
        if (mainPlayer.playbackRate !== speed) mainPlayer.playbackRate = speed; // native audio bhi sahi speed par

        if (vc.id !== lastAppliedClipKey) {
            // clip boundary (naya clip, ya gap ke baad wahi clip) — HAMESHA
            // hard-seek: warna video purani clip ki source-position par chalti
            // rehti hai aur boundary par glitch/repeat hota hai
            if (playing) videoSeekGuard = 4;
            mainPlayer.currentTime = clampedSrcT;
            lastAppliedClipKey = vc.id;
        } else if (!playing || Math.abs(mainPlayer.currentTime - clampedSrcT) > SEEK_RESYNC_THRESHOLD) {
            // paused/scrub, ya bara drift (decode hiccup) — real seek theek hai.
            // PLAYBACK ke dauran chhota drift (< 0.35s) intentionally RIDE karo:
            // WebView2 mein playback ke dauran repeated seeks 'seeking' state
            // mein phans jate hain (freeze/blank) — aur chhota drift har haal
            // invisible hai kyunki audio+video ek hi element mein hain (hamesha
            // synced). Boundary par waise bhi hard-seek ho jata hai.
            if (playing) videoSeekGuard = 4;
            mainPlayer.currentTime = clampedSrcT;
        }
        if (playing) {
            if (mainPlayer.paused) mainPlayer.play().catch(() => {});
        } else if (!mainPlayer.paused) {
            mainPlayer.pause();
        }
        window.__activeSourceTime = clampedSrcT; // captions.js isi source-time se sahi word/cue dhoondta hai
    } else if (mainPlayer) {
        lastAppliedClipKey = null;
        mainPlayer.muted = true;
        if (!mainPlayer.paused) mainPlayer.pause();
        window.__activeSourceTime = null; // gap/deleted region — koi caption bhi na dikhe
    }

    // ---- SPOTLIGHT SOURCE video (multi-screen) ----
    // Stack-2 rows UI se hata chuke hain — S2 video ab sirf SPOTLIGHT ki
    // source hai: jab koi segment ka spotlight mode on ho, S2 clip chalti hai
    // (auto full-length duplicate) aur spotlight.js uske frames se screens
    // banata hai. MULTI-SOURCE: har S2 clip apni file ka <video> element use
    // karti hai (clip.savedName; na ho to currentVideoRef ki file).
    const spotWantsS2 = (typeof spotlightNeedsSource === "function") ? spotlightNeedsSource() : (stackCount >= 2);
    const vc2 = spotWantsS2 ? findActiveVideoClip(t, 2) : null;
    if (spotWantsS2 && vc2) {
        const s2el = ensureStackVideoElement(2, vc2.savedName);
        if (s2el) {
            s2el.muted = true; // preview mein stack-2 audio nahi (S2 audio-lane mute by design)
            const srcT2 = Math.max(0, Math.min(vc2.sourceStart + (t - vc2.start) * (vc2.speed || 1), sourceDuration));
            if (s2el.__lastClipKey !== vc2.id || !playing) {
                // boundary change ya paused-scrub -> EXACT seek (paused seek sasta hai)
                s2el.currentTime = srcT2;
                s2el.__lastClipKey = vc2.id;
            } else if (Math.abs(s2el.currentTime - srcT2) > SEEK_RESYNC_THRESHOLD * 2) {
                s2el.currentTime = srcT2; // playback mein bara drift hi theek karo, chhota ride
            }
            if (playing) {
                if (s2el.paused) s2el.play().catch(() => {});
            } else if (!s2el.paused) {
                s2el.pause();
            }
            window.__stack2VideoEl = s2el;
            pauseAllStackVideoEls(s2el); // baaki files ke elements so jayen
        }
    } else {
        pauseAllStackVideoEls(null);
        if (!spotWantsS2) window.__stack2VideoEl = null;
    }

    // stack-2 detached audio lanes (preview mein muted — export mein mix hongi)
    if (stackCount >= 2) {
        const al2 = findActiveAudioLane(t, 2);
        if (al2) {
            const a2el = ensureStackAudioElement(2);
            if (a2el) {
                const srcT2 = Math.max(0, Math.min(al2.sourceStart + (t - al2.start), sourceDuration));
                if (a2el.__lastLaneKey !== al2.id || Math.abs(a2el.currentTime - srcT2) > SEEK_RESYNC_THRESHOLD) {
                    a2el.currentTime = srcT2;
                    a2el.__lastLaneKey = al2.id;
                }
                a2el.muted = true;
                if (playing) {
                    if (a2el.paused) a2el.play().catch(() => {});
                } else if (!a2el.paused) a2el.pause();
            }
        } else {
            const a2el = stackAudioEls[2];
            if (a2el && !a2el.paused) a2el.pause();
        }
    }

    // ---- detached audio lanes ----
    const al = findActiveAudioLane(t, 1);
    if (al && extraAudioEl) {
        const srcT = Math.max(0, Math.min(al.sourceStart + (t - al.start), sourceDuration));
        extraAudioEl.muted = !!al.muted;
        if (al.id !== lastAppliedLaneKey) {
            extraAudioEl.currentTime = srcT; // lane boundary — hard seek
            lastAppliedLaneKey = al.id;
        } else if (!playing || Math.abs(extraAudioEl.currentTime - srcT) > SEEK_RESYNC_THRESHOLD) {
            extraAudioEl.currentTime = srcT;
        }
        if (playing) {
            if (extraAudioEl.paused) extraAudioEl.play().catch(() => {});
        } else if (!extraAudioEl.paused) {
            extraAudioEl.pause();
        }
    } else {
        lastAppliedLaneKey = null;
        if (extraAudioEl && !extraAudioEl.paused) extraAudioEl.pause();
    }
}

function playbackTick(ts) {
    if (!isPlaying) return;
    if (lastFrameTs == null) lastFrameTs = ts;
    const dt = (ts - lastFrameTs) / 1000;
    lastFrameTs = ts;

    virtualTime += dt;
    // CRITICAL FIX: seek-guard ka DECAY — pehle guard sirf 'seeked' event par
    // clear hota tha, lekin rapid boundary seeks (speed != 1x) par 'seeked'
    // kabhi-kabhi fire NAHI hota aur guard HAMESHA ke liye phans jata tha —
    // dono canvas blank ho kar reh jate the (playhead chalta rehta hai).
    // Ab har frame par decay: worst case ~0.5s blank, phir guaranteed clear.
    if (videoSeekGuard > 0) videoSeekGuard--;

    // FIX (BUG 7 family): timelineContentEnd kabhi NaN ho gaya (load edge-case)
    // to playback khud ko hi freeze kar leta tha — self-heal recompute.
    if (!(typeof timelineContentEnd === "number" && isFinite(timelineContentEnd))) {
        recalcTimelineDuration();
    }

    // FIX: playback sirf VIDEO+AUDIO content tak (segments/crop playhead ko aage
    // nahi kheenchte) — uske baad khali timeline hai, wahan sirf drag/drop hota hai
    if (virtualTime >= timelineContentEnd) {
        virtualTime = timelineContentEnd;
        pausePlayback();
        if (playPauseBtnEl) playPauseBtnEl.textContent = "▶";
        updatePlayheadPosition(virtualTime);
        return;
    }

    // FIX (BUG 7): playback-loop DEATH-PROOF — applyVirtualTime/updatePlayhead
    // me koi bhi throw ho to bhi loop chalta rahe (pehle ek throw = rAF kabhi
    // re-queue nahi hota tha = playhead + video HAMESHA ke liye freeze). Error
    // log hota hai, agla frame try karta hai.
    try {
        applyVirtualTime(virtualTime, true);
        updatePlayheadPosition(virtualTime);
    } catch (err) {
        console.warn("playbackTick step failed (loop continues):", err);
    }
    rafId = requestAnimationFrame(playbackTick);
}

function startPlayback() {
    if (isPlaying) return;
    isPlaying = true;
    lastFrameTs = null;
    // end par play dabaya to start se dobara chalao (Filmora-style)
    if (timelineContentEnd > 0 && virtualTime >= timelineContentEnd - 0.01) {
        virtualTime = 0;
        updatePlayheadPosition(virtualTime);
    }
    // fresh sync: pehle sahi source-position par seek karo, phir clock chalao
    lastAppliedClipKey = null;
    lastAppliedLaneKey = null;
    // stack-2 elements bhi fresh-sync (sab ke __lastClipKey reset)
    Object.values(stackVideoEls).forEach((el) => { el.__lastClipKey = null; });
    const s2a = stackAudioEls[2];
    if (s2a) s2a.__lastLaneKey = null;
    applyVirtualTime(virtualTime, false);
    rafId = requestAnimationFrame(playbackTick);
}

function pausePlayback() {
    isPlaying = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    videoSeekGuard = 0; // playback ruka to blank-guard bhi foran clear (paused seek guard set hi nahi karta)
    if (mainPlayer && !mainPlayer.paused) mainPlayer.pause();
    if (extraAudioEl && !extraAudioEl.paused) extraAudioEl.pause();
    // stack-2 elements bhi rok do (sab files ke)
    pauseAllStackVideoEls(null);
    const s2a = stackAudioEls[2];
    if (s2a && !s2a.paused) s2a.pause();
}

function seekVirtual(t) {
    // FIX: playhead sirf video/audio content ke andar hi move hota hai —
    // content ke aage ki khali timeline (jo drag/drop ke liye hai) par
    // playhead nahi jata, wahan kuch play hone ko hai hi nahi
    // HARDENING (BUG 3): timelineContentEnd NaN/undefined ho to limit=0 ->
    // playhead HAMESHA 0 par clamp (frozen) — ab NaN-guard; aur t bhi NaN ho
    // to 0. capLoadPlayheadSpanToGlobals throw kare to seek mar na jaye
    // (try/catch) — warna shortkey-handler/tick break ho jata tha.
    const limit = (typeof timelineContentEnd === "number" && isFinite(timelineContentEnd) && timelineContentEnd > 0) ? timelineContentEnd : 0;
    const tt = (typeof t === "number" && isFinite(t)) ? t : 0;
    virtualTime = Math.max(0, Math.min(tt, limit));
    // BUG 3/7 guard: applyVirtualTime throw kare to playhead-position update
    // phir bhi ho (warna playhead frozen dikhta tha)
    try { applyVirtualTime(virtualTime, false); } catch (err) { console.warn("applyVirtualTime (seek) failed:", err); }
    updatePlayheadPosition(virtualTime);
    // CAPTIONS LAYER: playhead naye span mein enter hua to panel us span ki
    // values dikhaye (playhead-piece editing — user choice)
    try { if (typeof capLoadPlayheadSpanToGlobals === "function") capLoadPlayheadSpanToGlobals(); } catch (err) { console.warn("capLoadPlayheadSpanToGlobals failed:", err); }
}

// kept for backward compatibility (app.js jump-to-time calls this)
function seekToTime(t) {
    seekVirtual(t);
}

// ===== TIMELINE INIT =====

function migrateClip(c) {
    if (c.sourceStart === undefined) c.sourceStart = c.start;
    if (c.sourceEnd === undefined) c.sourceEnd = c.end;
    if (c.speed === undefined) c.speed = 1;   // NAYA: purani saved clips ke liye default 1x
    return c;
}
function migrateAudio(a) {
    if (a.sourceStart === undefined) a.sourceStart = a.start;
    if (a.sourceEnd === undefined) a.sourceEnd = a.end;
    return a;
}

async function initTimeline(video) {
    pausePlayback();
    ensurePlayerSeekGuard();
    currentVideoRef = video;
    baseVideoEl = mainPlayer || null;
    const res = await fetch(`/video/${video.saved_name}/timeline_assets`);
    const data = await res.json();

    sourceDuration = data.duration;
    allThumbnails = data.thumbnails || [];
    waveformFile = data.waveform || null;

    const stateRes = await fetch(`/video/${video.saved_name}/segments`);
    const stateData = await stateRes.json();
    segments = stateData.segments || [];
    audioLanes = (stateData.audioLanes || []).map(migrateAudio);
    // NAYE LAYERS restore (purane saves mein nahi hongi — khali arrays)
    captionSpans = stateData.captionSpans || [];
    transitions = stateData.transitions || [];
    panZoomSpans = stateData.panZoomSpans || [];
    gradeSpans = stateData.gradeSpans || [];
    titlesSpans = stateData.titlesSpans || [];
    if (typeof migrateEffectLayers === "function") migrateEffectLayers(stateData);
    videoClips = (stateData.videoClips && stateData.videoClips.length)
        ? stateData.videoClips.map(migrateClip)
        : [{ id: genId(), start: 0, end: sourceDuration, sourceStart: 0, sourceEnd: sourceDuration, muted: false, audioDetached: false, speed: 1 }];

    // STACK-2 restore — purane saves mein S2 data ho sakta hai (legacy).
    // Multi-screen redesign ke baad S2 sirf SPOTLIGHT ka source hai; rows UI
    // mein nahi hain, magar data-compatible rehna zaroori hai (undo/redo + save).
    stack2VideoClips = ((stateData.stack2VideoClips || []).map(migrateClip));
    stack2AudioLanes = ((stateData.stack2AudioLanes || []).map(migrateAudio));
    stack2Segments = stateData.stack2Segments || [];
    ensureStackCount(stateData.stackCount === 2 || stack2VideoClips.length || stack2Segments.length || stack2AudioLanes.length ? 2 : 1);
    if (stackCount >= 2) ensureStackVideoElement(2);
    updateStackLabels();

    // COLOR GRADE restore
    if (typeof colorGrade !== "undefined" && stateData.colorGrade) {
        Object.keys(colorGrade).forEach((k) => {
            if (stateData.colorGrade[k] !== undefined && stateData.colorGrade[k] !== null) {
                colorGrade[k] = stateData.colorGrade[k];
            }
        });
        if (typeof cgSyncUI === "function") cgSyncUI();
    }

    if (!extraAudioEl) {
        extraAudioEl = document.createElement("audio");
        extraAudioEl.style.display = "none";
        document.body.appendChild(extraAudioEl);
    }
    extraAudioEl.src = `/video/${video.saved_name}`;

    // captions.js ke globals (agar file loaded hai) — per-video state restore
    if (typeof captionCues !== "undefined") {
        captionCues = stateData.captionCues || [];
        currentCaptionStyle = stateData.captionStyle || currentCaptionStyle || "hormozi";
        captionsEnabled = stateData.captionsEnabled !== false;
        captionPosition = stateData.captionPosition || { x: 0.5, y: 0.86 };
        captionFontScale = stateData.captionFontScale || 1.0;
        // NAYA: color-overrides + remember-checkbox restore
        if (stateData.captionOverrides) captionOverrides = stateData.captionOverrides;
        if (stateData.captionRemember !== undefined) captionRemember = stateData.captionRemember;
        if (typeof refreshCaptionsUI === "function") refreshCaptionsUI();
    }

        // SHORTS CANVAS settings restore
        if (stateData.shortsCanvas) { try { if (typeof scLoadFromState === "function") scLoadFromState(stateData.shortsCanvas); } catch (e) {} }
        else { try { if (typeof scLoadFromState === "function") scLoadFromState({ enabled: false }); } catch (e) {} }
        clearSelection();
    if (typeof clearHistory === "function") clearHistory();

    recalcTimelineDuration();
    renderAll();
    virtualTime = 0;
    seekVirtual(0);
}

let __persistTimer = null;
async function persistTimelineState() {
    if (!currentVideoRef) return;
    const payload = {
        segments, audioLanes, videoClips,
        // STACK-2 state bhi save
        stack2VideoClips, stack2AudioLanes, stack2Segments, stackCount,
        // COLOR GRADE (global) — color_grade.js module se
        colorGrade: (typeof colorGrade !== "undefined") ? JSON.parse(JSON.stringify(colorGrade)) : null,
        // NAYE EFFECT-LAYERS
        captionSpans, transitions, panZoomSpans, gradeSpans,
        // TITLES LAYER (9:16 heading-spans)
        titlesSpans,
        // SHORTS CANVAS settings (null = OFF)
        shortsCanvas: (typeof scPersistPayload === "function") ? scPersistPayload() : null,
    };
    if (typeof captionCues !== "undefined") {
        payload.captionCues = captionCues;
        payload.captionStyle = currentCaptionStyle;
        payload.captionsEnabled = captionsEnabled;
        payload.captionPosition = captionPosition;
        payload.captionFontScale = captionFontScale;
        // NAYA: color-overrides + remember-checkbox bhi save
        payload.captionOverrides = (typeof captionOverrides !== "undefined") ? captionOverrides : null;
        payload.captionRemember = (typeof captionRemember !== "undefined") ? captionRemember : true;
    }
    // (HANG FIX) DEBOUNCE: pehle HAR input-event par ek full-timeline POST ja
    // raha tha (grade/trans sliders ~30-60 events/sec, captionCues ke sath poora
    // JSON) — backend flood ho kar UI freeze/lamba run crash karta tha. Ab 350ms
    // ke andar ke sab events EK hi POST mein coalesce hote hain (trailing).
    if (__persistTimer) clearTimeout(__persistTimer);
    __persistTimer = setTimeout(() => {
        __persistTimer = null;
        try {
            fetch(`/video/${currentVideoRef.saved_name}/segments`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            }).catch(() => {});
        } catch (err) { /* network fail — silent */ }
    }, 350);
}

function updatePlayheadPosition(t) {
    const x = t * pixelsPerSecond;
    playhead.style.left = `${x}px`;

    const fps = currentFps();
    const curF = Math.floor(t * fps);
    // FIX: total duration ab content-end hai (pehle +15s padding count hoti thi)
    const totF = Math.floor(timelineContentEnd * fps);
    timeDisplay.textContent = `${formatTime(t)} (f${curF}) / ${formatTime(timelineContentEnd)} (f${totF})`;
}

function timeFromClientX(clientX) {
    const rect = timelineTrack.getBoundingClientRect();
    const x = clientX - rect.left;
    const t = x / pixelsPerSecond;
    return Math.max(0, Math.min(t, timelineDuration));
}

// ===== FILMSTRIP / WAVEFORM (now per-clip, driven by the arrays) =====

function buildClipFilmstrip(c) {
    const wrap = document.createElement("div");
    wrap.className = "clip-filmstrip";
    if (!allThumbnails.length || !sourceDuration) return wrap;

    const n = allThumbnails.length;
    let firstIdx = Math.floor((c.sourceStart / sourceDuration) * n);
    let lastIdx = Math.ceil((c.sourceEnd / sourceDuration) * n) - 1;
    firstIdx = Math.max(0, Math.min(firstIdx, n - 1));
    lastIdx = Math.max(firstIdx, Math.min(lastIdx, n - 1));

    const count = lastIdx - firstIdx + 1;
    const widthPx = (c.end - c.start) * pixelsPerSecond;
    const tileW = widthPx / count;

    for (let i = firstIdx; i <= lastIdx; i++) {
        const img = document.createElement("img");
        img.src = `/cache/${allThumbnails[i]}`;
        img.style.width = `${tileW}px`;
        wrap.appendChild(img);
    }
    return wrap;
}

function styleWaveformSlice(el, srcStart) {
    if (!waveformFile || !sourceDuration) return;
    const fullWidthPx = sourceDuration * pixelsPerSecond;
    el.style.backgroundImage = `url(/cache/${waveformFile})`;
    el.style.backgroundSize = `${fullWidthPx}px 100%`;
    el.style.backgroundRepeat = "no-repeat";
    el.style.backgroundPosition = `-${srcStart * pixelsPerSecond}px 0`;
}

// ===== RENDER: VIDEO / AUDIO / SEGMENT blocks =====

function renderVideoClips() {
    videoBlocksLayer.innerHTML = "";
    videoClips.forEach((c) => {
        const el = document.createElement("div");
        el.className = "video-block" + (isSelected("video", c.id) ? " selected" : "");
        el.style.left = `${c.start * pixelsPerSecond}px`;
        el.style.width = `${(c.end - c.start) * pixelsPerSecond}px`;
        el.dataset.id = c.id;

        let icons = "";
        if (c.muted) icons += " 🔇";
        if (c.audioDetached) icons += " 🎧";
        if (c.speed !== undefined && c.speed !== 1) icons += ` ${c.speed.toFixed(2)}x`;

        el.innerHTML = `<span class="seg-label">video${icons}</span>
                         <div class="video-handle video-handle-left" data-id="${c.id}"></div>
                         <div class="video-handle video-handle-right" data-id="${c.id}"></div>`;
        el.insertBefore(buildClipFilmstrip(c), el.firstChild);
        videoBlocksLayer.appendChild(el);
    });
}

// STACK-2 renders — bilkul same look, sirf block par .stack2 class (thori
// different tint) taake visually turant pata chale ke ye doosri stack hai.
function renderStack2VideoClips() {
    if (!stack2VideoBlocksLayer) return;
    stack2VideoBlocksLayer.innerHTML = "";
    stack2VideoClips.forEach((c) => {
        const el = document.createElement("div");
        el.className = "video-block stack2" + (isSelected("video", c.id) ? " selected" : "");
        el.style.left = `${c.start * pixelsPerSecond}px`;
        el.style.width = `${(c.end - c.start) * pixelsPerSecond}px`;
        el.dataset.id = c.id;

        let icons = "";
        if (c.muted) icons += " 🔇";
        if (c.speed !== undefined && c.speed !== 1) icons += ` ${c.speed.toFixed(2)}x`;
        if (c.savedName && currentVideoRef && c.savedName !== currentVideoRef.saved_name) icons += " 📎"; // alag file

        el.innerHTML = `<span class="seg-label">video S2${icons}</span>
                         <div class="video-handle video-handle-left" data-id="${c.id}"></div>
                         <div class="video-handle video-handle-right" data-id="${c.id}"></div>`;
        // filmstrip sirf current-video ke thumbnails se — alag file ka skip
        if (!c.savedName || !currentVideoRef || c.savedName === currentVideoRef.saved_name) {
            el.insertBefore(buildClipFilmstrip(c), el.firstChild);
        }
        stack2VideoBlocksLayer.appendChild(el);
    });
}

function renderStack2Segments() {
    if (!stack2SegmentsLayer) return;
    stack2SegmentsLayer.querySelectorAll(".segment-block").forEach((n) => n.remove());
    stack2Segments.forEach((seg) => {
        const el = document.createElement("div");
        el.className = "segment-block stack2" + (isSelected("segment", seg.id) ? " selected" : "");
        el.style.left = `${seg.start * pixelsPerSecond}px`;
        el.style.width = `${(seg.end - seg.start) * pixelsPerSecond}px`;
        el.dataset.id = seg.id;

        el.innerHTML = `<span class="seg-label">${seg.mode} S2</span>
                         <div class="seg-handle seg-handle-left" data-id="${seg.id}"></div>
                         <div class="seg-handle seg-handle-right" data-id="${seg.id}"></div>`;
        stack2SegmentsLayer.appendChild(el);
    });
}

function renderStack2AudioLane() {
    if (!stack2AudioLayer) return;
    stack2AudioLayer.innerHTML = "";
    stack2AudioLanes.forEach((a) => {
        const el = document.createElement("div");
        el.className = "audio-block stack2" + (isSelected("audio", a.id) ? " selected" : "");
        el.style.left = `${a.start * pixelsPerSecond}px`;
        el.style.width = `${(a.end - a.start) * pixelsPerSecond}px`;
        el.dataset.id = a.id;
        styleWaveformSlice(el, a.sourceStart);
        el.insertAdjacentHTML("beforeend", `<span class="seg-label">🎵 audio S2</span>
                         <div class="audio-handle audio-handle-left" data-id="${a.id}"></div>
                         <div class="audio-handle audio-handle-right" data-id="${a.id}"></div>`);
        stack2AudioLayer.appendChild(el);
    });
}

function renderStack2All() {
    renderStack2VideoClips();
    renderStack2Segments();
    renderStack2AudioLane();
    window.__renderStack2UI = renderStack2All; // timeline.js ke renderStack2() ke liye
}

function renderSegments() {
    segmentsLayer.querySelectorAll(".segment-block").forEach((n) => n.remove());
    segments.forEach((seg) => {
        const el = document.createElement("div");
        el.className = "segment-block" + (isSelected("segment", seg.id) ? " selected" : "");
        el.style.left = `${seg.start * pixelsPerSecond}px`;
        el.style.width = `${(seg.end - seg.start) * pixelsPerSecond}px`;
        el.dataset.id = seg.id;

        let icons = "";
        if (seg.muted) icons += " 🔇";
        if (seg.audioDetached) icons += " 🎧";

        el.innerHTML = `<span class="seg-label">${seg.mode}${icons}</span>
                         <div class="seg-handle seg-handle-left" data-id="${seg.id}"></div>
                         <div class="seg-handle seg-handle-right" data-id="${seg.id}"></div>`;
        segmentsLayer.appendChild(el);
    });
}

function renderAudioLane() {
    audioLayer.innerHTML = "";

    // shadow waveform for a video clip's own embedded audio (follows the video clip
    // automatically — only shown while NOT detached)
    videoClips.forEach((c) => {
        if (c.audioDetached) return;
        const el = document.createElement("div");
        el.className = "audio-shadow" + (c.muted ? " muted" : "");
        el.style.left = `${c.start * pixelsPerSecond}px`;
        el.style.width = `${(c.end - c.start) * pixelsPerSecond}px`;
        styleWaveformSlice(el, c.sourceStart);
        audioLayer.appendChild(el);
    });

    // real, independent, draggable audio lanes (detached / pasted / duplicated)
    audioLanes.forEach((a) => {
        const el = document.createElement("div");
        el.className = "audio-block" + (isSelected("audio", a.id) ? " selected" : "");
        el.style.left = `${a.start * pixelsPerSecond}px`;
        el.style.width = `${(a.end - a.start) * pixelsPerSecond}px`;
        el.dataset.id = a.id;
        styleWaveformSlice(el, a.sourceStart);

        const icon = a.muted ? "🔇" : "🎵";
        el.insertAdjacentHTML("beforeend", `<span class="seg-label">${icon} audio</span>
                         <div class="audio-handle audio-handle-left" data-id="${a.id}"></div>
                         <div class="audio-handle audio-handle-right" data-id="${a.id}"></div>`);
        audioLayer.appendChild(el);
    });
}

function renderAll() {
    recalcTimelineDuration();
    // BUG 7 perf-fix ka hissa: naya draw-cycle — snapshot cache invalidate
    if (typeof invalidateSnapshot === "function") invalidateSnapshot();
    renderVideoClips();
    renderSegments();
    renderAudioLane();
    renderRulers();
    renderStack2All();
    // NAYE LAYER ROWS (layers.js — agar load ho)
    if (typeof renderEffectLayers === "function") renderEffectLayers();
}

// ===== SCRUB AREA: click = seek, click+drag = marquee select (press-and-hold) =====

function handleScrubMouseDown(e) {
    pausePlayback();
    if (playPauseBtnEl) playPauseBtnEl.textContent = "▶";
    const rect = timelineTrack.getBoundingClientRect();
    marqueeState = {
        startClientX: e.clientX, startClientY: e.clientY,
        startXpx: e.clientX - rect.left, startYpx: e.clientY - rect.top,
        ctrlKey: e.ctrlKey, moved: false, el: null,
        curX1: 0, curX2: 0, curY1: 0, curY2: 0,
    };
}

scrubArea.addEventListener("mousedown", handleScrubMouseDown);

rulerFramesEl.addEventListener("mousedown", (e) => {
    pausePlayback();
    if (playPauseBtnEl) playPauseBtnEl.textContent = "▶";
    isDraggingPlayhead = true;
    seekVirtual(timeFromClientX(e.clientX));
});
rulerSecondsEl.addEventListener("mousedown", (e) => {
    pausePlayback();
    if (playPauseBtnEl) playPauseBtnEl.textContent = "▶";
    isDraggingPlayhead = true;
    seekVirtual(timeFromClientX(e.clientX));
});

document.addEventListener("mousemove", (e) => {
    if (isDraggingPlayhead) {
        seekVirtual(timeFromClientX(e.clientX));
        return;
    }

    if (marqueeState && !dragState) {
        const dist = Math.hypot(e.clientX - marqueeState.startClientX, e.clientY - marqueeState.startClientY);
        if (!marqueeState.moved && dist > 4) {
            marqueeState.moved = true;
            const el = document.createElement("div");
            el.className = "marquee-box";
            tracksArea.appendChild(el);
            marqueeState.el = el;
        }
        if (marqueeState.moved) {
            const rect = timelineTrack.getBoundingClientRect();
            const curX = e.clientX - rect.left, curY = e.clientY - rect.top;
            const x1 = Math.min(marqueeState.startXpx, curX), x2 = Math.max(marqueeState.startXpx, curX);
            const y1 = Math.min(marqueeState.startYpx, curY), y2 = Math.max(marqueeState.startYpx, curY);
            marqueeState.el.style.left = `${x1}px`;
            marqueeState.el.style.top = `${y1}px`;
            marqueeState.el.style.width = `${x2 - x1}px`;
            marqueeState.el.style.height = `${y2 - y1}px`;
            marqueeState.curX1 = x1; marqueeState.curX2 = x2;
            marqueeState.curY1 = y1; marqueeState.curY2 = y2;
        }
    }
});

function applyMarqueeSelection(m, additive) {
    if (!additive) clearSelection();
    const trackRect = timelineTrack.getBoundingClientRect();
    function rowRange(el) {
        if (!el) return { top: -1, bottom: -1 };
        const r = el.getBoundingClientRect();
        return { top: r.top - trackRect.top, bottom: r.bottom - trackRect.top };
    }
    const videoRow = rowRange(document.getElementById("trackVideo"));
    const audioRow = rowRange(document.getElementById("trackAudioCombined"));
    const segRow = rowRange(document.getElementById("segmentsLayer"));
    const s2VideoRow = rowRange(document.getElementById("stack2VideoBlocksLayer")) || { top: -1, bottom: -1 };
    const s2AudioRow = rowRange(document.getElementById("stack2AudioLayer")) || { top: -1, bottom: -1 };
    const s2SegRow = rowRange(document.getElementById("stack2SegmentsLayer")) || { top: -1, bottom: -1 };
    // NAYE LAYER ROWS (marquee selection)
    const capRow = rowRange(captionSpansLayer ? captionSpansLayer.parentElement : null);
    const transRow = rowRange(transitionSpansLayer ? transitionSpansLayer.parentElement : null);
    const pzRow = rowRange(pzSpansLayer ? pzSpansLayer.parentElement : null);
    const gradeRow = rowRange(gradeSpansLayer ? gradeSpansLayer.parentElement : null);

    function intersects(rowR, itemStartPx, itemEndPx) {
        const vOverlap = !(m.curY2 < rowR.top || m.curY1 > rowR.bottom);
        const hOverlap = !(itemEndPx < m.curX1 || itemStartPx > m.curX2);
        return vOverlap && hOverlap;
    }

    videoClips.forEach((c) => {
        if (intersects(videoRow, c.start * pixelsPerSecond, c.end * pixelsPerSecond)) toggleSelectItem("video", c.id);
    });
    audioLanes.forEach((a) => {
        if (intersects(audioRow, a.start * pixelsPerSecond, a.end * pixelsPerSecond)) toggleSelectItem("audio", a.id);
    });
    segments.forEach((s) => {
        if (intersects(segRow, s.start * pixelsPerSecond, s.end * pixelsPerSecond)) toggleSelectItem("segment", s.id);
    });
    // STACK-2 rows bhi marquee mein shamil
    stack2VideoClips.forEach((c) => {
        if (intersects(s2VideoRow, c.start * pixelsPerSecond, c.end * pixelsPerSecond)) toggleSelectItem("video", c.id);
    });
    stack2AudioLanes.forEach((a) => {
        if (intersects(s2AudioRow, a.start * pixelsPerSecond, a.end * pixelsPerSecond)) toggleSelectItem("audio", a.id);
    });
    stack2Segments.forEach((s) => {
        if (intersects(s2SegRow, s.start * pixelsPerSecond, s.end * pixelsPerSecond)) toggleSelectItem("segment", s.id);
    });
    // NAYE LAYERS bhi marquee se select
    captionSpans.forEach((s) => { if (intersects(capRow, s.start * pixelsPerSecond, s.end * pixelsPerSecond)) toggleSelectItem("captionSpan", s.id); });
    transitions.forEach((s) => { if (intersects(transRow, s.start * pixelsPerSecond, s.end * pixelsPerSecond)) toggleSelectItem("transition", s.id); });
    panZoomSpans.forEach((s) => { if (intersects(pzRow, s.start * pixelsPerSecond, s.end * pixelsPerSecond)) toggleSelectItem("panZoom", s.id); });
    gradeSpans.forEach((s) => { if (intersects(gradeRow, s.start * pixelsPerSecond, s.end * pixelsPerSecond)) toggleSelectItem("gradeSpan", s.id); });
    // TITLES row (marquee-select)
    const titleRow = rowRange(titlesSpansLayer ? titlesSpansLayer.parentElement : null);
    titlesSpans.forEach((s) => { if (intersects(titleRow, s.start * pixelsPerSecond, s.end * pixelsPerSecond)) toggleSelectItem("titleSpan", s.id); });

    renderAll();
}

document.addEventListener("mouseup", (e) => {
    if (marqueeState) {
        if (marqueeState.moved) {
            applyMarqueeSelection(marqueeState, marqueeState.ctrlKey);
            if (marqueeState.el) marqueeState.el.remove();
        } else {
            if (!marqueeState.ctrlKey) clearSelection();
            seekVirtual(timeFromClientX(marqueeState.startClientX));
            renderAll();
        }
        marqueeState = null;
    }
    isDraggingPlayhead = false;
});

// ===== VIDEO LAYER interactions =====

videoBlocksLayer.addEventListener("mousedown", (e) => {
    const target = e.target;
    e.stopPropagation();
    pausePlayback();
    if (playPauseBtnEl) playPauseBtnEl.textContent = "▶";

    if (target.classList.contains("video-handle-left") || target.classList.contains("video-handle-right")) {
        const id = target.dataset.id;
        const c = getVideoClipById(id);
        if (e.ctrlKey) toggleSelectItem("video", id); else selectOnly("video", id);
        dragState = {
            kind: "video",
            type: target.classList.contains("video-handle-left") ? "resize-left" : "resize-right",
            id, origStart: c.start, origEnd: c.end,
        };
        renderAll();
        return;
    }

    const blockEl = target.closest(".video-block");
    if (blockEl) {
        const id = blockEl.dataset.id;
        if (e.ctrlKey) {
            if (isSelected("video", id) && selectedItems.length > 1) {
                // ambiguous: plain ctrl-click (toggle off) ya ctrl-held-drag (group move)?
                // decide at mouseup based on whether the mouse actually moved
                dragState = buildMoveDragState(e.clientX, "video", id);
                dragState.pendingCtrlToggle = { kind: "video", id };
            } else {
                toggleSelectItem("video", id);
            }
        } else {
            // agar ye item already ek multi-selection ka hissa hai, to poori
            // selection ko group ke tor par move karo (collapse mat karo)
            if (!isSelected("video", id) || selectedItems.length <= 1) {
                selectOnly("video", id);
            }
            dragState = buildMoveDragState(e.clientX, "video", id);
        }
        renderAll();
    }
});

// ===== SEGMENT LAYER interactions (unchanged: click+drag empty area = create) =====

segmentsLayer.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    pausePlayback();
    if (playPauseBtnEl) playPauseBtnEl.textContent = "▶";
    const target = e.target;

    if (target.classList.contains("seg-handle-left") || target.classList.contains("seg-handle-right")) {
        const id = target.dataset.id;
        const seg = getSegmentById(id);
        if (e.ctrlKey) toggleSelectItem("segment", id); else selectOnly("segment", id);
        dragState = {
            kind: "segment",
            type: target.classList.contains("seg-handle-left") ? "resize-left" : "resize-right",
            id, origStart: seg.start, origEnd: seg.end,
        };
        renderAll();
        return;
    }

    const blockEl = target.closest(".segment-block");
    if (blockEl) {
        const id = blockEl.dataset.id;
        if (e.ctrlKey) {
            if (isSelected("segment", id) && selectedItems.length > 1) {
                dragState = buildMoveDragState(e.clientX, "segment", id);
                dragState.pendingCtrlToggle = { kind: "segment", id };
            } else {
                toggleSelectItem("segment", id);
            }
        } else {
            if (!isSelected("segment", id) || selectedItems.length <= 1) {
                selectOnly("segment", id);
            }
            dragState = buildMoveDragState(e.clientX, "segment", id);
        }
        renderAll();
        return;
    }

    // empty area → draw new segment (Phase 4 behaviour, unchanged)
    if (!e.ctrlKey) clearSelection();
    renderAll();
    const startTime = timeFromClientX(e.clientX);
    dragState = { kind: "segment", type: "create", startTime, tempEl: null };
});

// ===== AUDIO LAYER interactions =====

audioLayer.addEventListener("mousedown", (e) => {
    const target = e.target;
    e.stopPropagation();
    pausePlayback();
    if (playPauseBtnEl) playPauseBtnEl.textContent = "▶";

    if (target.classList.contains("audio-handle-left") || target.classList.contains("audio-handle-right")) {
        const id = target.dataset.id;
        const a = getAudioById(id);
        if (e.ctrlKey) toggleSelectItem("audio", id); else selectOnly("audio", id);
        dragState = {
            kind: "audio",
            type: target.classList.contains("audio-handle-left") ? "resize-left" : "resize-right",
            id, origStart: a.start, origEnd: a.end,
        };
        renderAll();
        return;
    }

    const blockEl = target.closest(".audio-block");
    if (blockEl) {
        const id = blockEl.dataset.id;
        if (e.ctrlKey) {
            if (isSelected("audio", id) && selectedItems.length > 1) {
                dragState = buildMoveDragState(e.clientX, "audio", id);
                dragState.pendingCtrlToggle = { kind: "audio", id };
            } else {
                toggleSelectItem("audio", id);
            }
        } else {
            if (!isSelected("audio", id) || selectedItems.length <= 1) {
                selectOnly("audio", id);
            }
            dragState = buildMoveDragState(e.clientX, "audio", id);
        }
        renderAll();
    }
});

// ===== MAGNETIC SNAP (Filmora-style "join") =====
// FIX: ab CROSS-LAYER snap hai — pehle har layer sirf apni hi clips ke kinaron
// par snap karti thi (segment->segment only), isliye crop-segment video ke
// end par PERFECT stick nahi hota tha aur pata nahi chalta tha ke segment
// kahan tak apply hua. Ab: segment draw/move/resize par VIDEO clips ke start/end
// (aur playhead/0) bhi snap-points hain — aur ulta bhi (video clips segments ke
// kinaron par snap karti hain). Audio bhi dono se snap karta hai.
function getSnapCandidates(kind, excludeId) {
    const points = [0, virtualTime];
    // SAB layers (video + audio + segment, DONO stacks) ke kinaron par snap hota hai —
    // IDs globally unique hain (genId), isliye sirf id se exclude kaafi hai
    // NAYE LAYERS bhi snap-points hain (BUG 5/6 ki family — magnetic snap ab
    // transition/panzoom/grade/caption kinaron par bhi chipkega)
    [segments, audioLanes, videoClips, stack2Segments, stack2AudioLanes, stack2VideoClips,
     captionSpans, transitions, panZoomSpans, gradeSpans].forEach((arr) => {
        arr.forEach((it) => {
            if (excludeId && it.id === excludeId) return; // khud apne kinaron par snap na ho
            points.push(it.start, it.end);
        });
    });
    return points;
}

function closestSnap(value, candidates, thresholdSec) {
    let best = value, bestDist = thresholdSec;
    for (const c of candidates) {
        const d = Math.abs(value - c);
        if (d < bestDist) { bestDist = d; best = c; }
    }
    return best;
}

// ===== SHARED DRAG (move/resize/create) for all 3 layers =====
// move: only start/end change (position) — sourceStart/sourceEnd (content) untouched.
// resize: trims the SOURCE range too (like Filmora trim), 1:1 time mapping.

document.addEventListener("mousemove", (e) => {
    if (!dragState) return;

    if (dragState.type === "create") {
        const t = timeFromClientX(e.clientX);
        const start = Math.min(dragState.startTime, t);
        const end = Math.max(dragState.startTime, t);

        if (!dragState.tempEl) {
            const el = document.createElement("div");
            // EFFECT-LAYER create-drag: temp block usi layer-row mein dikhe
            if (dragState.effectKind) {
                el.className = "layer-span creating";
                const layerMap = { transition: transitionSpansLayer, panZoom: pzSpansLayer, gradeSpan: gradeSpansLayer };
                (layerMap[dragState.effectKind] || segmentsLayer).appendChild(el);
                // ROW-HEIGHT FIX: naye rows abs-inset hain — temp block poori row
                // cover kare (warna sirf 3px strip dikhta tha)
                el.style.top = "0";
                el.style.height = "100%";
            } else {
                el.className = "segment-block creating";
                segmentsLayer.appendChild(el);
            }
            dragState.tempEl = el;
        }
        dragState.tempEl.style.left = `${start * pixelsPerSecond}px`;
        dragState.tempEl.style.width = `${(end - start) * pixelsPerSecond}px`;
        dragState.liveStart = start;
        dragState.liveEnd = end;
        return;
    }

    if (dragState.type === "move") {
        const dt = (e.clientX - dragState.startClientX) / pixelsPerSecond;
        if (Math.abs(e.clientX - dragState.startClientX) > 3) dragState.hasMoved = true;
        let effectiveDt = dt;

        // sirf "primary" (jo item asal mein grab hua tha) ke kinaron par snap
        // check karo — baaki group same amount se shift hota hai (rigid group move)
        const primary = dragState.items.find(
            (x) => x.kind === dragState.primaryKind && x.id === dragState.primaryId
        );
        if (primary) {
            const dur = primary.origEnd - primary.origStart;
            let newStart = Math.max(0, primary.origStart + dt);
            const snapThresholdSec = 8 / pixelsPerSecond; // ~8px tolerance, Filmora-style magnetic snap
            const candidates = getSnapCandidates(primary.kind, primary.id);
            const snappedStart = closestSnap(newStart, candidates, snapThresholdSec);
            const snappedEnd = closestSnap(newStart + dur, candidates, snapThresholdSec);
            if (snappedStart !== newStart) {
                newStart = snappedStart;
            } else if (snappedEnd !== newStart + dur) {
                newStart = snappedEnd - dur;
            }
            newStart = Math.max(0, newStart);
            effectiveDt = newStart - primary.origStart;
        }

        // koi bhi item group mein 0 se neeche na jaye
        let minAllowedDt = -Infinity;
        dragState.items.forEach(({ origStart }) => {
            minAllowedDt = Math.max(minAllowedDt, -origStart);
        });
        effectiveDt = Math.max(effectiveDt, minAllowedDt);

        dragState.items.forEach(({ kind, id, origStart, origEnd }) => {
            const item = getItemInStack(kind, id); // STACK-AWARE: selection dono stacks se aa sakti hai
            if (!item) return;
            const dur = origEnd - origStart;
            const newStart = origStart + effectiveDt;
            item.start = newStart;
            item.end = newStart + dur;
            // sourceStart/sourceEnd intentionally untouched — moving changes position only
        });

        recalcTimelineDuration();
        renderAll();
        return;
    }

    // ---- resize-left / resize-right: single item only ----
    const item = getItemInStack(dragState.kind, dragState.id); // STACK-AWARE
    if (!item) return;

    const snapThresholdSec = 8 / pixelsPerSecond;
    const snapCandidates = getSnapCandidates(dragState.kind, item.id);

    if (dragState.type === "resize-left") {
        let newStart = timeFromClientX(e.clientX);
        newStart = closestSnap(newStart, snapCandidates, snapThresholdSec);
        newStart = Math.max(0, Math.min(newStart, item.end - 0.2));
        let deltaStart = newStart - item.start;
        if (item.sourceStart !== undefined) {
            if (item.sourceStart + deltaStart < 0) {
                deltaStart = -item.sourceStart;
                newStart = item.start + deltaStart;
            }
            item.sourceStart += deltaStart;
        }
        item.start = newStart;
    } else if (dragState.type === "resize-right") {
        let newEnd = timeFromClientX(e.clientX);
        newEnd = closestSnap(newEnd, snapCandidates, snapThresholdSec);
        newEnd = Math.max(newEnd, item.start + 0.2);
        let deltaEnd = newEnd - item.end;
        if (item.sourceEnd !== undefined) {
            let newSourceEnd = item.sourceEnd + deltaEnd;
            if (newSourceEnd > sourceDuration) {
                newSourceEnd = sourceDuration;
                deltaEnd = newSourceEnd - item.sourceEnd;
                newEnd = item.end + deltaEnd;
            }
            item.sourceEnd = newSourceEnd;
        }
        item.end = newEnd;
    }

    recalcTimelineDuration();
    renderAll();
});

document.addEventListener("mouseup", () => {
    if (!dragState) return;

    if (dragState.type === "create") {
        if (dragState.tempEl) dragState.tempEl.remove();
        const start = dragState.liveStart, end = dragState.liveEnd;

        // TITLES: titleSpan create default-data (createEffectSpan titleSpan branch)
        if (dragState.effectKind === "titleSpan" && typeof createEffectSpan === "function") {
            createEffectSpan("titleSpan", start, end);
            dragState = null;
            return;
        }

        // NAYE EFFECT-LAYERS: apna create-function (transition/panZoom/gradeSpan)
        if (dragState.effectKind && typeof createEffectSpan === "function") {
            createEffectSpan(dragState.effectKind, start, end);
            dragState = null;
            return;
        }

        if (end - start > 0.15) {
            if (typeof pushHistory === "function") pushHistory();
            const newSeg = {
                id: genId(),
                start, end,
                mode: "single",
                modeBoxState: {},
                muted: false,
                audioDetached: false,
            };
            segments.push(newSeg);
            selectOnly("segment", newSeg.id);
            recalcTimelineDuration();
            renderAll();
            persistTimelineState();
        }
    } else if (dragState.type === "move" || dragState.type === "resize-left" || dragState.type === "resize-right") {
        if (dragState.type === "move" && dragState.pendingCtrlToggle && !dragState.hasMoved) {
            // ye asal mein ek plain ctrl-click tha (drag nahi hua) — ab item ko
            // deselect karo, jaisa normal ctrl-click karta hai
            toggleSelectItem(dragState.pendingCtrlToggle.kind, dragState.pendingCtrlToggle.id);
        }
        dragState = null; // pehle drag khatam karo — taake recalc video-overlaps poori tarah resolve kare
        recalcTimelineDuration();
        renderAll();
        persistTimelineState();
    }

    dragState = null;
});

// ===== ZOOM =====

zoomInBtn.addEventListener("click", () => {
    pixelsPerSecond = Math.min(pixelsPerSecond + 40, 500);
    rezoomTimeline();
});

zoomOutBtn.addEventListener("click", () => {
    pixelsPerSecond = Math.max(pixelsPerSecond - 40, 20);
    rezoomTimeline();
});

function rezoomTimeline() {
    recalcTimelineDuration();
    renderAll();
    updatePlayheadPosition(virtualTime);
    // segment-marker flags (A/D) zoom ke sath re-position
    if (typeof updateMarkerOverlay === "function" && typeof __segMarkStart !== "undefined" && __segMarkStart !== null) {
        updateMarkerOverlay(__segMarkStart, null);
    }
}
```

### Name: frontend/titles.js
```js
// ===== TITLES LAYER (9:16 heading engine) — v2 =====
// Captions layer bilkul SEPARATE feature hai:
//  - Auto Captions poori video ke liye hai — wo AS-IS chalta rahega (captions.js
//    ko humne kuch nahi chheda; Auto Captions ka promise intact).
//  - Titles sirf 9:16 window par CHHOTE-SPAN HEADINGS ke liye hai. Span jitna,
//    title utna (koi poori-video overlay nahi).
//
// Data-model (timeline.js me titlesSpans = [] — waisa hi jaisa captionSpans):
//   titlesSpans : [{ id, start, end, template, text, align, position:{x,y}, scale }]
//   - template: 26 built-in animated heading templates har APNA style + anim
//   - text: manual heading-string, YA empty = caption-cue text us span me dikhaye
//   - align: "left" | "center" | "right" (title ko us x-position par anchor)
// Template engine (drawTitleOnCanvas) ka Python-mirror backend ke export_engine.py
// me hai — naya template add karte waqt dono update rakho (keys aur anims same).

const TITLE_TEMPLATES = {
    // ---- originals (10) ----
    boldPop:     { label: "Bold Pop",     fontWeight: "900", baseFontPx: 72, color: "#ffffff", accent: "#ffd42a", bg: null,      anim: "pop",       uppercase: true, shadow: true,  desc: "bada bold text, belly-pop in" },
    filmFade:    { label: "Film Fade",    fontWeight: "700", baseFontPx: 58, color: "#ffffff", accent: "#ffffff", bg: null,      anim: "fade",      uppercase: false, shadow: true,  desc: "classic film fade-in heading" },
    typewriter:  { label: "Typewriter",   fontWeight: "800", baseFontPx: 54, color: "#eaffff", accent: "#00e5ff", bg: null,      anim: "typewriter",uppercase: false, shadow: false, desc: "typing animation with caret" },
    boxIn:       { label: "Box In",       fontWeight: "900", baseFontPx: 60, color: "#111111", accent: "#ffd42a", bg: "#ffd42a", anim: "boxIn",     uppercase: true, shadow: false, desc: "highlight-box squeezes in behind text" },
    slideUp:     { label: "Slide Up",     fontWeight: "800", baseFontPx: 62, color: "#ffffff", accent: "#2fb8a6", bg: null,      anim: "slideUp",   uppercase: true, shadow: true,  desc: "heading slides up from below" },
    neonGlow:    { label: "Neon Title",   fontWeight: "800", baseFontPx: 64, color: "#eaffff", accent: "#00e5ff", bg: null,      anim: "neon",      uppercase: false, shadow: false, desc: "neon glow pulsing title" },
    bigPop:      { label: "Stamp In",     fontWeight: "900", baseFontPx: 76, color: "#ff2d55", accent: "#ffffff", bg: null,      anim: "stamp",     uppercase: true, shadow: false, desc: "rubber-stamp slam-down" },
    newsTicker:  { label: "News Ticker",  fontWeight: "700", baseFontPx: 46, color: "#111111", accent: "#ffffff", bg: "#ffffff", anim: "ticker",    uppercase: false, shadow: false, desc: "news-channel bottom bar" },
    greenScreen: { label: "Outline Grow", fontWeight: "900", baseFontPx: 66, color: "#00ff33", accent: "#000000", bg: null,      anim: "grow",      uppercase: true, shadow: false, desc: "outline text scaling up" },
    karaokeFill: { label: "Karaoke Line", fontWeight: "800", baseFontPx: 56, color: "#8a8a8a", accent: "#ffffff", bg: null,      anim: "karaoke",   uppercase: false, shadow: false,  desc: "text karaoke-fills as it plays" },
    // ---- captions-styles mirror (16 naye) — har caption-style ka title-look ----
    hormozi:     { label: "Hormozi",      fontWeight: "900", baseFontPx: 58, color: "#ffffff", accent: "#ffd42a", bg: "#ffd42a", anim: "boxIn",     uppercase: true, shadow: false, desc: "Yellow box + b/w — Hormozi caption look" },
    mrbeast:     { label: "MrBeast",      fontWeight: "900", baseFontPx: 56, color: "#ffffff", accent: "#00ff33", bg: null,      anim: "grow",      uppercase: true, shadow: false, desc: "green outline grow — MrBeast look" },
    tiktokPop:   { label: "TikTok Pop",   fontWeight: "900", baseFontPx: 54, color: "#ff2d55", accent: "#ffffff", bg: null,      anim: "pop",       uppercase: true, shadow: true,  desc: "hot-pink pop" },
    podcastBold: { label: "Podcast Bold", fontWeight: "800", baseFontPx: 50, color: "#ffffff", accent: "#e63946", bg: "#e63946", anim: "boxIn",     uppercase: true, shadow: false, desc: "red box + white text" },
    boldHighlight: { label: "Bold Highlight", fontWeight: "800", baseFontPx: 54, color: "#111111", accent: "#ffde59", bg: "#ffde59", anim: "boxIn",   uppercase: true, shadow: false, desc: "yellow line-box, black text" },
    viralYellow: { label: "Viral Yellow", fontWeight: "900", baseFontPx: 60, color: "#ffe600", accent: "#000000", bg: null,      anim: "grow",      uppercase: true, shadow: false, desc: "bright yellow outline pop" },
    karaokeWave: { label: "Karaoke Wave", fontWeight: "800", baseFontPx: 50, color: "rgba(255,255,255,0.45)", accent: "#00e5ff", bg: null, anim: "karaoke", uppercase: false, shadow: false, desc: "cyan sweep-fill karaoke" },
    softPastel:  { label: "Soft Pastel",  fontWeight: "600", baseFontPx: 46, color: "#ffd1dc", accent: "#ff8fab", bg: null,      anim: "fade",      uppercase: false, shadow: true,  desc: "soft pink fade heading" },
    retroWave:   { label: "Retro Wave",   fontWeight: "800", baseFontPx: 52, color: "#ff71ce", accent: "#01cdfe", bg: null,      anim: "neon",      uppercase: true, shadow: false, desc: "retro synthwave glow" },
    comicPop:    { label: "Comic Pop",    fontWeight: "900", baseFontPx: 56, color: "#ffffff", accent: "#ff2d55", bg: "#ffde00", anim: "boxIn",     uppercase: true, shadow: false, desc: "comic yellow box tilt" },
    gymBeast:    { label: "Gym Beast",    fontWeight: "900", baseFontPx: 62, color: "#ffffff", accent: "#ff3800", bg: "#111111", anim: "boxIn",     uppercase: true, shadow: true,   desc: "black box orange text, brutal" },
    luxuryGold:  { label: "Luxury Gold",  fontWeight: "800", baseFontPx: 52, color: "#d4af37", accent: "#fff8d8", bg: null,      anim: "neon",      uppercase: true, shadow: false,  desc: "gold glow title" },
    oceanBlue:   { label: "Ocean Blue",   fontWeight: "800", baseFontPx: 52, color: "#4cc9f0", accent: "#003049", bg: null,      anim: "slideUp",   uppercase: true, shadow: true,   desc: "deep blue slide-up heading" },
    fireRed:     { label: "Fire Red",     fontWeight: "900", baseFontPx: 58, color: "#ff4d00", accent: "#200000", bg: null,      anim: "stamp",     uppercase: true, shadow: false, desc: "fire stamp slam" },
    bubbleGum:   { label: "Bubble Gum",   fontWeight: "900", baseFontPx: 54, color: "#ffffff", accent: "#ff5da2", bg: "#ff5da2", anim: "boxIn",     uppercase: true, shadow: false, desc: "pink pill box" },
    monoGray:    { label: "Mono Gray",    fontWeight: "600", baseFontPx: 46, color: "#d0d0d0", accent: "#111111", bg: null,      anim: "fade",      uppercase: false, shadow: false,  desc: "editorial mono minimal" },
    bananaSplit: { label: "Banana Split", fontWeight: "900", baseFontPx: 56, color: "#111111", accent: "#ffe135", bg: "#ffe135", anim: "boxIn",     uppercase: true, shadow: false, desc: "yellow outline box, black text" },    whisperSmall: { label: "Whisper Small", fontWeight: "400", baseFontPx: 34, color: "#eeeeee", accent: "#ffffff", bg: null,    anim: "fade",      uppercase: false, shadow: true,  desc: "chhota quiet bottom heading" },
    // ===== "MY TITLES" (sample-video golden-glow look — myCaption mirror) =====
    myCaption1:   { label: "My Titles 1",   fontWeight: "900", baseFontPx: 60, color: "#ffe200", accent: "#ffd400", bg: null,      anim: "neon",      uppercase: false, shadow: false, desc: "bright-yellow glowing heading" },
    myCaption2:   { label: "My Titles 2",   fontWeight: "800", baseFontPx: 56, color: "rgba(255,255,255,0.45)", accent: "#ffdd00", bg: null, anim: "karaoke", uppercase: false, shadow: false, desc: "white karaoke fills into yellow" },
    myCaption3:   { label: "My Titles 3",   fontWeight: "900", baseFontPx: 62, color: "#ffe200", accent: "#ffd400", bg: null,      anim: "neon",      uppercase: false, shadow: false, desc: "big yellow glow heading" },
};
const TITLE_TEMPLATE_KEYS = Object.keys(TITLE_TEMPLATES);

// align presets (title anchor-x + text-align) — drag X position override ho sakti hai
const TITLE_ALIGN_PRESETS = {
    left:   { x: 0.12 },   // anchor 12% (padding-safe)
    center: { x: 0.5 },
    right:  { x: 0.88 },
};
const TITLE_DEFAULT_POSITION = { x: 0.5, y: 0.22 }; // BASE default

// Auto-captions transcript se aaye cues — TitlesPanel inhe text-source ke temp
// store karo (timeline.js persist me bhi jaate hain; manual text override hota hai)
let titlesCues = [];      // [{start, end, text}] — SOURCE-time (captions wala hi)
let titlesSelectedTemplate = "boldPop";
let titlesPanelOpen = false;

function titleTemplateAt(t) {
    if (typeof titlesSpans === "undefined") return null;
    for (const s of titlesSpans) if (t >= s.start && t < s.end) return s;
    return null;
}

function _titleTextForCue(t, span) {
    if (span && span.text && String(span.text).trim()) return String(span.text).trim();
    if (typeof titlesCues !== "undefined" && titlesCues.length) {
        const srcT = window.__activeSourceTime;
        const cue = (srcT != null) ? titlesCues.find((c) => srcT >= c.start && srcT < c.end) : null;
        if (cue && cue.words && cue.words.length) {
            return cue.words.map((w) => (w.text || "")).join(" ").replace(/\s+/g, " ").trim();
        }
        if (cue && typeof cue.text === "string") return cue.text.trim();
    }
    return "";
}

function drawTitleOnCanvas(ctx, rectX, rectY, rectW, rectH, refHeightPx, isPreview) {
    if (typeof titlesSpans === "undefined" || !titlesSpans.length) return;
    const t = (typeof virtualTime === "number") ? virtualTime : 0;
    const span = titleTemplateAt(t);
    if (!span) return;

    const tpl = TITLE_TEMPLATES[span.template || "boldPop"] || TITLE_TEMPLATES.boldPop;
    let text = _titleTextForCue(t, span);
    if (!text) return;

    const scale = rectH / (refHeightPx || 1080);
    const fontSize = Math.max(12, tpl.baseFontPx * scale * (span.scale || 1.0));
    const label = tpl.uppercase ? text.toUpperCase() : text;
    const align = span.align || "center";

    const dur = Math.max(0.01, span.end - span.start);
    const prog = Math.max(0, Math.min(1, (t - span.start) / dur));
    const easeOut = (p) => 1 - Math.pow(1 - Math.min(1, Math.max(0, p)), 3);

    // ALIGN → anchor-x resolve: manual position-x override hota hai warna preset
    let ax;
    if (span.position && span.position.x != null) ax = span.position.x;
    else ax = (TITLE_ALIGN_PRESETS[align] || TITLE_ALIGN_PRESETS.center).x;
    const px = rectX + rectW * ax;
    const py = rectY + rectH * ((span.position && span.position.y != null) ? span.position.y : 0.22);
    const cx = px, cy = py;

    ctx.save();
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.font = `${tpl.fontWeight} ${fontSize}px Arial, sans-serif`;

    // ---- multi-line support (manual \n me splits) ----
    const lines = label.split("\n");
    const lineH = fontSize * 1.22;
    ctx.lineWidth = Math.max(1, 4 * scale);
    ctx.strokeStyle = tpl.accent || "#000";

    // ---- per-template transform pre-state ----
    let drawScale = 1, dy = 0, rot = 0, alpha = 1;
    const anim = tpl.anim || "pop";
    if (anim === "pop")      { const p = easeOut(prog * 4); drawScale = 0.6 + 0.4 * p; dy = (1 - p) * 40 * scale; }
    else if (anim === "fade"){ alpha = Math.min(1, prog * 2.2); }
    else if (anim === "typewriter"){ /* chars slicing per-line below */ }
    else if (anim === "boxIn"){ const p = easeOut(prog * 2.6); ctx._boxSx = p; }
    else if (anim === "slideUp"){ const p = easeOut(prog * 2.2); dy = (1 - p) * 90 * scale; alpha = Math.min(1, prog * 3); }
    else if (anim === "neon"){ alpha = 0.85 + 0.15 * Math.sin(prog * Math.PI * 4); }
    else if (anim === "stamp"){ const p = easeOut(prog * 3); drawScale = 2.4 - 1.4 * p; alpha = Math.min(1, prog * 4); }
    else if (anim === "ticker"){ /* bar below; text slides within */ }
    else if (anim === "grow"){ const p = easeOut(prog * 3.5); drawScale = 0.3 + 0.7 * p; alpha = Math.min(1, prog * 2.4); }
    else if (anim === "karaoke"){ /* fill revealed via clip below */ }

    // ---- ticker bar special: bottom-edge bar across full width ----
    if (anim === "ticker") {
        const barH = fontSize * 2.0;
        const barY = rectY + rectH * ((span.position && span.position.y != null) ? span.position.y : 0.85);
        const off = Math.max(0, 1 - easeOut(prog * 2.2)) * rectW;
        ctx.fillStyle = tpl.bg || "#fff";
        ctx.fillRect(rectX - off, barY - barH / 2, rectW + off, barH);
        ctx.textAlign = "left";
        ctx.save();
        ctx.beginPath();
        ctx.rect(rectX, barY - barH / 2, rectW, barH);
        ctx.clip();
        ctx.fillStyle = tpl.color || "#111";
        const tw = ctx.measureText(label).width;
        const tx = rectX + off / 2 + Math.max(0, rectW * 0.05 - off * 0.4);
        ctx.fillText(label, tx, barY);
        ctx.restore();
        ctx.restore();
        if (isPreview) {
            window.__titleBBox = { x: rectX, y: barY - barH / 2, w: rectW, h: barH };
        }
        return;
    }

    ctx.globalAlpha = alpha;
    ctx.translate(cx + 0, cy + dy);
    if (rot) ctx.rotate(rot);
    if (drawScale !== 1) ctx.scale(drawScale, drawScale);

    // ---- bg-box (boxIn) — text ke peeche highlight box squeeze-in ----
    if (anim === "boxIn") {
        const sx = (ctx._boxSx != null) ? ctx._boxSx : 1;
        const fullW = ctx.measureText(lines.length ? lines.reduce((a, b) => (a.length > b.length ? a : b)) : "").width;
        const padX = 18 * scale, padY = 12 * scale;
        const boxCenterX = (align === "left") ? fullW / 2 : (align === "right") ? -fullW / 2 : 0;
        const bw = (fullW + padX * 2) * sx, bh = lineH * lines.length + padY;
        ctx.fillStyle = tpl.bg || "#ffd42a";
        ctx.fillRect(boxCenterX - bw / 2, -bh / 2, bw, bh);
    }

    // ---- per-line (multi-line + typewriter + karaoke) ----
    const totalChars = Math.max(1, label.length);
    let startY = -((lines.length - 1) * lineH) / 2;
    let charsUsed = 0;
    lines.forEach((ln, li) => {
        const y = startY + li * lineH;
        let txtToDraw = ln;
        if (anim === "typewriter") {
            const shown = Math.floor(prog * totalChars + 0.5);
            const lineStart = charsUsed;
            charsUsed += ln.length + 1;
            const n = Math.max(0, Math.min(ln.length, shown - lineStart));
            txtToDraw = ln.slice(0, n);
        }
        if (txtToDraw.length === 0 && anim === "typewriter") return;

        if (tpl.shadow) {
            ctx.shadowColor = "rgba(0,0,0,0.85)";
            ctx.shadowBlur = Math.max(2, 14 * scale);
        } else {
            ctx.shadowColor = "transparent";
            ctx.shadowBlur = 0;
        }
        if (anim === "neon") { ctx.shadowColor = tpl.accent; ctx.shadowBlur = 22 * scale; }
        if (anim === "grow") {
            ctx.strokeStyle = tpl.accent || "#000";
            ctx.strokeText(txtToDraw, 0, y);
        }
        ctx.fillStyle = tpl.color || "#fff";
        ctx.fillText(txtToDraw, 0, y);

        if (anim === "karaoke") {
            // revealed-by-progress accent text (clip se sweep fill) —
            // align-aware clip-x (left/center/right)
            const wLine = ctx.measureText(txtToDraw).width;
            let clipX0;
            if (align === "left") clipX0 = 0;
            else if (align === "right") clipX0 = -wLine;
            else clipX0 = -wLine / 2;
            ctx.save();
            ctx.beginPath();
            ctx.rect(clipX0, y - lineH / 2, Math.max(0, wLine * prog), lineH);
            ctx.clip();
            ctx.fillStyle = tpl.accent || "#fff";
            ctx.fillText(txtToDraw, 0, y);
            ctx.restore();
        }
    });

    // ---- typewriter caret ----
    if (anim === "typewriter") {
        const n = Math.floor(prog * totalChars + 0.5);
        let li = 0, rem = n;
        while (li < lines.length - 1 && rem > lines[li].length) { rem -= lines[li].length + 1; li++; }
        const curLine = lines[li] || "";
        const frozen = Math.max(0, Math.min(curLine.length, rem));
        const widthSoFar = ctx.measureText(curLine.slice(0, frozen)).width;
        const caretY = startY + li * lineH;
        let caretX;
        if (align === "left") caretX = widthSoFar + 3 * scale;
        else if (align === "right") caretX = -widthSoFar - 3 * scale;
        else caretX = widthSoFar / 2 + 3 * scale;
        if (Math.floor(t * 3) % 2 === 0) {
            ctx.fillStyle = tpl.accent || "#fff";
            ctx.fillRect(caretX, caretY - fontSize * 0.42, fontSize * 0.08, fontSize * 0.85);
        }
    }

    ctx.restore();
    if (isPreview) {
        window.__titleBBox = null;
    }
}

// ===== PREVIEW-OVERLAY: selected title span par dashed box (sirf PREVIEW canvas)
function titlesDrawOverlay() {
    if (typeof previewCtx === "undefined" || !previewCtx) return;
    if (typeof titlesSpans === "undefined" || !titlesSpans.length) return;
    if (typeof selectedItems === "undefined" || !selectedItems.length) return;
    let span = null;
    for (let i = selectedItems.length - 1; i >= 0; i--) {
        if (selectedItems[i].kind === "titleSpan") {
            span = titlesSpans.find((s) => s.id === selectedItems[i].id);
            break;
        }
    }
    if (!span) return;
    const rect = document.getElementById("previewCanvas");
    if (!rect) return;
    const W = rect.width, H = rect.height;
    let ax;
    if (span.position && span.position.x != null) ax = span.position.x;
    else ax = (TITLE_ALIGN_PRESETS[span.align || "center"] || TITLE_ALIGN_PRESETS.center).x;
    const px = ax * W;
    const py = (span.position && span.position.y != null ? span.position.y : 0.22) * H;
    previewCtx.save();
    previewCtx.strokeStyle = "#ff7ab8";
    previewCtx.lineWidth = 1.5;
    previewCtx.setLineDash([5, 4]);
    const bw = Math.max(60, W * 0.5), bh = Math.max(28, H * 0.08);
    previewCtx.strokeRect(px - bw / 2, py - bh / 2, bw, bh);
    previewCtx.fillStyle = "#ffd42a";
    previewCtx.fillRect(px - bw / 2 - 4, py - bh / 2 - 4, 8, 8);
    previewCtx.restore();
}

// ===== DRAG-MOVE positions (preview canvas par — caption-drag jaisa) =====
document.addEventListener("mousedown", (e) => {
    if (e.target !== (typeof previewCanvas !== "undefined" ? previewCanvas : null)) return;
    if (typeof selectedItems === "undefined") return;
    let span = null;
    for (let i = selectedItems.length - 1; i >= 0; i--) {
        if (selectedItems[i].kind === "titleSpan") {
            span = (titlesSpans || []).find((s) => s.id === selectedItems[i].id);
            break;
        }
    }
    if (!span) return;
    const r = previewCanvas.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    let ox;
    if (span.position && span.position.x != null) ox = span.position.x;
    else ox = (TITLE_ALIGN_PRESETS[span.align || "center"] || TITLE_ALIGN_PRESETS.center).x;
    const oy = (span.position && span.position.y != null ? span.position.y : 0.22);
    if (Math.abs(px - ox) < 0.2 && Math.abs(py - oy) < 0.15) {
        window.__titleDrag = { span, startX: px, startY: py, origX: ox, origY: oy };
        e.stopPropagation();
    }
});
document.addEventListener("mousemove", (e) => {
    if (!window.__titleDrag) return;
    const r = previewCanvas.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    const s = window.__titleDrag.span;
    s.position = {
        x: Math.max(0.04, Math.min(0.96, window.__titleDrag.origX + (px - window.__titleDrag.startX))),
        y: Math.max(0.04, Math.min(0.96, window.__titleDrag.origY + (py - window.__titleDrag.startY))),
    };
});
document.addEventListener("mouseup", () => {
    if (window.__titleDrag) {
        window.__titleDrag = null;
        if (typeof persistTimelineState === "function") persistTimelineState();
    }
});

// ===== TIMELINE-LAYER SPECIFIC CALLBACKS (timeline.js generic engine) =====

function titlesDefaultSpanData(start, end, opts) {
    const base = (typeof virtualTime === "number" && isFinite(virtualTime)) ? virtualTime : 0;
    const align = (opts && opts.align) || titlesAlign || "center";
    // align-preset X span-creation par LOCK (glitch fix: position bad men sync se
    // rewrite nahi hogi; user drag karke override kar sakta hai)
    const presetX = (TITLE_ALIGN_PRESETS[align] || TITLE_ALIGN_PRESETS.center).x;
    const baseY = (titlesPendingPosY != null) ? titlesPendingPosY : TITLE_DEFAULT_POSITION.y;
    const baseScale = (titlesPendingScale != null) ? titlesPendingScale : 1.0;
    return {
        id: (typeof genId === "function") ? genId() : ("ttl_" + Math.random().toString(36).slice(2, 9)),
        start: (start != null) ? start : base,
        end: (end != null) ? end : base + 3,
        template: (opts && opts.template) || titlesSelectedTemplate || "boldPop",
        text: (opts && opts.text) || "",
        align: align,
        position: { x: presetX, y: baseY },
        scale: baseScale,
    };
}

// ===== PANEL (left media-bin ke neeche dropdown-window) =====
function buildTitlesPanel() {
    const wrap = document.getElementById("titlesPanel");
    if (!wrap) return;
    wrap.dataset.autoForSpan = "1";  // (TITLES FIX): mark auto-open state
    const hasCues = (typeof captionCues !== "undefined" && captionCues.length);
    const active = _titlesTargetSpan();
    wrap.innerHTML = `
        <div class="cp-header">
            <span class="cp-title">🅣 Titles <span id="tpStateLabel" class="cg-target-label"></span></span>
            <span class="cp-toggle" id="tpCollapse">▾</span>
        </div>
        <div class="cp-body" id="tpBody">
            <div class="tp-template-grid" id="tpTemplateGrid">
                ${TITLE_TEMPLATE_KEYS.map((k) => `
                    <button class="tp-template-btn ${(active && active.template === k) || (!active && titlesSelectedTemplate === k) ? "active" : ""}" data-tpl="${k}" title="${TITLE_TEMPLATES[k].label} — ${TITLE_TEMPLATES[k].desc}">
                        ${TITLE_TEMPLATES[k].label}
                    </button>`).join("")}
            </div>
            <div class="tp-align-row" style="display:flex;gap:6px;margin-top:8px">
                <button class="tp-align-btn cg-mini-btn ${((active && (active.align || "center")) === "left") ? "active" : ""}" data-align="left" style="flex:1">Left</button>
                <button class="tp-align-btn cg-mini-btn ${((active && (active.align || "center")) === "center") ? "active" : ""}" data-align="center" style="flex:1">Center</button>
                <button class="tp-align-btn cg-mini-btn ${((active && (active.align || "center")) === "right") ? "active" : ""}" data-align="right" style="flex:1">Right</button>
            </div>
            <label class="cp-label" style="margin-top:8px">Title text <span class="cp-hint">(khali = caption-cue text use hoga)</span></label>
            <input type="text" id="tpText" class="tp-text-input" placeholder="Heading text (khaali = captions-cue line)..." value="${active && active.text ? String(active.text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;") : ""}" />
            <div class="tp-row" style="display:flex;gap:8px;margin-top:8px">
                <label style="flex:1;font-size:11px;color:#b9a7ff">Size<input type="range" id="tpScale" min="0.4" max="2.5" step="0.05" value="${active && active.scale != null ? active.scale : (titlesPendingScale != null ? titlesPendingScale : 1)}" style="width:100%"/></label>
                <label style="flex:1;font-size:11px;color:#b9a7ff">PosY<input type="range" id="tpPosY" min="0.05" max="0.95" step="0.01" value="${active && active.position && active.position.y != null ? active.position.y : (titlesPendingPosY != null ? titlesPendingPosY : 0.22)}" style="width:100%"/></label>
            </div>
            <div class="tp-actions" style="display:flex;gap:6px;margin-top:8px">
                <button id="tpAddBtn" class="cg-mini-btn" style="flex:1">＋ Title add karo (playhead par)</button>
            </div>
            <div class="tp-actions" style="display:flex;gap:6px;margin-top:6px">
                <button id="tpFromCuesBtn" class="cg-mini-btn" style="flex:1" ${hasCues ? "" : "disabled title=\"Pehle Auto Captions generate karo\""}>💬 Auto Captions se titles banao</button>
            </div>
            <div class="cp-hint-line" id="tpHint">Template par click karo — SELECTED / playhead-title ka style badal jayega. Span ko timeline par drag/resize kar sakte ho.</div>
        </div>
    `;

    // ---- align-buttons: span.align set + position.x preset par place karo ----
    document.querySelectorAll(".tp-align-btn").forEach((b) => {
        b.addEventListener("click", () => {
            const span = _titlesTargetSpan();
            const align = b.dataset.align;
            titlesAlign = align;
            document.querySelectorAll(".tp-align-btn").forEach((x) => x.classList.toggle("active", x === b));
            if (span) {
                span.align = align;
                span.position = { x: (TITLE_ALIGN_PRESETS[align] || TITLE_ALIGN_PRESETS.center).x, y: (span.position && span.position.y != null ? span.position.y : TITLE_DEFAULT_POSITION.y) };
                if (typeof persistTimelineState === "function") persistTimelineState();
                document.getElementById("tpStateLabel").textContent = `(align ${align})`;
            }
        });
    });

    // ---- template-buttons: selected / playhead-span par apply karo ----
    document.querySelectorAll(".tp-template-btn").forEach((b) => {
        b.addEventListener("click", () => {
            titlesSelectedTemplate = b.dataset.tpl;
            document.querySelectorAll(".tp-template-btn").forEach((x) => x.classList.toggle("active", x === b));
            const span = _titlesTargetSpan();
            if (span) {
                span.template = titlesSelectedTemplate;
                if (typeof persistTimelineState === "function") persistTimelineState();
                document.getElementById("tpStateLabel").textContent = `(updated ${span.template})`;
            }
        });
    });

    // ---- text input: selected / playhead-span par live-update ----
    const textEl = document.getElementById("tpText");
    if (textEl) textEl.addEventListener("input", () => {
        const span = _titlesTargetSpan();
        if (span) {
            span.text = textEl.value;
            if (typeof persistTimelineState === "function") persistTimelineState();
        }
    });

    // ---- size / posY sliders: target-span par LIVE update (fix: listeners missing the) ----
    const scaleEl = document.getElementById("tpScale");
    if (scaleEl) scaleEl.addEventListener("input", () => {
        const v = parseFloat(scaleEl.value);
        const span = _titlesTargetSpan();
        if (span) {
            span.scale = v;
            const lb = document.getElementById("tpStateLabel");
            if (lb) lb.textContent = `(size ${v.toFixed(2)})`;
        } else {
            titlesPendingScale = v; // koi span nahi -> agle title ke liye default
        }
        if (typeof persistTimelineState === "function") persistTimelineState();
    });
    const posEl = document.getElementById("tpPosY");
    if (posEl) posEl.addEventListener("input", () => {
        const v = parseFloat(posEl.value);
        const span = _titlesTargetSpan();
        if (span) {
            // x preserve — slider sirf Y change karta hai (x align/drag se aata hai)
            span.position = { x: (span.position && span.position.x != null) ? span.position.x : (TITLE_ALIGN_PRESETS[span.align || titlesAlign] || TITLE_ALIGN_PRESETS.center).x, y: v };
            const lb = document.getElementById("tpStateLabel");
            if (lb) lb.textContent = `(posY ${(v * 100).toFixed(0)}%)`;
        } else {
            titlesPendingPosY = v; // koi span nahi -> agle title ke liye default
        }
        if (typeof persistTimelineState === "function") persistTimelineState();
    });

    // ---- add-button ----
    const addB = document.getElementById("tpAddBtn");
    if (addB) addB.addEventListener("click", () => {
        if (typeof createEffectSpan !== "function") return;
        if (typeof pausePlayback === "function") pausePlayback();
        if (typeof playPauseBtnEl !== "undefined" && playPauseBtnEl) playPauseBtnEl.textContent = "▶";
        const base = (typeof virtualTime === "number" && isFinite(virtualTime)) ? virtualTime : 0;
        const seededText = document.getElementById("tpText") ? document.getElementById("tpText").value : "";
        createEffectSpan("titleSpan", base, base + 3, { template: titlesSelectedTemplate, align: titlesAlign, text: seededText });
    });

    // ---- auto-captions→titles converter ----
    const fromCues = document.getElementById("tpFromCuesBtn");
    if (fromCues) fromCues.addEventListener("click", () => titlesBuildFromCaptionCues());

    // ---- collapse ----
    const tog = document.getElementById("tpCollapse");
    if (tog) tog.addEventListener("click", () => {
        const body = document.getElementById("tpBody");
        body.style.display = body.style.display === "none" ? "" : "none";
        tog.textContent = body.style.display === "none" ? "▸" : "▾";
    });
}

let titlesAlign = "center";
// pending defaults: koi target-span na ho to sliders inhe set karte hain
// (agle naye title par yahi size/pos apply hoti hai)
let titlesPendingScale = 1.0;
let titlesPendingPosY = null; // null = TITLE_DEFAULT_POSITION.y

function _titlesTargetSpan() {
    if (typeof selectedItems !== "undefined" && selectedItems.length) {
        for (let i = selectedItems.length - 1; i >= 0; i--) {
            if (selectedItems[i].kind === "titleSpan") {
                const it = (titlesSpans || []).find((s) => s.id === selectedItems[i].id);
                if (it) return it;
            }
        }
    }
    if (typeof virtualTime === "number") return titleTemplateAt(virtualTime);
    return null;
}

// ===== AUTO-CAPTIONS→TITLES (caption-cues REUSE — whisper dobara nahi challega) =====
// Timeline-time mapping: caption-cues SOURCE-time me hote hain; timeline par
// video-clip mapping (sourceStart + offset) apply kar ke is span ko TIMELINE
// position par banaya jata hai — bilkul captions-render wahi source-time-map
// use karta hai, isliye title-text us span ke ANDAR hi dikhega (frame-proof).
function titlesBuildFromCaptionCues() {
    if (typeof captionCues === "undefined" || !captionCues.length) {
        alert("Pehle Auto Captions generate karo — titles usi transcript se bante hain.");
        return;
    }
    if (typeof pushHistory === "function") pushHistory();
    // SOURCE→TIMELINE map helper (videoClips ke sourceStart/offset/speed se)
    function _srcToTimeline(srcT) {
        const clips = (typeof videoClips !== "undefined") ? videoClips : [];
        for (const c of clips) {
            const speed = c.speed || 1;
            const sT = c.sourceStart, eT = (c.sourceEnd != null) ? c.sourceEnd : sT + (c.end - c.start) * speed;
            if (srcT >= sT && srcT <= eT) return c.start + (srcT - sT) / speed;
        }
        return srcT; // fallback as-is (no-clip edge)
    }
    titlesSpans.length = 0;
    (captionCues || []).forEach((c) => {
        const tlStart = _srcToTimeline(c.start);
        const tlEnd = _srcToTimeline(Math.max(c.end, c.start + 0.2));
        let wtxt = "";
        if (c.words && c.words.length) wtxt = c.words.map((w) => (w.text || "")).join(" ").replace(/\s+/g, " ").trim();
        else if (typeof c.text === "string") wtxt = c.text.trim();
        titlesSpans.push({
            id: (typeof genId === "function") ? genId() : ("ttl" + Math.random().toString(36)),
            start: tlStart, end: Math.max(tlEnd, tlStart + 0.2),
            template: titlesSelectedTemplate || "boldPop",
            align: titlesAlign || "center",
            text: wtxt,             // word-join (cue-word text — backend cues "text" key nahi rakhte!)
            position: { x: TITLE_ALIGN_PRESETS[titlesAlign] ? TITLE_ALIGN_PRESETS[titlesAlign].x : TITLE_DEFAULT_POSITION.x, y: TITLE_DEFAULT_POSITION.y },
            scale: 1.0,
        });
    });
    titlesCues = (captionCues || []).slice(); // mirrors captions to use in title drawing
    if (typeof recalcTimelineDuration === "function") recalcTimelineDuration();
    if (typeof renderAll === "function") renderAll();
    if (typeof invalidateSnapshot === "function") invalidateSnapshot();
    if (typeof persistTimelineState === "function") persistTimelineState();
    // Panel refresh (agar open hai)
    const wrap = document.getElementById("titlesPanel");
    if (wrap && (wrap.style.display === "block" || titlesPanelOpen)) buildTitlesPanel();
    const el = document.getElementById("tpHint");
    if (el) el.textContent = `${titlesSpans.length} titles captions-transcript se ban gaye — har cue = ek heading-span.`;
}

// ===== TITLES BUTTON (timeline control me) toggle =====
function toggleTitlesPanel() {
    const wrap = document.getElementById("titlesPanel");
    if (!wrap) return;
    titlesPanelOpen = !titlesPanelOpen;
    wrap.style.display = titlesPanelOpen ? "block" : "none";
    if (titlesPanelOpen) buildTitlesPanel();
}

// media-bin collapse par titles panel bhi fold (app.js pattern — subtitles wala)
function wireTitlesBtn() {
    const btn = document.getElementById("titlesToggleBtn");
    if (!btn) return;
    btn.addEventListener("click", toggleTitlesPanel);
    const syncBtn = () => { btn.classList.toggle("active", !!titlesPanelOpen); };
    btn.addEventListener("click", () => setTimeout(syncBtn, 0));
    syncBtn();
}
wireTitlesBtn();
```

### Name: install_and_run.bat
```bat
@echo off
title Reframe Studio - Setup + Run
cd /d "%~dp0"

echo ============================================================
echo  REFRAME STUDIO - pehli baar setup + har baar run
echo ============================================================
echo.

rem ---- Python check ----
where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python nahi mila!
    echo.
    echo Python install karo: https://www.python.org/downloads/
    echo INSTALL PAR "Add python.exe to PATH" KA CHECKBOX TICK KARO.
    echo.
    pause
    exit /b 1
)
for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo [OK] Python %PYVER% mil gaya
echo.

rem ---- FFmpeg check (system ya project-local) ----
where ffmpeg >nul 2>nul
if errorlevel 1 (
    if exist "ffmpeg\ffmpeg.exe" (
        echo [OK] Portable ffmpeg mila: ffmpeg\ffmpeg.exe
    ) else (
        echo [WARN] FFmpeg nahi mila!
        echo.
        echo   Hal (koi ek):
        echo   a) CMD mein:  winget install Gyan.FFmpeg
        echo   b) ffmpeg.exe + ffprobe.exe ko is folder ke
        echo      "ffmpeg" naam ke folder mein copy kar do
        echo.
        echo App phir bhi chala raha hoon — video features
        echo ffmpeg ke baghair kaam nahi karenge.
        echo.
        pause
    )
) else (
    echo [OK] FFmpeg system mein installed hai
)
echo.

rem ---- Python libraries check + auto-install (sirf pehli baar) ----
python -c "import fastapi, uvicorn, webview" >nul 2>nul
if errorlevel 1 (
    echo [SETUP] Python libraries install ho rahi hain
    echo         (sirf PEHLI BAAR chahiye — 2-5 minute)
    echo.
    python -m pip install --upgrade pip
    python -m pip install -r requirements.txt
    if errorlevel 1 (
        echo.
        echo [ERROR] Libraries install nahi ho payi — internet
        echo connection check karo aur dobara chalao.
        echo.
        pause
        exit /b 1
    )
) else (
    echo [OK] Python libraries already installed hain
)
echo.
echo ============================================================
echo  Reframe Studio start ho rahi hai...
echo ============================================================
echo.

python launcher.py
if errorlevel 1 (
    echo.
    echo [ERROR] App crash ho gayi — upar ka error message parho.
    echo.
    pause
)
```

### Name: launcher.py
```python
import threading
import uvicorn
import webview
import sys, os

sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "backend"))
from main import app, cleanup_uploads_now

def start_server():
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")

if __name__ == "__main__":
    server_thread = threading.Thread(target=start_server, daemon=True)
    server_thread.start()

    # NOTE: webview.start() tab tak block karta hai jab tak user window band na
    # kare — isliye uske NEECHE wala code app-close par chalta hai.
    #
    # FIX: pehle window FIXED 1300x800 thi — 1366x768 jaisi screens par bottom
    # ~32px screen se BAHAR chale jate the, aur wahi par timeline ki horizontal
    # scrollbar rehti thi (isliye kabhi nazar nahi aati thi!). Ab window
    # MAXIMIZE hoti hai (taskbar ke hisaab se fit) — scrollbar hamesha andar.
    try:
        webview.create_window("Reframe Studio", "http://127.0.0.1:8000", width=1300, height=800, maximized=True)
    except TypeError:
        # purana pywebview jo 'maximized' support nahi karta — fallback
        webview.create_window("Reframe Studio", "http://127.0.0.1:8000", width=1300, height=760)
    webview.start()

    # ===== APP CLOSE: uploads khud-delete (session-only uploads) =====
    try:
        cleanup_uploads_now()
    except Exception as e:
        print(f"[cleanup] uploads delete nahi ho payi: {e}")
```

### Name: run.bat
```bat

@echo off
cd /d "%~dp0"
python launcher.py
pause
```
