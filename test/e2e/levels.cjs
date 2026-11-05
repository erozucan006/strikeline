const { chromium } = require("playwright");
const SP = require("os").tmpdir() + "/";
const [BASE, MODE] = [process.argv[2], process.argv[3] || "guest"];
const log = [];
const ok = (c, what) => log.push((c ? "PASS " : "FAIL ") + "[" + MODE + "] " + what);
const sel = (n, v) => `#asBody input[name="${n}"][value="${v}"]`;
const seed = (level, warnedAck) => () => {};
const st = (p) => p.evaluate(() => ({
  groups: [...document.querySelectorAll("#presets .pg")].map((g) => g.querySelector(".pgh").innerText.replace(/\s+/g, " ")),
  fix: (document.querySelector(".fixbox") || {}).innerText?.replace(/\s+/g, " ") || "",
  btn: document.getElementById("submit").textContent, dis: document.getElementById("submit").disabled,
  legs: [...document.querySelectorAll(".leg .desc")].map((d) => d.firstChild.textContent.trim() + ":" + d.parentElement.querySelector(".side").textContent),
  msg: document.getElementById("msg").textContent,
}));

async function page(b, level, warnedAck) {
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message));
  await p.route(/fonts\./, (r) => r.abort());
  if (MODE === "guest") {
    await p.addInitScript(([level, warnedAck]) => { const now = Date.now(); localStorage.setItem("strikeline.appropriateness.v1", JSON.stringify({ tries: [now], record: { id: "SL-T", version: "2026-11", at: now, expires: now + 365 * 864e5, experience: {}, answers: {}, score: { core: 4, spread: level >= 2, short: level >= 3, optExp: level >= 3 }, level, warnedAck: warnedAck ? now : null, orders: [] } })); }, [level, warnedAck]);
  } else await p.route(/cdn\.jsdelivr\.net\/npm\/@supabase/, (r) => r.fulfill({ status: 302, headers: { location: BASE + "test/fake-supabase.js" } }));
  await p.goto(BASE + "app"); await p.waitForSelector("#chain tbody tr");
  return p;
}
const place = async (p) => { await p.evaluate(() => (document.getElementById("msg").textContent = "")); await p.click("#submit"); await p.waitForFunction(() => /Filled|server|market|price|not allow/.test(document.getElementById("msg").textContent) || /Confirm/.test(document.getElementById("submit").textContent)); if (/Confirm/.test(await p.textContent("#submit"))) await p.click("#submit"); await p.waitForFunction(() => /Filled|server|market|price|not allow/i.test(document.getElementById("msg").textContent)); return p.textContent("#msg"); };

