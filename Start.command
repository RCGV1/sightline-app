#!/bin/zsh
set -e
cd -- "${0:A:h}"
if curl --silent --fail --max-time 2 http://127.0.0.1:18765/api/health | grep -q '"app": "sightline"'; then
  printf 'Sightline is already running: http://127.0.0.1:18765\n'
  exit 0
fi
if [[ ! -x .venv/bin/python ]]; then
  if [[ -x /opt/homebrew/bin/python3.12 ]]; then
    /opt/homebrew/bin/python3.12 -m venv .venv
  else
    python3 -m venv .venv
  fi
  .venv/bin/python -m pip install -r requirements.txt
fi
printf 'Open http://127.0.0.1:18765 in your browser. Keep this window open.\n'
exec .venv/bin/python server.py
