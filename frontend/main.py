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
