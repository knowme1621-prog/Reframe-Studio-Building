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
