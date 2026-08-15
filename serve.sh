#!/usr/bin/env bash
#
# Serve the uploader on port 8081, reachable from any device on the same wifi,
# the way the booth itself is.
#
# Same page, same Worker, same buckets. This is NOT a test environment: anything
# deleted here is deleted from the museum's booth. The only difference is where
# the HTML came from.
#
# The serving is done by serve.py, not `python -m http.server`, because that one
# hands out every file under this folder to whoever asks, .git and the whole
# commit history included. serve.py answers for three files and 404s the rest.
#
# From this Mac, http://localhost:8081/ needs no phrase: local-key.js supplies
# it. From another device it does, because the page only trusts that file when
# it is being served from localhost, so the network link printed below carries
# the phrase in its fragment.

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
#
# Skipped when there is no terminal to ask at, which is how this runs from
# start.sh under launchd. Prompting there would hang the booth's own startup
# waiting for an answer nobody can give.
if [ ! -f "$KEYFILE" ] && [ -t 0 ]; then
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

LAN=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")

printf '\n\033[1mOverlay uploader\033[0m\n'
printf '  \033[32m✓\033[0m On this Mac:   http://localhost:%s/\n' "$PORT"
printf '                    no phrase needed, %s supplies it\n' "$KEYFILE"
if [ -n "$LAN" ]; then
  printf '  \033[32m✓\033[0m On the wifi:   http://%s:%s/#PHRASE\n' "$LAN" "$PORT"
  printf '                    replace PHRASE with the four words\n'
fi
printf '    Ctrl-C to stop.\n\n'

exec python3 serve.py "$PORT"
