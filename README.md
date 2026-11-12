# Strikeline

Crypto options for everyone: a demo of a retail-friendly options platform with small contract sizes, plain-language explanations and pro tools (Greeks, scenario grid, time-decay view).

Market data is **live from Deribit's public API**. Orders are paper trades only; nothing is sent to any exchange.

## How it works

```
browser ──every 15 s──▶ /api/chain (Vercel function, Frankfurt) ──▶ Deribit public API
                              │  picks 7 expiries, ~21 strikes each,
                              │  converts coin prices to USD
                              ▼
                        cached 10 s at Vercel's edge
```

| Path | What it is |
| --- | --- |
| `index.html` | Product page at `/`: live strike-lines hero, live examples, levels, guard rails |
| `app.html` | The app at `/app`: chain, strategy builder, payoff chart, ticket, positions |
| `api/chain.js` | Serverless function that fetches and returns the live chain |
| `api/_snapshot.js` | Pure transform from Deribit's raw data to the chain format (tested) |
| `api/config.js` | Hands the page the public Supabase URL and anon key (never the service key) |
| `api/order.js`, `api/close.js` | Price, check and book orders and closes on the server (`api/_trade.js`, `api/_deps.js`) |
| `api/health.js`, `api/log.js` | Uptime check (Deribit reachable, accounts configured) and page error reports |
| `supabase/migrations/` | Database: tables, row level security and the server functions for accounts |
| `snapshot.json` | Bundled fallback the page uses if the function is unreachable |
| `test/` | Unit and database tests, plus a local preview server |

## Run locally

```bash
npm test                      # transform, function and (with PGlite) database tests
node test/serve.js            # preview on http://localhost:4173 (app at /app) using the recorded Deribit sample
node test/serve.js --upstream # same, but calls Deribit for real
node test/serve.js --db       # also turns on accounts, backed by the real SQL in an in-process Postgres
```

Node 20 or newer. The app has no runtime dependencies; database tests and `--db` need `npm i --no-save @electric-sql/pglite@0.2.17`.

## Deploy

