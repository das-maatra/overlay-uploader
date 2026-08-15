#!/usr/bin/env python3
"""
Serve the uploader on the local network, and stand in front of the Worker.

Two jobs. It serves the page, and it proxies the page's API calls to the Worker
with the phrase attached.

**The proxy is the point.** The phrase lives in .phrase on this machine and is
added to each request here, so no device that opens this page ever needs it and
the browser never receives it. Handing the phrase to the browser instead would
have worked, and would also have handed it to everyone on the wifi, along with
access to the public GitHub Pages link, which uses the same phrase. This way,
what the wifi gets is the ability to use the tool, not the credential itself.

The consequence, and it is deliberate: anyone on the same network who opens this
address can add and delete frames with nothing to prove. That is the same
posture as the booth, which listens on every interface with no password at all.
On a venue network, treat both the same way.

Deliberately not `python -m http.server`. That serves every file under the folder
it started in, which here would publish .git and the whole commit history to
whoever can reach the port. This answers for an allowlist and 404s the rest.
"""

import json
import socket
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8081

# Where the Worker lives. Read from app.js rather than repeated here, so the two
# cannot disagree about which deployment is being talked to.
def worker_url() -> str:
    for line in (ROOT / "app.js").read_text().splitlines():
        if line.startswith("const WORKER"):
            return line.split("'")[1].rstrip("/")
    raise SystemExit("Could not find the Worker address in app.js")


WORKER = worker_url()
PHRASE = ""
phrase_file = ROOT / ".phrase"
if phrase_file.exists():
    PHRASE = phrase_file.read_text().strip()

SERVE = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
}

# Tells the page it is being served by this script, so it calls /api here rather
# than the Worker directly and sends no phrase of its own. Contains no secret,
# which is why it can go to any device. Withheld when there is no phrase to
# proxy with, so the page falls back to asking for one in the URL rather than
# silently failing every request.
CONFIG_JS = b"window.OVERLAY_PROXY = true;\n"

MAX_UPLOAD = 12 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    server_version = "overlay-uploader"
    protocol_version = "HTTP/1.1"

    # -- plumbing ---------------------------------------------------------

    def _send(self, status, body=b"", ctype="application/json; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _static(self, path):
        if path == "/local-config.js":
            if not PHRASE:
                self._send(404, b"", "text/plain")
                return
            self._send(200, CONFIG_JS, "text/javascript; charset=utf-8")
            return
        entry = SERVE.get(path)
        if entry is None:
            self._send(404, b"Not found", "text/plain; charset=utf-8")
            return
        try:
            body = (ROOT / entry[0]).read_bytes()
        except OSError:
            self._send(404, b"Not found", "text/plain; charset=utf-8")
            return
        self._send(200, body, entry[1])

    def _proxy(self):
        """Pass an /api call to the Worker with the phrase attached.

        Same-origin from the browser's point of view, so there is no CORS in
        this path at all and no preflight to answer.
        """
        if not PHRASE:
            self._send(503, json.dumps(
                {"error": "No .phrase on this machine, so this server cannot "
                          "reach the Worker. Run ./serve.sh to set one."}).encode())
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_UPLOAD:
            self._send(413, json.dumps({"error": "That file is too large."}).encode())
            return
        body = self.rfile.read(length) if length else None

        req = urllib.request.Request(
            WORKER + self.path,
            data=body,
            method=self.command,
            headers={
                "x-overlay-key": PHRASE,
                "content-type": self.headers.get("Content-Type", "application/octet-stream"),
                # Cloudflare answers urllib's default "Python-urllib/3.x" with a
                # 403 and error code 1010, which is its "your browser signature
                # is banned" response. Nothing to do with the phrase or the
                # Worker's own code, and the failure reads as an auth problem if
                # you do not know to look for the 1010.
                "user-agent": "overlay-uploader-proxy",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                payload = r.read()
                ctype = r.headers.get("Content-Type", "application/json")
                status = r.status
        except urllib.error.HTTPError as e:
            payload = e.read()
            ctype = e.headers.get("Content-Type", "application/json")
            status = e.code
        except (urllib.error.URLError, OSError) as e:
            # The Worker is unreachable, which is a different thing from it
            # saying no, and the page should say so rather than "not authorised".
            self._send(502, json.dumps(
                {"error": f"Could not reach the Worker: {e}"}).encode())
            return
        self._send(status, payload, ctype)

    # -- verbs ------------------------------------------------------------

    def do_GET(self):
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        if path.startswith("/api/"):
            self._proxy()
        else:
            self._static(path)

    def do_HEAD(self):
        self.do_GET()

    def do_PUT(self):
        if self.path.startswith("/api/"):
            self._proxy()
        else:
            self._send(405, b"", "text/plain")

    def do_DELETE(self):
        if self.path.startswith("/api/"):
            self._proxy()
        else:
            self._send(405, b"", "text/plain")

    def log_message(self, fmt, *args):
        # One line per request would bury the booth's own output when this is
        # started from start.sh. Failures still surface.
        code = str(args[1]) if len(args) > 1 else ""
        if code.startswith(("4", "5")):
            sys.stderr.write("  uploader: %s\n" % (fmt % args))


def lan_address() -> str:
    """This machine's address on the local network, as an iPad would reach it.

    Asks the routing table by opening a UDP socket to an address it never sends
    to, which is the reliable way to find the interface actually in use. No
    packet leaves the machine.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 1))  # TEST-NET-1, reserved and unroutable
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"  serving on {lan_address()}:{PORT}"
          f"{'' if PHRASE else '  (no .phrase: the page will ask for one)'}",
          flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
