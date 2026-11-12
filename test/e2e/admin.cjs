// Admin page: the platform's books after real (demo) fills, and closed to everyone else.
const { chromium } = require("playwright");
const BASE = process.argv[2];
const log = [], ok = (c, w) => log.push((c ? "PASS " : "FAIL ") + w);
const sel = (n, v) => `#asBody input[name="${n}"][value="${v}"]`;
async function page(ctx) {
  const p = await ctx.newPage(); p.errs = [];
  p.on("pageerror", (e) => p.errs.push(e.message));
  await p.route(/fonts\./, (r) => r.abort());
  await p.route(/cdn\.jsdelivr\.net\/npm\/@supabase/, (r) => r.fulfill({ status: 302, headers: { location: BASE + "test/fake-supabase.js" } }));
  return p;
}
async function signIn(p, email) {
  await p.goto(BASE + "app"); await p.waitForSelector("#chain tbody tr"); await p.waitForSelector('#auth [data-auth="in"]');
  await p.click('#auth [data-auth="in"]'); await p.fill("#siEmail", email); await p.click("#siSend");
  await p.waitForFunction(() => document.getElementById("siTitle").textContent === "Check your inbox");
  await p.evaluate(() => window.__fakeLogin());
  await p.waitForFunction(() => !/—/.test(document.getElementById("cash").textContent));
}
(async () => {
  const b = await chromium.launch();
  // admin@example.com is the preview's admin (test/serve.js); sign in, pass the check, trade
  const ctx = await b.newContext({ viewport: { width: 1300, height: 900 } });
  const p = await page(ctx);
  await signIn(p, "admin@example.com");
  if (/Start the knowledge check/.test(await p.textContent("#submit"))) {
    await p.click("#submit"); await p.click('#asFoot [data-act="toExp"]');
    for (const [k, v] of Object.entries({ e1: "10-49", e2: "3+", e3: ["crypto", "options"], e4: "500-5k", e5: "study" })) for (const x of [].concat(v)) await p.check(sel(k, x));
    await p.click('#asFoot [data-act="toQuiz"]'); for (let i = 1; i <= 7; i++) await p.check(sel("q" + i, "a"));
    await p.click('#asFoot [data-act="finish"]'); await p.waitForSelector('#asFoot [data-act="close"]'); await p.click('#asFoot [data-act="close"]');
  }
  await p.click('#presets button[data-p="2"]'); await p.click("#submit");
  await p.waitForFunction(() => /Filled|server|market|price/.test(document.getElementById("msg").textContent));
  ok(/Filled at the market/.test(await p.textContent("#msg")), "admin places a 2-leg order");
  const a = await page(ctx);
  await a.goto(BASE + "admin"); await a.waitForSelector("#main:not([hidden])", { timeout: 10000 });
  const t = await a.evaluate(() => ({ today: document.getElementById("kToday").textContent, all: document.getElementById("kAll").textContent,
    rows: document.querySelectorAll("#recent tbody tr").length, expo: document.querySelectorAll("#expo tbody tr").length, text: document.getElementById("expo").innerText,
    over: document.documentElement.scrollWidth > innerWidth }));
  ok(/^\$\d/.test(t.today) && t.today !== "$0.00", "earned today shows the markup: " + t.today);
  ok(t.rows >= 2, "latest fills lists both legs: " + t.rows);
  ok(t.expo >= 2 && /Platform holds/.test(t.text), "open exposure lists the legs clients hold");
  ok(!t.over, "no sideways scroll");
  await a.screenshot({ path: require("os").tmpdir() + "/admin.png", fullPage: true });
  await a.setViewportSize({ width: 390, height: 844 }); await a.waitForTimeout(200);
  ok(!(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth)), "phone: no sideways scroll");
  // client view never contains the exchange price or markup
  const app = await p.evaluate(() => document.body.innerText);
  ok(!/Exchange price|markup/i.test(app), "the client app never mentions exchange price or markup");
  // a normal user is refused, and the API refuses without a token
  const ctx2 = await b.newContext({ viewport: { width: 1300, height: 900 } });
  const u = await page(ctx2);
  await signIn(u, "client" + Date.now() + "@example.com");
  await u.goto(BASE + "admin"); await u.waitForFunction(() => /No access/.test(document.getElementById("state").textContent), null, { timeout: 8000 });
  ok(true, "a client account sees 'No access'");
  const anon = await u.evaluate(async () => (await fetch("/api/admin")).status);
  ok(anon === 401, "no token → 401");
  const viaRpc = await u.evaluate(async () => { const s = JSON.parse(localStorage.getItem("fake-sb-session"));
    return fetch("/fake/rpc", { method: "POST", body: JSON.stringify({ user: s.user.id, fn: "admin_summary", args: {} }) }).then((r) => r.json()); });
  ok(!!viaRpc.error, "browser cannot call admin_summary directly");
  ok(p.errs.length + a.errs.length + u.errs.length === 0, "no page errors " + JSON.stringify([...p.errs, ...a.errs, ...u.errs]));
  console.log(log.join("\n")); await b.close();
})().catch((e) => { console.log(log.join("\n")); console.log("CRASH", e.message.split("\n")[0]); process.exit(1); });
