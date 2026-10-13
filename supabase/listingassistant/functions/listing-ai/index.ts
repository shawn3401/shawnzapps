// Listing Assistant: build the brief for one seller lead from everything gathered on it
// (call and walkthrough transcripts, typed notes, photos). Supabase Edge Function `listing-ai`
// in the ShawnZapps project, verify_jwt on. Allow-list and daily cap in listing_access,
// one row per call in listing_usage. Secret: ANTHROPIC_API_KEY (the one Dough uses).
// The page sends the catalog of the form's boxes (built from form.js), so the form can change
// without redeploying this.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.110.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "claude-opus-5-5";
const MAX_PHOTOS = 24;
const MAX_WORDS = 160000;   // characters of transcript and notes sent

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const STAGES = ["new", "call", "walk_set", "walked", "pricing", "signed", "listed", "hold", "closed"];
const FIELDS = ["client_last_name", "street_address", "year_built", "total_sf", "lot_size", "beds", "baths", "improvements",
  "additional_notes", "irrigation_company", "elementary", "middle", "high", "well_depth", "pump_depth", "pump_size", "septic_size", "last_pumped"];
const ROOM_ROWS = ["upper", "main", "lower", "bsmnt", "adu"];
const ROOM_COLS = ["sqft", "bedrooms", "full_bath", "half_bath", "fam_room", "living_rm", "kitchen", "frml_dining", "den", "laundry", "fireplaces"];

const SYSTEM = `You work for a residential real estate listing agent in eastern Idaho. For one seller lead you are given everything the agent has gathered so far: transcripts of phone calls and in-person walkthroughs (machine transcribed, so expect garbled words and no reliable speaker labels), typed notes, and photos taken at the house. The agent is the one asking about the house; the seller is the one who lives there. Turn all of it into the brief the agent's team works from, and call the save_brief tool once.

The first rule is never to invent. Every fact must come from the material.
- A form box or field is filled only when the material supports it. Each box you mark carries a basis: "stated" (someone said it plainly), "seen" (clearly visible in a photo), or "inferred" (a reasonable reading that the agent must confirm). Give a short why for every inferred box, and for seen boxes say which photo.
- If something was not said and cannot be seen, leave it out and list it in not_captured so the agent knows to ask. A lead with only a first phone call will have a mostly empty form, and that is correct.
- Mark a "None" box only when someone said there is none.
- An appliance being present in a photo does not mean it stays with the house. Mark Appliances Included only when the seller said it stays; otherwise mention what was seen in not_captured.
- Do not guess utilities, schools, square footage, lot size, or year built.
- When the transcript is garbled and you are reading through it, use basis "inferred" and say so.

The form is the team's On Site Property Information form. You are given its catalog: sections, the boxes in each, and for some boxes sub-options, a count blank ("x __"), or a short text blank. Use the section and item keys exactly as given. Counts and short text go in count and text; sub-options in options. Leave count and text as empty strings and options empty when they do not apply.
- fields: client_last_name, street_address (street and city), year_built, total_sf, lot_size, beds, baths (like 3.5), improvements (what the seller has updated, one compact sentence or two, with years and costs when given), additional_notes (the handful of things about the property a reader of the form most needs that have no box, at most about 550 characters), plus the school and well and septic blanks. Only include a field when you have a value.
- rooms: the room count table. Rows are upper, main, lower, bsmnt, adu. Give counts only for what was said or seen.

The written notes are for different readers. Keep them apart.
- team_notes: the property write-up the whole team can read. Sections with a short heading and a plain paragraph or short lines: the house, each level, systems, garage and outbuildings, outside and lot, condition items, access. Facts about the property only.
- admin_notes: what the office staff needs to act: names and who is involved in the decision, how to reach and find the place, pets and showing considerations, what stays and what goes, disclosure items to capture, paperwork or scheduling to start, what is still missing for MLS input.
- private_notes: for the agent only. Seller motivation and hesitations, family dynamics, health or memory or money matters, neighbor disputes, price expectations, the agent's own read. Anything personal or sensitive about people goes here and nowhere else.
- actions: every commitment or next step, with who owns it ("Agent", the seller's first name, or another named person), what, and when if a time was mentioned (else empty).
- questions: specific things to ask on the next contact, most useful first. Draw from not_captured and from loose ends in the conversation.
- summary: two or three sentences on who this is, what the property is, and where things stand. motivation and timeline: one or two sentences each from what the seller said, empty if not discussed.
- lead: seller name as said (first and last when known), address, phone, email. Empty strings when not stated.
- suggested_stage: new (nothing but a name), call (first conversation done), walk_set (walkthrough scheduled), walked (walkthrough done), pricing (agent is preparing or presenting numbers), signed, listed, hold, closed. next_step: the single next thing the agent should do, one short sentence.

Writing style: plain, specific, warm. Short sentences. No em dashes or en dashes. No markdown. Quote the seller's own words where they carry weight. Skip small talk that has no bearing on the property, the people, or the deal.`;

