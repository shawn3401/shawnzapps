// Listing Assistant: read a purchase and sale agreement (or a counter offer) and return the offer's terms, so the
// Net sheet's Offers view can be filled in and its Offer Summary printed (Shawn, Oct 22, 2026). The PDF goes to
// Claude as a document from a short-lived signed link, so scanned pages are read too. Supabase Edge Function
// `listing-contract` in the ShawnZapps project, verify_jwt on. Same allow-list, daily cap, and usage log as
// listing-ai. Secret: ANTHROPIC_API_KEY.
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

const LABELS = ["Initial Offer", "Counter 1", "Counter 2", "Counter 3", "Counter 4", "Counter 5", "Counter 6", "Final Contract"];
const SYSTEM = `You read Idaho residential real estate contracts for a listing agent (Anderson Hicks Group, eastern Idaho) who represents the SELLER. You are given one document: usually a Purchase and Sale Agreement (often the Idaho REALTORS RE-21 form), sometimes a counter offer or an addendum. Pull out the terms the agent's net sheet and offer summary need, and call save_offer once.

Rules:
- Take only what the document says. Leave a field out when the document does not fill it in. Never guess or fill in typical values. Blank lines, unchecked boxes, and "N/A" mean not stated.
- Money in whole dollars as numbers (no symbols). Percents as numbers (3 for 3%). Dates as YYYY-MM-DD; the offer deadline as YYYY-MM-DDTHH:MM in local Idaho time.
- price: the purchase price. earnest: the earnest money amount.
- cc_amt: closing costs or concessions the SELLER pays toward the BUYER's costs, in dollars; use cc_pct instead when the contract states a percent of the price.
- conc: any other seller concession or credit in dollars (with conc_details saying what it is). repairs: a repair allowance or credit the seller gives for lender required repairs.
- warranty: the cost of a home warranty the SELLER pays for. misc: any other cost the contract puts on the seller (with misc_details).
- loan_type: Conventional, FHA, VA, RD (USDA rural development), Cash, or Other. new_loan: the amount the buyer is borrowing (a loan to value percent times the price is fine if that is how it is written). commit_days: the business days for the loan commitment, or for proof of funds on a cash offer.
- inspect: whether the buyer reserved an inspection; inspect_days: the business days to complete it.
- other_terms: true when the agreement's additional terms or conditions section has anything written in it.
- inclusions and exclusions: the items specifically included or excluded beyond the standard fixtures, in the contract's words, short.
- title: the title company, as one of alliance (Alliance Title), amerititle, flying_s (Flying S Title), pioneer (Pioneer Title), title_one (Title One), or other.
- closing: the closing date. possession: Upon Closing, Before Closing, or After Closing, with possession_date when it is not upon closing. walkthrough: days before closing for the final walkthrough.
- buyer: the buyer's last name or names. buyer_agent: the buyer's agent's name. dual: true when one brokerage represents both sides or the contract says dual agency. licensed: true when the contract discloses a buyer is a licensed agent. contingent: true when the offer depends on the sale of another home. applied: true when the contract says the buyer has applied for the loan. occupy: whether the buyer intends to occupy the home. assignable: whether the contract can be assigned.
- label: Initial Offer for an original purchase agreement; for a counter offer, Counter N with N taken from the document's counter number; Final Contract when the document says it is the final accepted contract. Leave it out when you cannot tell.
- When the document is a counter offer or addendum and you are given the terms before it, start from those terms and change only what this document changes; return the full resulting set.
- notes: up to eight short points the agent should not miss that the fields do not cover (deadlines for disclosures, appraisal terms, HOA items, seller rent back, unusual contingencies, anything that costs the seller money). Plain words, no em dashes or en dashes.
- unclear: the fields you set from wording that was hard to read or ambiguous, each with a few words on why.`;

