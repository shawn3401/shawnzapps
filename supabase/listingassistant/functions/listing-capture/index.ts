// Listing Assistant: quick capture (Shawn, Oct 25, 2026: a fast way to get a thought into Listing Assistant, from
// Siri on the watch or phone, or by email so Instinct can send notes too). Everything lands in the leads list's
// inbox (listing_recordings, source 'shortcut' or 'email') with a suggested lead, like a Granola recording.
// Supabase Edge Function `listing-capture` in the ShawnZapps project, verify_jwt OFF because the shortcut and
// Resend's webhook carry no Supabase sign-in; it checks who is calling itself:
//   - signed in (Supabase token): {action:"get"} or {action:"reset"} returns the person's capture link and email
//   - the Siri shortcut: POST ?t=<capture token> with {"text": "..."} (or a plain text body); answers in plain text
//     so the shortcut can speak it
//   - Resend inbound (event email.received): only the email's id is trusted; the email itself is fetched from
//     Resend with our key, and the capture token is the address's local part (<token>@<CAPTURE_EMAIL_DOMAIN>)
// Secrets: ANTHROPIC_API_KEY, RESEND_API_KEY (for email), CAPTURE_EMAIL_DOMAIN (the Resend receiving domain).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.110.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "claude-opus-5-5";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const say = (text: string, status = 200) =>
  new Response(text, { status, headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

function newToken() {
  const a = new Uint8Array(12); crypto.getRandomValues(a);
  return Array.from(a, (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");   // no 0/o/1/l, email safe
}
function links(token: string) {
  const domain = (Deno.env.get("CAPTURE_EMAIL_DOMAIN") || "").trim();
  return { url: Deno.env.get("SUPABASE_URL") + "/functions/v1/listing-capture?t=" + token, email: domain ? `${token}@${domain}` : "" };
}
function htmlText(h: string) {
  return h.replace(/<(style|script)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// file one captured note into the inbox, with a short title and a suggested lead
async function capture(userId: string, source: "shortcut" | "email", text: string, extra: { title?: string; from?: { name: string; email: string }; at?: string; id?: string }) {
  const { data: access } = await admin.from("listing_access").select("daily_limit").eq("user_id", userId).maybeSingle();
  if (!access) return { ok: false, reply: "Listing Assistant isn't turned on for this account." };
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count: used } = await admin.from("listing_usage").select("id", { count: "exact", head: true }).eq("user_id", userId).gte("created_at", since);

  let title = extra.title || "", lead: { id: string; name: string | null } | null = null, why = "";
  const { data: leads } = await admin.from("listing_leads").select("id, name, address").eq("user_id", userId).order("updated_at", { ascending: false }).limit(150);
  if ((used ?? 0) < access.daily_limit) {
    const leadList = (leads || []).map((l, i) => `${i + 1}. ${l.name || "(no name)"}${l.address ? ", " + l.address : ""}`).join("\n") || "(no leads yet)";
    const tool = { name: "file", description: "A short title and the lead this note is about.", input_schema: { type: "object", additionalProperties: false, required: ["title", "lead", "why"], properties: { title: { type: "string", description: "Up to 8 words saying what the note is about" }, lead: { type: "integer", description: "The lead's number, or 0 when no lead fits" }, why: { type: "string" } } } };
    try {
      const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
      const t0 = Date.now();
      const res = await client.messages.stream({
        model: MODEL, max_tokens: 1500, output_config: { effort: "low" },
        system: "A real estate listing agent sends quick notes (dictated to Siri, or emailed) into the app where they work their seller leads. Give the note a plain title of up to 8 words, and say which of the agent's seller leads it is about, using the seller's name, the property address or street, or what is discussed. Dictation garbles names and street numbers, so a close sound-alike counts. Pick 0 when nothing points clearly to one lead. why is a few words naming the clue, like \"mentions Woodhaven\". Never guess between two leads; use 0. No em dashes or en dashes. Call file once.",
        tools: [tool],
        messages: [{ role: "user", content: `<leads>\n${leadList}\n</leads>\n\n<note source="${source}"${extra.title ? ` subject="${extra.title.replace(/"/g, "'")}"` : ""}${extra.from ? ` from="${(extra.from.name || extra.from.email).replace(/"/g, "'")}"` : ""}>\n${text.slice(0, 8000)}\n</note>` }],
      } as Anthropic.MessageStreamParams).finalMessage();
      await admin.from("listing_usage").insert({ user_id: userId, kind: "capture", seconds: (Date.now() - t0) / 1000, input_tokens: (res.usage.input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0), output_tokens: res.usage.output_tokens ?? 0 });
      const p = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")?.input as { title?: string; lead?: number; why?: string } | undefined;
      if (p) { if (!extra.title) title = (p.title || "").slice(0, 120); const l = leads?.[(p.lead || 0) - 1]; if (l) { lead = l; why = (p.why || "").slice(0, 200); } }
    } catch (err) { console.error("suggest error", err); }
  }
  if (!title) title = text.replace(/\s+/g, " ").slice(0, 60) + (text.length > 60 ? "…" : "");
  const { error } = await admin.from("listing_recordings").insert({
    user_id: userId, source, source_id: extra.id || crypto.randomUUID(), title, recorded_at: extra.at || new Date().toISOString(),
    summary: text.slice(0, 1500), transcript: text.slice(0, 200000), attendees: extra.from ? [extra.from] : [], suggest_lead: lead?.id ?? null, suggest_why: why,
  });
  if (error) {
    if (error.code === "23505") return { ok: true, reply: "Already in your inbox." };   // Resend retried a webhook
    console.error("insert error", error); return { ok: false, reply: "That didn't save. Try again in a minute." };
  }
  console.log(`capture user=${userId} source=${source} chars=${text.length} lead=${lead?.id ?? "-"}`);
  return { ok: true, reply: lead ? `Got it. It's in your inbox, and looks like ${lead.name || "one of your leads"}.` : "Got it. It's in your inbox to file on a lead." };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return say("POST only.", 405);
  const url = new URL(req.url), t = url.searchParams.get("t") || "";
  const raw = await req.text();
  let body: Record<string, unknown> = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }

  // ---- the Siri shortcut
  if (t) {
    const { data: cap } = await admin.from("listing_capture").select("user_id").eq("token", t).maybeSingle();
    if (!cap) return say("That capture link isn't valid anymore. Copy the new one from Listing Assistant.", 401);
    const text = (typeof body.text === "string" ? body.text : (raw && !raw.trim().startsWith("{") ? raw : "")).trim();
    if (!text) return say("I didn't catch anything to save.", 400);
    const r = await capture(cap.user_id, "shortcut", text, {});
    return say(r.reply, r.ok ? 200 : 500);
  }

  // ---- Resend inbound email
  if (body.type === "email.received") {
    const id = (body.data as { email_id?: string })?.email_id || "";
    const key = Deno.env.get("RESEND_API_KEY"), domain = (Deno.env.get("CAPTURE_EMAIL_DOMAIN") || "").trim().toLowerCase();
    if (!id || !key || !domain) return json({ ok: false, why: "not set up" });
    const r = await fetch("https://api.resend.com/emails/receiving/" + encodeURIComponent(id), { headers: { Authorization: "Bearer " + key } });
    if (!r.ok) { console.error("resend fetch", r.status); return json({ ok: false }, r.status === 404 ? 200 : 502); }
    const m = await r.json();
    const to = [...(m.to || []), ...(m.received_for || []), ...(m.cc || [])].map((a: string) => (a.match(/<([^>]+)>/)?.[1] || a).trim().toLowerCase());
    const tokens = to.filter((a: string) => a.endsWith("@" + domain)).map((a: string) => a.split("@")[0]);
    const { data: cap } = tokens.length ? await admin.from("listing_capture").select("user_id").in("token", tokens).limit(1).maybeSingle() : { data: null };
    if (!cap) { console.log("email to unknown address", to.join(",")); return json({ ok: false, why: "unknown address" }); }
    const fromRaw = String(m.headers?.from || m.from || ""), fromEmail = (fromRaw.match(/<([^>]+)>/)?.[1] || fromRaw).trim();
    const fromName = fromRaw.includes("<") ? fromRaw.split("<")[0].replace(/"/g, "").trim() : "";
    const text = (m.text && String(m.text).trim()) || htmlText(String(m.html || "").replace(/^data:[^,]*,/, ""));
    if (!text && !m.subject) return json({ ok: false, why: "empty" });
    const out = await capture(cap.user_id, "email", text || "(no text)", { title: (m.subject || "").slice(0, 200), from: { name: fromName, email: fromEmail }, at: m.created_at, id: "email:" + id });
    return json({ ok: out.ok });
  }

  // ---- the page, signed in: show or replace the capture link
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who } = jwt ? await admin.auth.getUser(jwt) : { data: null };
  if (!who?.user) return json({ error: "Sign in first." }, 401);
  const { data: access } = await admin.from("listing_access").select("user_id").eq("user_id", who.user.id).maybeSingle();
  if (!access) return json({ error: "Listing Assistant isn't turned on for your account yet." }, 403);
  const { data: cap } = await admin.from("listing_capture").select("token").eq("user_id", who.user.id).maybeSingle();
  if (body.action === "get" && cap) return json(links(cap.token));
  if (body.action === "get" || body.action === "reset") {
    const token = newToken();
    await admin.from("listing_capture").upsert({ user_id: who.user.id, token, created_at: new Date().toISOString() });
    return json(links(token));
  }
  return json({ error: "Bad request." }, 400);
});
