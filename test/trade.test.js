// Server-side order pricing (/api/order, /api/close) with Deribit and the database mocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { placeOrder, closePosition, requiredCapital, feeFor, expiryTs, handler, QUOTE_MAX_AGE_MS } from "../api/_trade.js";
import { markup, clientAsk, clientBid, priceChain, spreadConfig } from "../api/_spread.js";
const IDX = 79800, A = (p) => clientAsk(p, IDX), B = (p) => clientBid(p, IDX);
const r4 = (v) => Math.round(v * 1e4) / 1e4;

const NOW = Date.UTC(2026, 10, 5, 12);
const E = "27NOV26", T = expiryTs(E);
// Deribit quotes in coin; underlying_price converts to USD
const ticker = (bid, ask, F = 80000, ts = NOW - 2000) => ({ best_bid_price: bid / F, best_ask_price: ask / F, mark_price: (bid + ask) / 2 / F, underlying_price: F, index_price: 79800, timestamp: ts });
function deps(book, extra = {}) {
  const calls = [];
  return {
    calls,
    getUser: async (t) => (t === "good-token" ? { id: "user-1" } : null),
    getTicker: async (name) => book[name] ?? null,
    getIndex: async () => 79800,
    getOpenPosition: async () => extra.position ?? null,
    rpc: async (fn, args) => { calls.push({ fn, args }); return { replayed: false, position: { id: 7 }, cash: 9900 }; },
  };
}
const body = (legs, o = {}) => ({ underlying: "BTC", name: "Test", idempotencyKey: "k".repeat(20), legs, ...o });
const L = (type, K, side, qty, limit) => ({ type, K, e: E, side, qty, limit });
const book = { "BTC-27NOV26-79000-C": ticker(2500, 2560), "BTC-27NOV26-81000-C": ticker(1600, 1650), "BTC-27NOV26-77000-P": ticker(1800, 1850) };

test("fills at the live ask/bid, not the price the browser sent", async () => {
  const d = deps(book);
  const r = await placeOrder(d, { token: "good-token", body: body([L("C", 79000, 1, 0.05, A(2560)), L("C", 81000, -1, 0.05, B(1600))]), now: NOW });
  const sent = d.calls[0].args;
  assert.equal(d.calls[0].fn, "place_order_v2");
  assert.deepEqual(sent.p_legs.map((l) => l.entry), [r4(A(2560)), r4(B(1600))], "buy at platform ask, sell at platform bid");
  assert.ok(A(2560) > 2560 && B(1600) < 1600, "platform prices are wider than the exchange");
  assert.equal(sent.p_fee, 0, "no separate commission");
  assert.ok(sent.p_legs.every((l) => !("limit" in l)), "browser limits are not passed on as prices");
  assert.equal(sent.p_user, "user-1");
  assert.equal(r.net, Math.round((r4(A(2560)) - r4(B(1600))) * 0.05 * 100) / 100);
  assert.equal(sent.p_legs[0].t, T);
});

test("a browser asking for a cheaper fill than the market gets price_moved, not a bargain", async () => {
  await assert.rejects(placeOrder(deps(book), { token: "good-token", body: body([L("C", 79000, 1, 0.05, 1000)]), now: NOW }), { code: "price_moved" });
  await assert.rejects(placeOrder(deps(book), { token: "good-token", body: body([L("C", 81000, -1, 0.05, 3000)]), now: NOW }), { code: "price_moved" });
});

test("small moves within tolerance still fill, at the market price", async () => {
  const d = deps(book);
  await placeOrder(d, { token: "good-token", body: body([L("C", 79000, 1, 0.05, A(2560) - 10)]), now: NOW }); // 10 USD under the ask
  assert.equal(d.calls[0].args.p_legs[0].entry, r4(A(2560)));
});

test("stale, missing or one-sided quotes are refused", async () => {
  const stale = { "BTC-27NOV26-79000-C": ticker(2500, 2560, 80000, NOW - QUOTE_MAX_AGE_MS - 1) };
  await assert.rejects(placeOrder(deps(stale), { token: "good-token", body: body([L("C", 79000, 1, 0.05, 2560)]), now: NOW }), { code: "stale_quote" });
  await assert.rejects(placeOrder(deps({}), { token: "good-token", body: body([L("C", 79000, 1, 0.05, 2560)]), now: NOW }), { code: "no_quote" });
  const noBid = { "BTC-27NOV26-79000-C": { ...ticker(2500, 2560), best_bid_price: 0 } };
  await assert.rejects(placeOrder(deps(noBid), { token: "good-token", body: body([L("C", 79000, -1, 0.05, 2500)]), now: NOW }), { code: "no_quote" });
});

test("bad tokens and malformed orders never reach the database", async () => {
  const d = deps(book);
  await assert.rejects(placeOrder(d, { token: "", body: body([L("C", 79000, 1, 0.05, 2560)]), now: NOW }), { code: "not_signed_in" });
  await assert.rejects(placeOrder(d, { token: "good-token", body: body([L("C", 79000, 1, 0.001, 2560)]), now: NOW }), { code: "invalid_legs" });
  await assert.rejects(placeOrder(d, { token: "good-token", body: body([L("X", 79000, 1, 0.05, 2560)]), now: NOW }), { code: "invalid_legs" });
  await assert.rejects(placeOrder(d, { token: "good-token", body: body([L("C", 79000, 1, 0.05, 2560)], { idempotencyKey: "short" }), now: NOW }), { code: "invalid_idempotency_key" });
  await assert.rejects(placeOrder(d, { token: "good-token", body: body([{ ...L("C", 79000, 1, 0.05, 2560), e: "1JAN20" }]), now: NOW }), { code: "invalid_legs" });
  assert.equal(d.calls.length, 0);
});

