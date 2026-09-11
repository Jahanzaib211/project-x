"""
21-external — the MT5 bridge.

Speaks the Project X bridge protocol (see services/mt5-sim/src/protocol.md)
on one side and MetaQuotes' `MetaTrader5` Python package on the other. The
package only exists for Windows Python, so in the container this runs under
Wine beside a headless MT5 terminal; on a Windows host it runs as-is.

The platform is never the financial source of truth (INV-200). This process
reads and mirrors; it decides nothing. Without `MT5_LOGIN`, `MT5_PASSWORD`
and `MT5_SERVER` it serves `state: unconfigured` and every data endpoint is
an honest 503 — never an invented quote.

Standard library only, on purpose: the process that holds a trading login
should carry the smallest surface that can do the job.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

try:  # The package is Windows-only; its absence is a state, not a crash.
    import MetaTrader5 as mt5  # type: ignore
except Exception:  # noqa: BLE001
    mt5 = None

PORT = int(os.environ.get("PORT", "8000"))
LOGIN = os.environ.get("MT5_LOGIN", "")
PASSWORD = os.environ.get("MT5_PASSWORD", "")
SERVER = os.environ.get("MT5_SERVER", "")
TERMINAL_PATH = os.environ.get("MT5_TERMINAL_PATH", "")
POLL_MS = int(os.environ.get("MT5_POLL_MS", "100"))

STATE = {"state": "unconfigured", "detail": "MT5_LOGIN, MT5_PASSWORD and MT5_SERVER are not set", "lastTickMs": 0}
LOCK = threading.Lock()


def log(level: str, message: str, **fields: object) -> None:
    sys.stdout.write(json.dumps({"ts": int(time.time() * 1000), "level": level, "service": "mt5-bridge",
                                 "module_id": "21-external", "tier": "T4", "message": message, **fields}) + "\n")
    sys.stdout.flush()


def dec(value: float, digits: int) -> str:
    """A float from the package rendered at the symbol's precision. The core
    snaps it to the grid again; this is the best a float can be made."""
    return f"{value:.{digits}f}"


def connect() -> None:
    """Bring the terminal up and log in. Retries forever; state says where it is."""
    if mt5 is None:
        STATE.update(state="unconfigured", detail="the MetaTrader5 package is not importable here (Windows Python under Wine is required)")
        return
    if not (LOGIN and PASSWORD and SERVER):
        return
    while True:
        STATE.update(state="connecting", detail=f"initialising terminal for {SERVER}")
        kwargs = {"login": int(LOGIN), "password": PASSWORD, "server": SERVER}
        if TERMINAL_PATH:
            kwargs["path"] = TERMINAL_PATH
        ok = mt5.initialize(**kwargs)
        if ok:
            info = mt5.terminal_info()
            STATE.update(state="connected", detail=f"connected to {SERVER}", build=getattr(info, "build", 0))
            log("info", "connected", server=SERVER, login=LOGIN)
            return
        code, text = mt5.last_error()
        STATE.update(state="degraded", detail=f"initialize failed ({code}): {text}")
        log("warn", "initialize failed", code=code, detail=text)
        time.sleep(10)


def digits_of(symbol: str) -> int:
    info = mt5.symbol_info(symbol) if mt5 else None
    return int(getattr(info, "digits", 5)) if info else 5


def ensure_selected(symbol: str) -> bool:
    if mt5 is None:
        return False
    info = mt5.symbol_info(symbol)
    if info is None:
        return False
    if not info.visible:
        return bool(mt5.symbol_select(symbol, True))
    return True


class Handler(BaseHTTPRequestHandler):
    server_version = "projectx-mt5-bridge/1"

    def log_message(self, *_args: object) -> None:  # quiet the default access log
        return

    def send_json(self, status: int, body: object) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def not_connected(self) -> bool:
        if STATE["state"] != "connected":
            self.send_json(503, {"error": "bridge_not_connected", "state": STATE["state"], "detail": STATE["detail"]})
            return True
        return False

    def do_GET(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        query = parse_qs(url.query)
        if url.path == "/health":
            return self.send_json(200, {"status": "healthy", "service": "mt5-bridge", "module_id": "21-external", "tier": "T4", "bridge": {"state": STATE["state"]}})
        if url.path == "/v1/state":
            return self.send_json(200, {**STATE, "server": SERVER, "login": LOGIN, "simulated": False})
        if self.not_connected():
            return None
        with LOCK:
            if url.path == "/v1/symbols":
                out = []
                for s in mt5.symbols_get() or []:
                    out.append({"symbol": s.name, "digits": s.digits, "contractSize": s.trade_contract_size, "description": s.description})
                return self.send_json(200, out)
            if url.path == "/v1/account":
                a = mt5.account_info()
                if a is None:
                    return self.send_json(503, {"error": "account_unavailable"})
                return self.send_json(200, {"login": str(a.login), "currency": a.currency, "leverage": a.leverage,
                                            "balance": dec(a.balance, 2), "equity": dec(a.equity, 2),
                                            "margin": dec(a.margin, 2), "freeMargin": dec(a.margin_free, 2)})
            if url.path == "/v1/positions":
                out = []
                for p in mt5.positions_get() or []:
                    d = digits_of(p.symbol)
                    out.append({"ticket": p.ticket, "symbol": p.symbol, "type": "BUY" if p.type == 0 else "SELL",
                                "volume": dec(p.volume, 3), "priceOpen": dec(p.price_open, d), "priceCurrent": dec(p.price_current, d),
                                "profit": dec(p.profit, 2), "comment": p.comment, "timeMs": int(p.time_msc)})
                return self.send_json(200, out)
            if url.path == "/v1/deals":
                since = int(query.get("since", ["0"])[0])
                start = datetime.now(timezone.utc) - timedelta(days=30)
                out = []
                for d in sorted(mt5.history_deals_get(start, datetime.now(timezone.utc) + timedelta(days=1)) or [], key=lambda x: x.ticket):
                    if d.ticket <= since or d.symbol == "":
                        continue
                    dg = digits_of(d.symbol)
                    out.append({"ticket": d.ticket, "order": d.order, "positionId": d.position_id, "symbol": d.symbol,
                                "type": "BUY" if d.type == 0 else "SELL", "entry": "IN" if d.entry == 0 else "OUT",
                                "volume": dec(d.volume, 3), "price": dec(d.price, dg), "profit": dec(d.profit, 2),
                                "commission": dec(d.commission, 2), "comment": d.comment, "timeMs": int(d.time_msc)})
                return self.send_json(200, out)
            if url.path == "/v1/candles":
                symbol = query.get("symbol", [""])[0]
                timeframe = {"M1": mt5.TIMEFRAME_M1, "M5": mt5.TIMEFRAME_M5, "M15": mt5.TIMEFRAME_M15, "H1": mt5.TIMEFRAME_H1}.get(query.get("timeframe", ["M1"])[0], mt5.TIMEFRAME_M1)
                count = min(2000, max(1, int(query.get("count", ["200"])[0])))
                if not ensure_selected(symbol):
                    return self.send_json(404, {"error": "unknown_symbol"})
                d = digits_of(symbol)
                rates = mt5.copy_rates_from_pos(symbol, timeframe, 0, count)
                out = [{"ms": int(r["time"]) * 1000, "open": dec(float(r["open"]), d), "high": dec(float(r["high"]), d),
                        "low": dec(float(r["low"]), d), "close": dec(float(r["close"]), d), "volume": str(int(r["tick_volume"]))}
                       for r in (rates if rates is not None else [])]
                return self.send_json(200, out)
        if url.path == "/v1/ticks":
            return self.stream_ticks(query)
        return self.send_json(404, {"error": "not_found", "path": url.path})

    def stream_ticks(self, query: dict) -> None:
        wanted = [s for s in query.get("symbols", [""])[0].split(",") if s]
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(b": bridge protocol v1\n\n")
        with LOCK:
            wanted = [s for s in wanted if ensure_selected(s)]
        last = {}
        seq = 0
        beat = time.time()
        try:
            while True:
                with LOCK:
                    for symbol in wanted:
                        t = mt5.symbol_info_tick(symbol)
                        if t is None:
                            continue
                        key = (t.bid, t.ask, t.time_msc)
                        if last.get(symbol) == key:
                            continue
                        last[symbol] = key
                        seq += 1
                        d = digits_of(symbol)
                        line = {"symbol": symbol, "bid": dec(t.bid, d), "ask": dec(t.ask, d), "ms": int(t.time_msc), "seq": seq}
                        self.wfile.write(f"data: {json.dumps(line)}\n\n".encode("utf-8"))
                        STATE["lastTickMs"] = int(time.time() * 1000)
                if time.time() - beat > 5:
                    self.wfile.write(b"event: heartbeat\ndata: {}\n\n")
                    beat = time.time()
                self.wfile.flush()
                time.sleep(POLL_MS / 1000)
        except (BrokenPipeError, ConnectionResetError):
            return

    def do_POST(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        length = int(self.headers.get("content-length", "0"))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self.send_json(400, {"error": "bad_json"})
        if self.not_connected():
            return None
        with LOCK:
            if url.path == "/v1/orders":
                symbol = str(body.get("symbol", ""))
                side = str(body.get("type", ""))
                if not ensure_selected(symbol) or side not in ("BUY", "SELL"):
                    return self.send_json(422, {"retcode": 10014, "detail": "invalid symbol or type"})
                tick = mt5.symbol_info_tick(symbol)
                request = {
                    "action": mt5.TRADE_ACTION_DEAL, "symbol": symbol, "volume": float(body.get("volume", "0")),
                    "type": mt5.ORDER_TYPE_BUY if side == "BUY" else mt5.ORDER_TYPE_SELL,
                    "price": tick.ask if side == "BUY" else tick.bid, "deviation": 20,
                    "comment": str(body.get("comment", ""))[:31], "type_filling": mt5.ORDER_FILLING_IOC, "type_time": mt5.ORDER_TIME_GTC,
                }
                r = mt5.order_send(request)
                out = {"retcode": r.retcode, "order": r.order, "deal": r.deal, "price": dec(r.price, digits_of(symbol)), "detail": r.comment}
                log("info", "order", **out, symbol=symbol, type=side)
                return self.send_json(200 if r.retcode == 10009 else 422, out)
            if url.path == "/v1/positions/close":
                ticket = int(body.get("ticket", 0))
                found = [p for p in (mt5.positions_get(ticket=ticket) or [])]
                if not found:
                    return self.send_json(422, {"retcode": 10036, "detail": "position not found"})
                p = found[0]
                tick = mt5.symbol_info_tick(p.symbol)
                request = {
                    "action": mt5.TRADE_ACTION_DEAL, "symbol": p.symbol, "volume": p.volume, "position": ticket,
                    "type": mt5.ORDER_TYPE_SELL if p.type == 0 else mt5.ORDER_TYPE_BUY,
                    "price": tick.bid if p.type == 0 else tick.ask, "deviation": 20, "comment": p.comment,
                    "type_filling": mt5.ORDER_FILLING_IOC, "type_time": mt5.ORDER_TIME_GTC,
                }
                r = mt5.order_send(request)
                return self.send_json(200 if r.retcode == 10009 else 422, {"retcode": r.retcode, "order": r.order, "deal": r.deal, "price": dec(r.price, digits_of(p.symbol)), "detail": r.comment})
        return self.send_json(404, {"error": "not_found", "path": url.path})


def main() -> None:
    threading.Thread(target=connect, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log("info", f"listening on 0.0.0.0:{PORT}", package=("present" if mt5 else "absent"), configured=bool(LOGIN and PASSWORD and SERVER))
    server.serve_forever()


if __name__ == "__main__":
    main()
