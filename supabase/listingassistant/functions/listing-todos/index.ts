// Listing Assistant: keep the running to-do list for a seller lead. Reads one new entry (a note, a
// transcript, the text of a PDF) or, with no item_id, everything on the lead, and adds the open actions it
// finds to listing_todos. It also flags open to-dos the material shows are finished (done_hint); the agent
// confirms those, nothing is ticked off automatically. Supabase Edge Function `listing-todos` in the
// ShawnZapps project, verify_jwt on. Same allow-list and usage log as listing-ai. Secret: ANTHROPIC_API_KEY.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.110.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "claude-opus-5-5";
const MAX_WORDS = 120000;   // characters of material sent
const MAX_ADD = 25;
const WHO: Record<string, string> = { agent: "Listing Agent", seller: "Seller", team: "Success Team" };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SYSTEM = `You keep the to-do list for a residential real estate listing agent who is getting a seller's home ready to list. You are given the to-dos already on the list for this seller, and new material the agent just added: a typed note, a transcript of a call or walkthrough (machine transcribed, so expect garbled words), or the text of a document. Find the open actions in the new material and call the save_todos tool once.

A to-do is a concrete thing that still has to be done by someone before this home goes live, or to keep the listing moving:
- something the agent said they need, want, or plan to do ("I need to measure the property" becomes "Measure the property")
- something the agent promised the seller or anyone else
- something the seller or another person agreed to do or to find out
- a repair, cleanup, document, or decision that someone said has to happen first

Not a to-do: a description of the house, an observation, something already done, small talk, a vague idea nobody committed to, or general good practice that nobody mentioned. Never invent a task. If the material has no open actions, return empty lists.

Rules for add:
- text is a short instruction that starts with a verb and names the specific thing, about 3 to 12 words. Keep names, dates, and amounts that were given ("Send Darlene Josh's number", "Meet Amanda and Katrina at the office Thursday at 2").
- who is one of three. "agent": the listing agent's own job (measuring, pricing, calls and meetings with the seller, anything the agent said "I" will do). "seller": the seller's job, or their family's or anyone on the seller's side (repairs, cleaning out, finding documents, decisions). "team": the agent's Success Team, the office staff who handle the listing's paperwork and logistics (listing documents and signatures, MLS entry, ordering title work, scheduling photos, signs and lockboxes, marketing pieces); use it when the material hands the task to the team, the office, or an admin, or when the task is plainly that kind of office work. When it is unclear, use "agent".
- Since who is only one of three, put any other person's name in the text itself ("Ask Craig what caused the basement flooding").
- Do not add anything that means the same as a to-do already on the list, whether open or done. One task, one line.
- When the note is itself just a task the agent jotted down, that task is the to-do.

Rules for done:
- List an existing OPEN to-do only when the new material clearly shows it has been finished ("measured the house today, 2,340 square feet" finishes "Measure the property"). Give its number and one short sentence of evidence in the material's own words.
- When in doubt, leave it out.

Rules for numbers (only these nine, only about THIS property, and only when the material states the amount):
- tax: the county's assessed or taxable value of the property.
- zest: Zillow's Zestimate for the property.
- wants: the price the seller says they want or would list at.
- loan: what the seller owes on the property (mortgage balance or payoff). When the seller says the house is paid off or they owe nothing, loan is 0.
- cma_low and cma_high: the low and high ends of the price range from the agent's CMA (comparable sales analysis).
- rec_low and rec_high: the low and high ends of the list price range the agent recommends to the seller.
- agreed: the list price the agent and seller agreed on.
Give the amount in whole dollars ("she wants 525" means 525000) and one short quote of where it came from. Never use a comparable sale, a neighbor's house, a past purchase price, or a guess. When none of the nine is stated, return an empty list.

A file can carry the agent's note saying how to treat it. Follow it. When the note calls the file a draft, a partial listing, or something to check, do not take facts or numbers from it; only add to-dos the note asks for or that come from checking it ("Fix the square footage on the partial listing").

Plain words. No em dashes or en dashes. No markdown.`;

