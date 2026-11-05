const { chromium } = require("playwright");
const SP = require("os").tmpdir() + "/";
const BASE = process.argv[2];
const log = [];
const ok = (c, what) => log.push((c ? "PASS " : "FAIL ") + what);
const sel = (n, v) => `#asBody input[name="${n}"][value="${v}"]`;

async function setup(ctx) {
  const p = await ctx.newPage();
  p.errs = [];
  p.on("pageerror", (e) => p.errs.push(e.message));
  await p.route(/fonts\./, (r) => r.abort());
  await p.route(/cdn\.jsdelivr\.net\/npm\/@supabase/, (r) => r.fulfill({ status: 302, headers: { location: BASE + "test/fake-supabase.js" } }));
  await p.goto(BASE + "app"); await p.waitForSelector("#chain tbody tr");
  await p.waitForSelector("#auth button", { timeout: 8000 });
  return p;
}
async function signIn(p, email) {
  await p.click('#auth [data-auth="in"]');
  await p.fill("#siEmail", email); await p.click("#siSend");
  await p.waitForFunction(() => document.getElementById("siTitle").textContent === "Check your inbox");
  await p.evaluate(() => window.__fakeLogin());
  await p.waitForFunction((e) => (document.querySelector("#auth .who") || {}).textContent === e, email);
  await p.waitForFunction(() => !/—/.test(document.getElementById("cash").textContent));
}
async function check(p, exp, pick) {
  await p.click('#asFoot [data-act="toExp"]');
  for (const [k, v] of Object.entries(exp)) for (const x of [].concat(v)) await p.check(sel(k, x));
  await p.click('#asFoot [data-act="toQuiz"]');
  for (let i = 1; i <= 7; i++) await p.check(sel("q" + i, pick(i)));
  await p.click('#asFoot [data-act="finish"]');
  await p.waitForFunction(() => /Result/.test(document.querySelector(".as-step")?.textContent || "") || /\S/.test(document.getElementById("asErr")?.textContent || ""));
}
const CAN = "can" + Date.now() + "@example.com";
const txt = (p, s) => p.textContent(s);
// A real BTC call from the recorded Deribit sample, with the price a browser would show for it.
const fx = require("../deribit-fixture.json");
const MON = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const expTs = (c) => { const m = /^(\d+)([A-Z]{3})(\d+)$/.exec(c); return Date.UTC(2000 + +m[3], MON.indexOf(m[2]), +m[1], 8); };
const calls = fx.BTC.rows.filter((r) => r.instrument_name.endsWith("-C") && r.bid_price > 0 && r.ask_price > 0 && expTs(r.instrument_name.split("-")[1]) > Date.now() + 864e5)
  .sort((a, b) => a.instrument_name.localeCompare(b.instrument_name));
