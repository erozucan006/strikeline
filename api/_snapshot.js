// Turns raw Deribit public market data into the compact chain the page reads.
// Row layout per strike: [K, cBid, cAsk, cMark, cIV, cOI, pBid, pAsk, pMark, pIV, pOI]
// Prices are USD per 1 coin (Deribit quotes in coin units; we multiply by the expiry forward).

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const DAY = 864e5;

export function expiryTime(code) {
  const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(code);
  if (!m || !(m[2] in MONTHS)) return null;
  return Date.UTC(2000 + Number(m[3]), MONTHS[m[2]], Number(m[1]), 8); // Deribit expiries settle 08:00 UTC
}

function isLastFridayOfMonth(t) {
  const d = new Date(t);
  return d.getUTCDay() === 5 && new Date(t + 7 * DAY).getUTCMonth() !== d.getUTCMonth();
}

export function pickExpiries(codes, now, { max = 7, near = 3, minDays = 1.5, maxDays = 200 } = {}) {
  const list = [...new Set(codes)]
    .map((code) => ({ code, t: expiryTime(code) }))
    .filter((e) => e.t !== null)
    .filter((e) => (e.t - now) / DAY >= minDays && (e.t - now) / DAY <= maxDays)
    .sort((a, b) => a.t - b.t);
  // Deribit lists dailies (incl. weekends), Friday weeklies and last-Friday monthlies.
  // Show the next few weeklies, then monthlies further out.
  const fridays = list.filter((e) => new Date(e.t).getUTCDay() === 5);
  const out = (fridays.length >= near ? fridays : list).slice(0, near);
  for (const e of list) {
    if (out.length >= max) break;
    if (e.t > out[out.length - 1].t && isLastFridayOfMonth(e.t)) out.push(e);
  }
  return out;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function buildSnapshot(raw, now = Date.now(), { maxStrikes = 21 } = {}) {
  const out = { ts: now, src: "Deribit public API" };
  for (const coin of ["BTC", "ETH"]) {
    const { index, rows } = raw[coin];
    const dp = coin === "BTC" ? 1 : 2;
    const round = (v) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(dp)));
    const byExp = {};
    for (const r of rows) {
      const parts = String(r.instrument_name).split("-");
      if (parts.length !== 4) continue;
      (byExp[parts[1]] ||= []).push({ r, K: Number(parts[2]), type: parts[3] });
    }
    const exps = [];
    for (const { code, t } of pickExpiries(Object.keys(byExp), now)) {
      const items = byExp[code];
      const F = median(items.map((x) => x.r.underlying_price).filter(Number.isFinite));
      if (!Number.isFinite(F)) continue;
      const strikes = {};
      for (const { r, K, type } of items) {
        const usd = (v) => (v == null ? null : v * F);
        (strikes[K] ||= {})[type] = [
          round(usd(r.bid_price || null)),
          round(usd(r.ask_price || null)),
          round(usd(r.mark_price)),
          Math.round(r.mark_iv * 10) / 10,
          Math.round((r.open_interest || 0) * 10) / 10,
        ];
      }
      let ks = Object.keys(strikes)
        .map(Number)
        .filter((K) => K > F * 0.72 && K < F * 1.35 && strikes[K].C && strikes[K].P)
        .sort((a, b) => a - b);
      while (ks.length > maxStrikes) {
        if (Math.abs(ks[0] - F) > Math.abs(ks[ks.length - 1] - F)) ks.shift();
        else ks.pop();
      }
      if (ks.length < 5) continue;
      exps.push({ code, t, F: Math.round(F * 100) / 100, s: ks.map((K) => [K, ...strikes[K].C, ...strikes[K].P]) });
    }
    out[coin] = { index, exps };
  }
  return out;
}