const str = { type: "string" };
const TOOL = {
  name: "save_brief",
  description: "Save the brief for this seller lead.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["lead", "summary", "motivation", "timeline", "suggested_stage", "next_step", "fields", "checks", "rooms",
      "not_captured", "team_notes", "admin_notes", "private_notes", "actions", "questions"],
    properties: {
      lead: {
        type: "object", additionalProperties: false, required: ["name", "address", "phone", "email"],
        properties: { name: str, address: str, phone: str, email: str },
      },
      summary: str, motivation: str, timeline: str,
      suggested_stage: { type: "string", enum: STAGES },
      next_step: str,
      fields: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["key", "value"], properties: { key: { type: "string", enum: FIELDS }, value: str } },
      },
      checks: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          required: ["section", "item", "basis", "why", "options", "count", "text"],
          properties: {
            section: str, item: str,
            basis: { type: "string", enum: ["stated", "seen", "inferred"] },
            why: str,
            options: { type: "array", items: str },
            count: str, text: str,
          },
        },
      },
      rooms: {
        type: "array",
        items: {
          type: "object", additionalProperties: false, required: ["row", "col", "value"],
          properties: { row: { type: "string", enum: ROOM_ROWS }, col: { type: "string", enum: ROOM_COLS }, value: str },
        },
      },
      not_captured: { type: "array", items: str },
      team_notes: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["heading", "body"], properties: { heading: str, body: str } },
      },
      admin_notes: { type: "array", items: str },
      private_notes: { type: "array", items: str },
      actions: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["who", "what", "when"], properties: { who: str, what: str, when: str } },
      },
      questions: { type: "array", items: str },
    },
  },
};

type Cat = Record<string, { t: string; g: string; i: Record<string, [string, string[], number, number]> }>;
const KIND: Record<string, string> = { call: "Phone call", walkthrough: "Walkthrough at the property", note: "Agent's note", photos: "Photos" };

