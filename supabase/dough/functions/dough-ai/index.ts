// Dough app AI helper. Supabase Edge Function `dough-ai` in the ShawnZapps project.
// The page sends the chat so far plus the calculator's current state; Claude replies and,
// when it has a concrete recipe, calls propose_dough so the page can fill the form.
// Secrets: ANTHROPIC_API_KEY (set by Shawn in Edge Functions, Secrets). Never in the repo.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.110.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "claude-opus-5-5";
const MAX_TURNS = 24;        // messages kept from the chat
const MAX_CHARS = 4000;      // per message
const MAX_RESUMES = 3;       // pause_turn continuations

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SYSTEM = `You are the baking helper inside Dough, a small web app where home bakers plan a dough, lock it in, bake it, and report back so the next batch is better.

How the app thinks about a dough:
- Everything is a baker's percentage: each ingredient is a percent of the total flour weight. Flour is always 100% and is never listed as an ingredient.
- A dough type has a name, a way of sizing a batch, an ingredient list with percents, and steps.
- Sizing is one of: "pizza" (count, diameter, thickness), "pieces" (count and grams of dough each, for loaves, rolls, buns, dough balls), or "flour" (start from a flour weight).

What the person wants from you:
- Help them get to a sensible starting formula and method for what they want to make, or improve one they already have. They are often new to this, so be concrete and brief.
- They may name a baker, channel, book, or site to look to for inspiration. When they do, use web search to find what that source actually does and base your proposal on it. Say plainly which numbers came from the source and which are your own judgment. If you could not find or confirm something, say so. Never present a guess as the source's recipe.
- When they share how past bakes went, suggest one or two specific changes and explain why in a sentence each.

When you have a concrete formula to offer, call the propose_dough tool. The app shows it as a card the person can apply with one tap and then edit. Convert any recipe in grams to percents of flour yourself (ingredient grams / flour grams x 100, rounded to two decimals at most). For a preferment or soaker, fold its flour and water into the totals and describe the preferment in the steps. Write the steps in your own words, short and practical, with times and temperatures in Fahrenheit, and refer to ingredients by name, not by gram amounts, since the app scales the batch. Do not copy a source's text. List the pages you relied on in sources.

If the request is too vague to propose anything useful, ask one short question instead. Otherwise propose first and let them push back.

Style: plain text only, no markdown, no headings, no bullet symbols. Warm and direct, a few sentences. Do not use em dashes or en dashes. Stay on baking and this app.`;

const PROPOSE_TOOL = {
  name: "propose_dough",
  description:
    "Offer a concrete dough formula and method the person can apply to the calculator. Call this whenever you have specific percents to suggest, including a revised version after feedback.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "name", "sizing", "count", "piece_g", "flour_g", "yeast_type", "ingredients", "steps", "sources"],
    properties: {
      summary: { type: "string", description: "Two to four plain sentences shown above the card: what this is, where the numbers came from, and anything to watch for." },
      name: { type: "string", description: "Short name for the dough type, such as Bread, Sandwich loaf, Focaccia." },
      sizing: { type: "string", enum: ["pizza", "pieces", "flour"] },
      count: { type: "integer", description: "How many pieces (loaves, rolls, pizzas) a sensible first batch makes. Use 1 for flour sizing." },
      piece_g: { type: "number", description: "Grams of dough per piece for a sensible first batch. Use 0 for pizza or flour sizing." },
      flour_g: { type: "number", description: "Total flour in grams for a sensible first batch." },
      yeast_type: { type: "string", enum: ["active_dry", "instant", "fresh", "none"], description: "The yeast the yeast percent is written for. Use none for sourdough or unleavened doughs." },
      ingredients: {
        type: "array",
        description: "Every ingredient except flour, as a percent of total flour weight.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "pct"],
          properties: { name: { type: "string" }, pct: { type: "number" } },
        },
      },
      steps: { type: "array", description: "The method, one short step per item, in order.", items: { type: "string" } },
      sources: {
        type: "array",
        description: "Pages you relied on. Empty if you used none.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "url"],
          properties: { title: { type: "string" }, url: { type: "string" } },
        },
      },
    },
  },
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // Who is asking. verify_jwt already rejected unsigned calls; this resolves the user.
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !who?.user) return json({ error: "Sign in to use the AI helper." }, 401);
  const userId = who.user.id;

  const { data: access } = await admin.from("dough_ai_access").select("daily_limit").eq("user_id", userId).maybeSingle();
  if (!access) return json({ error: "The AI helper isn't turned on for your account yet." }, 403);
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count: used } = await admin.from("dough_ai_usage").select("id", { count: "exact", head: true }).eq("user_id", userId).gte("created_at", since);
  if ((used ?? 0) >= access.daily_limit) return json({ error: "You've reached today's limit for the AI helper. It resets over the next 24 hours." }, 429);

  let body: { messages?: { role: string; text: string }[]; context?: unknown };
  try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400); }
  const turns = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.trim())
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.text.slice(0, MAX_CHARS) }));
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length || turns[turns.length - 1].role !== "user") return json({ error: "Say what you'd like to make." }, 400);

  // The calculator's state rides along with the newest message, so the stable system prompt stays cacheable.
  const context = JSON.stringify(body.context ?? {}).slice(0, 12000);
  const last = turns[turns.length - 1];
  const messages: Anthropic.MessageParam[] = [
    ...turns.slice(0, -1),
    { role: "user", content: `${last.content}\n\n<calculator_state>\n${context}\n</calculator_state>` },
  ];

  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  let inTok = 0, outTok = 0, searches = 0;
  let final: Anthropic.Message | null = null;
  try {
    for (let i = 0; i <= MAX_RESUMES; i++) {
      const res = await client.messages.stream({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: "low" },
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        tools: [
          { type: "web_search_20260209", name: "web_search", max_uses: 4 },
          PROPOSE_TOOL,
        ],
        messages,
      } as Anthropic.MessageStreamParams).finalMessage();
      inTok += (res.usage.input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
      outTok += res.usage.output_tokens ?? 0;
      searches += res.usage.server_tool_use?.web_search_requests ?? 0;
      final = res;
      // A long web-search turn can pause; hand the partial turn back and the server resumes it.
      if (res.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: res.content }); continue; }
      break;
    }
  } catch (err) {
    console.error("anthropic error", err);
    if (err instanceof Anthropic.RateLimitError) return json({ error: "The AI is busy right now. Try again in a minute." }, 503);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: "The AI key isn't set up correctly. Tell Shawn." }, 500);
    if (err instanceof Anthropic.APIError) return json({ error: "The AI couldn't answer that: " + err.message }, 502);
    return json({ error: "Something went wrong reaching the AI." }, 502);
  }

  await admin.from("dough_ai_usage").insert({ user_id: userId, input_tokens: inTok, output_tokens: outTok, searches });

  if (!final) return json({ error: "No answer came back." }, 502);
  if (final.stop_reason === "refusal") return json({ reply: "I can't help with that one. Ask me about a dough you want to make.", proposal: null });

  const text = final.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim();
  const call = final.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "propose_dough");
  const proposal = call ? (call.input as Record<string, unknown>) : null;
  const cut = final.stop_reason === "max_tokens" || final.stop_reason === "pause_turn";
  const reply = text || (proposal ? String(proposal.summary ?? "") : cut ? "That took longer than I had room for. Try asking for something a little narrower." : "");
  return json({ reply, proposal, remaining: Math.max(0, access.daily_limit - (used ?? 0) - 1) });
});
