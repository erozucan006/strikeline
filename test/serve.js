// Local preview: serves the page and runs api/chain.js the way Vercel would.
//   node test/serve.js            -> live mode, upstream answered from the recorded Deribit sample
//   node test/serve.js --down     -> /api/chain fails, page should fall back to snapshot.json
//   node test/serve.js --upstream -> really call Deribit (needs network access)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import handler from "../api/chain.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = new Set(process.argv.slice(2));
const port = Number(process.env.PORT || 4173);

if (!args.has("--upstream")) {
  const fx = JSON.parse(await readFile(join(root, "test/deribit-fixture.json"), "utf8"));
  let tick = 0;
  globalThis.fetch = async (url) => {
    if (args.has("--down")) return new Response("down", { status: 503 });
    const u = String(url), coin = /btc|BTC/.test(u) ? "BTC" : "ETH";
    const drift = 1 + 0.002 * Math.sin(++tick / 2); // nudge the index so polling visibly updates
    const result = u.includes("get_index_price") ? { index_price: fx[coin].index * drift } : fx[coin].rows;
    return new Response(JSON.stringify({ result }), { status: 200 });
  };
}

const types = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".js": "text/javascript" };
createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/api/chain") {
    const r = {
      setHeader: (k, v) => res.setHeader(k, v),
      status: (c) => ((res.statusCode = c), r),
      json: (b) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(b))),
    };
    return handler(req, r);
  }
  const file = normalize(join(root, path === "/" ? "index.html" : path));
  if (!file.startsWith(root) || file.includes("/api/") || file.includes("/test/")) return res.writeHead(404).end();
  try {
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" }).end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, () => console.log(`Strikeline preview on http://localhost:${port}`));
