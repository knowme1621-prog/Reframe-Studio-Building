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
