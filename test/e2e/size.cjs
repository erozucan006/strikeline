const { chromium } = require("playwright");
const SP = require("os").tmpdir() + "/";
const [BASE, MODE] = [process.argv[2], process.argv[3] || "guest"];
const log = [];
const ok = (c, what) => log.push((c ? "PASS " : "FAIL ") + "[" + MODE + "] " + what);
const sel = (n, v) => `#asBody input[name="${n}"][value="${v}"]`;
const st = (p) => p.evaluate(() => ({
  size: document.getElementById("tqty").value, btn: document.getElementById("submit").textContent, dis: document.getElementById("submit").disabled,
  risk: document.getElementById("risk").hidden ? "" : document.getElementById("risk").innerText.replace(/\s+/g, " "),
  hint: document.getElementById("sizehint").innerText.replace(/\s+/g, " "),
  legQty: [...document.querySelectorAll(".leg input[data-q]")].map((i) => i.value),
  cash: document.getElementById("cash").textContent, msg: document.getElementById("msg").textContent,
}));
const money = (s) => Number(String(s).replace(/[^0-9.-]/g, ""));

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.route(/fonts\./, (r) => r.abort());
  if (MODE === "guest") {
    await p.addInitScript(() => { const now = Date.now(); localStorage.setItem("strikeline.appropriateness.v1", JSON.stringify({ tries: [now], record: { id: "SL-T", version: "2026-11", at: now, expires: now + 365 * 864e5, experience: {}, answers: {}, score: { core: 4, spread: true, short: true, optExp: true }, level: 3, warnedAck: null, orders: [] } })); });
  } else {
    await p.route(/cdn\.jsdelivr\.net\/npm\/@supabase/, (r) => r.fulfill({ status: 302, headers: { location: BASE + "test/fake-supabase.js" } }));
  }
  await p.goto(BASE + "app"); await p.waitForSelector("#chain tbody tr");
  if (MODE === "db") {
    await p.waitForSelector('#auth [data-auth="in"]');
    await p.click('#auth [data-auth="in"]'); await p.fill("#siEmail", "size" + Date.now() + "@example.com"); await p.click("#siSend");
    await p.waitForFunction(() => document.getElementById("siTitle").textContent === "Check your inbox");
    await p.evaluate(() => window.__fakeLogin()); await p.waitForSelector("#auth .who");
    await p.waitForFunction(() => /knowledge check/.test(document.getElementById("submit").textContent));
    await p.click("#submit"); await p.click('#asFoot [data-act="toExp"]');
    for (const [k, v] of Object.entries({ e1: "50+", e2: "3+", e3: "options", e4: "500-5k", e5: "study" })) await p.check(sel(k, v));
    await p.click('#asFoot [data-act="toQuiz"]'); for (let i = 1; i <= 7; i++) await p.check(sel("q" + i, "a"));
    await p.click('#asFoot [data-act="finish"]'); await p.waitForFunction(() => /level: 3/.test(document.getElementById("asTitle").textContent));
    await p.click('#asFoot [data-act="close"]');
  }

  // 1. size stepper and typed size
  await p.click('#presets button[data-p="0"]');
  let s = await st(p);
  ok(s.size === "0.05" && !s.risk && s.btn === "Place demo order", "long call starts at 0.05 BTC, no warning: " + JSON.stringify([s.size, s.risk, s.btn]));
  await p.click('#sizebox [data-sz="up"]'); s = await st(p);
  ok(s.size === "0.06" && s.legQty[0] === "0.06", "+ raises size and the leg follows");
  await p.click('#sizebox [data-sz="down"]'); await p.click('#sizebox [data-sz="down"]'); s = await st(p);
  ok(s.size === "0.04", "− lowers size");
  await p.fill("#tqty", "0.1"); await p.press("#tqty", "Enter"); s = await st(p);
  ok(s.size === "0.10" && s.legQty[0] === "0.1", "typed size applies on Enter: " + s.size);
  for (let i = 0; i < 30; i++) await p.click('#sizebox [data-sz="down"]');
  ok((await st(p)).size === "0.01", "size never goes below the 0.01 BTC minimum");

  // 2. over cash → blocked with a suggested size
  await p.fill("#tqty", "50"); await p.press("#tqty", "Enter"); s = await st(p);
  ok(/Not enough demo cash/.test(s.risk) && s.dis && /Lower the size to/.test(s.risk), "too large → blocked, suggests a size: " + s.risk.slice(0, 90));

  // 4. multi-leg keeps ratio
  await p.click('#presets button[data-p="2"]');
  await p.click('#sizebox [data-sz="up"]'); s = await st(p);
  ok(s.legQty.length === 2 && s.legQty[0] === s.legQty[1] && s.legQty[0] === "0.06" && /All 2 legs/.test(s.hint), "spread: both legs scale together " + s.legQty);

  // 5. unlimited loss always needs review
  await p.click('#presets button[data-p="0"]'); await p.click("[data-flip]"); s = await st(p);
  ok(/Loss is not limited/.test(s.risk) && s.btn === "Review large order", "naked short → 'Loss is not limited' + review");

  await p.click('#presets button[data-p="0"]');
  // 3. "most your cash allows" → large-order two-step
  await p.click('#sizehint [data-sz="max"]'); s = await st(p);
  ok(/Large order/.test(s.risk) && s.btn === "Review large order" && !s.dis, "max size → large-order warning, review button: " + s.risk.slice(0, 80));
  const maxSize = s.size;
  await p.click("#submit"); s = await st(p);
  ok(/^Confirm order · \$/.test(s.btn) && !/Filled/.test(s.msg), "first click only arms the confirm: " + s.btn);
  await p.click('#sizebox [data-sz="down"]'); s = await st(p);
  ok(s.btn === "Review large order", "changing the size cancels the armed confirm");
  // stay one step under the max so a price tick can't push it over the cash limit
  const cash0 = money((await st(p)).cash);
  await p.click("#submit"); await p.click("#submit");
  await p.waitForFunction(() => /Filled|server|market|price|minute/.test(document.getElementById("msg").textContent));
  s = await st(p);
  ok(/Filled/.test(s.msg), "second click places the large order: " + s.msg);

  // 6. partial close
  await p.waitForSelector("[data-adj]");
  await p.click("[data-adj]");
  const opts = await p.$$eval("[data-closef]", (b) => b.map((x) => x.textContent.replace(/\s+/g, " ")));
  ok(opts.length === 3 && /Close 25%/.test(opts[0]) && /Close all/.test(opts[2]), "reduce menu offers 25% / 50% / all: " + opts.join(" | "));
  const before = money((await st(p)).cash);
  await p.click('[data-closef$=":0.5"]');
  await p.waitForFunction(() => !document.querySelector(".adj"));
  await p.waitForTimeout(400);
  const qtyText = await p.textContent(".pcard small");
  const after = money((await st(p)).cash);
  const expect = ((Number(maxSize) - 0.01) / 2).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  ok(qtyText.includes("Buy " + expect + " C") && after > before, `close 50% → ${expect} BTC left, cash ${before} → ${after}: ` + qtyText.slice(0, 50));
  if (MODE === "db") {
    await p.reload(); await p.waitForSelector("#auth .who"); await p.waitForFunction(() => document.querySelectorAll(".pcard").length > 0);
    ok((await p.textContent(".pcard small")).includes("Buy " + expect + " C"), "reduced size is saved on the server (survives reload)");
  }
  await p.screenshot({ path: SP + `size-${MODE}.png` });
  ok(errs.length === 0, "no page errors " + JSON.stringify(errs));
  console.log(log.join("\n")); await b.close();
})().catch((e) => { console.log(log.join("\n")); console.log("CRASH", e.message.split("\n")[0]); process.exit(1); });
