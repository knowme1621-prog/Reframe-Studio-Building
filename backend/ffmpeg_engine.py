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


