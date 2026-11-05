// Live prices that stop updating pause orders; they resume once a fresh update arrives.
const { chromium } = require("playwright");
const BASE = process.argv[2];
(async () => {
  const b = await chromium.launch(), p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  await p.addInitScript(() => { const now = Date.now(); localStorage.setItem("strikeline.appropriateness.v1", JSON.stringify({ tries: [now], record: { id: "SL-TEST", version: "2026-11", at: now, expires: now + 365 * 864e5, experience: {}, answers: {}, score: { core: 4, spread: true, short: true, optExp: true }, level: 3, warnedAck: null, orders: [] } })); });
  await p.route(/fonts\./, (r) => r.abort());
  await p.goto(BASE + "app"); await p.waitForSelector("#chain tbody tr");
  const fresh = await p.evaluate(() => [document.getElementById("submit").disabled, document.getElementById("risk").textContent]);
  // freeze the feed and move the clock 2 minutes ahead
  await p.route(/api\/chain/, (r) => r.abort());
  await p.evaluate(() => { const real = Date.now; Date.now = () => real() + 120000; });
  await p.waitForFunction(() => /Prices out of date/.test(document.getElementById("risk").textContent), null, { timeout: 8000 });
  const stale = await p.evaluate(() => document.getElementById("submit").disabled);
  console.log((!fresh[0] && !/out of date/.test(fresh[1]) ? "PASS" : "FAIL") + " fresh prices: order button enabled");
  console.log((stale ? "PASS" : "FAIL") + " live prices 2 minutes old: orders paused with a notice");
  await b.close();
})().catch((e) => { console.log("CRASH", e.message); process.exit(1); });
