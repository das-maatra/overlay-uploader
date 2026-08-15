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
KEYFILE=local-key.js

# The phrase, so http://localhost:8081/ works without it on the end of the URL.
#
# Written here rather than committed, because this repository is public and the
# phrase is the only thing standing between the internet and a bucket the
# museum's booth reads. Gitignored, and readable by this user only. app.js
# ignores it unless the page is actually being served from localhost.
if [ ! -f "$KEYFILE" ]; then
  printf '\n\033[1mFirst run\033[0m\n'
  printf '  No %s yet. Enter the phrase once and it will be remembered.\n' "$KEYFILE"
  printf '  Phrase: ' >&2
  read -rs phrase
  printf '\n' >&2
  if [ -z "$phrase" ]; then
    printf '  \033[31m✗\033[0m Nothing entered. Run again, or use the #phrase on the URL.\n' >&2
    exit 1
  fi
  # Written through printf %s and JSON-quoted, so a phrase containing a quote
  # cannot end the string early and turn the rest of it into code.
  printf 'window.OVERLAY_KEY = %s;\n' "$(printf '%s' "$phrase" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" > "$KEYFILE"
  chmod 600 "$KEYFILE"
  printf '  \033[32m✓\033[0m Saved to %s (gitignored, this user only)\n' "$KEYFILE"
fi

if lsof -ti ":$PORT" >/dev/null 2>&1; then
  printf '  \033[31m✗\033[0m Something is already listening on %s. Stop it first:\n' "$PORT" >&2
  printf '      lsof -ti :%s | xargs kill\n' "$PORT" >&2
  exit 1
fi

printf '\n\033[1mOverlay uploader\033[0m\n'
printf '  \033[32m✓\033[0m http://localhost:%s/\n' "$PORT"
printf '    No phrase needed on the URL here; %s supplies it.\n' "$KEYFILE"
printf '    Ctrl-C to stop.\n\n'

exec python3 -m http.server "$PORT" --bind 127.0.0.1