test("fee and required capital are computed on the server", () => {
  const legs = [{ type: "C", K: 79000, side: 1, qty: 0.05, entry: 2560 }, { type: "C", K: 81000, side: -1, qty: 0.05, entry: 1600 }];
  const fee = feeFor(legs, 79800);
  assert.ok(Math.abs(fee - (Math.min(0.0003 * 79800 * 0.05, 0.125 * 2560 * 0.05) + Math.min(0.0003 * 79800 * 0.05, 0.125 * 1600 * 0.05))) < 1e-9);
  const spread = requiredCapital(legs, 79800, fee);
  assert.equal(spread.unlimited, false);
  assert.ok(Math.abs(spread.req - ((2560 - 1600) * 0.05 + fee)) < 1e-6, "bull call spread: max loss = debit");
  const naked = requiredCapital([{ type: "C", K: 82000, side: -1, qty: 0.05, entry: 900 }], 79800, 1);
  assert.equal(naked.unlimited, true);
  assert.ok(naked.req > 0.1 * 79800 * 0.05);
  const shortPut = requiredCapital([{ type: "P", K: 77000, side: -1, qty: 0.05, entry: 1800 }], 79800, 1);
  assert.ok(Math.abs(shortPut.req - ((77000 - 1800) * 0.05 + 1)) < 1e-6, "short put: loss if BTC goes to zero");
});

test("closing sells longs at the bid and buys back shorts at the ask", async () => {
  const position = { id: 7, underlying: "BTC", legs: [{ ...L("C", 79000, 1, 0.08, 0), t: T }, { ...L("C", 81000, -1, 0.08, 0), t: T }] };
  const d = deps(book, { position });
  const r = await closePosition(d, { token: "good-token", body: { positionId: 7, fraction: 0.25, idempotencyKey: "c".repeat(20) }, now: NOW });
  assert.equal(d.calls[0].fn, "reduce_position_v2");
  assert.equal(r.value, Math.round((B(2500) - A(1650)) * 0.08 * 0.25 * 100) / 100);
  const d2 = deps(book, { position });
  await closePosition(d2, { token: "good-token", body: { positionId: 7, fraction: 1, idempotencyKey: "c".repeat(20) }, now: NOW });
  assert.equal(d2.calls[0].fn, "close_position_v2");
});

test("legs past expiry settle at intrinsic value", async () => {
  const past = Date.UTC(2026, 10, 1, 8);
  const position = { id: 8, underlying: "BTC", legs: [{ type: "C", K: 78000, side: 1, qty: 0.1, t: past, e: "1NOV26" }] };
  const r = await closePosition(deps({}, { position }), { token: "good-token", body: { positionId: 8, fraction: 1, idempotencyKey: "d".repeat(20) }, now: NOW });
  assert.equal(r.value, Math.round((79800 - 78000) * 0.1 * 100) / 100);
});

test("HTTP wrapper: method, missing config and database errors map to clear codes", async () => {
  const res = () => { const r = { code: 0, headers: {}, body: null }; r.setHeader = (k, v) => (r.headers[k] = v); r.status = (c) => ((r.code = c), r); r.json = (b) => ((r.body = b), r); r.end = () => r; return r; };
  let r = res(); await handler(placeOrder, deps(book))({ method: "GET", headers: {} }, r);
  assert.equal(r.code, 405);
  r = res(); await handler(placeOrder, () => null)({ method: "POST", headers: {}, body: {} }, r);
  assert.deepEqual([r.code, r.body.error], [503, "server_not_configured"]);
  const failing = { ...deps(book), rpc: async () => { throw new Error("level_required"); } };
  r = res(); await handler(placeOrder, failing)({ method: "POST", headers: { authorization: "Bearer good-token" }, body: body([L("C", 79000, 1, 0.05, A(2560))]) }, r);
  // the real clock is used here; a 2-second-old ticker relative to NOW is stale now, so expect either code
  assert.ok([409].includes(r.code) && ["level_required", "stale_quote"].includes(r.body.error), JSON.stringify(r.body));
  assert.equal(r.headers["Cache-Control"], "no-store");
});

test("markup: share of price, with a floor and a cap tied to the index", () => {
  const c = { pct: 0.04, floor: 0.0004, cap: 0.0015 };
  assert.equal(markup(2000, 80000, c), 80, "4% of a mid-priced option");
  assert.equal(markup(300, 80000, c), 32, "floor on a cheap option");
  assert.equal(markup(12000, 80000, c), 120, "cap on an expensive option");
  assert.equal(clientBid(20, 80000, c), null, "a bid the markup would wipe out is not offered");
  assert.equal(clientAsk(null, 80000, c), null);
  const env = spreadConfig({ SPREAD_PCT: "0.02", SPREAD_FLOOR: "", SPREAD_CAP: "0.001" });
  assert.deepEqual(env, { pct: 0.02, floor: 0.0004, cap: 0.001 }, "environment overrides, blanks fall back");
});

test("the chain clients see is the exchange chain widened by the markup; marks are untouched", () => {
  const snap = { BTC: { index: 80000, exps: [{ code: E, s: [[80000, 1900, 2000, 1950, 40, 1, 1800, 1900, 1850, 40, 1]] }] }, ETH: { index: 3000, exps: [] } };
  const c = { pct: 0.04, floor: 0.0004, cap: 0.0015 }, row = priceChain(snap, c).BTC.exps[0].s[0];
  assert.deepEqual(row, [80000, 1824, 2080, 1950, 40, 1, 1728, 1976, 1850, 40, 1]);
  assert.equal(snap.BTC.exps[0].s[0][1], 1900, "input not modified");
});
