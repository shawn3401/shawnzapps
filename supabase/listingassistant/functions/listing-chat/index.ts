// Listing Assistant: the Ask tab. One message from the agent about one seller lead; Claude answers from
// everything on the lead and can make changes with tools (to-dos, notes, the property form, the stage).
// Every change is logged with what it takes to undo it, and the page shows each one with an Undo button.
// Supabase Edge Function `listing-chat` in the ShawnZapps project, verify_jwt on. Same allow-list, daily cap,
// and usage log as listing-ai. Secret: ANTHROPIC_API_KEY. The page sends the form catalog, as for listing-ai.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.110.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "claude-opus-5-5";
const MAX_WORDS = 120000;   // characters of notes, transcripts, and PDF text sent
const MAX_ROUNDS = 8;       // tool rounds per message
const HISTORY = 20;         // earlier messages sent along

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const STAGES = ["new", "call", "walk_set", "walked", "pricing", "signed", "listed", "hold", "closed"];
const STAGE_NAME: Record<string, string> = { new: "New lead", call: "First call done", walk_set: "Walkthrough set", walked: "Walked", pricing: "Pricing", signed: "Signed", listed: "Listed", hold: "On hold", closed: "Closed out" };
const FIELDS = ["client_last_name", "street_address", "year_built", "total_sf", "lot_size", "beds", "baths", "improvements",
  "additional_notes", "irrigation_company", "elementary", "middle", "high", "well_depth", "pump_depth", "pump_size", "septic_size", "last_pumped"];
const ROOM_ROWS = ["upper", "main", "lower", "bsmnt", "adu"];
const ROOM_COLS = ["sqft", "bedrooms", "full_bath", "half_bath", "fam_room", "living_rm", "kitchen", "frml_dining", "den", "laundry", "fireplaces"];
const WHO: Record<string, string> = { agent: "Listing Agent", seller: "Seller", team: "Success Team" };
const NUM: Record<string, string> = { tax: "Tax assessed value", zest: "Zestimate", wants: "Seller wants", loan: "Loan amount", cma_low: "CMA low", cma_high: "CMA high" };

const SYSTEM = `You are the assistant inside Listing Assistant, a tool a residential real estate listing agent in eastern Idaho (Anderson Hicks Group) uses to get a seller's home ready to list. You are working on ONE seller lead. You are given everything on it: the agent's notes, transcripts of calls and walkthroughs (machine transcribed, so expect garbled words), text read from PDFs, the names of photos and other files, the to-do list, the property form as it stands, and the last brief. The agent talks to you in short messages, often dictated on a phone.

Answer questions from that material. Be direct and brief: a sentence or a few short lines, a short list only when it helps. Say where something came from when it matters ("in your Oct 13 note", "on the walkthrough recording"). If the material does not say, say so plainly and suggest who could answer. Never invent facts about the property, the seller, or the market.

You can also make changes with your tools: add a to-do, mark one done or not done, change who it belongs to, save a note, mark or clear boxes and fill blanks on the property form, and change the lead's stage.
- Make a change only when the agent asks for it or the message clearly implies it. While answering a question, do not change anything on your own; offer instead ("Want me to add that as a to-do?").
- When the agent tells you a new fact about the property, the seller, or the deal, save it with add_note (their words, lightly cleaned up) so it stays with the lead, and also make any form change or to-do change it calls for. Example: "Brett said the roof is original, metal" means add_note, mark the roof to-do done if there is one, and check Roof: Metal.
- Use the to-do numbers and the form keys exactly as given. Make several tool calls when the message asks for several things.
- After making changes, reply in one or two short sentences saying what you did. The page shows each change with an Undo button, so do not ask for permission first. If the request is ambiguous, ask one short question instead of guessing.
- On the form, anything the agent tells you counts as confirmed. When checking a box that has options, a count, or a text blank, fill those only with what was given (empty strings and an empty list otherwise).
- The Value card holds six numbers: tax (tax assessed value), zest (Zestimate), wants (what the seller wants), loan (what they owe), cma_low and cma_high (the agent's CMA range). Set one with set_value when the agent gives it ("Zestimate is 512k", "CMA came in 470 to 495"), in whole dollars, with a short note of where it came from if they said. An amount of 0 clears it. Never set one from your own estimate.
- Who on a to-do is one of: agent (Listing Agent: the agent's own work, and the default), seller (the seller or anyone on their side), team (the Success Team: office paperwork, MLS entry, title, photos, signs, lockboxes, marketing).

Plain words. No markdown headings, tables, or bold. No em dashes or en dashes.`;

