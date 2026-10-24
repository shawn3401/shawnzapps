// Listing Assistant: Granola recordings (Shawn, Oct 24, 2026: record on the Apple Watch with Granola, then pick
// the recording from a list in Listing Assistant and file it on a lead). Each person connects their own Granola
// API key (Business plan; Settings, Connectors, API keys in the Granola desktop app), kept in listing_granola,
// which only this function can read. "sync" copies new notes (summary and full transcript) into
// listing_recordings and has Claude suggest which lead each belongs to; the page files them itself.
// Supabase Edge Function `listing-granola` in the ShawnZapps project, verify_jwt on. Secret: ANTHROPIC_API_KEY.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.110.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const GRANOLA = "https://public-api.granola.ai";
const MODEL = "claude-opus-5-5";
const FIRST_DAYS = 30;    // how far back the first sync looks
const MAX_NEW = 15;       // notes fetched per sync, to keep a sync well under a minute

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Seg = { speaker?: { source?: string; attribution?: string; diarization_label?: string }; text: string; start_time?: string; end_time?: string };

async function granola(key: string, path: string) {
  const r = await fetch(GRANOLA + path, { headers: { Authorization: "Bearer " + key } });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}
function transcriptText(segs: Seg[]) {   // "Agent:" for the note's owner, "Them:" for everyone else, merged by turn
  const out: string[] = []; let last = "", buf: string[] = [];
  const flush = () => { if (buf.length) out.push((last ? last + ": " : "") + buf.join(" ")); buf = []; };
  for (const s of segs) {
    const a = s.speaker?.attribution, d = s.speaker?.diarization_label;
    const who = a === "me" ? "Agent" : a === "them" ? "Them" : d ? "Speaker " + d : "";
    if (who !== last) { flush(); last = who; }
    if (s.text?.trim()) buf.push(s.text.trim());
  }
  flush();
  return out.join("\n");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !who?.user) return json({ error: "Sign in first." }, 401);
  const userId = who.user.id;
  const { data: access } = await admin.from("listing_access").select("daily_limit").eq("user_id", userId).maybeSingle();
  if (!access) return json({ error: "Listing Assistant isn't turned on for your account yet." }, 403);

  let body: { action?: string; key?: string };
  try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400); }
  const { data: conn } = await admin.from("listing_granola").select("api_key, connected_at, last_sync, last_error").eq("user_id", userId).maybeSingle();

  if (body.action === "status") return json({ connected: !!conn, last_sync: conn?.last_sync ?? null, last_error: conn?.last_error ?? "" });
  if (body.action === "disconnect") { await admin.from("listing_granola").delete().eq("user_id", userId); return json({ connected: false }); }
  if (body.action === "connect") {
    const key = (body.key || "").trim();
    if (!/^grn_\S{10,}$/.test(key)) return json({ error: "That doesn't look like a Granola API key. They start with grn_." }, 400);
    const t = await granola(key, "/v1/notes?page_size=1");
    if (t.status === 401) return json({ error: "Granola didn't accept that key. Check it was copied whole, and that it can read your personal notes." }, 400);
    if (t.status !== 200) return json({ error: "Granola answered " + t.status + ". Try again in a minute." }, 502);
    await admin.from("listing_granola").upsert({ user_id: userId, api_key: key, connected_at: new Date().toISOString(), last_error: "" });
    return json({ connected: true });
  }
  if (body.action !== "sync") return json({ error: "Bad request." }, 400);
  if (!conn) return json({ error: "Connect Granola first." }, 400);

  // ---- 1. list notes since the last sync (a day of overlap), skipping ones already copied
  const since = conn.last_sync ? new Date(new Date(conn.last_sync).getTime() - 24 * 3600 * 1000) : new Date(Date.now() - FIRST_DAYS * 24 * 3600 * 1000);
  const found: { id: string; title: string | null; created_at: string }[] = [];
  let cursor = "";
  for (let page = 0; page < 6; page++) {
    const r = await granola(conn.api_key, `/v1/notes?page_size=30&created_after=${encodeURIComponent(since.toISOString())}${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
    if (r.status === 401) { await admin.from("listing_granola").update({ last_error: "Granola no longer accepts the key." }).eq("user_id", userId); return json({ error: "Granola no longer accepts your key. Connect it again with a new one." }, 400); }
    if (r.status !== 200) return json({ error: "Granola answered " + r.status + ". Try again in a minute." }, 502);
    for (const n of r.body.notes || []) if (!n.deleted_at) found.push(n);
    if (!r.body.hasMore || !r.body.cursor) break;
    cursor = r.body.cursor;
  }
  const { data: have } = await admin.from("listing_recordings").select("source_id").eq("user_id", userId).eq("source", "granola").in("source_id", found.map((n) => n.id).length ? found.map((n) => n.id) : ["none"]);
  const known = new Set((have || []).map((h) => h.source_id));
  const todo = found.filter((n) => !known.has(n.id)).sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(-MAX_NEW);

  // ---- 2. fetch each new note with its transcript
  const rows: Record<string, unknown>[] = [];
  for (const n of todo) {
    const r = await granola(conn.api_key, `/v1/notes/${n.id}?include=transcript`);
    let note = r.body, segs: Seg[] = note?.transcript || [];
    if (r.status === 413 || (r.status === 400 && /TRANSCRIPT_TOO_LARGE/.test(JSON.stringify(r.body)))) {
      const r2 = await granola(conn.api_key, `/v1/notes/${n.id}`); note = r2.body; segs = [];
      let c = "";
      for (let p = 0; p < 40; p++) {
        const t = await granola(conn.api_key, `/v1/notes/${n.id}/transcript?page_size=100${c ? "&cursor=" + encodeURIComponent(c) : ""}`);
        if (t.status !== 200) break;
        segs.push(...(t.body.transcript || []));
        if (!t.body.hasMore || !t.body.cursor) break; c = t.body.cursor;
      }
    } else if (r.status !== 200) continue;
    const times = segs.map((s) => [s.start_time, s.end_time]).flat().filter(Boolean).map((t) => new Date(t as string).getTime()).filter((t) => !isNaN(t));
    rows.push({
      user_id: userId, source: "granola", source_id: n.id, title: note?.title || n.title || "Untitled recording",
      recorded_at: note?.calendar_event?.scheduled_start_time || n.created_at,
      minutes: times.length ? Math.max(1, Math.round((Math.max(...times) - Math.min(...times)) / 60000)) : null,
      summary: (note?.summary_markdown || note?.summary_text || "").slice(0, 20000),
      transcript: transcriptText(segs).slice(0, 200000),
      attendees: (note?.attendees || []).map((a: { name?: string; email?: string }) => ({ name: a.name || "", email: a.email || "" })),
      web_url: note?.web_url || "",
    });
  }
  let inserted: { id: string; title: string; summary: string; transcript: string; attendees: unknown; recorded_at: string }[] = [];
  if (rows.length) {
    const { data, error } = await admin.from("listing_recordings").upsert(rows, { onConflict: "user_id,source,source_id", ignoreDuplicates: true }).select("id, title, summary, transcript, attendees, recorded_at");
    if (error) console.error("insert error", error); else inserted = data || [];
  }

  // ---- 3. suggest a lead for each new recording
  if (inserted.length) {
    const { data: leads } = await admin.from("listing_leads").select("id, name, address").eq("user_id", userId).order("updated_at", { ascending: false }).limit(150);
    if (leads?.length) {
      const leadList = leads.map((l, i) => `${i + 1}. ${l.name || "(no name)"}${l.address ? ", " + l.address : ""}`).join("\n");
      const recs = inserted.map((r, i) => `<recording n="${i + 1}">\nTitle: ${r.title}\nDate: ${r.recorded_at}\nAttendees: ${JSON.stringify(r.attendees)}\nSummary: ${r.summary.slice(0, 1500)}\nTranscript start: ${r.transcript.slice(0, 3000)}\n</recording>`).join("\n");
      const tool = { name: "suggest", description: "Which lead each recording is about.", input_schema: { type: "object", additionalProperties: false, required: ["picks"], properties: { picks: { type: "array", items: { type: "object", additionalProperties: false, required: ["recording", "lead", "why"], properties: { recording: { type: "integer" }, lead: { type: "integer", description: "The lead's number, or 0 when no lead fits" }, why: { type: "string" } } } } } } };
      try {
        const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
        const t0 = Date.now();
        const res = await client.messages.stream({
          model: MODEL, max_tokens: 3000, output_config: { effort: "low" },
          system: "A real estate listing agent records meetings and calls about sellers' homes. For each recording, say which of the agent's seller leads it is about, using the seller's name, the property address or street, and what is discussed. Pick 0 when nothing points clearly to one lead (a team meeting, a buyer, a lead not on the list). why is a few words naming the clue, like \"mentions 166 Woodhaven\" or \"Brett Hathaway on the call\". Never guess between two leads; use 0. Call suggest once.",
          tools: [tool],
          messages: [{ role: "user", content: `<leads>\n${leadList}\n</leads>\n\n${recs}` }],
        } as Anthropic.MessageStreamParams).finalMessage();
        await admin.from("listing_usage").insert({ user_id: userId, kind: "granola", seconds: (Date.now() - t0) / 1000, input_tokens: (res.usage.input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0), output_tokens: res.usage.output_tokens ?? 0 });
        const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        for (const p of ((call?.input as { picks?: { recording: number; lead: number; why: string }[] })?.picks || [])) {
          const rec = inserted[p.recording - 1], lead = leads[p.lead - 1];
          if (rec && lead) await admin.from("listing_recordings").update({ suggest_lead: lead.id, suggest_why: (p.why || "").slice(0, 200) }).eq("id", rec.id);
        }
      } catch (err) { console.error("suggest error", err); }
    }
  }
  await admin.from("listing_granola").update({ last_sync: new Date().toISOString(), last_error: "" }).eq("user_id", userId);
  console.log(`granola sync user=${userId} listed=${found.length} new=${inserted.length}`);
  return json({ added: inserted.length, more: found.filter((n) => !known.has(n.id)).length > MAX_NEW });
});
