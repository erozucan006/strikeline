// Runs every browser suite against the three local preview servers and fails on any FAIL line.
//   PORT=4173 node test/serve.js & PORT=4174 node test/serve.js --db & PORT=4175 node test/serve.js --down &
const { execFileSync } = require("child_process");
const G = "http://localhost:4173/", DB = "http://localhost:4174/", DOWN = "http://localhost:4175/";
const runs = [
  ["guest.cjs", G + "app", "live"], ["guest.cjs", DOWN + "app", "down"],
  ["assess.cjs", G + "app"], ["levels.cjs", G, "guest"], ["levels.cjs", DB, "db"],
  ["size.cjs", G, "guest"], ["size.cjs", DB, "db"], ["accounts.cjs", DB], ["admin.cjs", DB], ["stale.cjs", G],
];
let bad = 0;
for (const [f, ...a] of runs) {
  let out = "";
  try { out = execFileSync("node", [__dirname + "/" + f, ...a], { encoding: "utf8", timeout: 240000 }); }
  catch (e) { out = (e.stdout || "") + "\nCRASH " + e.message.split("\n")[0]; }
  const fails = out.split("\n").filter((l) => /^(FAIL|CRASH)/.test(l));
  const passes = out.split("\n").filter((l) => /^PASS/.test(l)).length;
  console.log(`${fails.length ? "✗" : "✓"} ${f} ${a.join(" ")} — ${passes} passed${fails.length ? "\n  " + fails.join("\n  ") : ""}`);
  bad += fails.length;
}
process.exit(bad ? 1 : 0);
