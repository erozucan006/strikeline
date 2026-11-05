// Local preview: serves the page and runs the api/ functions the way Vercel would.
//   node test/serve.js            -> live mode, upstream answered from the recorded Deribit sample
//   node test/serve.js --down     -> /api/chain fails, page should fall back to snapshot.json
//   node test/serve.js --upstream -> really call Deribit (needs network access)
//   node test/serve.js --db       -> also enable accounts: runs supabase/migrations in PGlite
//                                    (npm i --no-save @electric-sql/pglite@0.2.17); the browser test
//                                    swaps supabase-js for test/fake-supabase.js, which calls /fake/*
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import chain from "../api/chain.js";
import config from "../api/config.js";
import logApi from "../api/log.js";
import { handler as tradeHandler, placeOrder, closePosition } from "../api/_trade.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = new Set(process.argv.slice(2));
const port = Number(process.env.PORT || 4173);

if (!args.has("--upstream")) {
  const fx = JSON.parse(await readFile(join(root, "test/deribit-fixture.json"), "utf8"));
  let tick = 0;
  globalThis.__fixture = fx;
  globalThis.fetch = async (url) => {
    if (args.has("--down")) return new Response("down", { status: 503 });
    const u = String(url), coin = /btc|BTC/.test(u) ? "BTC" : "ETH";
    const drift = 1 + 0.002 * Math.sin(++tick / 2); // nudge the index so polling visibly updates
    const result = u.includes("get_index_price") ? { index_price: fx[coin].index * drift } : fx[coin].rows;
    return new Response(JSON.stringify({ result }), { status: 200 });
  };
}

let db = null, queue = Promise.resolve();
if (args.has("--db")) {
  const { PGlite } = await import("@electric-sql/pglite");
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; grant usage on schema auth to authenticated, anon, service_role;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant execute on function auth.uid() to authenticated, anon, service_role;
    grant usage on schema public to authenticated, anon, service_role;`);
  for (const f of (await readdir(join(root, "supabase/migrations"))).filter((f) => f.endsWith(".sql")).sort())
    await db.exec(await readFile(join(root, "supabase/migrations", f), "utf8"));
  process.env.SUPABASE_URL = `http://localhost:${port}/fake`;
  process.env.SUPABASE_ANON_KEY = "test-anon-key";
}
const RPCS = new Set(["my_state", "submit_assessment", "accept_warning", "place_order", "close_position", "reduce_position", "reset_account"]);
// One connection: run each call to completion as the given user before the next starts.
const asUser = (user, fn, role = user ? "authenticated" : "anon") => {
  const run = queue.then(async () => {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user ? String(user).replace(/[^0-9a-f-]/g, "") : ""}', false); set role ${role};`);
    try { return await fn(); } finally { await db.exec("reset role;"); }
  });
  queue = run.catch(() => {}); // a failed call must not block the ones after it
  return run;
};
async function fakeApi(path, body) {
  if (path === "/fake/otp") {
    const email = String(body.email || "").toLowerCase();
    const h = createHash("md5").update(email).digest("hex");
    const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
    await db.query("insert into auth.users values ($1, $2) on conflict do nothing", [id, email]);
    return { id, email };
  }
  if (path === "/fake/rpc") {
    if (!RPCS.has(body.fn)) return { error: { message: "unknown function" } };
    const names = Object.keys(body.args || {}).filter((k) => /^p_[a-z_]+$/.test(k));
    const params = names.map((k) => { const v = body.args[k]; return v !== null && typeof v === "object" ? JSON.stringify(v) : v; });
    const sql = `select to_jsonb(r) as v from public.${body.fn}(${names.map((k, i) => `${k} => $${i + 1}`).join(", ")}) r`;
    try {
      const rows = await asUser(body.user, () => db.query(sql, params));
      let v = rows.rows[0]?.v;
      if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && body.fn in v) v = v[body.fn];
      return { data: v };
    } catch (e) {
      return { error: { message: e.message, details: e.detail || null } };
    }
  }
  return { error: { message: "not found" } };
}

// What /api/order and /api/close use on Vercel (api/_deps.js), answered locally: the session token
// is the user id, tickers come from the recorded Deribit sample stamped "now", and the booking
// functions run in PGlite as the service role, exactly as they would through the service key.
const sqlCall = (fn, args) => {
  const names = Object.keys(args || {}).filter((k) => /^p_[a-z_]+$/.test(k));
  const params = names.map((k) => { const v = args[k]; return v !== null && typeof v === "object" ? JSON.stringify(v) : v; });
  return [`select to_jsonb(r) as v from public.${fn}(${names.map((k, i) => `${k} => $${i + 1}`).join(", ")}) r`, params];
};
const tradeDeps = () => db && {
  async getUser(token) {
    if (!/^[0-9a-f-]{36}$/.test(token)) return null;
    const r = await db.query("select id from auth.users where id = $1", [token]);
    return r.rows[0] ? { id: token } : null;
  },
  async getTicker(name) {
    const fx = globalThis.__fixture, coin = name.slice(0, 3), row = fx && fx[coin]?.rows.find((r) => r.instrument_name === name);
    if (!row) return null;
    return { best_bid_price: row.bid_price, best_ask_price: row.ask_price, mark_price: row.mark_price, underlying_price: row.underlying_price, index_price: fx[coin].index, timestamp: Date.now() };
  },
  async getIndex(u) { return globalThis.__fixture[u].index; },
  async getOpenPosition(user, id) {
    const r = await db.query("select id, underlying, legs from public.positions where id = $1 and user_id = $2 and closed_at is null", [Number(id), user]);
    return r.rows[0] || null;
  },
  async rpc(fn, args) {
    const [sql, params] = sqlCall(fn, args);
    const rows = await asUser(null, () => db.query(sql, params), "service_role");
    const v = rows.rows[0]?.v;
    return v && typeof v === "object" && fn in v ? v[fn] : v;
  },
};
const orderApi = tradeHandler(placeOrder, tradeDeps), closeApi = tradeHandler(closePosition, tradeDeps);

const types = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".js": "text/javascript" };
const vercelRes = (res) => {
  const r = {
    setHeader: (k, v) => res.setHeader(k, v),
    status: (c) => ((res.statusCode = c), r),
    json: (b) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(b))),
    end: (b) => res.end(b),
  };
  return r;
};
createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/api/chain") return chain(req, vercelRes(res));
  if (path === "/api/config") return config(req, vercelRes(res));
  if (["/api/order", "/api/close", "/api/log"].includes(path)) {
    let raw = ""; for await (const c of req) raw += c;
    req.body = raw;
    const fn = path === "/api/order" ? orderApi : path === "/api/close" ? closeApi : logApi;
    return fn(req, vercelRes(res));
  }
  if (db && path.startsWith("/fake/") && req.method === "POST") {
    let raw = ""; for await (const c of req) raw += c;
    const out = await fakeApi(path, JSON.parse(raw || "{}"));
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
  }
  if (db && path === "/test/fake-supabase.js") {
    return res.writeHead(200, { "content-type": "text/javascript" }).end(await readFile(join(root, path)));
  }
  // Mirrors vercel.json "cleanUrls": /app serves app.html
  const file = normalize(join(root, path === "/" ? "index.html" : path === "/app" ? "app.html" : path));
  if (!file.startsWith(root) || file.includes("/api/") || file.includes("/test/") || file.includes("/supabase/")) return res.writeHead(404).end();
  try {
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" }).end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, () => console.log(`Strikeline preview on http://localhost:${port}${db ? " (accounts on)" : ""}`));
