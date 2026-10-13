// Listing Assistant: turn an uploaded recording (audio or video) into words, with speakers marked.
// Supabase Edge Function `listing-transcribe` in the ShawnZapps project, verify_jwt on.
// Deepgram reads the file straight from a short-lived signed link, so nothing large passes through here.
// Secret: DEEPGRAM_API_KEY. Same allow-list and usage log as listing-ai.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

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

  let body: { item_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400); }
  const { data: item } = await admin.from("listing_items").select("id, transcript, files").eq("id", body.item_id ?? "").eq("user_id", userId).maybeSingle();
  if (!item) return json({ error: "That item wasn't found." }, 404);
  const media = (item.files as { path: string; name: string; type: string }[]).filter((f) => /^(audio|video)\//.test(f.type || ""));
  if (!media.length) return json({ error: "There is no recording on this item." }, 400);

  const fail = async (msg: string, status: number) => {
    await admin.from("listing_items").update({ status: "failed", error: msg }).eq("id", item.id);
    return json({ error: msg }, status);
  };
  const key = Deno.env.get("DEEPGRAM_API_KEY");
  if (!key) return fail("Transcription isn't set up yet (no Deepgram key). Paste the transcript instead for now.", 503);

  const t0 = Date.now();
  const texts: string[] = [];
  for (const f of media) {
    const { data: signed } = await admin.storage.from("listing-files").createSignedUrl(f.path, 900);
    if (!signed?.signedUrl) return fail("Couldn't read the recording " + f.name + ".", 502);
    const r = await fetch("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&diarize=true&paragraphs=true&punctuate=true", {
      method: "POST",
      headers: { Authorization: "Token " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ url: signed.signedUrl }),
    });
    if (!r.ok) {
      console.error("deepgram", r.status, await r.text());
      return fail("The transcription service couldn't read " + f.name + " (" + r.status + ").", 502);
    }
    const d = await r.json();
    const alt = d?.results?.channels?.[0]?.alternatives?.[0];
    const words = (alt?.paragraphs?.transcript || alt?.transcript || "").trim();
    if (words) texts.push(media.length > 1 ? `[${f.name}]\n${words}` : words);
    console.log(`transcribed ${f.name} ${d?.metadata?.duration ?? "?"}s audio`);
  }
  if (!texts.length) return fail("No speech was found in the recording.", 422);
  const transcript = [item.transcript, ...texts].filter(Boolean).join("\n\n");
  await admin.from("listing_items").update({ transcript, status: "ready", error: "" }).eq("id", item.id);
  await admin.from("listing_usage").insert({ user_id: userId, kind: "transcribe", seconds: (Date.now() - t0) / 1000 });
  return json({ transcript });
});
