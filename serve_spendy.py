#!/usr/bin/env python3
"""
Spendy Sync Server
- Serves Spendy.html + static files
- POST /sync/backup → save snapshot to spendy-sync.json
- GET  /sync/backup → return latest snapshot

(The Gemini CLI history viewer is now a separate project — see ../GeminiHistory/serve_gemini.py.)
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

FILE = Path(__file__).resolve()
SERVE_DIR = str(FILE.parent)
SYNC_FILE = FILE.parent / "spendy-sync.json"

class SpendyHandler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=SERVE_DIR, **kw)

    def do_GET(self):
        if self.path == "/sync/backup":
            self.serve_backup()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path == "/sync/backup":
            self.save_backup()
        else:
            self.send_error(405)

    # ---- backup endpoints ----

    def serve_backup(self):
        if not SYNC_FILE.exists():
            self.send_response(204)
            self.end_headers()
            return

        mtime = SYNC_FILE.stat().st_mtime
        ims = self.headers.get("If-Modified-Since")
        if ims:
            try:
                client_time = datetime.strptime(ims, "%a, %d %b %Y %H:%M:%S %Z").timestamp()
                if mtime <= client_time:
                    self.send_response(304)
                    self.end_headers()
                    return
            except ValueError:
                pass

        data = SYNC_FILE.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Last-Modified", datetime.fromtimestamp(mtime, timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT"))
        self.end_headers()
        self.wfile.write(data)

    def save_backup(self):
        length = int(self.headers.get("Content-Length", 0))
        if not length:
            self.send_error(400, "Empty body")
            return
        body = self.rfile.read(length)
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self.send_error(400, "Invalid JSON")
            return

        SYNC_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, fmt, *args):
        pass  # clean terminal

def open_browser(url):
    try:
        if sys.platform == "win32":
            os.startfile(url)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", url])
        else:
            subprocess.Popen(["xdg-open", url])
    except Exception:
        pass

if __name__ == "__main__":
    port = 8765
    url = f"http://localhost:{port}/Spendy.html"
    print(f"  Spendy Sync Server running at {url}")
    print(f"  Press Ctrl+C to stop\n")
    open_browser(url)
    server = HTTPServer(("127.0.0.1", port), SpendyHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()
        print("\n  Stopped.")