function catalogText(cat: Cat) {
  const out: string[] = [];
  for (const [sk, s] of Object.entries(cat)) {
    const items = Object.entries(s.i).map(([ik, [label, opts, count, text]]) => {
      const extra = [opts.length ? "options: " + opts.join("|") : "", count ? "count" : "", text ? "text" : ""].filter(Boolean).join("; ");
      return `${ik} "${label}"${extra ? " [" + extra + "]" : ""}`;
    });
    out.push(`${sk} (${s.g}: ${s.t}): ${items.join(", ")}`);
  }
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
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count: used } = await admin.from("listing_usage").select("id", { count: "exact", head: true }).eq("user_id", userId).gte("created_at", since);
  if ((used ?? 0) >= access.daily_limit) return json({ error: "You've reached today's limit. It resets over the next 24 hours." }, 429);

  let body: { lead_id?: string; catalog?: Cat };
  try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400); }
  const cat = body.catalog;
  if (!body.lead_id || !cat || typeof cat !== "object") return json({ error: "Bad request." }, 400);

  const { data: lead } = await admin.from("listing_leads").select("id, name, address, phone, email, stage").eq("id", body.lead_id).eq("user_id", userId).maybeSingle();
  if (!lead) return json({ error: "That lead wasn't found." }, 404);
  const { data: items } = await admin.from("listing_items").select("kind, occurred_on, title, transcript, files, status")
    .eq("lead_id", lead.id).order("occurred_on").order("created_at");
  if (!items?.length) return json({ error: "Add a call, a walkthrough, notes, or photos first." }, 400);

  // words
  let room = MAX_WORDS;
  const parts: string[] = [];
  const photos: { path: string; label: string }[] = [];
  items.forEach((it, n) => {
    const head = `Item ${n + 1}: ${KIND[it.kind] ?? it.kind}, ${it.occurred_on}${it.title ? ", " + it.title : ""}`;
    const imgs = (it.files as { path: string; name: string; type: string }[]).filter((f) => (f.type || "").startsWith("image/"));
    imgs.forEach((f) => photos.push({ path: f.path, label: `Photo ${photos.length + 1} (from item ${n + 1})` }));
    const words = (it.transcript || "").slice(0, Math.max(0, room));
    room -= words.length;
    const waiting = it.status !== "ready" && !words ? "\n(The recording for this item has not been transcribed.)" : "";
    parts.push(`<item>\n${head}${imgs.length ? `\n${imgs.length} photo${imgs.length === 1 ? "" : "s"} attached.` : ""}${waiting}\n${words}\n</item>`);
  });
  const shown = photos.slice(0, MAX_PHOTOS);
  const content: unknown[] = [];
  if (shown.length) {
    const { data: signed } = await admin.storage.from("listing-files").createSignedUrls(shown.map((p) => p.path), 600);
    shown.forEach((p, i) => {
      const url = signed?.[i]?.signedUrl;
      if (!url) return;
      content.push({ type: "text", text: p.label + ":" });
      content.push({ type: "image", source: { type: "url", url } });
    });
  }
  content.push({
    type: "text",
    text: `Build the brief for this seller lead and call save_brief.

What the agent has entered for the lead so far (may be blank or partial): ${JSON.stringify({ name: lead.name, address: lead.address, phone: lead.phone, email: lead.email })}
Today is ${new Date().toLocaleDateString("en-US", { timeZone: "America/Boise", year: "numeric", month: "long", day: "numeric" })}.${photos.length > shown.length ? `\nOnly the first ${shown.length} of ${photos.length} photos are shown.` : ""}

<form_catalog>
${catalogText(cat)}
</form_catalog>

<material>
${parts.join("\n")}
</material>`,
  });

  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  const t0 = Date.now();
  try {
    const res = await client.messages.stream({
      model: MODEL,
      max_tokens: 20000,
      output_config: { effort: "medium" },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: [TOOL],
      messages: [{ role: "user", content }],
    } as Anthropic.MessageStreamParams).finalMessage();
    const seconds = (Date.now() - t0) / 1000;
    await admin.from("listing_usage").insert({
      user_id: userId, kind: "brief", seconds,
      input_tokens: (res.usage.input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0),
      output_tokens: res.usage.output_tokens ?? 0,
    });
    console.log(`brief lead=${lead.id} items=${items.length} photos=${shown.length} in=${res.usage.input_tokens} out=${res.usage.output_tokens} ${seconds.toFixed(1)}s stop=${res.stop_reason}`);
    const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "save_brief");
    if (!call || res.stop_reason === "max_tokens") return json({ error: "The brief came back incomplete. Try again." }, 502);
    const brief = call.input as Record<string, unknown> & { checks: { section: string; item: string; options: string[] }[] };
    // keep only boxes that exist on the form
    brief.checks = (brief.checks || []).filter((c) => cat[c.section]?.i?.[c.item]).map((c) => ({ ...c, options: (c.options || []).filter((o) => cat[c.section].i[c.item][1].includes(o)) }));
    brief.photos_used = shown.length; brief.photos_total = photos.length;
    const brief_at = new Date().toISOString();
    const { error: saveErr } = await admin.from("listing_leads").update({ brief, brief_at }).eq("id", lead.id);
    if (saveErr) console.error("save error", saveErr);
    return json({ brief, brief_at });
  } catch (err) {
    console.error("anthropic error", err);
    if (err instanceof Anthropic.RateLimitError) return json({ error: "The AI is busy right now. Try again in a minute." }, 503);
    if (err instanceof Anthropic.APIError) return json({ error: "The AI couldn't do that: " + err.message }, 502);
    return json({ error: "Something went wrong reaching the AI." }, 502);
  }
});
