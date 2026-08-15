#!/usr/bin/env bash
#
# Serve this folder at http://localhost:8081, so the uploader can be used from a
# checkout instead of from GitHub Pages.
#
# Same page, same Worker, same buckets. This is NOT a test environment: anything
# deleted here is deleted from the museum's booth. The only difference is where
# the HTML came from.
#
# 8081 specifically, because the Worker's ALLOWED_ORIGINS names that port. Serve
# it anywhere else and the browser blocks every request as a cross origin one.
#
# Bound to 127.0.0.1 rather than the default 0.0.0.0. Python's http.server will
# hand out any file under this folder to anyone who asks, .git included, and
# there is no reason for that to be reachable from the venue wifi.

set -euo pipefail
cd "$(dirname "$0")"

PORT=8081

if lsof -ti ":$PORT" >/dev/null 2>&1; then
  printf '  \033[31m✗\033[0m Something is already listening on %s. Stop it first:\n' "$PORT" >&2
  printf '      lsof -ti :%s | xargs kill\n' "$PORT" >&2
  exit 1
fi

printf '\n\033[1mOverlay uploader\033[0m\n'
printf '  \033[32m✓\033[0m http://localhost:%s/#the-hand-the-eye\n' "$PORT"
printf '    The part after the # is required. Without it the page will not work.\n'
printf '    Ctrl-C to stop.\n\n'

exec python3 -m http.server "$PORT" --bind 127.0.0.1
