// Runs the Supabase migrations in an in-process Postgres (PGlite) with a stub of Supabase's auth
// schema and roles, then exercises the server rules as two signed-in users and as the trusted
// server (service role) that books orders.
//   npm i --no-save @electric-sql/pglite@0.2.17 && node --test test/db.test.js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

let PGlite;
try { ({ PGlite } = await import("@electric-sql/pglite")); } catch { /* optional dev dependency */ }
const skip = !PGlite && "install @electric-sql/pglite to run database tests";

const A = "11111111-1111-1111-1111-111111111111", B = "22222222-2222-2222-2222-222222222222";
const ALL_RIGHT = { q1: "a", q2: "a", q3: "a", q4: "a", q5: "a", q6: "a", q7: "a" };
const EXP = (o = {}) => ({ e1: "0", e2: "3+", e3: ["crypto"], e4: "500-5k", e5: "study", ...o });
const future = Date.now() + 20 * 864e5;
const leg = (type, side, K, entry, qty = 0.05, t = future) => ({ type, side, K, entry, qty, t });
let db, n = 0;
const key = () => `test-key-${Date.now()}-${++n}`.padEnd(20, "x");
const nowIso = () => new Date().toISOString();

const runAs = async (role, user, sql, params = []) => {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user || ""}', false); set role ${role};`);
  try { return (await db.query(sql, params)).rows; } finally { await db.exec("reset role;"); }
};
const as = (user, sql, params) => runAs("authenticated", user, sql, params);
const svc = (sql, params) => runAs("service_role", null, sql, params);
const fails = async (p, code) => { await assert.rejects(p, (e) => (assert.match(e.message, new RegExp(code)), true)); };

// The trusted server's calls (what /api/order and /api/close do)
const order = async (u, name, legs, fee, req, k = key(), qts = nowIso()) =>
  (await svc("select place_order_v2($1,$2,'BTC',$3,$4,$5,$6,$7) as r", [u, name, legs, fee, req, k, qts]))[0].r;
const closeP = async (u, id, value, k = key()) => (await svc("select close_position_v2($1,$2,$3,$4,$5) as r", [u, id, value, k, nowIso()]))[0].r;
const reduceP = async (u, id, f, value, k = key()) => (await svc("select reduce_position_v2($1,$2,$3,$4,$5,$6) as r", [u, id, f, value, k, nowIso()]))[0].r;
const cash = async (u) => Number((await as(u, "select cash from accounts"))[0].cash);

