# syntax=docker/dockerfile:1
# =============================================================================
# 21-external — mt5-bridge: a real MetaTrader 5 terminal, headless, under Wine
# =============================================================================
# There is no open-source MT5 server API. What is freely downloadable is the
# terminal itself and MetaQuotes' `MetaTrader5` Python package, which talks to
# a running terminal — on Windows. This image runs both under Wine, the way
# the community images (e.g. gmag11/MetaTrader5-Docker-Image, MIT) do, and
# fronts them with `bridge.py`, which speaks the Project X bridge protocol.
#
# It is deliberately in its own profile (`external`): it is large, it needs a
# display server, and it holds a trading login. Nothing in the core depends
# on it being up (INV-200); the simulator carries CI.
#
# Every download below is a public artefact: Ubuntu, WineHQ, python.org, the
# MetaQuotes CDN. The build is reproducible to the extent those are.
# =============================================================================

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    WINEPREFIX=/home/app/.wine \
    WINEARCH=win64 \
    WINEDEBUG=-all \
    # No Mono, no Gecko: neither is needed, and their installers are dialogs
    # that wait forever for a click nobody can give under Xvfb. No winedbg:
    # a crash must exit, not attach a debugger and wait forever.
    WINEDLLOVERRIDES="mscoree=d;mshtml=d;winedbg.exe=d" \
    PORT=8000

RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg xvfb xauth cabextract unzip \
 && mkdir -pm755 /etc/apt/keyrings \
 && curl -fsSL https://dl.winehq.org/wine-builds/winehq.key -o /etc/apt/keyrings/winehq-archive.key \
 && curl -fsSL https://dl.winehq.org/wine-builds/ubuntu/dists/noble/winehq-noble.sources -o /etc/apt/sources.list.d/winehq-noble.sources \
 && apt-get update \
 # Wine 10.0, pinned. Under Wine 11 the MetaQuotes installer's anti-tamper
 # check reports "a debugger has been found" and never installs; under 10.0
 # it installs in about a minute. The pin is the difference between an image
 # that works and one that hangs.
 && apt-get install -y --no-install-recommends \
      winehq-stable=10.0.0.0~noble-1 wine-stable=10.0.0.0~noble-1 \
      wine-stable-amd64=10.0.0.0~noble-1 wine-stable-i386:i386=10.0.0.0~noble-1 \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 10001 app
USER app
WORKDIR /home/app

# A 64-bit prefix, Windows Python, and the package. `wineboot` initialises the
# prefix headless (it needs no display for that); the Python installer is
# silent; pip runs under Wine.
RUN wineboot --init && wineserver -w \
 && curl -fsSL https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe -o /tmp/python.exe \
 && xvfb-run -a wine /tmp/python.exe /quiet InstallAllUsers=1 PrependPath=1 Include_test=0 TargetDir='C:\Python311' \
 && rm /tmp/python.exe \
 # numpy 2 calls ucrtbase.crealf, which Wine 10 does not implement, and the
 # package imports numpy; 1.26 does not, and MetaTrader5 is happy with it.
 && xvfb-run -a wine 'C:\Python311\python.exe' -m pip install --no-cache-dir --disable-pip-version-check "numpy<2" MetaTrader5

# The terminal. `/auto` downloads and installs silently into Program Files
# inside the prefix; the installer then lingers on an advertisement, so the
# build waits for terminal64.exe to exist rather than for the installer to end.
RUN curl -fsSL https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe -o /tmp/mt5setup.exe \
 && (xvfb-run -a wine /tmp/mt5setup.exe /auto >/tmp/mt5setup.log 2>&1 &) \
 && for i in $(seq 1 60); do \
      [ -f "/home/app/.wine/drive_c/Program Files/MetaTrader 5/terminal64.exe" ] && break; sleep 5; \
    done \
 && sleep 10 && wineserver -k || true \
 && rm -f /tmp/mt5setup.exe \
 && ls -la "/home/app/.wine/drive_c/Program Files/MetaTrader 5/terminal64.exe"

WORKDIR /app
COPY --chown=app:app bridge.py entrypoint.sh ./

EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD curl -fsS http://localhost:8000/health || exit 1
ENTRYPOINT ["/app/entrypoint.sh"]