Import the repository on [vercel.com/new](https://vercel.com/new). No build settings are needed: Vercel serves `index.html` at `/`, `app.html` at `/app` (`cleanUrls`), and turns `api/*.js` into functions. `vercel.json` pins them to Frankfurt (`fra1`).

### Accounts (optional)

Without Supabase the app runs in guest mode and keeps everything in the browser. To turn on accounts:

1. In the Vercel project: **Storage → Create Database → Supabase**, connected to this project. This adds `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
2. In Supabase: **SQL Editor** → run each file in `supabase/migrations/` in order (`001_…`, `002_…`, `003_…`).
3. In Vercel: check that `SUPABASE_SERVICE_ROLE_KEY` is set (the Supabase integration adds it). Orders need it; `/api/health` shows `"accounts": true` when it is there.
4. In Supabase: **Authentication → URL Configuration** → set **Site URL** to the deployed address and add it under **Redirect URLs** (a sign-in link that lands on `/` is forwarded to `/app`).
5. Redeploy on Vercel so the functions pick up the new variables.

Sign-in is by emailed link. Supabase's built-in mail sender allows only a few emails per hour; connect your own SMTP under Authentication → Emails before real users arrive.

### Who can change what

The browser reads its own rows through row level security and cannot write any table directly. It never prices its own trades:

```
browser ── "buy 0.05 BTC-27NOV26-80000-C, worst price 2 560 USD", session token, idempotency key ──▶ /api/order
/api/order ── checks the token with Supabase, fetches each leg's ticker from Deribit (refused if older than 30 s)
           ── fills buys at the ask and sells at the bid, each widened by the markup; refuses with price_moved if worse than the limit (1% tolerance)
           ── computes fee and required capital itself
           ── place_order_v2 (service key only) ──▶ database: level, cash, rate limit, idempotency, quote age
```

| Function | Who may call | Server checks |
| --- | --- | --- |
| `submit_assessment` | signed-in user | Scores answers with a key the browser never sees; 3 attempts per 24 h; validates every answer |
| `accept_warning` | signed-in user | Only the latest, failed, unanswered assessment |
| `place_order_v2` | service role (`/api/order`) | Required level from the legs (covered vs uncovered), fee and capital bounds, enough cash, quote at most 30 s old, 20 orders a minute, same idempotency key → the first result instead of a second order |
| `close_position_v2` / `reduce_position_v2` | service role (`/api/close`) | Own open positions only; valued at the live bid (longs) and ask (shorts), expired legs at intrinsic value |
| `reset_account` | signed-in user | Closes open positions and restores demo cash |

The old browser-callable `place_order`, `close_position` and `reduce_position` are revoked by migration 003.

### Pricing

Clients see Deribit's quote widened by a markup and pay no separate commission (`api/_spread.js`). Per 1 coin of option the markup is `clamp(SPREAD_PCT × price, SPREAD_FLOOR × index, SPREAD_CAP × index)`; buys fill at ask + markup, sells at bid − markup. The chain (`/api/chain`), fills (`/api/order`) and closes (`/api/close`) all use the same function. Set the three values as Vercel environment variables; the numbers in the code are only fallbacks for the preview and tests. The ticket shows the client "trading costs (in price)": the distance between their price and the market mid.

### Records

Orders and knowledge checks are append-only: database triggers refuse any update or delete (a warning can be accepted once). Deleting a sign-in user is refused while records exist (`on delete restrict`), so closing an account has to go through a process that keeps them for the MiFID II retention period.

### Other protections

- **Stale prices:** if the live feed has not updated for 60 s the ticket pauses orders and says why.
- **Double clicks and retries:** the page reuses one idempotency key per order until it succeeds.
- **Security headers** (`vercel.json`): Content-Security-Policy limited to this site, Google Fonts, jsDelivr and Supabase; no framing; HSTS; nosniff; strict referrer; camera, microphone, location and payment off.
- **Error reports:** page errors are sent to `/api/log` and appear in Vercel's function logs.

## Tests

```bash
npm test                                   # unit, server pricing and database tests (34)
PORT=4173 node test/serve.js &             # browser suites need the three preview servers
PORT=4174 node test/serve.js --db &
PORT=4175 node test/serve.js --down &
node test/e2e/run.cjs                      # guest, accounts, levels, sizing, stale prices, tampering
```

GitHub Actions (`.github/workflows/test.yml`) runs all of them on every push.

## Next steps

- Connect a licensed broker or exchange API for real order routing (see partner options: Interactive Brokers introducing-broker program, Alpaca Broker API, a German *Haftungsdach* provider).
- Before real money: an independent security review and penetration test, monitoring with alerts, database backups with tested restores, and a ledger reconciled daily against the broker.

## Order safety

- **Size control in the ticket:** steppers, typed size and "most your cash allows". The first leg sets the size; other legs keep their ratio.
- **Large orders need a second click:** when an order puts 25% or more of demo cash at risk, or its loss is not limited, the first click shows the risk and the button turns into "Confirm order". Changing the order cancels the armed confirmation.
- **Too large is blocked** with a suggested size that fits.
- **Positions can be reduced:** close 25%, 50% or all; the server fills at the live bid/ask (partial options only when both parts stay above the minimum size).

## Appropriateness check (MiFID II Art. 25(3))

Before the first order the client takes a knowledge check built along ESMA's appropriateness guidelines (ESMA35-43-2938): 5 experience questions (Art. 55 Delegated Regulation 2017/565: products traded, frequency, period, size, education/profession) and 7 knowledge questions with an "I don't know" option and shuffled answers. No self-assessment checkbox.

| Level | Unlocks | Needs |
| --- | --- | --- |
| 1 · Buy options | Long calls/puts, straddles, strangles | 3 of 4 basic questions |
| 2 · Spreads | Covered spreads, iron condors | Level 1 + spread question |
| 3 · Uncovered selling | Naked short calls/puts | Level 2 + both short-option questions + 10+ options/futures trades in 3 years (1–9 if working in finance) |

Strategies are grouped by the level they need, with each group marked open or locked for the signed-in client. Locked strategies can still be explored on the chart. When an order is above the client's level, the ticket names each unprotected sold leg and offers one-click fixes: buy a further out-of-the-money option as protection (turning it into a spread), buy instead of sell, or remove the leg; level 1 clients can drop all sold legs or buy every leg instead.

A failed check shows a clear warning; the client may proceed with buying options only after accepting it. Retakes are limited to 3 per 24 hours, checks expire after 12 months, and every order is logged against the assessment record. Signed-in users' records live in the database; guests' stay in the browser.