const str = { type: "string" };
const tool = (name: string, description: string, properties: Record<string, unknown>) =>
  ({ name, description, strict: true, input_schema: { type: "object", additionalProperties: false, required: Object.keys(properties), properties } });
const TOOLS = [
  tool("add_todo", "Add a to-do to this lead.", { text: str, who: { type: "string", enum: ["agent", "seller", "team"] } }),
  tool("mark_todo", "Mark a to-do done, or not done, by its number in the list.", { number: { type: "integer" }, done: { type: "boolean" } }),
  tool("set_todo_who", "Change who a to-do belongs to, by its number.", { number: { type: "integer" }, who: { type: "string", enum: ["agent", "seller", "team"] } }),
  tool("add_note", "Save a note on this lead, in the agent's words.", { text: str }),
  tool("set_form_box", "Mark (checked true) or clear (checked false) one box on the property form, by section and item key from the catalog.", { section: str, item: str, checked: { type: "boolean" }, options: { type: "array", items: str }, count: str, text: str }),
  tool("set_form_field", "Fill a written blank on the form (top of the form, the two written lines, schools, irrigation company, well and septic blanks). An empty value clears it.", { key: { type: "string", enum: FIELDS }, value: str }),
  tool("set_room_count", "Fill one cell of the room count table. An empty value clears it.", { row: { type: "string", enum: ROOM_ROWS }, col: { type: "string", enum: ROOM_COLS }, value: str }),
  tool("set_stage", "Move the lead to another stage.", { stage: { type: "string", enum: STAGES } }),
  tool("set_value", "Set one number on the Value card, in whole dollars. 0 clears it.", { key: { type: "string", enum: Object.keys(NUM) }, amount: { type: "integer" }, note: str }),
];

type Cat = Record<string, { t: string; g: string; i: Record<string, [string, string[], number, number]> }>;
type Form = { fields: Record<string, string>; checks: Record<string, { b: string; why: string; opts: string[]; count: string; text: string }>; rooms: Record<string, string>; locked: Record<string, number> };
type Todo = { id: string; text: string; who: string; done: boolean; done_at: string | null; done_hint: string };
type Action = { label: string; undo: Record<string, unknown> };

