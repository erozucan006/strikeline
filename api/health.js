// GET /api/health — is Deribit reachable and fresh, and are accounts configured? For uptime checks.
import { realDeps } from "./_deps.js";
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const t0 = Date.now();
  let deribit = { ok: false };
  try {
    const r = await fetch("https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd", { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    deribit = { ok: r.ok && j?.result?.index_price > 0, ms: Date.now() - t0 };
  } catch {}
  const accounts = !!realDeps();
  res.status(deribit.ok ? 200 : 503).json({ ok: deribit.ok, deribit, accounts, at: new Date().toISOString() });
}
