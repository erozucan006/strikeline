// GET /api/config → the public Supabase settings the page needs to offer sign-in.
// Only the project URL and the anon/publishable key are exposed; both are designed to be public.
// Row level security and the SQL functions in supabase/migrations decide what a signed-in user can do.
// Never return the service role key here.
export function publicConfig(env) {
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey =
    env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    env.SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  return url && anonKey ? { url, anonKey } : { url: null, anonKey: null };
}

export default function handler(req, res) {
  res.setHeader("Cache-Control", "public, s-maxage=300");
  res.status(200).json(publicConfig(process.env));
}
