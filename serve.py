#!/usr/bin/env python3
"""
Serve the uploader on the local network.

Deliberately not `python -m http.server`. That one hands out every file under
the folder it is started in, which here includes .git, and therefore the whole
commit history, to anyone who can reach the port. On a venue network that is a
worse problem than the thing this script exists to solve, so this serves an
explicit allowlist of three files and answers 404 to everything else.

Binds every interface, so an iPad on the same wifi can reach it the way it
reaches the booth. The phrase is still required from another device: local-key.js
is only honoured when the page is served from localhost, so the link printed for
the network carries the phrase in its fragment.
"""

import socket
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8081

# Everything the page needs and nothing else. local-key.js is optional and
# gitignored; it only exists on a machine where ./serve.sh has been run.
LOOPBACK = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}

SERVE = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/local-key.js": ("local-key.js", "text/javascript; charset=utf-8"),
}


class Handler(BaseHTTPRequestHandler):
    server_version = "overlay-uploader"

    def do_GET(self):
        # Query and fragment are not part of the path, but a stray "?" would
        # otherwise turn a known path into an unknown one.
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        entry = SERVE.get(path)
        if entry is None:
            self.send_error(404, "Not found")
            return

        # local-key.js holds the phrase in the clear, so it goes to this machine
        # and nowhere else. Serving it across the wifi would hand the phrase to
        # everyone on the network, which is worse than the typing it saves: the
        # page would not even use it from there, since it only trusts that file
        # when the hostname is localhost. From another device, the phrase goes
        # in the URL fragment instead.
        if path == "/local-key.js" and self.client_address[0] not in LOOPBACK:
            self.send_error(404, "Not found")
            return

        target = ROOT / entry[0]
        try:
            body = target.read_bytes()
        except OSError:
            # local-key.js is expected to be missing on a fresh checkout, and
            # index.html has an onerror on that tag, so a 404 is the right and
            # quiet answer rather than an error.
            self.send_error(404, "Not found")
            return

        self.send_response(200)
        self.send_header("Content-Type", entry[1])
        self.send_header("Content-Length", str(len(body)))
        # The page is edited and reloaded constantly while it is being worked
        # on, and a cached copy of app.js looks exactly like a change that did
        # not work. Same reasoning as the booth serving / and /static no-store.
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # One line per request would bury the booth's own output when this runs
        # from start.sh. Errors still surface: log_error routes here too, so
        # keep those.
        if str(args[1] if len(args) > 1 else "").startswith(("4", "5")):
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
    print(f"  serving on {lan_address()}:{PORT}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
