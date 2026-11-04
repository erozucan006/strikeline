// Runs the Supabase migration in an in-process Postgres (PGlite) with a stub of Supabase's
// auth schema, then exercises the server rules as two different signed-in users.
//   npm i --no-save @electric-sql/pglite@0.2.17 && node --test test/db.test.js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let PGlite;
try { ({ PGlite } = await import("@electric-sql/pglite")); } catch { /* optional dev dependency */ }
const skip = !PGlite && "install @electric-sql/pglite to run database tests";

const A = "11111111-1111-1111-1111-111111111111", B = "22222222-2222-2222-2222-222222222222";
const ALL_RIGHT = { q1: "a", q2: "a", q3: "a", q4: "a", q5: "a", q6: "a", q7: "a" };
const EXP = (o = {}) => ({ e1: "0", e2: "3+", e3: ["crypto"], e4: "500-5k", e5: "study", ...o });
const future = Date.now() + 20 * 864e5;
const leg = (type, side, K, entry, qty = 0.05, t = future) => ({ type, side, K, entry, qty, t });
let db;

const as = async (user, sql, params = []) => {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user}', false); set role authenticated;`);
  try { return (await db.query(sql, params)).rows; } finally { await db.exec("reset role;"); }
};
const fails = async (p, code) => { await assert.rejects(p, (e) => (assert.match(e.message, new RegExp(code)), true)); };

before(async () => {
  if (skip) return;
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; grant usage on schema auth to authenticated, anon;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant execute on function auth.uid() to authenticated, anon;
    grant usage on schema public to authenticated, anon;
    insert into auth.users values ('${A}'), ('${B}');
  `);
  await db.exec(readFileSync(new URL("../supabase/migrations/001_accounts.sql", import.meta.url), "utf8"));
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

test("failed check: no trading until the warning is accepted, then buy-only", { skip }, async () => {
  const [r] = await as(B, "select * from submit_assessment('2026-11', $1, $2)", [EXP(), { ...ALL_RIGHT, q1: "dk", q2: "b" }]);
  assert.equal(r.level, 0);
  const buy = [leg("C", 1, 80000, 1500)];
  await fails(as(B, "select place_order('Long call', 'BTC', $1, 3, 80)", [buy]), "level_required");
  await as(B, "select accept_warning($1)", [r.id]);
  await fails(as(B, "select accept_warning($1)", [r.id]), "warning_not_open");
  const [pos] = await as(B, "select * from place_order('Long call', 'BTC', $1, 3, 80)", [buy]);
  assert.ok(pos.id);
  const [o] = await as(B, "select after_warning, level_required from orders where position_id = $1", [pos.id]);
  assert.deepEqual(o, { after_warning: true, level_required: 1 });
  await fails(as(B, "select place_order('Bull call spread', 'BTC', $1, 5, 100)", [[leg("C", 1, 78000, 2300), leg("C", -1, 82000, 900)]]), "level_required");
});

test("level 2 can trade covered spreads but not uncovered shorts", { skip }, async () => {
  // user A's latest assessment is the failed third attempt; reset by inserting a passing one directly
  await db.query("update assessments set created_at = created_at - interval '2 days' where user_id = $1", [A]);
  await as(A, "select submit_assessment('2026-11', $1, $2)", [EXP(), ALL_RIGHT]);
  const spread = [leg("C", 1, 78000, 2300), leg("C", -1, 82000, 900)];
  await as(A, "select place_order('Bull call spread', 'BTC', $1, 5, 100)", [spread]);
  await fails(as(A, "select place_order('Short call', 'BTC', $1, 2, 3000)", [[leg("C", -1, 82000, 900)]]), "level_required");
  await fails(as(A, "select place_order('Short put', 'BTC', $1, 2, 3000)", [[leg("P", -1, 74000, 900)]]), "level_required");
  // a sold leg covered only by a shorter-dated bought leg is not covered
  const calendar = [leg("C", -1, 80000, 1500, 0.05, future + 30 * 864e5), leg("C", 1, 80000, 1200)];
  await fails(as(A, "select place_order('Calendar', 'BTC', $1, 2, 3000)", [calendar]), "level_required");
});

test("cash is checked and moved on the server", { skip }, async () => {
  const [{ cash: before }] = await as(A, "select cash from accounts");
  await fails(as(A, "select place_order('Long call', 'BTC', $1, 1, 999999)", [[leg("C", 1, 80000, 1500)]]), "insufficient_cash");
  await fails(as(A, "select place_order('Long call', 'BTC', $1, 1, 10)", [[leg("C", 1, 80000, 1500)]]), "invalid_required");
  await fails(as(A, "select place_order('Long call', 'BTC', $1, 500, 600)", [[leg("C", 1, 80000, 1500)]]), "invalid_fee");
  await fails(as(A, "select place_order('Old', 'BTC', $1, 1, 100)", [[leg("C", 1, 80000, 1500, 0.05, Date.now() - 1000)]]), "invalid_legs");
  const [pos] = await as(A, "select * from place_order('Long call', 'BTC', $1, 2.5, 80)", [[leg("C", 1, 80000, 1500)]]);
  const [{ cash: after }] = await as(A, "select cash from accounts");
  assert.equal(Number(before) - Number(after), 77.5, "premium 0.05 × 1500 + fee 2.5");
  await as(A, "select close_position($1, 60)", [pos.id]);
  const [{ cash: closed }] = await as(A, "select cash from accounts");
  assert.equal(Number(closed) - Number(after), 60);
  await fails(as(A, "select close_position($1, 60)", [pos.id]), "position_not_open");
});

test("users only see their own rows and cannot write tables directly", { skip }, async () => {
  const mine = await as(B, "select user_id from positions");
  assert.ok(mine.length > 0 && mine.every((r) => r.user_id === B));
  assert.equal((await as(B, "select * from assessments where user_id = $1", [A])).length, 0);
  await fails(as(B, "update accounts set cash = 1e9"), "permission denied");
  await fails(as(B, "insert into assessments (user_id, version, experience, answers, score, level) values ($1, 'x', '{}', '{}', '{}', 3)", [B]), "permission denied");
  await fails(as(A, "select close_position($1, 1)", [(await as(B, "select id from positions limit 1"))[0].id]), "position_not_open");
});

test("my_state returns everything the page needs", { skip }, async () => {
  const [{ my_state: s }] = await as(A, "select my_state()");
  assert.ok(Number(s.cash) > 0 && s.assessment.level === 2 && Array.isArray(s.positions) && s.tries24h.length === 1);
  assert.equal(s.assessment.user_id, undefined);
});

test("signed-out callers are refused", { skip }, async () => {
  await db.exec("reset role; select set_config('request.jwt.claim.sub', '', false); set role anon;");
  await fails(db.query("select my_state()"), "permission denied");
  await db.exec("reset role;");
});
