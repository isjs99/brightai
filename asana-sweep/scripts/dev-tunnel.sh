#!/bin/bash
# One command for local testing behind a public https URL:
#   starts a Cloudflare quick tunnel to :3000, writes PUBLIC_URL into .env, prints the redirect URL
#   for Partner Center, then builds and starts the dashboard. Ctrl+C stops both.
# Needs the cloudflared binary (default ~/Downloads/cloudflared) or CLOUDFLARED=/path/to/cloudflared.
set -euo pipefail
cd "$(dirname "$0")/.."
CF="${CLOUDFLARED:-$HOME/Downloads/cloudflared}"
if [ ! -x "$CF" ]; then
  echo "cloudflared not found at $CF. Download it:"
  echo "  cd ~/Downloads && curl -L -o cloudflared.tgz \"https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-\$(uname -m | sed 's/x86_64/amd64/').tgz\" && tar -xzf cloudflared.tgz && chmod +x cloudflared"
  exit 1
fi
[ -f .env ] || cp .env.example .env
LOG="$(mktemp -t tunnel)"
"$CF" tunnel --url http://localhost:3000 > "$LOG" 2>&1 &
CF_PID=$!
trap 'kill $CF_PID 2>/dev/null; exit 0' INT TERM EXIT
echo "Starting the tunnel…"
URL=""
for _ in $(seq 1 40); do
  URL="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 1
done
if [ -z "$URL" ]; then echo "Tunnel did not come up. Log:"; cat "$LOG"; exit 1; fi
# One PUBLIC_URL line, set to the tunnel.
grep -v '^PUBLIC_URL=' .env > .env.tmp || true
echo "PUBLIC_URL=$URL" >> .env.tmp
mv .env.tmp .env
echo
echo "================================================================"
echo "Public URL:            $URL"
echo "Partner Center redirect: $URL/api/tts/callback"
echo "================================================================"
echo
if ! grep -q '^TTS_APP_KEY=.\+' .env || ! grep -q '^TTS_APP_SECRET=.\+' .env; then
  echo "TTS_APP_KEY / TTS_APP_SECRET are not set in .env yet. Add them (open -e .env) and rerun."
fi
lsof -ti :3000 | xargs kill 2>/dev/null || true
npm run build >/dev/null
echo "Dashboard starting on $URL (Ctrl+C stops the tunnel and the dashboard)"
npm start
