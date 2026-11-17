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