before(async () => {
  if (skip) return;
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; grant usage on schema auth to authenticated, anon, service_role;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant execute on function auth.uid() to authenticated, anon, service_role;
    grant usage on schema public to authenticated, anon, service_role;
    insert into auth.users values ('${A}'), ('${B}');
  `);
  const dir = new URL("../supabase/migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await db.exec(readFileSync(new URL(f, dir), "utf8"));
});

test("scoring happens on the server and matches the page's rules", { skip }, async () => {
  const [r] = await as(A, "select * from submit_assessment('2026-11', $1, $2)", [EXP(), ALL_RIGHT]);
  assert.equal(r.level, 2, "all correct but no options experience → level 2");
  assert.deepEqual(r.score, { core: 4, spread: true, short: true, optExp: false });
  const [r3] = await as(A, "select * from submit_assessment('2026-11', $1, $2)", [EXP({ e1: "1-9", e5: "work" }), ALL_RIGHT]);
  assert.equal(r3.level, 3, "1-9 trades + works in finance → level 3");
});

test("three attempts per 24 hours", { skip }, async () => {
  await as(A, "select submit_assessment('2026-11', $1, $2)", [EXP(), { ...ALL_RIGHT, q1: "dk", q2: "b" }]);
  await fails(as(A, "select submit_assessment('2026-11', $1, $2)", [EXP(), ALL_RIGHT]), "attempt_limit");
});

test("bad input is rejected", { skip }, async () => {
  await fails(as(B, "select submit_assessment('2026-11', $1, $2)", [EXP({ e1: "lots" }), ALL_RIGHT]), "invalid_experience");
  await fails(as(B, "select submit_assessment('2026-11', $1, $2)", [EXP({ e3: [] }), ALL_RIGHT]), "invalid_experience");
  await fails(as(B, "select submit_assessment('2026-11', $1, $2)", [EXP(), { ...ALL_RIGHT, q7: "z" }]), "invalid_answers");
});

test("browsers can no longer book trades with their own prices", { skip }, async () => {
  await fails(as(A, "select place_order('Long call','BTC',$1,1,100)", [[leg("C", 1, 80000, 1)]]), "permission denied");
  await fails(as(A, "select place_order_v2($1,'x','BTC',$2,1,100,'abcdefghijklmnopq',now())", [A, [leg("C", 1, 80000, 1)]]), "permission denied");
  await fails(as(A, "select close_position(1, 1)"), "permission denied");
  await fails(as(A, "select reduce_position(1, 0.5, 1)"), "permission denied");
  await fails(as(A, "select close_position_v2($1, 1, 1, 'abcdefghijklmnopq', now())", [A]), "permission denied");
});

test("failed check: no trading until the warning is accepted, then buy-only", { skip }, async () => {
  const [r] = await as(B, "select * from submit_assessment('2026-11', $1, $2)", [EXP(), { ...ALL_RIGHT, q1: "dk", q2: "b" }]);
  assert.equal(r.level, 0);
  const buy = [leg("C", 1, 80000, 1500)];
  await fails(order(B, "Long call", buy, 3, 80), "level_required");
  await as(B, "select accept_warning($1)", [r.id]);
  await fails(as(B, "select accept_warning($1)", [r.id]), "warning_not_open|records_are_append_only");
  const res = await order(B, "Long call", buy, 3, 80);
  assert.ok(res.position.id && res.replayed === false);
  const [o] = await as(B, "select after_warning, level_required, quote_ts is not null as has_ts from orders where position_id = $1", [res.position.id]);
  assert.deepEqual(o, { after_warning: true, level_required: 1, has_ts: true });
  await fails(order(B, "Bull call spread", [leg("C", 1, 78000, 2300), leg("C", -1, 82000, 900)], 5, 100), "level_required");
});

test("level 2 can trade covered spreads but not uncovered shorts", { skip }, async () => {
  await db.query("alter table assessments disable trigger assessments_guard");
  await db.query("update assessments set created_at = created_at - interval '2 days' where user_id = $1", [A]);
  await db.query("alter table assessments enable trigger assessments_guard");
  await as(A, "select submit_assessment('2026-11', $1, $2)", [EXP(), ALL_RIGHT]);
  await order(A, "Bull call spread", [leg("C", 1, 78000, 2300), leg("C", -1, 82000, 900)], 5, 100);
  await fails(order(A, "Short call", [leg("C", -1, 82000, 900)], 2, 3000), "level_required");
  await fails(order(A, "Short put", [leg("P", -1, 74000, 900)], 2, 3000), "level_required");
  const calendar = [leg("C", -1, 80000, 1500, 0.05, future + 30 * 864e5), leg("C", 1, 80000, 1200)];
  await fails(order(A, "Calendar", calendar, 2, 3000), "level_required");
});

test("cash, fee, capital and expiry are checked; cash moves on the server", { skip }, async () => {
  const before = await cash(A);
  await fails(order(A, "Long call", [leg("C", 1, 80000, 1500)], 1, 999999), "insufficient_cash");
  await fails(order(A, "Long call", [leg("C", 1, 80000, 1500)], 1, 10), "invalid_required");
  await fails(order(A, "Long call", [leg("C", 1, 80000, 1500)], 500, 600), "invalid_fee");
  await fails(order(A, "Old", [leg("C", 1, 80000, 1500, 0.05, Date.now() - 1000)], 1, 100), "invalid_legs");
  const res = await order(A, "Long call", [leg("C", 1, 80000, 1500)], 2.5, 80);
  assert.equal(before - Number(res.cash), 77.5, "premium 0.05 × 1500 + fee 2.5");
  await closeP(A, res.position.id, 60);
  assert.equal((await cash(A)) - Number(res.cash), 60);
  await fails(closeP(A, res.position.id, 60), "position_not_open");
});

test("the same idempotency key never books twice", { skip }, async () => {
  const k = key(), legs = [leg("C", 1, 80000, 1500)];
  const c0 = await cash(A);
  const first = await order(A, "Long call", legs, 2.5, 80, k);
  const again = await order(A, "Long call", legs, 2.5, 80, k);
  assert.equal(again.replayed, true);
  assert.equal(again.position.id, first.position.id);
  assert.equal(c0 - (await cash(A)), 77.5, "charged once");
  const ck = key();
  await closeP(A, first.position.id, 50, ck);
  const replay = await closeP(A, first.position.id, 50, ck);
  assert.equal(replay.replayed, true, "a repeated close is answered, not refused or doubled");
});

test("stale quotes and bursts are refused", { skip }, async () => {
  const old = new Date(Date.now() - 60_000).toISOString();
  await fails(order(A, "Long call", [leg("C", 1, 80000, 1500)], 2.5, 80, key(), old), "stale_quote");
  await fails(order(A, "Long call", [leg("C", 1, 80000, 1500)], 2.5, 80, key(), null), "stale_quote");
  // 20 orders a minute per user at most (earlier tests already used some of A's budget)
  let refused = false;
  for (let i = 0; i < 25 && !refused; i++) {
    try { await order(A, "Long call", [leg("C", 1, 80000, 1, 0.01)], 0, 0.01); } catch (e) { refused = /rate_limited/.test(e.message); if (!refused) throw e; }
  }
  assert.ok(refused, "rate limit kicks in");
});

test("partial close keeps the rest consistent and logs the closed part", { skip }, async () => {
  await db.query("alter table orders disable trigger orders_append_only");
  await db.query("update orders set created_at = created_at - interval '5 minutes' where user_id = $1", [A]);
  await db.query("alter table orders enable trigger orders_append_only");
  const res = await order(A, "Bull call spread", [leg("C", 1, 78000, 2300, 0.08), leg("C", -1, 82000, 900, 0.08)], 4, 200);
  const c0 = await cash(A);
  await reduceP(A, res.position.id, 0.25, 30);
  const [p] = await as(A, "select legs, fee from positions where id = $1", [res.position.id]);
  assert.deepEqual(p.legs.map((l) => l.qty), [0.06, 0.06]);
  assert.equal(Number(p.fee), 3);
  assert.equal((await cash(A)) - c0, 30);
  const [o] = await as(A, "select legs from orders where position_id = $1 and kind = 'reduce'", [res.position.id]);
  assert.deepEqual(o.legs.map((l) => l.qty), [0.02, 0.02]);
  await fails(reduceP(A, res.position.id, 1, 10), "invalid_fraction");
  await fails(reduceP(A, res.position.id, 0.5, 1e9), "invalid_value");
  await fails(reduceP(B, res.position.id, 0.5, 10), "position_not_open");
});

test("records are append-only and survive account deletion attempts", { skip }, async () => {
  await fails(db.query("update orders set net = 0 where user_id = $1", [A]), "records_are_append_only");
  await fails(db.query("delete from orders where user_id = $1", [A]), "records_are_append_only");
  await fails(db.query("update assessments set level = 3 where user_id = $1", [B]), "records_are_append_only");
  await fails(db.query("delete from assessments where user_id = $1", [B]), "records_are_append_only");
  await fails(db.query("delete from auth.users where id = $1", [A]), "foreign key|violates");
});

test("users only see their own rows and cannot write tables directly", { skip }, async () => {
  const mine = await as(B, "select user_id from positions");
  assert.ok(mine.length > 0 && mine.every((r) => r.user_id === B));
  assert.equal((await as(B, "select * from assessments where user_id = $1", [A])).length, 0);
  await fails(as(B, "update accounts set cash = 1e9"), "permission denied");
  await fails(as(B, "insert into assessments (user_id, version, experience, answers, score, level) values ($1, 'x', '{}', '{}', '{}', 3)", [B]), "permission denied");
});

test("my_state returns everything the page needs", { skip }, async () => {
  const [{ my_state: s }] = await as(A, "select my_state()");
  assert.ok(Number(s.cash) > 0 && s.assessment.level === 2 && Array.isArray(s.positions));
  assert.equal(s.assessment.user_id, undefined);
});

test("signed-out callers are refused", { skip }, async () => {
  await db.exec("reset role; select set_config('request.jwt.claim.sub', '', false); set role anon;");
  await fails(db.query("select my_state()"), "permission denied");
  await db.exec("reset role;");
});

test("revenue books: service-only, idempotent, append-only; admin summary shows markup and client exposure", { skip }, async () => {
  const row = (k, n, o = {}) => ({ user_id: A, kind: "open", position_id: null, idempotency_key: k, leg_no: n, underlying: "BTC", instrument: "BTC-27NOV26-80000-C",
    client_side: 1, qty: 0.05, index_price: 80000, exchange_price: 2000, client_price: 2040, markup: 2, exchange_fee: 1.2, ...o });
  const k1 = key();
  assert.equal((await svc("select record_revenue($1) as n", [[row(k1, 0), row(k1, 1, { markup: 1.5 })]]))[0].n, 2);
  assert.equal((await svc("select record_revenue($1) as n", [[row(k1, 0)]]))[0].n, 0, "same key and leg is not counted twice");
  await fails(as(A, "select * from revenue"), "permission denied");
  await fails(as(A, "select record_revenue($1)", [[row(key(), 0)]]), "permission denied");
  await fails(as(A, "select admin_summary()"), "permission denied");
  await fails(db.exec("update revenue set markup = 0"), "records_are_append_only");
  const s = (await svc("select admin_summary() as s"))[0].s;
  assert.ok(Number(s.totals.all) >= 3.5 && Number(s.totals.today) >= 3.5 && s.totals.fills >= 2, JSON.stringify(s.totals));
  assert.ok(s.recent.length >= 2 && s.by_instrument.some((i) => i.instrument === "BTC-27NOV26-80000-C"));
  assert.ok(Array.isArray(s.exposure) && s.exposure.every((e) => Number(e.client_net) !== 0), "open client positions summed by option");
});
