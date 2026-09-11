#!/usr/bin/env bash
# The MT5 terminal needs a display even when nobody looks at it; Xvfb is that
# display. The bridge is Windows Python under Wine, because the MetaTrader5
# package is Windows-only. Everything here is free to download and open to
# inspect; the one thing it cannot supply is a login.
set -euo pipefail
export DISPLAY=:99
Xvfb :99 -screen 0 1024x768x16 -nolisten tcp >/dev/null 2>&1 &
sleep 1
if [ -z "${MT5_LOGIN:-}" ] || [ -z "${MT5_PASSWORD:-}" ] || [ -z "${MT5_SERVER:-}" ]; then
  echo '{"level":"warn","service":"mt5-bridge","message":"MT5_LOGIN/MT5_PASSWORD/MT5_SERVER not set — serving as unconfigured"}'
fi
if [ -x "${WINEPREFIX}/drive_c/Program Files/MetaTrader 5/terminal64.exe" ]; then
  # Portable mode keeps the terminal's data inside its own directory, on the
  # volume, so a restart does not re-download history.
  wine "${WINEPREFIX}/drive_c/Program Files/MetaTrader 5/terminal64.exe" /portable >/dev/null 2>&1 &
  sleep 5
fi
exec wine "${WINEPREFIX}/drive_c/Python311/python.exe" /app/bridge.py