const legFrom = (r, side, qty = 0.05) => { const [, e, K] = r.instrument_name.split("-"); return { type: "C", K: +K, e, side, qty, limit: (side > 0 ? r.ask_price : r.bid_price) * r.underlying_price }; };
const apiOrder = (p, legs, key, path = "/api/order") => p.evaluate(async ([legs, key, path]) => {
  const s = JSON.parse(localStorage.getItem("fake-sb-session"));
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + s.access_token }, body: JSON.stringify({ underlying: "BTC", name: "x", legs, idempotencyKey: key }) });
  return { status: r.status, body: await r.json() };
}, [legs, key, path]);
const rpc = (p, fn, args) => p.evaluate(async ([fn, args]) => {
  const s = JSON.parse(localStorage.getItem("fake-sb-session"));
  return fetch("/fake/rpc", { method: "POST", body: JSON.stringify({ user: s.user.id, fn, args }) }).then((r) => r.json());
}, [fn, args]);

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
  let p = await setup(ctx); globalThis.__p = p;

  ok(/Sign in/.test(await txt(p, "#auth")), "config on → Sign in button shows");
  // validation
  await p.click('#auth [data-auth="in"]'); await p.fill("#siEmail", "can@"); await p.click("#siSend");
  ok(/full email address/.test(await txt(p, "#siErr")) && (await p.getAttribute("#siEmail", "aria-invalid")) === "true", "invalid email is flagged");
  await p.click("#siClose");
  await signIn(p, CAN);
  ok((await txt(p, "#cash")) === "$10,000.00", "new account starts with $10,000");
  ok((await txt(p, "#submit")) === "Start the knowledge check", "signed-in user without a check must take it");

  // server-scored check: level 3
  await p.click("#submit");
  await check(p, { e1: "10-49", e2: "3+", e3: ["crypto", "options"], e4: "500-5k", e5: "study" }, () => "a");
  ok(/level: 3/.test(await txt(p, "#asTitle")), "server scores the check → level 3");
  await p.click('#asFoot [data-act="close"]');
  await p.click('#presets button[data-p="2"]'); await p.click("#submit");
  await p.waitForFunction(() => /Filled|server|market|price|minute/.test(document.getElementById("msg").textContent));
  ok(/Filled at the market/.test(await txt(p, "#msg")), "order priced and booked by the server: " + (await txt(p, "#msg")));

  // tampering: the old browser-priced function is gone; a cheap limit is refused; a repeat is not booked twice
  const old = await rpc(p, "place_order", { p_name: "x", p_underlying: "BTC", p_legs: [{ type: "C", side: 1, K: 80000, entry: 1, qty: 0.05, t: Date.now() + 9e8 }], p_fee: 0, p_required: 0.05 });
  ok(/permission denied/.test(old.error?.message || ""), "browser can no longer book with its own prices: " + (old.error?.message || "").slice(0, 60));
  const direct = await rpc(p, "place_order_v2", { p_user: "x" });
  ok(/permission denied|unknown function/.test(direct.error?.message || ""), "browser cannot call the server-only booking function");
  const cheap = await apiOrder(p, [{ ...legFrom(calls[0], 1), limit: 1 }], "tamper-cheap-000001");
  ok(cheap.status === 409 && cheap.body.error === "price_moved", "asking for a 1 USD fill → price_moved " + JSON.stringify(cheap));
  const forged = await p.evaluate(async () => (await fetch("/api/order", { method: "POST", headers: { authorization: "Bearer 00000000-0000-0000-0000-000000000000" }, body: "{}" })).status);
  ok(forged === 401, "unknown session token → 401");
  const cashBefore = await txt(p, "#cash");
  const k = "double-click-000001", legs1 = [legFrom(calls[0], 1, 0.01)];
  const [o1, o2] = await Promise.all([apiOrder(p, legs1, k), apiOrder(p, legs1, k)]);
  ok(o1.status === 200 && o2.status === 200 && [o1.body.replayed, o2.body.replayed].sort().join() === "false,true", "same key twice at once → one order, one replay");
  await p.reload(); await p.waitForSelector("#auth .who"); await p.waitForFunction(() => document.querySelectorAll(".pcard").length > 0);
  ok((await p.$$(".pcard")).length === 2, "exactly 2 positions after the double click (strategy + one call)");
  ok(cashBefore !== (await txt(p, "#cash")), "cash moved once for the extra call");
  const extra = (await p.$$("[data-adj]"));
  await extra[0].click(); await p.click('[data-closef$=":1"]');
  await p.waitForFunction(() => document.querySelectorAll(".pcard").length === 1);
  ok(/Closed at the market/.test(await txt(p, "#msg")), "close priced by the server: " + (await txt(p, "#msg")));
  const cashAfter = await txt(p, "#cash");

  // persists across reload
  await p.reload(); await p.waitForSelector("#auth .who");
  await p.waitForFunction(() => document.querySelectorAll(".pcard").length > 0);
  const cashReload = await txt(p, "#cash"); ok((await p.$$(".pcard")).length === 1 && cashReload === cashAfter, `position and cash survive a reload (${cashAfter} → ${cashReload})`);
  await p.click("details.rec summary");
  const rec = await txt(p, "details.rec");
  ok(/Saved to your account/.test(rec) && /Orders under this check\s*2/.test(rec.replace(/\s+/g, " ")), "record says saved to account, 2 orders");

  // close position
  await p.click("[data-adj]"); await p.click('[data-closef$=":1"]');
  await p.waitForFunction(() => document.querySelectorAll(".pcard").length === 0);
  await p.reload(); await p.waitForSelector("#auth .who"); await p.waitForTimeout(500);
  ok((await p.$$(".pcard")).length === 0, "closed position stays closed after reload");

  // reset balance with in-page confirmation
  await p.click('[data-reset="ask"]');
  ok(/reset cash to \$10,000/.test(await txt(p, "#pos")), "reset asks for confirmation in the page");
  await p.click('[data-reset="yes"]');
  await p.waitForFunction(() => document.getElementById("cash").textContent === "$10,000.00");
  ok(true, "reset restores $10,000");

  // second user: fails → warning → buy only; server refuses a spread even if the page is bypassed
  await p.click('#auth [data-auth="out"]'); await p.waitForSelector("#chain tbody tr"); await p.waitForSelector('#auth [data-auth="in"]');
  ok((await txt(p, "#submit")) === "Start the knowledge check", "signed out → back to guest state");
  await signIn(p, "deniz" + Date.now() + "@example.com");
  await p.click("#submit");
  await check(p, { e1: "0", e2: "<1", e3: ["none"], e4: "<500", e5: "no" }, (i) => (i <= 2 ? "dk" : "b"));
  ok(!!(await p.$(".warnbox")), "server result for a failed check shows the warning");
  const blocked = await apiOrder(p, [legFrom(calls[0], 1)], "blocked-before-ack-01");
  ok(blocked.body.error === "level_required", "server refuses orders before the warning is accepted " + JSON.stringify(blocked.body));
  await p.click('#asFoot [data-act="accept"]');
  await p.waitForFunction(() => /accepted this warning/.test(document.getElementById("asBody").textContent));
  await p.click('#asFoot [data-act="close"]');
  ok(/Level 1/.test(await txt(p, "#access")), "accepted warning → level 1 from the server");
  const sameExp = calls.filter((r) => r.instrument_name.split("-")[1] === calls[0].instrument_name.split("-")[1]);
  const spread = await apiOrder(p, [legFrom(sameExp[0], 1), legFrom(sameExp[sameExp.length - 1], -1)], "spread-at-level1-01");
  ok(spread.body.error === "level_required", "server refuses a spread at level 1 even when the page is bypassed " + JSON.stringify(spread.body));
  await p.click('#presets button[data-p="0"]'); await p.click("#submit");
  await p.waitForFunction(() => /Filled|server|market|price|Not enough/.test(document.getElementById("msg").textContent));
  ok(/Filled at the market/.test(await txt(p, "#msg")), "level 1 user can buy a call: " + (await txt(p, "#msg")));

  // attempt limit comes from the server
  for (let i = 0; i < 2; i++) { await p.click('#access [data-act="retake"]'); await check(p, { e1: "0" }, () => "b"); await p.click('#asFoot [data-act="close"]').catch(() => {}); await p.keyboard.press("Escape"); }
  ok(/Next retake from/.test(await txt(p, "#access")), "3 server attempts → retake locked");
  const fourth = await rpc(p, "submit_assessment", { p_version: "2026-11", p_experience: { e1: "0", e2: "<1", e3: ["none"], e4: "<500", e5: "no" }, p_answers: { q1: "a", q2: "a", q3: "a", q4: "a", q5: "a", q6: "a", q7: "a" } });
  ok(/attempt_limit/.test(fourth.error?.message || ""), "server refuses a 4th attempt");

  // first user's data is untouched and private
  await p.click('#auth [data-auth="out"]'); await p.waitForSelector('#auth [data-auth="in"]');
  await signIn(p, CAN);
  await p.waitForFunction(() => /Level \d|knowledge check/.test(document.getElementById("access").textContent + document.getElementById("submit").textContent), null, { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(600);
  const acc1 = (await txt(p, "#access")).replace(/\s+/g, " ").slice(0, 80);
  ok(/Level 3/.test(acc1), "first user still level 3 after the second user's attempts: " + acc1);

  // phone layout of header with auth
  const ph = await b.newPage({ viewport: { width: 390, height: 844 } });
  await ph.route(/fonts\./, (r) => r.abort());
  await ph.route(/cdn\.jsdelivr\.net\/npm\/@supabase/, (r) => r.fulfill({ status: 302, headers: { location: BASE + "test/fake-supabase.js" } }));
  await ph.goto(BASE + "app"); await ph.waitForSelector("#auth button");
  await ph.click('#auth [data-auth="in"]');
  const over = await ph.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  ok(!over, "phone: no sideways scroll with sign-in");
  await ph.screenshot({ path: SP + "signin-phone.png" });

  ok(p.errs.length === 0, "no page errors " + JSON.stringify(p.errs));
  console.log(log.join("\n"));
  await b.close();
})().catch(async (e) => { console.log(log.join("\n")); console.log("CRASH", e.message.split("\n")[0]); try { const pg = globalThis.__p; console.log("asBody:", (await pg.textContent("#asBody")).replace(/\s+/g," ").slice(0,400)); console.log("asFoot:", await pg.textContent("#asFoot")); console.log("errs:", pg.errs); } catch (x) {} process.exit(1); });
