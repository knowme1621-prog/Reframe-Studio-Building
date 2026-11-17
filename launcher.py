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
