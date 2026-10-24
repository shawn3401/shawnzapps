// Listing Assistant: the Recordings inbox on the leads list (Shawn, Oct 24, 2026). Granola recordings (Apple Watch,
// iPhone, Mac) are copied in by the listing-granola function; each one waits here until it is filed on a lead,
// where it becomes an ordinary note (so the brief, Ask, the to-do scan, and the Value card read it) or hidden.
// Uses the page's globals (sb, session, leads, fn, esc, $, niceDate). Loaded after netsheet.js.
let recs = [], recConn = null, recBusy = false, recPick = null, recShowAll = false, recMsg = "";
const REC_SHOWN = 5, REC_AUTO_MIN = 10;   // rows before "Show all"; minutes between automatic checks

async function loadRecs(){
  if (!session) return;
  if (recConn === null){ try { recConn = await fn("listing-granola", { action: "status" }); } catch (_) { recConn = { connected: false }; } }
  const { data } = await sb.from("listing_recordings").select("id, title, recorded_at, minutes, summary, attendees, web_url, suggest_lead, suggest_why").eq("status", "new").order("recorded_at", { ascending: false }).limit(100);
  recs = data || []; renderRecs();
  if (recConn.connected && !recBusy && (!recConn.last_sync || Date.now() - new Date(recConn.last_sync) > REC_AUTO_MIN * 60000)) syncRecs(true);
}
async function syncRecs(quiet){
  recBusy = true; if (!quiet) recMsg = ""; renderRecs();
  try {
    const d = await fn("listing-granola", { action: "sync" });
    recConn.last_sync = new Date().toISOString();
    if (!quiet || d.added) recMsg = d.added ? `${d.added} new recording${d.added === 1 ? "" : "s"} from Granola.${d.more ? " There are more; check again for the rest." : ""}` : "Nothing new in Granola.";
  } catch (err){ recMsg = err.message; }
  recBusy = false;
  const { data } = await sb.from("listing_recordings").select("id, title, recorded_at, minutes, summary, attendees, web_url, suggest_lead, suggest_why").eq("status", "new").order("recorded_at", { ascending: false }).limit(100);
  recs = data || []; renderRecs();
}
function renderRecs(){
  const box = $("#recBox"); if (!box) return;
  if (!recConn){ box.innerHTML = ""; return; }
  if (!recConn.connected){
    box.innerHTML = `<div class="reccard off"><div><b>Granola recordings</b><div class="note">Record on your Apple Watch with Granola and the recordings show up here to file on a lead.</div></div><button class="btn" id="recConnect">Connect Granola</button></div>`;
    return;
  }
  const leadName = id => { const l = leads.find(x => x.id === id); return l ? (l.name || l.address || "that lead") : null; };
  const shown = recShowAll ? recs : recs.slice(0, REC_SHOWN);
  const when = d => d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  box.innerHTML = `<div class="reccard">
    <div class="rechead"><b>Recordings${recs.length ? ` <span class="recn">${recs.length} to file</span>` : ""}</b>
      <span class="recact">${recBusy ? `<span class="note">Checking Granola…</span>` : `<button class="btn small" id="recSync">Check Granola</button>`}<button class="btn link" id="recSettings">Granola settings</button></span></div>
    ${recMsg ? `<div class="note" style="margin-top:6px">${esc(recMsg)}</div>` : ""}
    ${!recs.length ? `<div class="note" style="margin-top:6px">Nothing waiting. New Granola recordings land here${recConn.last_sync ? `; last checked ${when(recConn.last_sync)}` : ""}.</div>` : ""}
    ${shown.map(r => { const sug = r.suggest_lead && leadName(r.suggest_lead), who = (r.attendees || []).map(a => a.name || a.email).filter(Boolean).slice(0, 3).join(", ");
      return `<div class="recrow">
        <div class="recmain"><b>${esc(r.title || "Untitled recording")}</b><div class="note">${when(r.recorded_at)}${r.minutes ? ` · ${r.minutes} min` : ""}${who ? ` · ${esc(who)}` : ""}</div>
          ${r.summary ? `<details><summary>Granola's summary</summary><div class="recsum">${esc(r.summary).replace(/\n/g, "<br>")}</div></details>` : ""}</div>
        <div class="recbtns">
          ${sug ? `<button class="btn small primary" data-recadd="${r.id}|${r.suggest_lead}">Add to ${esc(sug)}</button><div class="note recwhy">${esc(r.suggest_why)}</div>` : ""}
          <span><button class="btn small" data-recpick="${r.id}">${sug ? "Another lead" : "Pick a lead"}</button> <button class="btn link" data-rechide="${r.id}">Not a listing</button></span>
        </div>
        ${recPick === r.id ? `<div class="recleads">${leads.length ? leads.map(l => `<button class="pill" data-recadd="${r.id}|${l.id}">${esc(l.name || l.address || "Unnamed lead")}</button>`).join("") : `<span class="note">No leads yet.</span>`}</div>` : ""}
      </div>`; }).join("")}
    ${recs.length > REC_SHOWN ? `<button class="btn link" id="recMore" style="margin-top:8px">${recShowAll ? "Show fewer" : `Show all ${recs.length}`}</button>` : ""}
  </div>`;
}
async function fileRec(id, leadId){
  const { data: r } = await sb.from("listing_recordings").select("*").eq("id", id).maybeSingle(); if (!r) return;
  const day = new Date(r.recorded_at || r.created_at).toLocaleDateString("en-CA", { timeZone: "America/Boise" });
  const words = `Recorded with Granola${r.minutes ? `, ${r.minutes} minutes` : ""}${r.web_url ? ` (${r.web_url})` : ""}.${r.summary ? `\n\nGranola's summary:\n${r.summary}` : ""}${r.transcript ? `\n\nTranscript:\n${r.transcript}` : ""}`;
  const { data: item, error } = await sb.from("listing_items").insert({ lead_id: leadId, kind: "note", title: "Granola: " + (r.title || "Recording"), occurred_on: day, transcript: words }).select().single();
  if (error) return alert("That didn't file: " + error.message);
  await sb.from("listing_recordings").update({ status: "assigned", lead_id: leadId, item_id: item.id }).eq("id", id);
  recs = recs.filter(x => x.id !== id); recPick = null;
  const l = leads.find(x => x.id === leadId); recMsg = `Filed "${r.title || "Recording"}" on ${l?.name || "the lead"}. Checking it for to-dos and numbers…`; renderRecs();
  try { const d = await fn("listing-todos", { lead_id: leadId, item_id: item.id }); const n = d.added?.length || 0; recMsg = `Filed "${r.title || "Recording"}" on ${l?.name || "the lead"}${n ? `, and added ${n} to-do${n === 1 ? "" : "s"}` : ""}.`; if (l && n) l.todo = (l.todo || 0) + n; }
  catch (_) { recMsg = `Filed "${r.title || "Recording"}" on ${l?.name || "the lead"}.`; }
  renderRecs(); if (typeof renderList === "function" && !cur) renderList();
}
document.addEventListener("click", async e => {
  if (!e.target.closest("#recBox")) return;
  const t = e.target, add = t.closest("[data-recadd]"), pick = t.closest("[data-recpick]"), hide = t.closest("[data-rechide]");
  if (t.id === "recConnect" || t.id === "recSettings") return openGranola();
  if (t.id === "recSync") return syncRecs(false);
  if (t.id === "recMore"){ recShowAll = !recShowAll; return renderRecs(); }
  if (pick){ recPick = recPick === pick.dataset.recpick ? null : pick.dataset.recpick; return renderRecs(); }
  if (add){ const [id, lead] = add.dataset.recadd.split("|"); add.disabled = true; return fileRec(id, lead); }
  if (hide){ const id = hide.dataset.rechide; recs = recs.filter(x => x.id !== id); renderRecs(); await sb.from("listing_recordings").update({ status: "hidden" }).eq("id", id); }
});

// ---- connecting Granola -----------------------------------------------------------------------
function openGranola(){
  const on = recConn?.connected;
  $("#granOn").hidden = !on; $("#granOff").hidden = on;
  $("#granErr").hidden = true; $("#granKey").value = ""; $("#granDlg").showModal();
}
$("#granForm").addEventListener("submit", async e => {
  e.preventDefault();
  const key = $("#granKey").value.trim(), err = $("#granErr"); err.hidden = true; $("#granSave").disabled = true;
  try { await fn("listing-granola", { action: "connect", key }); recConn = { connected: true, last_sync: null }; $("#granDlg").close(); syncRecs(false); }
  catch (x){ err.textContent = x.message; err.hidden = false; }
  $("#granSave").disabled = false;
});
$("#granCancel").addEventListener("click", () => $("#granDlg").close());
$("#granClose").addEventListener("click", () => $("#granDlg").close());
$("#granOff2").addEventListener("click", async () => {
  if (!confirm("Disconnect Granola? Recordings already filed stay on their leads.")) return;
  await fn("listing-granola", { action: "disconnect" }); recConn = { connected: false }; $("#granDlg").close(); renderRecs();
});
