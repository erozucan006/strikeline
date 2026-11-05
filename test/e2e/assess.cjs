const { chromium } = require("playwright");
const SP = require("os").tmpdir() + "/";
const URL = process.argv[2];
const log = [];
const ok = (cond, what) => { log.push((cond ? "PASS " : "FAIL ") + what); };

async function fillExp(p, e) {
  for (const [k, v] of Object.entries(e)) for (const x of [].concat(v)) await p.check(`#asBody input[name="${k}"][value="${x}"]`);
}
async function quiz(p, pick) { for (let i = 1; i <= 7; i++) await p.check(`#asBody input[name="q${i}"][value="${pick(i)}"]`); }
async function runCheck(p, exp, pick) {
  await p.click("#submit");                      // opens dialog (or Retake link handled by caller)
  await p.click('#asFoot button[data-act="toExp"]');
  await fillExp(p, exp);
  await p.click('#asFoot button[data-act="toQuiz"]');
  await quiz(p, pick);
  await p.click('#asFoot button[data-act="finish"]');
}
const state = (p) => p.evaluate(() => ({
  btn: document.getElementById("submit").textContent, dis: document.getElementById("submit").disabled,
  access: document.getElementById("access").innerText.replace(/\s+/g, " ").slice(0, 200),
  title: document.getElementById("asTitle")?.textContent, open: document.getElementById("assess").open,
  msg: document.getElementById("msg").textContent,
}));

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.route(/fonts\./, (r) => r.abort());
  await p.goto(URL); await p.waitForSelector("#chain tbody tr");

  // A. fresh visitor: no self-assessment checkbox, button starts the check
  let s = await state(p);
  ok(s.btn === "Start the knowledge check" && !s.dis, "fresh: ticket button starts the check");
  ok(!(await p.$("#ack")), "fresh: old 'I understand' checkbox is gone");
  await p.click("#submit");
  ok((await state(p)).title === "Options knowledge check", "intro opens");
  await p.click('#asFoot button[data-act="toExp"]');
  await p.click('#asFoot button[data-act="toQuiz"]');
  const err = await p.textContent("#asErr");
  ok(/5 highlighted/.test(err) && (await p.$$("fieldset.missing")).length === 5, "exp: empty submit flags 5 questions: " + err);
  // "None of these" clears the others
  await p.check('input[name="e3"][value="crypto"]'); await p.check('input[name="e3"][value="none"]');
  ok(!(await p.isChecked('input[name="e3"][value="crypto"]')), "exp: 'None of these' unticks other boxes");
  await p.click('#asFoot button[data-act="close"]').catch(() => {});
  await p.keyboard.press("Escape");

  // B. strong candidate but little options experience -> level 2
  await runCheck(p, { e1: "0", e2: "3+", e3: ["crypto", "stocks"], e4: "500-5k", e5: "study" }, () => "a");
  s = await state(p);
  ok(/level: 2/.test(s.title), "all correct + no options experience -> level 2: " + s.title);
  const locked = await p.textContent(".levels > div.off");
  ok(/10 times/.test(locked), "level 3 lock explains the experience rule");
  await p.click('#asFoot button[data-act="close"]');
  // bull call spread (preset 2) is allowed at level 2
  await p.click('#presets button[data-p="2"]');
  await p.click("#submit");
  ok(/Filled/.test(await p.textContent("#msg")), "level 2 can trade a bull call spread");
  // a naked short call needs level 3
  await p.click('#presets button[data-p="0"]'); // long call
  await p.click("[data-flip]");                 // flip to SELL -> uncovered
  s = await state(p);
  ok(s.dis && /needs level 3/.test(s.access), "uncovered short call is blocked at level 2: " + s.access);
  // short put alone is also uncovered (finite but large loss)
  await p.click('#presets button[data-p="1"]'); await p.click("[data-flip]");
  ok((await state(p)).dis, "uncovered short put is blocked at level 2");

  // C. retake with wrong answers -> warning, accept -> buy-only
  await p.click('#access [data-act="retake"]');
  await p.click('#asFoot button[data-act="toExp"]');
  ok(await p.isChecked('input[name="e5"][value="study"]'), "retake pre-fills experience answers");
  await p.click('#asFoot button[data-act="toQuiz"]');
  ok(!(await p.$("#asBody input[name='q1']:checked")), "retake does not pre-fill knowledge answers");
  await quiz(p, (i) => (i <= 2 ? "dk" : "b"));
  await p.click('#asFoot button[data-act="finish"]');
  s = await state(p);
  ok(/may not be appropriate/.test(s.title) && !!(await p.$(".warnbox")), "fail -> prominent warning");
  await p.click('#asFoot button[data-act="close"]'); // Not now
  s = await state(p);
  ok(s.btn === "Review my result" && /may not be appropriate/.test(s.access), "declined warning -> trading paused, review offered");
  await p.click("#submit");
  await p.click('#asFoot button[data-act="accept"]');
  await p.click('#asFoot button[data-act="close"]');
  s = await state(p);
  ok(/Level 1/.test(s.access) && /continue after an appropriateness warning/.test(s.access), "accepted warning -> level 1 with note");
  await p.click('#presets button[data-p="2"]');
  ok((await state(p)).dis, "level 1 cannot place a spread");
  ok(/Locked · your level is 1/.test(await p.textContent('#presets .pg:nth-child(2) .pgh')), "locked level group says so");
  await p.click('#presets button[data-p="4"]'); await p.click("#submit");
  ok(/Filled/.test(await p.textContent("#msg")), "level 1 can buy a straddle");

  // D. third attempt, then the limit
  await p.click('#access [data-act="retake"]');
  await p.click('#asFoot button[data-act="toExp"]'); await p.click('#asFoot button[data-act="toQuiz"]');
  await quiz(p, () => "a"); await p.click('#asFoot button[data-act="finish"]');
  await p.click('#asFoot button[data-act="close"]');
  const acc = await p.textContent("#access");
  ok(/Next retake from/.test(acc), "after 3 attempts the retake link is replaced by a time");
  // record details
  await p.click("details.rec summary");
  const rec = await p.textContent("details.rec dl");
  ok(/SL-/.test(rec) && /Orders under this check/.test(rec), "assessment record is visible");

  // E. persists across reload
  await p.reload(); await p.waitForSelector("#chain tbody tr");
  s = await state(p);
  ok(/Level 2/.test(s.access), "level persists after reload: " + s.access.slice(0, 60));
  await p.screenshot({ path: SP + "assess-ticket.png" });

  // F. phone + dark: quiz screen
  const ph = await b.newPage({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  await ph.route(/fonts\./, (r) => r.abort());
  await ph.goto(URL); await ph.waitForSelector("#chain tbody tr");
  await ph.click("#submit"); await ph.click('#asFoot button[data-act="toExp"]');
  await fillExp(ph, { e1: "1-9", e2: "1-3", e3: ["crypto"], e4: "<500", e5: "work" });
  await ph.click('#asFoot button[data-act="toQuiz"]');
  const ov = await ph.evaluate(() => { const d = document.getElementById("assess"); return { dlgW: d.getBoundingClientRect().width, scrollW: document.getElementById("asBody").scrollWidth, clientW: document.getElementById("asBody").clientWidth }; });
  ok(ov.dlgW <= 390 - 32 + 1 && ov.scrollW <= ov.clientW, "phone: dialog fits, no sideways scroll " + JSON.stringify(ov));
  await ph.screenshot({ path: SP + "assess-phone-dark.png" });

  ok(errs.length === 0, "no page errors " + JSON.stringify(errs));
  console.log(log.join("\n"));
  await b.close();
})().catch((e) => { console.log(log.join("\n")); console.log("CRASH", e.message); process.exit(1); });
