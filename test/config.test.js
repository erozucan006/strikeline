import { test } from "node:test";
import assert from "node:assert/strict";
import { publicConfig } from "../api/config.js";

test("returns the public URL and anon key from the Vercel Supabase integration", () => {
  assert.deepEqual(publicConfig({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon" }), { url: "https://x.supabase.co", anonKey: "anon" });
  assert.deepEqual(publicConfig({ NEXT_PUBLIC_SUPABASE_URL: "u", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "pk" }), { url: "u", anonKey: "pk" });
});

test("never exposes the service role key", () => {
  const out = JSON.stringify(publicConfig({ SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "secret", SUPABASE_JWT_SECRET: "jwt" }));
  assert.ok(!out.includes("secret") && !out.includes("jwt"));
  assert.deepEqual(JSON.parse(out), { url: null, anonKey: null }, "no anon key → accounts stay off");
});

test("missing configuration turns accounts off", () => {
  assert.deepEqual(publicConfig({}), { url: null, anonKey: null });
});