function catalogText(cat: Cat) {
  return Object.entries(cat).map(([sk, s]) => `${sk} (${s.t}): ` + Object.entries(s.i).map(([ik, [label, opts, count, text]]) => {
    const extra = [opts.length ? "options: " + opts.join("|") : "", count ? "count" : "", text ? "text" : ""].filter(Boolean).join("; ");
    return `${ik} "${label}"${extra ? " [" + extra + "]" : ""}`;
  }).join(", ")).join("\n");
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

  let body: { lead_id?: string; message?: string; catalog?: Cat };
  try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400); }
  const message = (body.message || "").trim().slice(0, 8000), cat = body.catalog;
  if (!message || !cat || typeof cat !== "object") return json({ error: "Bad request." }, 400);
  const { data: lead } = await admin.from("listing_leads").select("id, name, address, stage, form, brief, numbers").eq("id", body.lead_id ?? "").eq("user_id", userId).maybeSingle();
  if (!lead) return json({ error: "That lead wasn't found." }, 404);

  const [{ data: itemRows }, { data: todoRows }, { data: past }] = await Promise.all([
    admin.from("listing_items").select("kind, occurred_on, title, transcript, files").eq("lead_id", lead.id).order("occurred_on").order("created_at"),
    admin.from("listing_todos").select("id, text, who, done, done_at, done_hint").eq("lead_id", lead.id).order("created_at"),
    admin.from("listing_chats").select("role, text, actions").eq("lead_id", lead.id).order("created_at", { ascending: false }).limit(HISTORY),
  ]);
  const todos = (todoRows || []) as Todo[];
  const f = (lead.form || {}) as Partial<Form>;
  const form: Form = { fields: f.fields || {}, checks: f.checks || {}, rooms: f.rooms || {}, locked: f.locked || {} };

  // ---- what Claude is told about the lead
  let room = MAX_WORDS;
  const material = (itemRows || []).map((it, n) => {
    const files = (it.files as { name: string; type: string }[]).map((x) => x.name).join(", ");
    const words = (it.transcript || "").slice(0, Math.max(0, room)); room -= words.length;
    const head = it.kind === "note" ? `Note${it.title ? " (" + it.title + ")" : ""}` : `File: ${files}`;
    return `<entry n="${n + 1}">\n${head}, ${it.occurred_on}\n${words}\n</entry>`;
  }).join("\n") || "(nothing yet)";
  const todoText = () => todos.length ? todos.map((t, n) => `${n + 1}. [${t.done ? "done" : "open"}] ${t.text} (${WHO[t.who] ?? "Listing Agent"})`).join("\n") : "(none)";
  const marked = Object.entries(form.checks).map(([k, c]) => {
    const [s, i] = k.split("."), it = cat[s]?.i?.[i]; if (!it) return "";
    return `${k} = ${cat[s].t}: ${it[0]}${c.opts?.length ? " (" + c.opts.join(", ") + ")" : ""}${c.count ? " x" + c.count : ""}${c.text ? " [" + c.text + "]" : ""}${c.b === "inferred" ? " (AI guess, not confirmed yet)" : ""}`;
  }).filter(Boolean).join("\n") || "(none)";
  const nums = (lead.numbers || {}) as Record<string, any>;
  const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
  const numText = Object.keys(NUM).map((k) => `${k} (${NUM[k]}): ${nums[k]?.amount ? money(nums[k].amount) + (nums[k].note ? " (" + nums[k].note + ")" : "") : "not set"}${nums.hints?.[k] ? `; suggested from the material: ${money(nums.hints[k].amount)}` : ""}`).join("\n");
  const fieldText = Object.entries(form.fields).map(([k, v]) => `${k}: ${v}`).join("\n") || "(none)";
  const roomText = Object.entries(form.rooms).map(([k, v]) => `${k}: ${v}`).join("\n") || "(none)";
  const b = (lead.brief || {}) as Record<string, unknown>;
  const briefText = lead.brief ? JSON.stringify({ summary: b.summary, motivation: b.motivation, timeline: b.timeline, not_captured: b.not_captured, questions: b.questions }) : "(no brief built yet)";
  const context = `Seller lead: ${lead.name || "(no name)"}${lead.address ? ", " + lead.address : ""}. Stage: ${STAGE_NAME[lead.stage] ?? lead.stage}.
Today is ${new Date().toLocaleDateString("en-US", { timeZone: "America/Boise", weekday: "long", year: "numeric", month: "long", day: "numeric" })}.

<material>
${material}
</material>

<last_brief>
${briefText}
</last_brief>

<form_catalog>
${catalogText(cat)}
</form_catalog>

<form_boxes_marked>
${marked}
</form_boxes_marked>

<form_fields>
${fieldText}
</form_fields>

<room_counts>
${roomText}
</room_counts>

<value_numbers>
${numText}
</value_numbers>`;
  const history = (past || []).reverse().map((m) => m.role === "user" ? `Agent: ${m.text}` :
    `You: ${m.text}${(m.actions as Action[]).length ? "\n(Changes you made: " + (m.actions as (Action & { undone?: boolean })[]).map((a) => a.label + (a.undone ? " [later undone]" : "")).join("; ") + ")" : ""}`).join("\n\n");

  await admin.from("listing_chats").insert({ lead_id: lead.id, user_id: userId, role: "user", text: message });

  // ---- the tools, run against this lead only
  const actions: Action[] = [];
  let formDirty = false;
  const setForm = (src: "checks" | "fields" | "rooms", k: string, lk: string, value: unknown) => {
    const prev = (form[src] as Record<string, unknown>)[k] ?? null, prevLock = form.locked[lk] ?? null;
    if (value === null || value === "") delete (form[src] as Record<string, unknown>)[k]; else (form[src] as Record<string, unknown>)[k] = value;
    form.locked[lk] = 1; formDirty = true;
    return { t: "form", src, k, lk, prev, prevLock };
  };
  async function run(name: string, a: Record<string, unknown>): Promise<string> {
    if (name === "add_todo") {
      const text = String(a.text || "").trim().slice(0, 300); if (!text) return "Empty to-do, nothing added.";
      const w = WHO[a.who as string] ? a.who as string : "agent";
      const { data, error } = await admin.from("listing_todos").insert({ lead_id: lead.id, user_id: userId, text, who: w, source: "ai" }).select("id, text, who, done, done_at, done_hint").single();
      if (error) return "Couldn't add it: " + error.message;
      todos.push(data as Todo);
      actions.push({ label: `Added to-do: ${text} (${WHO[w]})`, undo: { t: "todo_del", id: data.id } });
      return `Added as to-do ${todos.length}.`;
    }
    if (name === "mark_todo" || name === "set_todo_who") {
      const t = todos[Number(a.number) - 1]; if (!t) return `There is no to-do number ${a.number}.`;
      if (name === "mark_todo") {
        const done = !!a.done; if (t.done === done) return `To-do ${a.number} is already ${done ? "done" : "open"}.`;
        const prev = { done: t.done, done_at: t.done_at, done_hint: t.done_hint };
        const patch = { done, done_at: done ? new Date().toISOString() : null, done_hint: "" };
        const { error } = await admin.from("listing_todos").update(patch).eq("id", t.id); if (error) return "Couldn't change it: " + error.message;
        Object.assign(t, patch);
        actions.push({ label: `${done ? "Marked done" : "Reopened"}: ${t.text}`, undo: { t: "todo_set", id: t.id, patch: prev } });
        return "Done.";
      }
      const w = WHO[a.who as string] ? a.who as string : "agent"; if (t.who === w) return "It already belongs to them.";
      const { error } = await admin.from("listing_todos").update({ who: w }).eq("id", t.id); if (error) return "Couldn't change it: " + error.message;
      actions.push({ label: `${t.text}: now ${WHO[w]}`, undo: { t: "todo_set", id: t.id, patch: { who: t.who } } });
      t.who = w; return "Done.";
    }
    if (name === "add_note") {
      const text = String(a.text || "").trim().slice(0, 8000); if (!text) return "Empty note, nothing saved.";
      const { data, error } = await admin.from("listing_items").insert({ lead_id: lead.id, user_id: userId, kind: "note", title: "From Ask", transcript: text }).select("id").single();
      if (error) return "Couldn't save it: " + error.message;
      actions.push({ label: `Saved a note: "${text.length > 90 ? text.slice(0, 87) + "..." : text}"`, undo: { t: "item_del", id: data.id } });
      return "Saved.";
    }
    if (name === "set_form_box") {
      const s = String(a.section), i = String(a.item), it = cat[s]?.i?.[i];
      if (!it) return `There is no box ${s}.${i} on the form. Check the catalog keys.`;
      const key = `${s}.${i}`, on = !!a.checked;
      if (!on && !form.checks[key]) return "That box was already clear.";
      const opts = on ? ((a.options as string[]) || []).filter((o) => it[1].includes(o)) : [];
      const undo = setForm("checks", key, "c:" + key, on ? { b: "agent", why: "", opts, count: String(a.count || ""), text: String(a.text || "") } : null);
      actions.push({ label: `${on ? "Checked" : "Cleared"} on the form: ${cat[s].t}, ${it[0]}${opts.length ? " (" + opts.join(", ") + ")" : ""}${on && a.count ? " x" + a.count : ""}${on && a.text ? " [" + a.text + "]" : ""}`, undo });
      return "Done.";
    }
    if (name === "set_form_field") {
      const k = String(a.key), v = String(a.value || "").trim(); if (!FIELDS.includes(k)) return "Unknown field.";
      const undo = setForm("fields", k, "f:" + k, v);
      actions.push({ label: v ? `Form, ${k.replace(/_/g, " ")}: ${v.length > 70 ? v.slice(0, 67) + "..." : v}` : `Cleared on the form: ${k.replace(/_/g, " ")}`, undo });
      return "Done.";
    }
    if (name === "set_room_count") {
      const r = String(a.row), c = String(a.col), v = String(a.value || "").trim();
      if (!ROOM_ROWS.includes(r) || !ROOM_COLS.includes(c)) return "Unknown cell.";
      const undo = setForm("rooms", `${r}.${c}`, `r:${r}.${c}`, v);
      actions.push({ label: `Room count, ${r} ${c.replace(/_/g, " ")}: ${v || "cleared"}`, undo });
      return "Done.";
    }
    if (name === "set_stage") {
      const st = String(a.stage); if (!STAGES.includes(st)) return "Unknown stage."; if (st === lead.stage) return "It is already in that stage.";
      const { error } = await admin.from("listing_leads").update({ stage: st }).eq("id", lead.id); if (error) return "Couldn't change it: " + error.message;
      actions.push({ label: `Moved to ${STAGE_NAME[st]}`, undo: { t: "stage", prev: lead.stage } });
      lead.stage = st; return "Done.";
    }
    if (name === "set_value") {
      const k = String(a.key), amt = Math.round(Number(a.amount) || 0); if (!NUM[k]) return "Unknown number.";
      const prev = nums[k] ?? null, prevHint = nums.hints?.[k] ?? null;
      if (amt > 0) nums[k] = { amount: amt, note: String(a.note || "").trim().slice(0, 120) || "From Ask", at: new Date().toISOString(), history: prev?.amount ? [...(prev.history || []), { amount: prev.amount, note: prev.note, at: prev.at }] : (prev?.history || []) };
      else delete nums[k];
      if (nums.hints) delete nums.hints[k];
      const { error } = await admin.from("listing_leads").update({ numbers: nums }).eq("id", lead.id); if (error) return "Couldn't save it: " + error.message;
      actions.push({ label: amt > 0 ? `${NUM[k]}: ${money(amt)}` : `Cleared ${NUM[k]}`, undo: { t: "num", key: k, prev, prevHint } });
      return "Done.";
    }
    return "Unknown tool.";
  }

  // ---- the conversation
  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  const t0 = Date.now(); let inTok = 0, outTok = 0, reply = "";
  const msgs: Anthropic.MessageParam[] = [{ role: "user", content: [
    { type: "text", text: context, cache_control: { type: "ephemeral" } },
    { type: "text", text: `<earlier_conversation>\n${history || "(none)"}\n</earlier_conversation>\n\n<todo_list>\n${todoText()}\n</todo_list>\n\nNew message from the agent:\n${message}` },
  ] }];
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await client.messages.stream({
        model: MODEL, max_tokens: 4000, output_config: { effort: "medium" },
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        tools: TOOLS, messages: msgs,
      } as Anthropic.MessageStreamParams).finalMessage();
      inTok += (res.usage.input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
      outTok += res.usage.output_tokens ?? 0;
      const uses = res.content.filter((x): x is Anthropic.ToolUseBlock => x.type === "tool_use");
      const text = res.content.filter((x): x is Anthropic.TextBlock => x.type === "text").map((x) => x.text).join("\n").trim();
      if (!uses.length || res.stop_reason !== "tool_use") { reply = text; break; }
      msgs.push({ role: "assistant", content: res.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const u of uses) {
        let out: string;
        try { out = await run(u.name, u.input as Record<string, unknown>); } catch (e) { out = "That failed: " + (e as Error).message; }
        results.push({ type: "tool_result", tool_use_id: u.id, content: out });
      }
      msgs.push({ role: "user", content: results });
    }
  } catch (err) {
    console.error("anthropic error", err);
    if (!actions.length) {
      if (err instanceof Anthropic.RateLimitError) return json({ error: "The AI is busy right now. Try again in a minute." }, 503);
      return json({ error: "Something went wrong reaching the AI." }, 502);
    }
    reply = "I made some of the changes, then lost the connection to the AI. Check the list below.";
  }
  if (formDirty) await admin.from("listing_leads").update({ form }).eq("id", lead.id);
  if (!reply) reply = actions.length ? "Done." : "Sorry, I didn't get an answer together. Try asking again.";
  await admin.from("listing_usage").insert({ user_id: userId, kind: "chat", seconds: (Date.now() - t0) / 1000, input_tokens: inTok, output_tokens: outTok });
  console.log(`chat lead=${lead.id} actions=${actions.length} in=${inTok} out=${outTok} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const { data: saved } = await admin.from("listing_chats").insert({ lead_id: lead.id, user_id: userId, role: "assistant", text: reply, actions }).select().single();
  return json({ reply, actions, message: saved });
});
