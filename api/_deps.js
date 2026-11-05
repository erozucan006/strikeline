// Real network dependencies for the trade functions, built from Vercel environment variables.
// SUPABASE_SERVICE_ROLE_KEY never leaves the server: it is only used here, for the database
// functions that browsers are not allowed to call.

const DERIBIT = "https://www.deribit.com/api/v2/public";

async function json(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(6000) });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { message: text }; }
  return { ok: r.ok, status: r.status, body };
}

export function realDeps(env = process.env) {
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const service = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;
  if (!url || !anon || !service) return null;
  const svc = { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json" };
  return {
    // Supabase checks the session token and returns the user it belongs to.
    async getUser(token) {
      if (!token) return null;
      const r = await json(`${url}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${token}` } });
      return r.ok && r.body && r.body.id ? { id: r.body.id } : null;
    },
    async getTicker(name) {
      const r = await json(`${DERIBIT}/ticker?instrument_name=${encodeURIComponent(name)}`);
      return r.ok && r.body && r.body.result ? r.body.result : null;
    },
    async getIndex(u) {
      const r = await json(`${DERIBIT}/get_index_price?index_name=${u.toLowerCase()}_usd`);
      return r.ok && r.body && r.body.result ? Number(r.body.result.index_price) : 0;
    },
    async getOpenPosition(userId, id) {
      const r = await json(`${url}/rest/v1/positions?select=id,underlying,legs&id=eq.${Number(id)}&user_id=eq.${encodeURIComponent(userId)}&closed_at=is.null`, { headers: svc });
      return r.ok && Array.isArray(r.body) && r.body[0] ? r.body[0] : null;
    },
    async rpc(fn, args) {
      const r = await json(`${url}/rest/v1/rpc/${fn}`, { method: "POST", headers: svc, body: JSON.stringify(args) });
      if (!r.ok) throw new Error(String((r.body && (r.body.message || r.body.hint)) || `rpc ${fn} ${r.status}`));
      return r.body;
    },
  };
}
