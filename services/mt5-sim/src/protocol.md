# The Project X bridge protocol (v1)

Spoken by every MT5 bridge — the real terminal under Wine (`services/mt5-bridge`)
and this simulator alike — and consumed by the feed gateway (`13-lp-connectivity`)
and the external reconciler (`21-external`). One dialect on this side of the
adapter, whatever the platform speaks on the other (INV-120, INV-200).

| Method | Path | Meaning |
|---|---|---|
| GET | `/health` | Liveness: `{status, service, bridge:{state}}` |
| GET | `/v1/state` | `{state, server, login, build, lastTickMs, detail}` — `unconfigured` \| `connecting` \| `connected` \| `degraded` |
| GET | `/v1/symbols` | `[{symbol, digits, contractSize, description}]` |
| GET | `/v1/ticks?symbols=A,B` | Server-sent events: `data: {symbol, bid, ask, ms, seq}`; `event: heartbeat` every 5 s |
| GET | `/v1/candles?symbol=&timeframe=M1&count=` | `[{ms, open, high, low, close, volume}]`, oldest first |
| GET | `/v1/account` | `{login, currency, leverage, balance, equity, margin, freeMargin}` |
| GET | `/v1/positions` | `[{ticket, symbol, type, volume, priceOpen, priceCurrent, profit, comment, timeMs}]` |
| GET | `/v1/deals?since=<ticket>` | Deals with ticket > since, oldest first: `[{ticket, order, positionId, symbol, type, entry, volume, price, profit, commission, comment, timeMs}]` |
| POST | `/v1/orders` | `{symbol, type: BUY\|SELL, volume, comment}` → `{retcode, order, deal, price}`; `retcode` 10009 is done |
| POST | `/v1/positions/close` | `{ticket}` → as above |

Prices and volumes are decimal strings. `type` is `BUY` or `SELL`; `entry` is
`IN` or `OUT`. `comment` is where the core's order id travels to the platform
and back — it is what makes a mirrored order recognisable on the way home.

The simulator adds one endpoint no real bridge has: `POST /v1/sim/trade`
`{symbol, type, volume, comment?}` — a deal that originated *on the platform*,
so the reconciler's platform-originated path can be proven without a terminal.