const TOOL = {
  name: "save_offer",
  description: "Save the offer terms read from the contract.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["notes", "unclear"],
    properties: {
      label: { type: "string", enum: LABELS },
      buyer: { type: "string" }, buyer_agent: { type: "string" },
      price: { type: "number" }, earnest: { type: "number" }, deadline: { type: "string" }, contingent: { type: "boolean" },
      cc_amt: { type: "number" }, cc_pct: { type: "number" }, conc: { type: "number" }, conc_details: { type: "string" }, repairs: { type: "number" },
      warranty: { type: "number" }, misc: { type: "number" }, misc_details: { type: "string" },
      loan_type: { type: "string", enum: ["Conventional", "FHA", "VA", "RD", "Cash", "Other"] }, new_loan: { type: "number" }, lender: { type: "string" }, loan_officer: { type: "string" }, applied: { type: "boolean" }, commit_days: { type: "number" },
      inspect: { type: "boolean" }, inspect_days: { type: "number" }, other_terms: { type: "boolean" }, inclusions: { type: "string" }, exclusions: { type: "string" },
      occupy: { type: "boolean" }, assignable: { type: "boolean" }, licensed: { type: "boolean" }, dual: { type: "boolean" },
      title: { type: "string", enum: ["alliance", "amerititle", "flying_s", "pioneer", "title_one", "other"] },
      closing: { type: "string" }, walkthrough: { type: "number" }, possession: { type: "string", enum: ["Upon Closing", "Before Closing", "After Closing"] }, possession_date: { type: "string" },
      notes: { type: "array", items: { type: "string" } },
      unclear: { type: "array", items: { type: "object", additionalProperties: false, required: ["field", "why"], properties: { field: { type: "string" }, why: { type: "string" } } } },
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

  let body: { lead_id?: string; item_id?: string; previous?: Record<string, unknown> | null };
  try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400); }
  const { data: item } = await admin.from("listing_items").select("id, lead_id, files").eq("id", body.item_id ?? "").eq("lead_id", body.lead_id ?? "").eq("user_id", userId).maybeSingle();
  const f = (item?.files as { path: string; type: string; name: string }[] | undefined)?.[0];
  if (!item || !f) return json({ error: "That contract wasn't found." }, 404);
  if (f.type !== "application/pdf") return json({ error: "The contract needs to be a PDF." }, 400);
  const { data: signed } = await admin.storage.from("listing-files").createSignedUrl(f.path, 900);
  if (!signed?.signedUrl) return json({ error: "Couldn't open the contract file." }, 502);

  const prev = body.previous && typeof body.previous === "object" ? JSON.stringify(body.previous).slice(0, 6000) : "";
  const content: unknown[] = [
    { type: "document", source: { type: "url", url: signed.signedUrl }, title: f.name },
    { type: "text", text: `Read this contract (${f.name}) and call save_offer.${prev ? `\n\nThe terms before this document, from the agent's last saved offer or counter:\n${prev}` : ""}\nToday is ${new Date().toLocaleDateString("en-US", { timeZone: "America/Boise", year: "numeric", month: "long", day: "numeric" })}.` },
  ];
  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  const t0 = Date.now();
  try {
    const res = await client.messages.stream({
      model: MODEL, max_tokens: 12000, output_config: { effort: "medium" },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: [TOOL], messages: [{ role: "user", content }],
    } as Anthropic.MessageStreamParams).finalMessage();
    await admin.from("listing_usage").insert({
      user_id: userId, kind: "contract", seconds: (Date.now() - t0) / 1000,
      input_tokens: (res.usage.input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0),
      output_tokens: res.usage.output_tokens ?? 0,
    });
    console.log(`contract item=${item.id} in=${res.usage.input_tokens} out=${res.usage.output_tokens} ${((Date.now() - t0) / 1000).toFixed(1)}s stop=${res.stop_reason}`);
    const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "save_offer");
    if (!call) return json({ error: "I couldn't read the terms out of that document. Is it a purchase agreement or counter offer?" }, 422);
    return json({ offer: call.input });
  } catch (err) {
    console.error("anthropic error", err);
    if (err instanceof Anthropic.RateLimitError) return json({ error: "The AI is busy right now. Try again in a minute." }, 503);
    if (err instanceof Anthropic.APIError) return json({ error: "The AI couldn't do that: " + err.message }, 502);
    return json({ error: "Something went wrong reaching the AI." }, 502);
  }
});
