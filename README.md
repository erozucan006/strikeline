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
| `snapshot.json` | Bundled fallback the page uses if the function is unreachable |
| `test/` | Unit tests on a real Deribit sample, plus a local preview server |

## Run locally

```bash
npm test                      # transform + function tests
node test/serve.js            # preview on http://localhost:4173 using the recorded Deribit sample
node test/serve.js --upstream # same, but calls Deribit for real
```

No dependencies to install; Node 20 or newer.

## Deploy

Import the repository on [vercel.com/new](https://vercel.com/new). No build settings are needed: Vercel serves `index.html` and turns `api/chain.js` into a function. `vercel.json` pins the function to Frankfurt (`fra1`).

## Next steps

- Connect a licensed broker or exchange API for real order routing (see partner options: Interactive Brokers introducing-broker program, Alpaca Broker API, a German *Haftungsdach* provider).
- Accounts and persistent positions; move the appropriateness record server-side (MiFID II record-keeping, 5 years).

## Appropriateness check (MiFID II Art. 25(3))

Before the first order the client takes a knowledge check built along ESMA's appropriateness guidelines (ESMA35-43-2938): 5 experience questions (Art. 55 Delegated Regulation 2017/565: products traded, frequency, period, size, education/profession) and 7 knowledge questions with an "I don't know" option and shuffled answers. No self-assessment checkbox.

| Level | Unlocks | Needs |
| --- | --- | --- |
| 1 · Buy options | Long calls/puts, straddles, strangles | 3 of 4 basic questions |
| 2 · Spreads | Covered spreads, iron condors | Level 1 + spread question |
| 3 · Uncovered selling | Naked short calls/puts | Level 2 + both short-option questions + 10+ options/futures trades in 3 years (1–9 if working in finance) |

A failed check shows a clear warning; the client may proceed with buying options only after accepting it. Retakes are limited to 3 per 24 hours, checks expire after 12 months, and every order is logged against the assessment record. In this demo the record lives in the browser.
