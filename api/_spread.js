// The platform's price: Deribit's quote widened by a markup. Clients only ever see the result.
// The markup is set per Vercel environment (SPREAD_PCT, SPREAD_FLOOR, SPREAD_CAP); the values
// below are only fallbacks so the preview and tests have something to run with.
//
// Per 1 coin of option: markup = clamp(PCT × price, FLOOR × index, CAP × index)
//   PCT    share of the option price            (cheap and mid-priced options)
//   FLOOR  minimum, as a share of the index      (covers the exchange fee on cheap options)
//   CAP    maximum, as a share of the index      (keeps expensive in-the-money options fair)
const num = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Number(v) : d);

export function spreadConfig(env = typeof process !== "undefined" ? process.env : {}) {
  return {
    pct: num(env.SPREAD_PCT, 0.04),
    floor: num(env.SPREAD_FLOOR, 0.0004),
    cap: num(env.SPREAD_CAP, 0.0015),
  };
}

export function markup(price, index, c = spreadConfig()) {
  if (!(price > 0) || !(index > 0)) return 0;
  return Math.min(Math.max(c.pct * price, c.floor * index), c.cap * index);
}
// Client buys at the exchange ask plus the markup, sells at the exchange bid minus it.
// A bid that the markup would push to zero or below is not offered.
export const clientAsk = (ask, index, c) => (ask > 0 ? ask + markup(ask, index, c) : null);
export function clientBid(bid, index, c) {
  if (!(bid > 0)) return null;
  const v = bid - markup(bid, index, c);
  return v > 0 ? v : null;
}

// Applies the markup to a chain built by _snapshot.js (row: [K, cBid, cAsk, cMark, cIV, cOI, pBid, pAsk, pMark, pIV, pOI]).
export function priceChain(snap, c = spreadConfig()) {
  const out = { ...snap };
  for (const coin of ["BTC", "ETH"]) {
    if (!snap[coin]) continue;
    const { index } = snap[coin], dp = coin === "BTC" ? 1 : 2;
    const r = (v) => (v == null ? null : Number(v.toFixed(dp)));
    out[coin] = {
      ...snap[coin],
      exps: snap[coin].exps.map((e) => ({
        ...e,
        s: e.s.map((row) => {
          const x = [...row];
          x[1] = r(clientBid(row[1], index, c)); x[2] = r(clientAsk(row[2], index, c));
          x[6] = r(clientBid(row[6], index, c)); x[7] = r(clientAsk(row[7], index, c));
          return x;
        }),
      })),
    };
  }
  return out;
}
