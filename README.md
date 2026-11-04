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
| `index.html` | The whole app: chain, strategy builder, payoff chart, ticket, positions |
| `api/chain.js` | Serverless function that fetches and returns the live chain |
| `api/_snapshot.js` | Pure transform from Deribit's raw data to the chain format (tested) |
| `api/config.js` | Hands the page the public Supabase URL and anon key (never the service key) |
| `supabase/migrations/` | Database: tables, row level security and the server functions for accounts |
| `snapshot.json` | Bundled fallback the page uses if the function is unreachable |
| `test/` | Unit and database tests, plus a local preview server |

## Run locally

```bash
npm test                      # transform, function and (with PGlite) database tests
node test/serve.js            # preview on http://localhost:4173 using the recorded Deribit sample
node test/serve.js --upstream # same, but calls Deribit for real
node test/serve.js --db       # also turns on accounts, backed by the real SQL in an in-process Postgres
```

Node 20 or newer. The app has no runtime dependencies; database tests and `--db` need `npm i --no-save @electric-sql/pglite@0.2.17`.

## Deploy

Import the repository on [vercel.com/new](https://vercel.com/new). No build settings are needed: Vercel serves `index.html` and turns `api/*.js` into functions. `vercel.json` pins them to Frankfurt (`fra1`).

### Accounts (optional)

Without Supabase the app runs in guest mode and keeps everything in the browser. To turn on accounts:

1. In the Vercel project: **Storage → Create Database → Supabase**, connected to this project. This adds `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
2. In Supabase: **SQL Editor** → run each file in `supabase/migrations/` in order (`001_…`, then `002_…`).
3. In Supabase: **Authentication → URL Configuration** → set **Site URL** to the deployed address and add it under **Redirect URLs**.
4. Redeploy on Vercel so the functions pick up the new variables.

Sign-in is by emailed link. Supabase's built-in mail sender allows only a few emails per hour; connect your own SMTP under Authentication → Emails before real users arrive.

### Who can change what

The browser reads its own rows through row level security and cannot write any table directly. Every change goes through a `SECURITY DEFINER` function that checks the signed-in user:

| Function | Server checks |
| --- | --- |
| `submit_assessment` | Scores answers with a key the browser never sees; 3 attempts per 24 h; validates every answer |
| `accept_warning` | Only the latest, failed, unanswered assessment |
| `place_order` | Required level from the legs (covered vs uncovered), fee bounds, expiry in the future, enough cash; logs the order against the assessment and whether it followed a warning |
| `close_position` / `reduce_position` / `reset_account` | Own open positions only; partial closes keep every leg above zero and scale fees with the size |

Order prices still come from the page's live Deribit quote, which is fine for paper trading. Real trading must price and fill on the server through the broker.

## Next steps

- Connect a licensed broker or exchange API for real order routing (see partner options: Interactive Brokers introducing-broker program, Alpaca Broker API, a German *Haftungsdach* provider).
- Retention: keep assessment and order records for at least 5 years after an account closes (MiFID II record-keeping); today `on delete cascade` removes them with the user.

## Order safety

- **Size control in the ticket:** steppers, typed size and "most your cash allows". The first leg sets the size; other legs keep their ratio.
- **Large orders need a second click:** when an order puts 25% or more of demo cash at risk, or its loss is not limited, the first click shows the risk and the button turns into "Confirm order". Changing the order cancels the armed confirmation.
- **Too large is blocked** with a suggested size that fits.
- **Positions can be reduced:** close 25%, 50% or all at current mid prices (partial options only when both parts stay above the minimum size).

## Appropriateness check (MiFID II Art. 25(3))

Before the first order the client takes a knowledge check built along ESMA's appropriateness guidelines (ESMA35-43-2938): 5 experience questions (Art. 55 Delegated Regulation 2017/565: products traded, frequency, period, size, education/profession) and 7 knowledge questions with an "I don't know" option and shuffled answers. No self-assessment checkbox.

| Level | Unlocks | Needs |
| --- | --- | --- |
| 1 · Buy options | Long calls/puts, straddles, strangles | 3 of 4 basic questions |
| 2 · Spreads | Covered spreads, iron condors | Level 1 + spread question |
| 3 · Uncovered selling | Naked short calls/puts | Level 2 + both short-option questions + 10+ options/futures trades in 3 years (1–9 if working in finance) |

A failed check shows a clear warning; the client may proceed with buying options only after accepting it. Retakes are limited to 3 per 24 hours, checks expire after 12 months, and every order is logged against the assessment record. Signed-in users' records live in the database; guests' stay in the browser.
