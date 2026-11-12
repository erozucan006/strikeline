// Server-side order and close logic. The browser only says WHAT to trade and the worst price it
// accepts; this module prices every leg from a fresh Deribit ticker, computes fees and required
// capital itself, and books the result through service-only database functions.
//
// Everything that touches the network comes in through `deps`, so the same code runs on Vercel
// (api/_deps.js), in the local preview (test/serve.js) and in unit tests.

import { clientAsk, clientBid, spreadConfig } from "./_spread.js";

export const QUOTE_MAX_AGE_MS = 30_000; // a ticker older than this is treated as stale
export const MAX_LEGS = 8;
const COINS = { BTC: { minQty: 0.01 }, ETH: { minQty: 0.1 } };
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export class TradeError extends Error {
  constructor(code, status = 400, detail) {
    super(code);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

// Deribit expiry code (e.g. 27NOV26) → 08:00 UTC timestamp
export function expiryTs(code) {
  const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(String(code));
  const mi = m ? MONTHS.indexOf(m[2]) : -1;
  if (!m || mi < 0) return null;
  return Date.UTC(2000 + Number(m[3]), mi, Number(m[1]), 8);
}
export const instrumentName = (u, l) => `${u}-${l.e}-${l.K}-${l.type}`;

// Validates the shape the browser sends. Prices from the browser are only used as limits.
export function parseOrder(body, now) {
  const b = body && typeof body === "object" ? body : {};
  const u = b.underlying;
  if (!COINS[u]) throw new TradeError("invalid_underlying");
  if (!Array.isArray(b.legs) || b.legs.length < 1 || b.legs.length > MAX_LEGS) throw new TradeError("invalid_legs");
  const key = String(b.idempotencyKey || "");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) throw new TradeError("invalid_idempotency_key");
  const legs = b.legs.map((l) => {
    const t = expiryTs(l && l.e);
    const leg = {
      u, type: l && l.type, K: Number(l && l.K), e: l && l.e, t, side: Number(l && l.side),
      qty: Number(l && l.qty), limit: Number(l && l.limit),
    };
    if (!["C", "P"].includes(leg.type) || ![1, -1].includes(leg.side) || !(leg.K > 0) || !t || t <= now
      || !(leg.qty >= COINS[u].minQty - 1e-9) || leg.qty > 100 || !(leg.limit >= 0))
      throw new TradeError("invalid_legs");
    leg.qty = Math.round(leg.qty * 1e4) / 1e4;
    return leg;
  });
  return { u, legs, name: String(b.name || "Custom").slice(0, 40), key };
}

// Turns a Deribit ticker into USD prices (Deribit quotes options in coin; the instrument's own
// underlying_price is the forward for its expiry).
export function usdQuote(t) {
  const F = Number(t.underlying_price);
  const usd = (v) => (v == null || !(Number(v) > 0) ? null : Number(v) * F);
  return { bid: usd(t.best_bid_price), ask: usd(t.best_ask_price), mark: usd(t.mark_price), index: Number(t.index_price), ts: Number(t.timestamp) };
}

export async function quotesFor(deps, u, legs, now) {
  const quotes = await Promise.all(legs.map((l) => deps.getTicker(instrumentName(u, l))));
  let oldest = Infinity, index = 0;
  const out = quotes.map((t, i) => {
    if (!t) throw new TradeError("no_quote", 409, instrumentName(u, legs[i]));
    const q = usdQuote(t);
    if (!(q.ts > 0) || now - q.ts > QUOTE_MAX_AGE_MS) throw new TradeError("stale_quote", 409, instrumentName(u, legs[i]));
    oldest = Math.min(oldest, q.ts);
    index = q.index || index;
    return q;
  });
  if (!(index > 0)) throw new TradeError("no_quote", 409, "index");
  return { quotes: out, oldest, index };
}

// Buy at the platform ask, sell at the platform bid (exchange quote widened by the markup). A fill worse than the browser's limit by more than a small
// tolerance is refused, so a price that moved between screen and server is never filled silently.
export function fillLegs(legs, quotes, index, c = spreadConfig()) {
  return legs.map((l, i) => {
    const q = quotes[i], px = l.side > 0 ? clientAsk(q.ask, index, c) : clientBid(q.bid, index, c);
    if (px == null) throw new TradeError("no_quote", 409, `${l.type} ${l.K} ${l.side > 0 ? "ask" : "bid"}`);
    const tol = Math.max(0.01 * l.limit, 0.0002 * index);
    if (l.side > 0 ? px > l.limit + tol : px < l.limit - tol)
      throw new TradeError("price_moved", 409, { leg: i, limit: l.limit, price: Math.round(px * 100) / 100 });
    return { ...l, entry: Math.round(px * 1e4) / 1e4, xp: l.side > 0 ? q.ask : q.bid };
  });
}

// Same formula as the ticket: per leg min(0.03% of index × qty, 12.5% of premium × qty)
export const feeFor = (legs, index) => legs.reduce((s, l) => s + Math.min(0.0003 * index * l.qty, 0.125 * l.entry * l.qty), 0);

// Capital the order ties up. Defined-risk orders: the worst loss at the first expiry (later legs
// valued at intrinsic only, which can only overstate the loss) plus fees. Net short calls: no upper
// limit, so premium plus a margin of 15% of the index per sold option, less how far it is out of
// the money, never below 10% of the index.
export function requiredCapital(legs, index, fee) {
  const net = legs.reduce((s, l) => s + l.side * l.qty * l.entry, 0);
  const netCalls = legs.filter((l) => l.type === "C").reduce((s, l) => s + l.side * l.qty, 0);
  if (netCalls < -1e-9) {
    let req = fee + Math.max(0, net);
    for (const l of legs) if (l.side < 0) {
      const otm = Math.max(0, l.type === "C" ? l.K - index : index - l.K);
      req += Math.max(0.15 * index - otm, 0.1 * index) * l.qty;
    }
    return { req, net, unlimited: true };
  }
  const val = (S) => legs.reduce((s, l) => s + l.side * l.qty * (Math.max(0, l.type === "C" ? S - l.K : l.K - S) - l.entry), 0);
  let worst = Infinity;
  const hi = Math.max(index * 4, ...legs.map((l) => l.K * 2));
  const pts = new Set([0, hi, ...legs.map((l) => l.K)]);
  for (let i = 0; i <= 800; i++) pts.add((hi * i) / 800);
  for (const S of pts) worst = Math.min(worst, val(S));
  return { req: Math.max(0, -worst) + fee, net, unlimited: false };
}

export async function placeOrder(deps, { token, body, now = Date.now() }) {
  const user = await deps.getUser(token);
  if (!user) throw new TradeError("not_signed_in", 401);
  const order = parseOrder(body, now);
  const { quotes, oldest, index } = await quotesFor(deps, order.u, order.legs, now);
  const legs = fillLegs(order.legs, quotes, index);
  const fee = 0; // no separate commission: the platform earns its markup in the price
  const { req, net } = requiredCapital(legs, index, fee);
  const booked = await deps.rpc("place_order_v2", {
    p_user: user.id, p_name: order.name, p_underlying: order.u,
    p_legs: legs.map(({ limit, xp, ...l }) => l), p_fee: fee, p_required: Math.round(req * 100) / 100,
    p_idem: order.key, p_quote_ts: new Date(oldest).toISOString(),
  });
  if (booked && !booked.replayed)
    await recordRevenue(deps, legs.map((l, i) => revenueRow({ user, kind: "open", positionId: booked.position?.id, key: order.key, i, u: order.u, leg: l, clientSide: l.side, qty: l.qty, index, xp: l.xp, cp: l.entry })));
  return { ...booked, fills: legs.map((l) => ({ type: l.type, K: l.K, e: l.e, side: l.side, qty: l.qty, price: l.entry })), net: Math.round(net * 100) / 100, fee, required: Math.round(req * 100) / 100 };
}

// Closing sells what was bought (at the platform bid) and buys back what was sold (at the platform ask).
// Legs past expiry settle at intrinsic value against the index.
export async function closePosition(deps, { token, body, now = Date.now() }) {
  const user = await deps.getUser(token);
  if (!user) throw new TradeError("not_signed_in", 401);
  const b = body && typeof body === "object" ? body : {};
  const id = Number(b.positionId), f = Number(b.fraction);
  const key = String(b.idempotencyKey || "");
  if (!(id > 0) || !(f > 0 && f <= 1) || !/^[A-Za-z0-9_-]{16,64}$/.test(key)) throw new TradeError("invalid_request");
  const pos = await deps.getOpenPosition(user.id, id);
  if (!pos) throw new TradeError("position_not_open", 404);
  const u = pos.underlying, legs = pos.legs.map((l) => ({ ...l, t: Number(l.t) }));
  const live = legs.filter((l) => l.t > now), done = legs.filter((l) => l.t <= now);
  let index = 0, oldest = now;
  const q = live.length ? await quotesFor(deps, u, live, now) : null;
  if (q) { index = q.index; oldest = q.oldest; }
  if (done.length && !index) index = await deps.getIndex(u);
  let value = 0;
  const c = spreadConfig(), rows = [];
  live.forEach((l, i) => {
    const xp = l.side > 0 ? q.quotes[i].bid : q.quotes[i].ask;
    const px = l.side > 0 ? clientBid(xp, index, c) : clientAsk(xp, index, c);
    if (px == null) throw new TradeError("no_quote", 409, `${l.type} ${l.K}`);
    value += l.side * l.qty * f * px;
    rows.push({ l, i, xp, px });
  });
  for (const l of done) value += l.side * l.qty * f * Math.max(0, l.type === "C" ? index - l.K : l.K - index);
  value = Math.round(value * 100) / 100;
  const args = { p_user: user.id, p_id: id, p_value: value, p_idem: key, p_quote_ts: new Date(oldest).toISOString() };
  const booked = f >= 1 ? await deps.rpc("close_position_v2", args) : await deps.rpc("reduce_position_v2", { ...args, p_fraction: f });
  if (booked && !booked.replayed)
    await recordRevenue(deps, rows.map(({ l, i, xp, px }) => revenueRow({ user, kind: f >= 1 ? "close" : "reduce", positionId: id, key, i, u, leg: l, clientSide: -l.side, qty: Math.round(l.qty * f * 1e4) / 1e4, index, xp, cp: px })));
  return { ...booked, value };
}

// The platform's books: what the exchange quoted, what the client got, and the markup in between.
function revenueRow({ user, kind, positionId, key, i, u, leg, clientSide, qty, index, xp, cp }) {
  return {
    user_id: user.id, kind, position_id: positionId ?? null, idempotency_key: key, leg_no: i, underlying: u,
    instrument: instrumentName(u, leg), client_side: clientSide, qty, index_price: Math.round(index * 100) / 100,
    exchange_price: Math.round(xp * 1e4) / 1e4, client_price: Math.round(cp * 1e4) / 1e4,
    markup: Math.round(Math.abs(cp - xp) * qty * 1e4) / 1e4,
    exchange_fee: Math.round(Math.min(0.0003 * index * qty, 0.125 * xp * qty) * 1e4) / 1e4,
  };
}
// The client's trade is already booked; a failure here is logged, never shown to the client.
async function recordRevenue(deps, rows) {
  if (!rows.length) return;
  try { await deps.rpc("record_revenue", { p_rows: rows }); }
  catch (e) { console.error("revenue not recorded", e && e.message, JSON.stringify(rows).slice(0, 500)); }
}

// Summary for the admin page. Only e-mail addresses listed in ADMIN_EMAILS get in.
export const LOT = { BTC: 0.1, ETH: 1 }; // smallest Deribit option order
export async function adminSummary(deps, { token, env = process.env }) {
  const user = await deps.getUser(token);
  if (!user) throw new TradeError("not_signed_in", 401);
  const admins = String(env.ADMIN_EMAILS || "").toLowerCase().split(/[\s,;]+/).filter(Boolean);
  if (!admins.length) throw new TradeError("admin_not_configured", 503);
  if (!user.email || !admins.includes(String(user.email).toLowerCase())) throw new TradeError("not_admin", 403);
  const s = await deps.rpc("admin_summary", {});
  // The platform holds the opposite of what clients hold. Deribit takes whole lots, so the part
  // below one lot stays unhedged (covered with a futures delta hedge in practice).
  s.exposure = (s.exposure || []).map((x) => {
    const need = -Number(x.client_net), lot = LOT[x.underlying];
    const hedge = Math.sign(need) * Math.floor(Math.abs(need) / lot + 1e-9) * lot;
    return { ...x, instrument: `${x.underlying}-${x.e}-${Number(x.k)}-${x.type}`, hedge: Math.round(hedge * 1e4) / 1e4, residual: Math.round((need - hedge) * 1e4) / 1e4 };
  });
  return s;
}

// Shared HTTP wrapper for Vercel-style (req, res) handlers.
export function handler(fn, deps, method = "POST") {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== method) return res.status(405).json({ error: "method_not_allowed" });
    try {
      const d = typeof deps === "function" ? deps() : deps;
      if (!d) throw new TradeError("server_not_configured", 503);
      const auth = String(req.headers.authorization || req.headers.Authorization || "");
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const body = method !== "POST" ? {} : typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      return res.status(200).json(await fn(d, { token, body }));
    } catch (e) {
      if (e instanceof TradeError) return res.status(e.status).json({ error: e.code, detail: e.detail ?? null });
      const m = /\b(level_required|insufficient_cash|assessment_required|attempt_limit|position_not_open|invalid_legs|invalid_fee|invalid_required|invalid_value|invalid_fraction|stale_quote|rate_limited|duplicate)\b/.exec(String(e && e.message));
      if (m) return res.status(409).json({ error: m[1], detail: null });
      console.error("trade error", e);
      return res.status(500).json({ error: "server_error", detail: null });
    }
  };
}