(async () => {
  const b = await chromium.launch();
  let p = await page(b, 2, false);
  if (MODE === "db") {
    await p.waitForSelector('#auth [data-auth="in"]');
    await p.click('#auth [data-auth="in"]'); await p.fill("#siEmail", "lvl" + Date.now() + "@example.com"); await p.click("#siSend");
    await p.waitForFunction(() => document.getElementById("siTitle").textContent === "Check your inbox");
    await p.evaluate(() => window.__fakeLogin()); await p.waitForSelector("#auth .who");
    await p.waitForFunction(() => /knowledge check/.test(document.getElementById("submit").textContent));
    await p.click("#submit"); await p.click('#asFoot [data-act="toExp"]');
    for (const [k, v] of Object.entries({ e1: "0", e2: "1-3", e3: "crypto", e4: "<500", e5: "study" })) await p.check(sel(k, v));
    await p.click('#asFoot [data-act="toQuiz"]'); for (let i = 1; i <= 7; i++) await p.check(sel("q" + i, "a"));
    await p.click('#asFoot [data-act="finish"]'); await p.waitForFunction(() => /level: 2/.test(document.getElementById("asTitle").textContent));
    await p.click('#asFoot [data-act="close"]');
  }
  // groups
  let s = await st(p);
  ok(s.groups.length === 3 && /Level 1.*Open to you/.test(s.groups[0]) && /Level 2.*Open to you/.test(s.groups[1]) && /Level 3.*Locked · your level is 2/.test(s.groups[2]), "level 2 sees L1+L2 open, L3 locked: " + s.groups.join(" | "));
  const l3 = await p.$$eval("#presets .pg:nth-child(3) button", (b) => b.map((x) => x.textContent));
  ok(l3.join() === "Short put,Short call,Short strangle", "L3 group lists the uncovered strategies: " + l3);

  // short put → add protection → becomes a bull put spread and can be placed
  await p.click('#presets button[data-p="7"]'); s = await st(p);
  ok(s.dis && /needs level 3/.test(s.fix) && /Sell put .* has no protection/.test(s.fix) && /Add protection: buy put/.test(s.fix), "short put blocked with explanation + fixes: " + s.fix.slice(0, 120));
  await p.click('[data-fix^="protect:"]'); s = await st(p);
  ok(!s.fix && !s.dis && s.legs.length === 2 && /fits your level/.test(s.msg), "add protection → 2 legs, order allowed: " + s.legs);
  let m = await place(p);
  ok(/Filled/.test(m), "protected short put is placed" + (MODE === "db" ? " and the server accepts it" : "") + ": " + m);

  // short call → buy it instead
  await p.click('#presets button[data-p="8"]'); await p.click('[data-fix^="flip:"]'); s = await st(p);
  ok(!s.fix && !s.dis && /BUY/.test(s.legs[0]), "buy it instead → long call allowed");

  // short strangle: remove one leg, protect the other
  await p.click('#presets button[data-p="9"]'); s = await st(p);
  ok((s.fix.match(/has no protection/g) || []).length === 2, "short strangle shows both unprotected legs");
  await p.click('[data-fix^="drop:"]'); s = await st(p);
  ok((s.fix.match(/has no protection/g) || []).length === 1 && s.legs.length === 1, "remove it → one leg left, still flagged");
  await p.click('[data-fix^="protect:"]'); s = await st(p);
  ok(!s.fix && !s.dis, "protect the last one → allowed");

  // chain bid tap = sell → fix appears
  await p.click('#presets button[data-p="0"]'); await p.click("[data-del]");
  await p.click('#chain tbody tr:nth-child(10) button.bid[data-a^="C"]'); s = await st(p);
  ok(/has no protection/.test(s.fix), "tapping a bid price in the chain shows the fix box");
  await p.click('[data-fix^="protect:"]');
  ok(!(await st(p)).dis, "and protecting it makes it tradeable");
  await p.screenshot({ path: SP + `levels-${MODE}.png` });

  if (MODE === "guest") {
    // level 1 (after warning): spread → remove sold options
    const p1 = await page(b, 0, true);
    let s1 = await st(p1);
    ok(/Level 1.*Open to you/.test(s1.groups[0]) && /Level 2.*Locked · your level is 1/.test(s1.groups[1]), "level 1 sees only L1 open");
    await p1.click('#presets button[data-p="2"]'); s1 = await st(p1);
    ok(/allows buying options only/.test(s1.fix) && s1.dis, "level 1 + spread → 'buying options only' + fixes");
    await p1.click('[data-fix="dropsold"]'); s1 = await st(p1);
    ok(!s1.fix && !s1.dis && s1.legs.length === 1, "remove sold options → long call allowed");
    await p1.click('#presets button[data-p="6"]'); await p1.click('[data-fix="buyall"]'); s1 = await st(p1);
    ok(!s1.fix && s1.legs.every((l) => /BUY/.test(l)), "buy every leg instead → allowed");
    // level 3: nothing locked
    const p3 = await page(b, 3, false);
    const s3 = await st(p3);
    ok(s3.groups.every((g) => /Open to you/.test(g)) && !(await p3.$("#presets .fine")), "level 3 sees all groups open");
    p.errs.push(...p1.errs, ...p3.errs);
  }
  ok(p.errs.length === 0, "no page errors " + JSON.stringify(p.errs));
  console.log(log.join("\n")); await b.close();
})().catch((e) => { console.log(log.join("\n")); console.log("CRASH", e.message.split("\n")[0]); process.exit(1); });
