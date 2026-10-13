// Dough app: timing suggestions. A recipe is written for one timing; when the baker picks a different
// one for today's bake, this returns a few concrete ways to speed the recipe up or slow it down.
// It does NOT rewrite the recipe. Supabase Edge Function `dough-adapt` in the ShawnZapps project.
// Shares the access list, daily cap, and usage log with `dough-ai`. Secret: ANTHROPIC_API_KEY.
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

const SYSTEM = `You help a home baker fit a dough recipe to the time they have today. You are given their recipe: ingredient percents (baker's percentages, flour is 100), yeast type, and the steps they wrote. The recipe is written for one timing. Today they picked a different timing.

Do not rewrite the recipe. Give two to four specific suggestions for how to speed it up or slow it down to fit the new timing, then call the timing_tips tool. Rules:
- Point at their actual steps. Say which rest, rise, or temperature to change and to what, for example "Do the first rise in the refrigerator overnight, then shape while cold". Times and temperatures in Fahrenheit.
- Each tip has a short title (a few words) and one or two plain sentences of detail.
- Faster usually means more yeast, warmer liquid, and a warm place to rise, at some cost in flavor. Slower usually means less yeast, cooler liquid, and time in the refrigerator. Rich doughs with butter, sugar, milk, or eggs rise slower than lean ones.
- yeast_pct is the yeast percent you would use for the new timing with the yeast type they have. Return 0 if the dough has no yeast or you would leave it unchanged.
- note is one honest sentence: what they trade off, or, if this timing is a poor fit for this dough, say so plainly and name the closest timing that works.
- Plain text, no markdown. Do not use em dashes or en dashes. These are starting points; tell them to trust how the dough looks over the clock only if it fits naturally in the note.`;

const TIPS_TOOL = {
  name: "timing_tips",
  description: "Return the suggestions for fitting this recipe to the new timing.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["tips", "yeast_pct", "note"],
    properties: {
      tips: {
        type: "array",
        description: "Two to four suggestions, most useful first.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "detail"],
          properties: { title: { type: "string" }, detail: { type: "string" } },
        },
      },
      yeast_pct: { type: "number", description: "Suggested yeast percent of flour for the new timing, or 0 for no change or no yeast." },
      note: { type: "string", description: "One sentence on the tradeoff, or a plain warning if this timing does not suit the dough." },
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

  let body: { from?: unknown; to?: unknown; context?: unknown };
  try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400); }
  const ask = JSON.stringify({ recipe_is_written_for: body.from, timing_picked_today: body.to, recipe: body.context ?? {} }).slice(0, 14000);

  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  try {
    const res = await client.messages.stream({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: "low" },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: [TIPS_TOOL],
      messages: [{ role: "user", content: `Give me suggestions for today's timing and call timing_tips.\n\n<request>\n${ask}\n</request>` }],
    } as Anthropic.MessageStreamParams).finalMessage();
    await admin.from("dough_ai_usage").insert({
      user_id: userId,
      input_tokens: (res.usage.input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0),
      output_tokens: res.usage.output_tokens ?? 0,
    });
    const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "timing_tips");
    if (!call || res.stop_reason === "max_tokens") return json({ error: "I couldn't come up with suggestions. Try again." }, 502);
    return json({ tips: call.input });
  } catch (err) {
    console.error("anthropic error", err);
    if (err instanceof Anthropic.RateLimitError) return json({ error: "The AI is busy right now. Try again in a minute." }, 503);
    if (err instanceof Anthropic.APIError) return json({ error: "The AI couldn't do that: " + err.message }, 502);
    return json({ error: "Something went wrong reaching the AI." }, 502);
  }
});
