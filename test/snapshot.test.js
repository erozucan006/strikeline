import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSnapshot, pickExpiries, expiryTime } from "../api/_snapshot.js";
import handler from "../api/chain.js";

// Real Deribit sample captured 4 Nov 2026 (subset of strikes near the money).
const fx = JSON.parse(readFileSync(new URL("./deribit-fixture.json", import.meta.url)));
const now = fx.capturedAt;

test("expiryTime parses Deribit codes at 08:00 UTC", () => {
  assert.equal(new Date(expiryTime("27NOV26")).toISOString(), "2026-11-27T08:00:00.000Z");
  assert.equal(new Date(expiryTime("5NOV26")).toISOString(), "2026-11-05T08:00:00.000Z");
  assert.equal(expiryTime("PERPETUAL"), null);
});

test("pickExpiries takes the next three Friday weeklies, then monthlies", () => {
  const codes = [...new Set(fx.BTC.rows.map((r) => r.instrument_name.split("-")[1]))];
  const picked = pickExpiries(codes, now).map((e) => e.code);
  // 6 Nov is a Friday 1.9 days out, so it is the first weekly.
  assert.deepEqual(picked, ["6NOV26", "13NOV26", "20NOV26", "27NOV26", "25DEC26", "29JAN27", "26MAR27"]);
});

test("pickExpiries skips expiries less than 1.5 days away", () => {
  const picked = pickExpiries(["5NOV26", "6NOV26", "13NOV26"], now).map((e) => e.code);
  assert.ok(!picked.includes("5NOV26"));
});

test("buildSnapshot produces well-formed USD chains", () => {
  const snap = buildSnapshot(fx, now);
  for (const coin of ["BTC", "ETH"]) {
    assert.equal(snap[coin].index, fx[coin].index);
    assert.ok(snap[coin].exps.length >= 5, `${coin} has expiries`);
    for (const e of snap[coin].exps) {
      assert.ok(e.s.length >= 5 && e.s.length <= 21);
      const ks = e.s.map((r) => r[0]);
      assert.deepEqual(ks, [...ks].sort((a, b) => a - b), "strikes ascending");
      for (const r of e.s) {
        assert.equal(r.length, 11);
        assert.ok(r[3] > 0 && r[8] > 0, "marks present");
        if (r[1] != null && r[2] != null) assert.ok(r[1] <= r[2], "bid <= ask");
      }
    }
  }
});

test("call minus put matches forward minus strike (put-call parity)", () => {
  const snap = buildSnapshot(fx, now);
  for (const coin of ["BTC", "ETH"]) {
    for (const e of snap[coin].exps) {
      for (const r of e.s) {
        const gap = r[3] - r[8] - (e.F - r[0]);
        assert.ok(Math.abs(gap) < e.F * 0.0005, `${coin} ${e.code} ${r[0]} parity gap ${gap}`);
      }
    }
  }
});

test("prices convert from coin units to USD with the expiry forward", () => {
  const snap = buildSnapshot(fx, now);
  const e = snap.BTC.exps.find((x) => x.code === "27NOV26");
  const row = e.s.find((r) => r[0] === 80000);
  const src = fx.BTC.rows.find((r) => r.instrument_name === "BTC-27NOV26-80000-C");
  assert.ok(Math.abs(row[3] - src.mark_price * e.F) < 0.2);
});

function mockRes() {
  const r = { headers: {}, code: 0, body: null };
  r.setHeader = (k, v) => (r.headers[k.toLowerCase()] = v);
  r.status = (c) => ((r.code = c), r);
  r.json = (b) => ((r.body = b), r);
  return r;
}

test("handler returns 200 with a cacheable chain", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    const u = String(url);
    const coin = /btc|BTC/.test(u) ? "BTC" : "ETH";
    const result = u.includes("get_index_price") ? { index_price: fx[coin].index } : fx[coin].rows;
    return new Response(JSON.stringify({ result }), { status: 200 });
  });
  const res = mockRes();
  await handler({}, res);
  assert.equal(res.code, 200);
  assert.match(res.headers["cache-control"], /s-maxage=10/);
  assert.ok(res.body.BTC.exps.length && res.body.ETH.exps.length);
});

test("handler returns 502 with a readable message when Deribit fails", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("down", { status: 503 }));
  const res = mockRes();
  await handler({}, res);
  assert.equal(res.code, 502);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.match(res.body.error, /unavailable/);
});
