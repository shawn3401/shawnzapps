// Listing Assistant: sign in through AHG Tools (Shawn, Oct 25, 2026: "When we auth at the gateway, we should be
// authed at each tool we place inside it"). AHG Tools (ahgtools.com) is its own Supabase project, so its sign-in
// can't be read here directly. Its Home page sends the person's AHG access token; this checks it with AHG's own
// auth server, checks the person has Listing Assistant on AHG's Team page (tool_access, read with their own token so
// AHG's rules apply), and answers with a one-time sign-in link for the same email here. Until Listing Assistant
// moves into AHG Tools, this is the bridge. Supabase Edge Function `listing-sso` in the ShawnZapps project,
// verify_jwt OFF (the caller has an AHG token, not one of ours). No secrets: AHG's publishable key is public.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const AHG_URL = "https://pjfiyfljkzcvfvcrdrcj.supabase.co";
const AHG_KEY = "sb_publishable_XQn3G4SYVTsF2cT8IKZyUg_BAcJtlx4";
const HOME = "https://shawnzapps.com/listingassistant/";
const ORIGINS = ["https://ahgtools.com", "https://www.ahgtools.com", "http://localhost:8771"];

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin") || "";
  const cors = {
    "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: { ahg_token?: string };
  try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400); }
  const tok = body.ahg_token || "";
  if (!tok) return json({ error: "Sign in to AHG Tools first." }, 401);

  // 1. who is this, according to AHG Tools
  const u = await fetch(AHG_URL + "/auth/v1/user", { headers: { apikey: AHG_KEY, Authorization: "Bearer " + tok } });
  if (!u.ok) return json({ error: "Your AHG Tools sign-in has expired. Sign in there again." }, 401);
  const ahgUser = await u.json();
  const email = String(ahgUser.email || "").toLowerCase();
  if (!email.endsWith("@andersonhicks.com") || !(ahgUser.email_confirmed_at || ahgUser.confirmed_at)) return json({ error: "Only andersonhicks.com accounts can do this." }, 403);

  // 2. does AHG Tools give them Listing Assistant (read with their own token, so AHG's row rules decide)
  const a = await fetch(`${AHG_URL}/rest/v1/tool_access?select=tool_key&tool_key=eq.listing_assistant&email=eq.${encodeURIComponent(email)}`, { headers: { apikey: AHG_KEY, Authorization: "Bearer " + tok } });
  const rows = a.ok ? await a.json() : [];
  if (!Array.isArray(rows) || !rows.length) return json({ error: "Listing Assistant isn't turned on for you in AHG Tools. Ask an admin to add it on the Team page." }, 403);

  // 3. a one-time sign-in link for the same email here (creates the account the first time)
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email, options: { redirectTo: HOME } });
  if (error || !data?.properties?.action_link) { console.error("generateLink", error); return json({ error: "Couldn't sign you in to Listing Assistant. Try again in a minute." }, 502); }
  // AHG Tools decides who gets the tool, so turn Listing Assistant on here to match
  await admin.from("listing_access").upsert({ user_id: data.user.id, daily_limit: 500 }, { onConflict: "user_id", ignoreDuplicates: true });
  console.log(`sso ${email} -> ${data.user.id}`);
  return json({ url: data.properties.action_link });
});
