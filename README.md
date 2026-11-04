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
- MiFID II appropriateness test as a proper multi-question flow.
- Accounts and persistent positions.