const TOOL = {
  name: "save_todos",
  description: "Save what was found in the new material.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["add", "done", "numbers"],
    properties: {
      add: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["text", "who"], properties: { text: { type: "string" }, who: { type: "string", enum: ["agent", "seller", "team"] } } },
      },
      done: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["number", "evidence"], properties: { number: { type: "integer" }, evidence: { type: "string" } } },
      },
      numbers: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["key", "amount", "evidence"], properties: { key: { type: "string", enum: ["tax", "zest", "wants", "loan", "cma_low", "cma_high", "rec_low", "rec_high", "agreed"] }, amount: { type: "integer" }, evidence: { type: "string" } } },
      },
    },
  },
};

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

  let body: { lead_id?: string; item_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400); }
  const { data: lead } = await admin.from("listing_leads").select("id, name, address, numbers").eq("id", body.lead_id ?? "").eq("user_id", userId).maybeSingle();
  if (!lead) return json({ error: "That lead wasn't found." }, 404);

  let q = admin.from("listing_items").select("id, kind, occurred_on, title, transcript, note").eq("lead_id", lead.id).order("occurred_on").order("created_at");
  if (body.item_id) q = q.eq("id", body.item_id);
  const { data: all } = await q;
  const items = (all || []).filter((i) => (i.transcript || "").trim() || (i.note || "").trim());
  if (!items.length) return json({ added: [], hinted: [], numbers: lead.numbers });
  const { data: have } = await admin.from("listing_todos").select("id, text, who, done").eq("lead_id", lead.id).order("created_at");
  const todos = have || [];

  let room = MAX_WORDS;
  const parts = items.map((it) => {
    const words = it.transcript.slice(0, Math.max(0, room)); room -= words.length;
    return `<entry>\n${it.kind === "note" ? "Agent's note" : "File: " + it.title}, ${it.occurred_on}${it.note ? "\nAgent's note about this file: " + it.note : ""}\n${words}\n</entry>`;
  });
  const list = todos.length ? todos.map((t, n) => `${n + 1}. [${t.done ? "done" : "open"}] ${t.text} (${WHO[t.who] ?? "Listing Agent"})`).join("\n") : "(none yet)";
  const ask = `Seller: ${lead.name || "(no name yet)"}${lead.address ? ", " + lead.address : ""}
Today is ${new Date().toLocaleDateString("en-US", { timeZone: "America/Boise", weekday: "long", year: "numeric", month: "long", day: "numeric" })}.

<todos_already_on_the_list>
${list}
</todos_already_on_the_list>

<new_material>
${parts.join("\n")}
</new_material>

Call save_todos.`;

  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  const t0 = Date.now();
  try {
    const res = await client.messages.stream({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: "low" },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: [TOOL],
      messages: [{ role: "user", content: ask }],
    } as Anthropic.MessageStreamParams).finalMessage();
    await admin.from("listing_usage").insert({
      user_id: userId, kind: "todos", seconds: (Date.now() - t0) / 1000,
      input_tokens: (res.usage.input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0),
      output_tokens: res.usage.output_tokens ?? 0,
    });
    const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "save_todos");
    const out = (call?.input ?? { add: [], done: [], numbers: [] }) as { add: { text: string; who: string }[]; done: { number: number; evidence: string }[]; numbers: { key: string; amount: number; evidence: string }[] };
    console.log(`todos lead=${lead.id} entries=${items.length} add=${out.add?.length ?? 0} done=${out.done?.length ?? 0} in=${res.usage.input_tokens} out=${res.usage.output_tokens}`);

    const rows = (out.add || []).filter((a) => a.text?.trim()).slice(0, MAX_ADD).map((a) => ({
      lead_id: lead.id, user_id: userId, text: a.text.trim().slice(0, 300), who: WHO[a.who] ? a.who : "agent", source: "ai", item_id: body.item_id ?? null,
    }));
    let added: unknown[] = [];
    if (rows.length) {
      const { data, error } = await admin.from("listing_todos").insert(rows).select();
      if (error) console.error("insert error", error); else added = data ?? [];
    }
    const hinted: { id: string; done_hint: string }[] = [];
    for (const d of out.done || []) {
      const t = todos[d.number - 1];
      if (!t || t.done || !d.evidence?.trim()) continue;
      const done_hint = d.evidence.trim().slice(0, 300);
      await admin.from("listing_todos").update({ done_hint }).eq("id", t.id);
      hinted.push({ id: t.id, done_hint });
    }
    // a number it spotted waits on the Value card as a suggestion; it never overwrites one
    const nums = (lead.numbers || {}) as Record<string, any>; let numsDirty = false;
    for (const n of out.numbers || []) {
      if (!["tax", "zest", "wants", "loan", "cma_low", "cma_high", "rec_low", "rec_high", "agreed"].includes(n.key) || !(n.amount > 0 || (n.key === "loan" && n.amount === 0))) continue;
      if (nums[n.key]?.amount === n.amount) continue;
      nums.hints = nums.hints || {};
      nums.hints[n.key] = { amount: n.amount, evidence: (n.evidence || "").trim().slice(0, 300), at: new Date().toISOString(), item_id: body.item_id ?? null };
      numsDirty = true;
    }
    if (numsDirty) await admin.from("listing_leads").update({ numbers: nums }).eq("id", lead.id);
    return json({ added, hinted, numbers: nums });
  } catch (err) {
    console.error("anthropic error", err);
    if (err instanceof Anthropic.RateLimitError) return json({ error: "The AI is busy right now. Try again in a minute." }, 503);
    if (err instanceof Anthropic.APIError) return json({ error: "The AI couldn't do that: " + err.message }, 502);
    return json({ error: "Something went wrong reaching the AI." }, 502);
  }
});
