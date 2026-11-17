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

    # 1MB chunks: badi (1GB+) video RAM mein poori load nahi hoti
    with open(saved_path, "wb") as f:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)

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
