// AHG Tools: copy new and edited Jotform submissions into the Anderson Hicks Group project.
// Supabase Edge Function `jot-sync` (project pjfiyfljkzcvfvcrdrcj), verify_jwt on. pg_cron calls it
// every 5 minutes (supabase/ahg/005_jot_schedule.sql). For each active row in jot_forms it asks
// Jotform for submissions created or updated since the last run (with a 2 hour overlap, since
// Jotform's clock is its own), and hands them to jot_ingest(), which keeps every changed version.
// Secret: JOTFORM_API_KEY (a read-only key on Shawn's Jotform account).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const JOT = "https://api.jotform.com";
const OVERLAP_HOURS = 2;
const MIN_SECONDS_BETWEEN_RUNS = 60;   // anyone with the public key can call this; keep it cheap

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Answer = { answer?: unknown; type?: string };
type Sub = { id: string; created_at: string; updated_at: string | null; status: string; answers: Record<string, Answer> };

// Keep only answered questions, as {qid: answer}.
function slim(s: Sub) {
  const answers: Record<string, unknown> = {};
  for (const [qid, a] of Object.entries(s.answers || {})) {
    const v = a?.answer;
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) ||
        (typeof v === "object" && !Array.isArray(v) && !Object.values(v as object).some(x => x !== "" && x != null))) continue;
    answers[qid] = v;
  }
  return { id: s.id, created_at: s.created_at, updated_at: s.updated_at, status: s.status, answers };
}

// "YYYY-MM-DD HH:MM:SS" minus some hours, still in Jotform's clock.
function minusHours(t: string, h: number) {
  const d = new Date(t.replace(" ", "T") + "Z");
  d.setUTCHours(d.getUTCHours() - h);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

async function fetchSince(key: string, form: string, field: "created_at" | "updated_at", since: string) {
  const out: Sub[] = [];
  for (let offset = 0; ; offset += 1000) {
    const u = new URL(`${JOT}/form/${form}/submissions`);
    u.searchParams.set("apiKey", key);
    u.searchParams.set("limit", "1000");
    u.searchParams.set("offset", String(offset));
    u.searchParams.set("filter", JSON.stringify({ [`${field}:gt`]: since }));
    const r = await fetch(u);
    const d = await r.json();
    if (d.responseCode !== 200) throw new Error(`Jotform ${d.responseCode}: ${d.message}`);
    out.push(...(d.content as Sub[]));
    if ((d.content as Sub[]).length < 1000) return out;
  }
}

// Re-read the form's question list each run, so a question added in Jotform (like the contract jot's
// Contract Date, Oct 21, 2026) shows up on its own. One extra call per form per run.
async function refreshQuestions(db: ReturnType<typeof createClient>, key: string, form: string) {
  const r = await fetch(`${JOT}/form/${form}/questions?apiKey=${encodeURIComponent(key)}`);
  const d = await r.json();
  if (d.responseCode !== 200) throw new Error(`Jotform ${d.responseCode}: ${d.message}`);
  const rows = Object.entries(d.content as Record<string, { text?: string; type?: string; order?: string }>).map(([qid, q]) =>
    ({ form_id: form, qid, label: q.text ?? "", type: q.type ?? "", qorder: Number(q.order) || 0 }));
  const { error } = await db.from("jot_questions").upsert(rows, { onConflict: "form_id,qid" });
  if (error) throw new Error(error.message);
}

Deno.serve(async () => {
  const key = Deno.env.get("JOTFORM_API_KEY");
  if (!key) return json({ error: "JOTFORM_API_KEY isn't set." }, 500);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const { data: forms, error } = await db.from("jot_forms").select("*").eq("active", true);
  if (error) return json({ error: error.message }, 500);

  const results: Record<string, unknown> = {};
  for (const f of forms ?? []) {
    if (f.last_sync_at && Date.now() - new Date(f.last_sync_at).getTime() < MIN_SECONDS_BETWEEN_RUNS * 1000) {
      results[f.form_id] = "skipped, ran under a minute ago";
      continue;
    }
    try {
      if (!f.synced_through) throw new Error("Run the backfill first (ahg-tools/import/jot_backfill.py).");
      await refreshQuestions(db, key, f.form_id);
      const since = minusHours(f.synced_through, OVERLAP_HOURS);
      const [created, updated] = await Promise.all([
        fetchSince(key, f.form_id, "created_at", since),
        fetchSince(key, f.form_id, "updated_at", since),
      ]);
      const byId = new Map<string, Sub>();
      for (const s of [...created, ...updated]) byId.set(s.id, s);
      const subs = [...byId.values()].map(slim);
      let through = f.synced_through as string;
      for (const s of subs) for (const t of [s.created_at, s.updated_at]) if (t && t > through) through = t;
      let counts = { new: 0, changed: 0 };
      for (let i = 0; i < subs.length; i += 200) {
        const { data, error } = await db.rpc("jot_ingest", { p_form: f.form_id, p_subs: subs.slice(i, i + 200) });
        if (error) throw new Error(error.message);
        counts = { new: counts.new + data.new, changed: counts.changed + data.changed };
      }
      const note = `${subs.length} checked, ${counts.new} new, ${counts.changed} changed`;
      await db.from("jot_forms").update({ synced_through: through, last_sync_at: new Date().toISOString(), last_sync_note: note }).eq("form_id", f.form_id);
      results[f.form_id] = note;
    } catch (e) {
      const note = "Error: " + (e as Error).message;
      await db.from("jot_forms").update({ last_sync_at: new Date().toISOString(), last_sync_note: note }).eq("form_id", f.form_id);
      results[f.form_id] = note;
    }
  }
  console.log("jot-sync", JSON.stringify(results));
  return json(results);
});
