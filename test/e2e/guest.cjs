const { chromium } = require("playwright");
(async () => {
  const url = process.argv[2], mode = process.argv[3];
  const b = await chromium.launch();
  const out = {};
  for (const vp of [{ w: 1400, h: 900, n: "desktop" }, { w: 390, h: 844, n: "phone" }]) {
    const p = await b.newPage({ viewport: { width: vp.w, height: vp.h } });
    const errs = [];
    p.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    p.on("console", (m) => m.type() === "error" && errs.push("console: " + m.text()));
    await p.addInitScript(() => { const now = Date.now(); localStorage.setItem("strikeline.appropriateness.v1", JSON.stringify({ tries: [now], record: { id: "SL-TEST", version: "2026-11", at: now, expires: now + 365 * 864e5, experience: {}, answers: {}, score: { core: 4, spread: true, short: true, optExp: true }, level: 3, warnedAck: null, orders: [] } })); });
    await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    await p.goto(url);
    await p.waitForFunction(() => document.querySelectorAll("#chain tbody tr").length > 0, null, { timeout: 8000 });
    const s1 = await p.evaluate(() => ({
      status: document.getElementById("snap").textContent,
      state: document.getElementById("feed").dataset.state,
      spot: document.getElementById("spot").textContent,
      rows: document.querySelectorAll("#chain tbody tr").length,
      exps: [...document.querySelectorAll("#exps button")].map((b) => b.textContent.trim()),
      legs: document.querySelectorAll(".leg").length,
      explain: document.getElementById("explain").innerText.slice(0, 160),
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
    }));
    // place an order, then (live mode) wait for a poll and check the position re-marks
    await p.click("#submit");
    const msg = await p.textContent("#msg");
    let s2 = null;
    if (mode === "live" && vp.n === "desktop") {
      const before = await p.textContent("#spot");
      await p.waitForFunction((b) => document.getElementById("spot").textContent !== b, before, { timeout: 20000 });
      s2 = await p.evaluate(() => ({
        status: document.getElementById("snap").textContent,
        spot: document.getElementById("spot").textContent,
        pos: document.querySelector(".pcard .num")?.textContent,
        legsStill: document.querySelectorAll(".leg").length,
      }));
      // switch underlying and expiry to make sure nothing throws after a refresh
      await p.click('#useg button[data-u="ETH"]');
      await p.click("#exps button:nth-child(5)");
      await p.click('#presets button[data-p="6"]');
    }
    await p.screenshot({ path: require("os").tmpdir() + `/${mode}-${vp.n}.png`, fullPage: vp.n === "phone" });
    out[vp.n] = { ...s1, order: msg, afterPoll: s2, errors: errs };
    await p.close();
  }
  const ok = (c, w) => console.log((c ? "PASS " : "FAIL ") + w);
  for (const [n, o] of Object.entries(out)) {
    ok(o.rows > 0 && o.exps.length > 0, `${mode} ${n}: chain loads (${o.rows} rows)`);
    ok(o.state === (mode === "live" ? "live" : "snapshot"), `${mode} ${n}: feed shows ${o.state}: ${o.status}`);
    ok(!o.overflowX, `${mode} ${n}: no sideways scroll`);
    ok(/Filled/.test(o.order), `${mode} ${n}: demo order fills: ${o.order}`);
    // blocked web fonts and the deliberately failing feed in --down mode are expected
    const errs = o.errors.filter((e) => !/ERR_FAILED|502|503/.test(e));
    ok(errs.length === 0, `${mode} ${n}: no page errors ${JSON.stringify(errs)}`);
    if (o.afterPoll) ok(o.afterPoll.spot !== o.spot && o.afterPoll.legsStill > 0, `${mode} ${n}: polling updates prices and keeps the legs`);
  }
  await b.close();
})();
