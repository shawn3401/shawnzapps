// Dough app: after a bake is rated, suggest what to change next time.
// Supabase Edge Function `dough-tweak` in the ShawnZapps project. Shares the access list,
// daily cap, and usage log with `dough-ai`. Secret: ANTHROPIC_API_KEY.
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

const SYSTEM = `You help a home baker improve a dough recipe one batch at a time. You are given the recipe (ingredient percents as baker's percentages with flour at 100, yeast type, steps, notes) and their recent bakes of it, newest first, each with a star rating, what went well, what went poorly, what they want to try next time, updates logged along the way, and what they changed for that bake.

Suggest what to change for the next batch and call the suggest_changes tool. Rules:
- Work from what they reported about the most recent bake. If they already said what to try next time, turn that into specific numbers.
- Prefer one change to the ratios, two at most. Changing one thing at a time is how they learn what did what. If the bake went well and nothing needs fixing, return no ratio changes and say so.
- A ratio change names an ingredient exactly as it appears in their ingredient list and gives the new percent of flour. Keep moves modest: usually 1 to 3 points of hydration, 0.2 to 0.5 points of salt, a small step in yeast.
- Things that are not ratios (oven temperature, bake time, resting or proofing time, shaping, flour brand) go in tips, each with a short title and one or two plain sentences.
- Each why is one plain sentence tying the change to what they reported.
- summary is one or two plain sentences on what you make of the last bake.
- Plain text, no markdown. Fahrenheit. Do not use em dashes or en dashes. These are starting points, not guarantees.`;

const TOOL = {
  name: "suggest_changes",
  description: "Return the suggested changes for the next batch.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "changes", "tips"],
    properties: {
      summary: { type: "string" },
      changes: {
        type: "array",
        description: "Zero to two ratio changes.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["ingredient", "to_pct", "why"],
          properties: {
            ingredient: { type: "string", description: "The ingredient's name exactly as in their list." },
            to_pct: { type: "number", description: "The new percent of flour." },
            why: { type: "string" },
          },
        },
      },
      tips: {
        type: "array",
        description: "Zero to three suggestions that are not ratios.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "detail"],
          properties: { title: { type: "string" }, detail: { type: "string" } },
        },
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
  if (whoErr || !who?.user) return json({ error: "Sign in to use the AI helper." }, 401);
  const userId = who.user.id;

  const { data: access } = await admin.from("dough_ai_access").select("daily_limit").eq("user_id", userId).maybeSingle();
  if (!access) return json({ error: "The AI helper isn't turned on for your account yet." }, 403);
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count: used } = await admin.from("dough_ai_usage").select("id", { count: "exact", head: true }).eq("user_id", userId).gte("created_at", since);
  if ((used ?? 0) >= access.daily_limit) return json({ error: "You've reached today's limit for the AI helper. It resets over the next 24 hours." }, 429);

  let body: { context?: unknown };
  try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400); }
  const ask = JSON.stringify(body.context ?? {}).slice(0, 16000);

  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  try {
    const res = await client.messages.stream({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: "low" },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: [TOOL],
      messages: [{ role: "user", content: `Suggest what to change for my next batch and call suggest_changes.\n\n<recipe_and_bakes>\n${ask}\n</recipe_and_bakes>` }],
    } as Anthropic.MessageStreamParams).finalMessage();
    await admin.from("dough_ai_usage").insert({
      user_id: userId,
      input_tokens: (res.usage.input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0),
      output_tokens: res.usage.output_tokens ?? 0,
    });
    const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "suggest_changes");
    if (!call || res.stop_reason === "max_tokens") return json({ error: "I couldn't come up with suggestions. Try again." }, 502);
    return json({ suggest: call.input });
  } catch (err) {
    console.error("anthropic error", err);
    if (err instanceof Anthropic.RateLimitError) return json({ error: "The AI is busy right now. Try again in a minute." }, 503);
    if (err instanceof Anthropic.APIError) return json({ error: "The AI couldn't do that: " + err.message }, 502);
    return json({ error: "Something went wrong reaching the AI." }, 502);
  }
});
