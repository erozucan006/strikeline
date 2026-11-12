// GET /api/chain → live BTC and ETH option chains from Deribit's public API.
// Cached at Vercel's edge for 10 s so many viewers share one upstream call.
import { buildSnapshot } from "./_snapshot.js";
import { priceChain } from "./_spread.js";

const BASE = "https://www.deribit.com/api/v2/public";

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Deribit ${r.status} for ${url}`);
  const j = await r.json();
  if (!j || !("result" in j)) throw new Error(`Unexpected Deribit response for ${url}`);
  return j.result;
}

export async function fetchRaw() {
  const coins = ["BTC", "ETH"];
  const results = await Promise.all(
    coins.flatMap((c) => [
      getJson(`${BASE}/get_index_price?index_name=${c.toLowerCase()}_usd`),
      getJson(`${BASE}/get_book_summary_by_currency?currency=${c}&kind=option`),
    ])
  );
  const raw = {};
  coins.forEach((c, i) => {
    raw[c] = { index: results[i * 2].index_price, rows: results[i * 2 + 1] };
  });
  return raw;
}

export default async function handler(req, res) {
  try {
    const snap = priceChain(buildSnapshot(await fetchRaw()));
    res.setHeader("Cache-Control", "public, s-maxage=10, stale-while-revalidate=30");
    res.status(200).json(snap);
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: "Market data is unavailable right now.", detail: String(err.message || err) });
  }
}
