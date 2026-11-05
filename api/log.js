// POST /api/log — the page reports its own JavaScript errors here; they show up in Vercel's
// function logs. Only the message, place and page are kept, cut short; nothing about the user.
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).end();
  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const clip = (v, n) => String(v ?? "").slice(0, n);
    console.error("client error", JSON.stringify({ msg: clip(b.msg, 300), src: clip(b.src, 200), line: Number(b.line) || 0, page: clip(b.page, 40), ua: clip(req.headers["user-agent"], 120) }));
  } catch {}
  res.status(204).end();
}
