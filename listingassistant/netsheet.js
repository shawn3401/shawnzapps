// Listing Assistant: the Net sheet tab (Shawn, Oct 22, 2026). Rebuilt from the team's Google Sheet
// "AHG NetSheet": one sheet per purpose, picked at the top: Listing appointment (Low, Medium, High when the
// price is still a range), With the listing (the list price), and Offers (each offer and counter saved by name).
// Uses the page's globals (cur, sb, $, esc, kmoney, renderView...). Stored on the lead as listing_leads.netsheet;
// team fee defaults in listing_settings under "fees"; title premiums from titlerates.js.
//
// Fixes agreed with Shawn while rebuilding (the Sheet still has the old behavior):
// 1. Title insurance reads the whole table to $5M on every sheet (the listing sheets' "insrates" range stopped at
//    $799k) and rounds the price UP to the next $1,000, as the Offer sheet did.
// 2. On an offer, tax labels and amounts both use the contract closing date, or the estimated date (with a note)
//    until one is entered. The Sheet labeled with one date and computed with the other.
// 3. Payoff 2 is labeled Payoff 2.
// 4. Well test is $160 everywhere (the listing sheets said $150).
// 5. Reconveyance is charged once per seller loan being paid off ($85 each), on every sheet, whatever the buyer's
//    financing. The Sheet charged it always on listing sheets and dropped it for cash buyers on offers.
// 6. A Low or High column with no price is left out instead of showing a negative net.
// Also: the Jun 20 to 30 proration counts the closing day like the other ranges do.

const NS_TITLES = [["alliance", "Alliance Title"], ["amerititle", "Amerititle"], ["flying_s", "Flying S Title"], ["pioneer", "Pioneer Title"], ["title_one", "Title One"], ["other", "Other"]];
const NS_LOANS = ["Conventional", "FHA", "VA", "RD", "Cash", "Other"];
const NS_LABELS = ["Initial Offer", "Counter 1", "Counter 2", "Counter 3", "Counter 4", "Counter 5", "Counter 6", "Final Contract"];
const NS_MODES = [["appt", "Listing appointment"], ["listing", "With the listing"], ["offer", "Offers"]];
const NS_FEES = { transaction: 495, reconveyance: 85, recording: 25, tax_service: 85, flood: 12, reinspection: 150, well: 160, septic: 500, escrow_rate: 3, escrow_base_listing: 150,
  escrow_base: { alliance: 100, pioneer: 100, title_one: 100, flying_s: 100, amerititle: 150, other: 150 } };
const NS_FEE_LABELS = [["transaction", "Transaction/compliance fee (starting amount)"], ["reconveyance", "Reconveyance, per seller loan"], ["recording", "Recording"], ["well", "Well test"], ["septic", "Septic pump and inspection"],
  ["tax_service", "Tax service fee (FHA, VA, RD)"], ["flood", "Flood certification (FHA, VA, RD)"], ["reinspection", "Appraisal reinspection (FHA, VA, RD)"], ["escrow_rate", "Escrow fee per $1,000 of price"], ["escrow_base_listing", "Escrow base fee, listing sheets"]];
let nsFees = { ...NS_FEES, escrow_base: { ...NS_FEES.escrow_base } }, nsFeesLoaded = false, nsSaveT = 0, nsOverKey = null;

const cents = n => (n < 0 ? "−" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = n => Math.round(n * 100) / 100;
function parseAmt(t){   // "$5,000", "5000", "5k", "1.2m"; blank is null (no "thousands" guessing here: earnest money can be $500)
  t = String(t ?? "").toLowerCase().replace(/[$,\s]/g, ""); if (!t) return null;
  const m = t.match(/^(\d+(?:\.\d+)?)(k|m)?$/); if (!m) return NaN;
  return r2(parseFloat(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1));
}
const ymd = s => { if (!s) return null; const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return y ? new Date(y, m - 1, d) : null; };
const mdy = d => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function nsLoadFees(){
  if (nsFeesLoaded) return; nsFeesLoaded = true;
  const { data } = await sb.from("listing_settings").select("value").eq("key", "fees").maybeSingle();
  if (data?.value) nsFees = { ...NS_FEES, ...data.value, escrow_base: { ...NS_FEES.escrow_base, ...(data.value.escrow_base || {}) } };
  if (cur && view === "net") renderNet();
}

// ---- the math ---------------------------------------------------------------------------------
function titleRate(co, price){
  if (!(price > 0)) return 0;
  let p = Math.ceil(price / 1000) * 1000; if (p < 20000) p = 1; if (p > TITLE_RATES.max) p = TITLE_RATES.max;
  for (const [a, v, b, dv] of TITLE_RATES.segs[co] || TITLE_RATES.segs.other) if (p >= a && p <= b) return r2(v + (b === a ? 0 : (p - a) / (b - a) * dv));
  return 0;
}
// Idaho taxes are paid in arrears in halves due Dec 20 and Jun 20. Two lines: the half still unpaid at closing,
// and the share of the current half from its start through the closing day.
function taxLines(d, T){
  if (!d || !(T > 0)) return [{ key: "tax_a", label: "Property Taxes", amount: 0, note: !(T > 0) ? "Add the annual property taxes" : "Add a closing date" }];
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate(), from = s => Math.round((d - s) / 864e5) + 1, out = [];
  if (m === 12 && day > 20) out.push({ key: "tax_a", label: `Property Taxes - 1st Half of ${y} (paid Dec 20)`, amount: 0 });
  else if (m === 6 && day >= 20) out.push({ key: "tax_a", label: `Property Taxes - 1/1/${y} to ${mdy(d)}`, amount: T / 365 * from(new Date(y, 0, 1)) });
  else if (m >= 7) out.push({ key: "tax_a", label: `Property Taxes - 1st Half of ${y}`, amount: T / 2 });
  else out.push({ key: "tax_a", label: `Property Taxes - 2nd Half of ${y - 1}`, amount: T / 2 });
  if (m >= 7) out.push({ key: "tax_b", label: `Property Taxes - 7/1/${y} to ${mdy(d)}`, amount: T / 365 * from(new Date(y, 6, 1)) });
  else if (!(m === 6 && day >= 20)) out.push({ key: "tax_b", label: `Property Taxes - 1/1/${y} to ${mdy(d)}`, amount: T / 365 * from(new Date(y, 0, 1)) });
  return out;
}
// One column of a sheet: the price, any price reductions (offers), every cost line, and the nets.
function nsColumn(kind, price, o){
  const S = nsShared(), F = nsFees, o_ = o || {}, offer = kind === "offer";
  const loan = offer ? o_.loan_type || "" : "", govt = ["FHA", "VA", "RD"].includes(loan), co = offer ? o_.title || "other" : "other";
  const cc = offer ? (o_.cc_amt != null ? o_.cc_amt : o_.cc_pct != null ? price * o_.cc_pct / 100 : 0) : 0;
  const reductions = offer ? [["cc", "Seller-Paid Buyer Closing Costs", cc], ["conc", "Other Concessions" + (o_.conc_details ? ` (${o_.conc_details})` : ""), o_.conc || 0], ["repairs", "Lender Required Repair Allowance", o_.repairs || 0]] : [];
  const net_price = r2(price - reductions.reduce((s, x) => s + x[2], 0));
  const date = offer ? ymd(o_.closing) || ymd(S.closing) : ymd(S.closing);
  const L = [], add = (key, label, amount, opt) => { if (opt && !amount) return; L.push({ key, label, amount: r2(amount) }); };
  add("title", "Owner Policy Title Insurance", titleRate(co, price));
  const escrow = price / 1000 * F.escrow_rate + (offer ? F.escrow_base[co] ?? 150 : F.escrow_base_listing);
  add("escrow", loan === "VA" ? "Closing/Escrow Fee (100%, VA loan)" : "Closing/Escrow Fee (50%)", loan === "VA" ? escrow : escrow / 2);
  for (const t of taxLines(date, S.taxes)) L.push({ ...t, amount: r2(t.amount) });
  const commBase = offer && o_.comm_on_conc === false ? net_price : price;
  add("buyer_comm", `Buyers Agent Commission (${S.buyer_pct}%)`, commBase * S.buyer_pct / 100);
  add("list_comm", `Listing Agent Commission (${S.list_pct}%)`, commBase * S.list_pct / 100);
  add("transaction", "Transaction/Compliance Fee", S.transaction ?? F.transaction);   // an input on the sheet (Shawn, Oct 22, 2026), starting from the team default
  if (offer) add("tax_service", "Tax Service Fee", govt ? F.tax_service : 0, true);
  const loans = [S.payoff1, S.payoff2].filter(x => x > 0).length;
  add("reconveyance", loans > 1 ? `Reconveyance (${loans} loans)` : "Reconveyance", F.reconveyance * loans, true);
  add("recording", "Recording", F.recording);
  if (offer){ add("flood", "Flood Certification", govt ? F.flood : 0, true); add("reinspection", "Appraisal Reinspection", govt ? F.reinspection : 0, true); }
  add("warranty", "Home Warranty", (offer ? o_.warranty : S.warranty) || 0, true);
  add("well", "Well Tests", S.well ? F.well : 0, true);
  add("septic", "Septic Pump and Inspection", S.septic ? F.septic : 0, true);
  if (offer) add("misc", "Misc Fee" + (o_.misc_details ? ` (${o_.misc_details})` : ""), o_.misc || 0, true);
  const over = (offer ? o_.over : N_()[kind]?.over) || {};
  for (const l of L) if (over[l.key] != null){ l.std = l.amount; l.amount = over[l.key]; l.over = true; }
  const total = r2(L.reduce((s, l) => s + l.amount, 0)), proceeds = r2(net_price - total);
  const payoffs = [["payoff1", "Payoff 1", S.payoff1, S.payoff1_to], ["payoff2", "Payoff 2", S.payoff2, S.payoff2_to]].filter(p => p[2] > 0);
  const net = r2(proceeds - payoffs.reduce((s, p) => s + p[2], 0));
  return { price, reductions, net_price, lines: L, total, proceeds, payoffs, net, date, dateIsEstimate: offer && !ymd(o_.closing) };
}

// ---- the stored sheet, with defaults from the lead -------------------------------------------------
function N_(){ return cur.netsheet ||= {}; }
function nsShared(){   // what is entered, falling back to the lead and its Value card
  const s = N_().shared || {}, V = cur.numbers || {}, amt = k => V[k]?.amount;
  const d = new Date(); d.setDate(d.getDate() + 60);
  return {
    seller: s.seller ?? cur.name ?? "", address: s.address ?? cur.address ?? "", city: s.city ?? "",
    closing: s.closing ?? isoDay(d), taxes: s.taxes ?? null, buyer_pct: s.buyer_pct ?? 3, list_pct: s.list_pct ?? 3, transaction: s.transaction ?? nsFees.transaction, warranty: s.warranty ?? null,
    well: !!s.well, septic: !!s.septic, payoff1: s.payoff1 !== undefined ? s.payoff1 : amt("loan") ?? null, payoff1_to: s.payoff1_to ?? "", payoff2: s.payoff2 ?? null, payoff2_to: s.payoff2_to ?? "",
  };
}
function nsPrices(){
  const N = N_(), V = cur.numbers || {}, a = k => V[k]?.amount;
  const lo = a("rec_low") ?? a("cma_low"), hi = a("rec_high") ?? a("cma_high");
  const ap = N.appt || {}, li = N.listing || {};
  return {
    appt: { high: ap.high !== undefined ? ap.high : hi ?? null, mid: ap.mid !== undefined ? ap.mid : a("agreed") ?? (lo && hi ? Math.round((lo + hi) / 2000) * 1000 : null), low: ap.low !== undefined ? ap.low : lo ?? null },
    listing: li.price !== undefined ? li.price : a("agreed") ?? null,
  };
}
const nsMode = () => N_().mode || "appt";
function nsOffer(){ const N = N_(); N.offers ||= []; return N.offers.find(o => o.id === N.offer_id) || N.offers[N.offers.length - 1] || null; }
function nsSave(){
  clearTimeout(nsSaveT);
  const id = cur.id, data = N_();
  nsSaveT = setTimeout(() => sb.from("listing_leads").update({ netsheet: data }).eq("id", id).then(({ error }) => { if (error) alert("The net sheet didn't save: " + error.message); }), 600);
}

// ---- the page ------------------------------------------------------------------------------
// Layout (Shawn, Oct 22, 2026, "kind of messy"): one toolbar, a short bar with the few numbers that change, the
// rest folded into sections that each show a one-line summary, then the sheet at full width. On a phone the
// Listing appointment sheet shows one column at a time.
let nsOpen = new Set(), nsCol = "mid", nsBusy = "", nsResult = null;
const nsNarrow = () => matchMedia("(max-width:640px)").matches;
const nsIsDefault = (where, key) => { const N = N_(); return where === "shared" ? N.shared?.[key] === undefined : where === "appt" ? N.appt?.[key] === undefined : where === "listing" ? N.listing?.price === undefined : false; };
function renderNet(){
  nsLoadFees();
  const mode = nsMode(), N = N_(), o = mode === "offer" ? nsOffer() : null;
  let h = `<div class="nstool"><div class="pills">${NS_MODES.map(([k, n]) => `<button class="pill${mode === k ? " on" : ""}" data-nsmode="${k}">${n}</button>`).join("")}</div>
    <div class="nstoolr">${mode === "offer" ? `<button class="btn" id="nsReadBtn"${nsBusy ? " disabled" : ""}>Read a contract</button><input type="file" id="nsContract" accept="application/pdf,.pdf" hidden>` : ""}<button class="btn primary" id="nsPrint">Print or save as PDF</button></div></div>`;
  if (mode === "offer"){
    h += `<div class="nsoffers"><span class="pills">${(N.offers || []).map(x => `<button class="pill${o && x.id === o.id ? " on" : ""}" data-nsoffer="${x.id}">${esc(x.label)}</button>`).join("")}</span>
      <button class="btn small" id="nsNewOffer">${N.offers?.length ? "+ New counter by hand" : "+ Add an offer by hand"}</button>${o ? `<button class="btn link" id="nsDelOffer">Delete ${esc(o.label)}</button>` : ""}</div>`;
  }
  if (nsBusy) h += `<div class="busy" style="margin:0 0 12px"><div class="spin"></div><span>${esc(nsBusy)}</span></div>`;
  if (nsResult) h += nsResultHtml();
  if (mode === "offer" && !o){ $("#netTab").innerHTML = h + `<p class="sub" style="margin-top:6px">Tap <b>Read a contract</b> and pick the purchase agreement PDF: the AI fills in the offer and writes its summary. Or add one by hand. Each counter starts as a copy of the one before.</p>`; return; }
  h += nsWarnings(mode);
  h += `<div class="nsbar">${nsBar(mode)}</div>`;
  h += `<div class="nssecs">${nsSections(mode).map(([id, title, sum, body]) => `<details class="nssec" data-sec="${id}"${nsOpen.has(id) ? " open" : ""}><summary><b>${title}</b><span>${esc(sum)}</span></summary><div class="nssecbody"><div class="grid2">${body}</div></div></details>`).join("")}</div>`;
  h += `<div id="nsSheet" class="nssheet">${nsSheetHtml(mode, false)}</div>`;
  h += `<details class="nsfees"><summary>Team fee defaults</summary><p class="note">These apply to every net sheet for everyone on the team. To change a line on just one sheet, tap its amount on the sheet.</p><div class="grid2">${NS_FEE_LABELS.map(([k, n]) => `<div><label class="f" for="nsfee_${k}">${n}</label><input type="text" inputmode="decimal" id="nsfee_${k}" data-nsfee="${k}" value="${nsFees[k]}"></div>`).join("")}${NS_TITLES.map(([k, n]) => `<div><label class="f" for="nsfeeb_${k}">Escrow base fee, ${n}</label><input type="text" inputmode="decimal" id="nsfeeb_${k}" data-nsfeeb="${k}" value="${nsFees.escrow_base[k]}"></div>`).join("")}</div><p class="note">Title insurance rates are from ${TITLE_RATES.updated.replace(/(\d+)-(\d+)-(\d+)/, "$2/$3/$1")}.</p></details>`;
  $("#netTab").innerHTML = h;
}
function nsRefreshSheet(){ const el = $("#nsSheet"); if (el) el.innerHTML = nsSheetHtml(nsMode(), false); const w = $("#nsWarn"); if (w) w.outerHTML = nsWarnings(nsMode()); }
function nsWarnings(mode){
  const S = nsShared(), P = nsPrices(), out = [];
  if (!(S.taxes > 0)) out.push("Add the annual property taxes above to include the tax lines on the sheet.");
  if (mode === "appt"){ const { low, mid, high } = P.appt; if ((low && mid && low > mid) || (mid && high && mid > high) || (low && high && low > high)) out.push("The prices are out of order: Low should be the smallest and High the largest."); }
  return `<div id="nsWarn">${out.map(t => `<div class="warnbox" style="margin:0 0 10px">${t}</div>`).join("")}</div>`;
}

// field builders: data-ns is "where.key", where = shared | appt | listing | offer
const nsVal = (where, key) => { const S = nsShared(), P = nsPrices(), o = nsOffer() || {}; return where === "shared" ? S[key] : where === "appt" ? P.appt[key] : where === "listing" ? P.listing : o[key]; };
const nsTag = (where, key, from) => nsVal(where, key) != null && nsIsDefault(where, key) ? ` <span class="nstag">${from}</span>` : "";
function fMoney(where, key, label, from){ const v = nsVal(where, key); return `<div><label class="f" for="ns_${where}_${key}">${label}${from ? nsTag(where, key, from) : ""}</label><input type="text" inputmode="decimal" id="ns_${where}_${key}" data-ns="${where}.${key}" data-t="money" value="${v != null ? cents(v).replace("−", "-") : ""}" placeholder="$"></div>`; }
function fPct(where, key, label){ const v = nsVal(where, key); return `<div><label class="f" for="ns_${where}_${key}">${label}</label><input type="text" inputmode="decimal" id="ns_${where}_${key}" data-ns="${where}.${key}" data-t="pct" value="${v ?? ""}" placeholder="%"></div>`; }
function fText(where, key, label, ph, from){ const v = nsVal(where, key); return `<div><label class="f" for="ns_${where}_${key}">${label}${from ? nsTag(where, key, from) : ""}</label><input type="text" id="ns_${where}_${key}" data-ns="${where}.${key}" data-t="text" value="${esc(v ?? "")}" placeholder="${esc(ph || "")}"></div>`; }
function fNum(where, key, label){ const v = nsVal(where, key); return `<div><label class="f" for="ns_${where}_${key}">${label}</label><input type="text" inputmode="numeric" id="ns_${where}_${key}" data-ns="${where}.${key}" data-t="num" value="${v ?? ""}"></div>`; }
function fDate(where, key, label, type){ const v = nsVal(where, key); return `<div><label class="f" for="ns_${where}_${key}">${label}</label><input type="${type || "date"}" id="ns_${where}_${key}" data-ns="${where}.${key}" data-t="text" value="${esc(v ?? "")}"></div>`; }
function fPick(where, key, label, opts, wide){ const v = nsVal(where, key); return `<div${wide ? ` style="grid-column:1/-1"` : ""}><label class="f">${label}</label><div class="pills">${opts.map(([k, n]) => `<button class="pill${v === k ? " on" : ""}" data-nspick="${where}.${key}" data-v="${esc(JSON.stringify(k))}">${n}</button>`).join("")}</div></div>`; }
const YN = [[true, "Yes"], [false, "No"]];
const ynS = v => v === true ? "Yes" : v === false ? "No" : "";
function nsBar(mode){
  if (mode === "appt") return fMoney("appt", "low", "Low", "Value card") + fMoney("appt", "mid", "Medium", "Value card") + fMoney("appt", "high", "High", "Value card") + fDate("shared", "closing", "Estimated closing") + fMoney("shared", "taxes", "Annual property taxes");
  if (mode === "listing") return fMoney("listing", "price", "List price", "Value card") + fDate("shared", "closing", "Estimated closing") + fMoney("shared", "taxes", "Annual property taxes");
  return fMoney("offer", "price", "Purchase price") + fMoney("offer", "cc_amt", "Buyer closing costs") + fDate("offer", "closing", "Contract closing") + fMoney("shared", "taxes", "Annual property taxes") + fPick("offer", "loan_type", "Loan type", NS_LOANS.map(x => [x, x]), true) + fPick("offer", "title", "Title company", NS_TITLES, true);
}
function nsSections(mode){
  const S = nsShared(), o = nsOffer() || {}, list = a => a.filter(Boolean).join(" · ");
  const secs = [];
  if (mode === "offer"){
    secs.push(["offer", "The offer", list([o.label, o.buyer && "Buyer " + o.buyer, o.earnest && "Earnest " + cents(o.earnest), o.contingent === true && "Contingent on sale"]),
      fPick("offer", "label", "Which one", NS_LABELS.map(x => [x, x]), true) + fText("offer", "buyer", "Buyer's last name") + fText("offer", "buyer_agent", "Buyer's agent") + fMoney("offer", "earnest", "Earnest money") + fDate("offer", "deadline", "Offer deadline", "datetime-local") + fPick("offer", "contingent", "Contingent on sale of a home?", YN)]);
    secs.push(["reduce", "Price reductions", list([o.cc_amt && "Closing costs " + cents(o.cc_amt), o.cc_pct && "Closing costs " + o.cc_pct + "%", o.conc && "Concessions " + cents(o.conc), o.repairs && "Repairs " + cents(o.repairs), o.comm_on_conc === false && "Commission on net price"]) || "None",
      fPct("offer", "cc_pct", "Buyer closing costs as % of price") + fMoney("offer", "conc", "Other concessions") + fText("offer", "conc_details", "Concession details") + fMoney("offer", "repairs", "Lender required repairs") + fPick("offer", "comm_on_conc", "Commission on the full price?", YN)]);
    secs.push(["fin", "Financing", list([o.loan_type, o.loan_type !== "Cash" && o.new_loan && "Borrowing " + cents(o.new_loan), o.lender, o.commit_days != null && o.commit_days + " business days"]) || "Not set",
      o.loan_type === "Cash" ? fNum("offer", "commit_days", "Proof of funds deadline (business days)") : fMoney("offer", "new_loan", "Amount buyer is borrowing") + fText("offer", "lender", "Lender") + fText("offer", "loan_officer", "Loan officer") + fPick("offer", "applied", "Buyer applied for the loan?", YN) + fNum("offer", "commit_days", "Loan commitment deadline (business days)")]);
    secs.push(["terms", "Inspection and terms", list([o.inspect === true && "Inspection" + (o.inspect_days != null ? " " + o.inspect_days + " days" : ""), o.inspect === false && "No inspection", o.other_terms === true && "Other terms", o.dual === true && "Dual agency"]) || "Not set",
      fPick("offer", "inspect", "Will the buyer inspect?", YN) + (o.inspect === true ? fNum("offer", "inspect_days", "Days to complete inspection") : "") + fPick("offer", "other_terms", "Any other terms and conditions?", YN) + fText("offer", "inclusions", "Items specifically included") + fText("offer", "exclusions", "Items specifically excluded") + fPick("offer", "occupy", "Buyer will occupy?", YN) + fPick("offer", "assignable", "Can the contract be assigned?", YN) + fPick("offer", "licensed", "Buyers are licensed agents?", YN) + fPick("offer", "dual", "Is this dual agency?", YN) + fPick("offer", "buying_locally", "Sellers buying locally too?", YN)]);
    secs.push(["closing", "Closing and seller costs", list([o.possession, o.walkthrough != null && "Walkthrough " + o.walkthrough + " days", o.warranty && "Warranty " + cents(o.warranty), o.misc && "Misc " + cents(o.misc)]) || "Not set",
      fNum("offer", "walkthrough", "Walkthrough days before close") + fPick("offer", "possession", "Possession", [["Upon Closing", "Upon closing"], ["Before Closing", "Before closing"], ["After Closing", "After closing"]]) + (["Before Closing", "After Closing"].includes(o.possession) ? fDate("offer", "possession_date", "Possession date") : "") + fMoney("offer", "warranty", "Home warranty (seller pays)") + fMoney("offer", "misc", "Misc fees") + fText("offer", "misc_details", "Misc fee details")]);
  }
  secs.push(["seller", "Seller and property", list([S.seller, S.address, S.well && "Well", S.septic && "Septic", mode !== "offer" && S.warranty && "Warranty " + cents(S.warranty)]),
    fText("shared", "seller", "Seller name", "", "From the lead") + fText("shared", "address", "Street address", "", "From the lead") + fText("shared", "city", "City, state, zip") + (mode === "offer" ? "" : fMoney("shared", "warranty", "Home warranty")) + fPick("shared", "well", "Well on the property?", YN) + fPick("shared", "septic", "Septic tank on the property?", YN)]);
  secs.push(["fees", "Commissions and fees", `Buyer's agent ${S.buyer_pct}% · Listing ${S.list_pct}% · Transaction ${cents(S.transaction)}`,
    fPct("shared", "buyer_pct", "Buyer's agent commission %") + fPct("shared", "list_pct", "Listing agent commission %") + fMoney("shared", "transaction", "Transaction/compliance fee")]);
  secs.push(["loans", "Loans being paid off", list([S.payoff1 > 0 && cents(S.payoff1) + (S.payoff1_to ? " to " + S.payoff1_to : ""), S.payoff2 > 0 && cents(S.payoff2) + (S.payoff2_to ? " to " + S.payoff2_to : "")]) || "None",
    fMoney("shared", "payoff1", "1st lien payoff", "Value card") + fText("shared", "payoff1_to", "Paid to") + fMoney("shared", "payoff2", "2nd lien payoff") + fText("shared", "payoff2_to", "Paid to")]);
  return secs;
}
function nsResultHtml(){
  const r = nsResult;
  return `<div class="nsresult"><div class="ih"><b>${esc(r.title)}</b><button class="btn link" id="nsResultX">Close</button></div>
    ${r.error ? `<div class="err">${esc(r.error)}</div>` : `<p class="sub" style="margin:4px 0 0">Every field below came from the contract. Check them against it before you send anything.</p>`}
    ${r.unclear?.length ? `<p class="note" style="margin:8px 0 2px"><b>Hard to read, check these:</b></p><ul>${r.unclear.map(u => `<li>${esc(u.field)}: ${esc(u.why)}</li>`).join("")}</ul>` : ""}
    ${r.notes?.length ? `<p class="note" style="margin:8px 0 2px"><b>Also in the contract:</b></p><ul>${r.notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}</div>`;
}

// ---- the sheet itself (screen and print) ------------------------------------------------------------
function nsSheetHtml(mode, print){
  const S = nsShared(), P = nsPrices(), o = mode === "offer" ? nsOffer() : null;
  let cols;
  if (mode === "appt") cols = [["High", P.appt.high], ["Medium", P.appt.mid], ["Low", P.appt.low]].filter(c => c[1] > 0);
  else if (mode === "listing") cols = P.listing > 0 ? [["", P.listing]] : [];
  else cols = o?.price > 0 ? [["", o.price]] : [];
  const title = mode === "appt" ? "Seller Estimated Net Sheet" : mode === "listing" ? "Estimated Net Sheet - Original Listing" : `Offer Net Sheet: ${esc(o?.label || "")}`;
  let C = cols.map(([n, p]) => ({ name: n, ...nsColumn(mode, p, o) }));
  let picker = "";
  if (!print && mode === "appt" && C.length > 1 && nsNarrow()){
    const want = { high: "High", mid: "Medium", low: "Low" }[nsCol], pick = C.find(c => c.name === want) || C[Math.floor(C.length / 2)];
    picker = `<div class="pills" style="margin:12px 0 0">${C.map(c => `<button class="pill${c === pick ? " on" : ""}" data-nscol="${c.name}">${c.name}</button>`).join("")}</div>`;
    C = [pick];
  }
  const d0 = C[0]?.date || ymd(S.closing);
  let h = `<div class="nshead"><div><div class="nstitle">${title}</div><table class="nsinfo">
    <tr><td>Seller</td><td>${esc(S.seller)}</td></tr><tr><td>Property</td><td>${esc(S.address)}${S.city ? `<br>${esc(S.city)}` : ""}</td></tr>
    <tr><td>Closing date</td><td>${d0 ? mdy(d0) : "Enter a closing date"}${C[0]?.dateIsEstimate ? ` <span class="nsnote">(estimated; enter the contract date)</span>` : ""}</td></tr>
    ${mode === "offer" ? `<tr><td>Buyer</td><td>${esc(o.buyer || "")}</td></tr>${o.deadline ? `<tr><td>Offer deadline</td><td>${new Date(o.deadline).toLocaleString("en-US", { month: "numeric", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</td></tr>` : ""}` : ""}
    </table></div><img class="nslogo" src="ahg-logo.png" alt="Anderson Hicks Group"></div>`;
  h += picker;
  if (!C.length) return h + `<p class="sub" style="margin:16px 0">${mode === "appt" ? "Enter at least one price." : mode === "listing" ? "Enter the list price." : "Enter the purchase price."}</p>`;
  const multi = C.length > 1 || mode === "appt", cell = (v, cls) => `<td class="num${cls ? " " + cls : ""}">${v}</td>`;
  const keys = []; for (const c of C) for (const l of c.lines) if (!keys.find(k => k.key === l.key)) keys.push({ key: l.key, label: l.label });
  let t = `<table class="nstable">${multi ? `<tr><th></th>${C.map(c => `<th class="num">${c.name}</th>`).join("")}</tr>` : ""}`;
  t += `<tr class="strong"><td>Purchase Price</td>${C.map(c => cell(cents(c.price))).join("")}</tr>`;
  if (mode === "offer"){
    for (const [k, label, v] of C[0].reductions) if (v) t += `<tr><td>${esc(label)}</td>${cell(cents(-v))}</tr>`;
    t += `<tr class="strong"><td>Net Purchase Price</td>${cell(cents(C[0].net_price))}</tr>`;
  }
  t += `<tr class="sechead"><td colspan="${C.length + 1}">Seller costs and prorations</td></tr>`;
  for (const k of keys) t += `<tr><td>${esc(k.label)}</td>${C.map(c => { const l = c.lines.find(x => x.key === k.key); if (!l) return cell(""); return print ? cell(cents(l.amount)) : `<td class="num"><button class="nsamt${l.over ? " over" : ""}" data-nsover="${k.key}" title="${l.over ? "Changed on this sheet. Tap to change or reset" : "Tap to change on this sheet"}">${cents(l.amount)}</button></td>`; }).join("")}</tr>`;
  t += `<tr class="strong total"><td>Total Closing Costs</td>${C.map(c => cell(cents(c.total))).join("")}</tr>`;
  t += `<tr class="strong"><td>Proceeds Before Payoffs</td>${C.map(c => cell(cents(c.proceeds))).join("")}</tr>`;
  if (C[0].payoffs.length){ t += `<tr class="sechead"><td colspan="${C.length + 1}">Mortgages and payoffs</td></tr>`; for (const [k, label, v, to] of C[0].payoffs) t += `<tr><td>${label}${to ? ` (${esc(to)})` : ""}</td>${C.map(() => cell(cents(-v))).join("")}</tr>`; }
  t += `<tr class="net"><td>${mode === "offer" ? "Final Net Proceeds to Seller" : "Net Proceeds"}</td>${C.map(c => cell(cents(c.net))).join("")}</tr></table>`;
  h += t;
  if (mode === "offer") h += nsSummaryHtml(o, C[0]);
  h += `<p class="nsdisc">* This ${mode === "offer" ? "summary is" : "is"} prepared by Anderson Hicks Group and should serve as an estimate only. Some costs may vary slightly at closing.${mode === "offer" ? " We advise you to read through the offer thoroughly to ensure the above information is correct." : ""}</p>`;
  return h;
}
function nsSummaryHtml(o, c){
  const yn = v => v === true ? "Yes" : v === false ? "No" : "", cash = o.loan_type === "Cash", row = (k, v) => v === "" || v == null ? "" : `<tr><td>${k}</td><td>${esc(String(v))}</td></tr>`;
  const S = nsShared();
  const block = (t, rows) => rows.trim() ? `<tr class="sechead"><td colspan="2">${t}</td></tr>${rows}` : "";
  return `<div class="nstitle" style="margin-top:22px">Offer Summary: ${esc(o.label)}</div><table class="nstable nssum">
    ${block("Financial information", row("Offer price", o.price ? cents(o.price) : "") + row("Buyer closing costs requested", c.reductions[0][2] ? cents(c.reductions[0][2]) : "") + row("Other concessions", o.conc ? cents(o.conc) : "") + row("Lender required repair allowance", o.repairs ? cents(o.repairs) : "") + row("Net offer price", cents(c.net_price)))}
    ${block("Buyer information", row("Buyer name", o.buyer) + row("Buyer's agent", o.buyer_agent) + row("Buyer is a licensed agent", yn(o.licensed)) + row("Dual agency", yn(o.dual)))}
    ${block("Financing information", row("Earnest money", o.earnest ? cents(o.earnest) : "") + row("Contingent on sale of home?", yn(o.contingent)) + row("Loan type", o.loan_type) + row("Buyer applied for loan?", cash ? "NA" : yn(o.applied)) + row("Lender", cash ? "NA" : o.lender) + row("Loan officer", cash ? "NA" : o.loan_officer) + row("Amount buyer is borrowing", cash ? "NA" : o.new_loan ? cents(o.new_loan) : "") + row("Loan to value", cash ? "NA" : o.new_loan && o.price ? (o.new_loan / o.price * 100).toFixed(1) + "%" : "") + row(cash ? "Proof of funds deadline" : "Loan commitment deadline", o.commit_days != null ? o.commit_days + " business days" : ""))}
    ${block("Inspection details", row("Will the buyer do an inspection?", yn(o.inspect)) + row("Days to complete inspection", o.inspect === false ? "NA" : o.inspect_days != null ? o.inspect_days + " business days" : ""))}
    ${block("Misc information", row("Other terms and conditions", o.other_terms === false ? "NA" : o.other_terms === true ? "See Offer Page 2 section 4" : "") + row("Does buyer intend to occupy the home?", yn(o.occupy)) + row("Can the contract be assigned?", yn(o.assignable)) + row("Items specifically included", o.inclusions) + row("Items specifically excluded", o.exclusions) + row("Sellers buying locally at the same time?", o.buying_locally === true ? "Yes. Align closing date and title company if possible." : yn(o.buying_locally)))}
    ${o.contract_notes?.length ? block("Also in the contract", o.contract_notes.map(n => `<tr><td colspan="2">${esc(n)}</td></tr>`).join("")) : ""}
    ${block("Closing details", row("Walkthrough before close", o.walkthrough != null ? o.walkthrough + " calendar days" : "") + row("Title company", (NS_TITLES.find(x => x[0] === o.title) || [0, ""])[1]) + row("Possession", o.possession ? o.possession + (o.possession !== "Upon Closing" && ymd(o.possession_date) ? " - " + mdy(ymd(o.possession_date)) : "") : "") + row("Closing date", ymd(o.closing) ? mdy(ymd(o.closing)) : ""))}
  </table>`;
}

// ---- events ---------------------------------------------------------------------------------------
function nsSet(where, key, v){
  const N = N_();
  if (where === "offer"){ const o = nsOffer(); if (o) o[key] = v; }
  else if (where === "listing") (N.listing ||= {}).price = v;
  else (N[where] ||= {})[key] = v;
  nsSave();
}
$("#netTab").addEventListener("change", async e => {
  const t = e.target;
  if (t.dataset.ns){
    const [where, key] = t.dataset.ns.split("."), type = t.dataset.t; let v = t.value.trim();
    if (type === "money"){ v = parseAmt(v); if (Number.isNaN(v)){ t.setCustomValidity("Type an amount like 5000 or $5,000"); t.reportValidity(); return; } t.setCustomValidity(""); if (v != null) t.value = cents(v); }
    else if (type === "pct" || type === "num"){ v = v === "" ? null : Number(v.replace(/[%,\s]/g, "")); if (Number.isNaN(v)){ t.setCustomValidity("Type a number"); t.reportValidity(); return; } t.setCustomValidity(""); }
    if (where === "offer" && key === "cc_amt" && v != null) nsSet("offer", "cc_pct", null);
    if (where === "offer" && key === "cc_pct" && v != null) nsSet("offer", "cc_amt", null);
    nsSet(where, key, v === "" ? null : v);
    if (where === "offer" && (key === "cc_amt" || key === "cc_pct")) return renderNet();
    nsRefreshSheet();
    const sec = t.closest("[data-sec]"); if (sec){ const sm = sec.querySelector("summary span"), found = nsSections(nsMode()).find(x => x[0] === sec.dataset.sec); if (sm && found) sm.textContent = found[2]; }
  }
  if (t.dataset.nsfee || t.dataset.nsfeeb){
    const v = Number(t.value.replace(/[$,\s]/g, "")); if (Number.isNaN(v)) return;
    if (t.dataset.nsfee) nsFees[t.dataset.nsfee] = v; else nsFees.escrow_base[t.dataset.nsfeeb] = v;
    const { error } = await sb.from("listing_settings").upsert({ key: "fees", value: nsFees, updated_at: new Date().toISOString(), updated_by: session.user.id });
    if (error) alert("The team default didn't save: " + error.message);
    nsRefreshSheet();
  }
});
$("#netTab").addEventListener("toggle", e => { const d = e.target.closest?.("[data-sec]"); if (d){ if (d.open) nsOpen.add(d.dataset.sec); else nsOpen.delete(d.dataset.sec); } }, true);
$("#netTab").addEventListener("click", e => {
  const t = e.target, N = N_();
  const colb = t.closest("[data-nscol]"); if (colb){ nsCol = { High: "high", Medium: "mid", Low: "low" }[colb.dataset.nscol]; return nsRefreshSheet(); }
  if (t.id === "nsReadBtn") return $("#nsContract").click();
  if (t.id === "nsResultX"){ nsResult = null; return renderNet(); }
  const mode = t.closest("[data-nsmode]"), pick = t.closest("[data-nspick]"), off = t.closest("[data-nsoffer]"), ov = t.closest("[data-nsover]");
  if (mode){ N.mode = mode.dataset.nsmode; nsSave(); return renderNet(); }
  if (pick){ const [where, key] = pick.dataset.nspick.split("."), v = JSON.parse(pick.dataset.v); nsSet(where, key, nsVal(where, key) === v ? null : v); return renderNet(); }
  if (off){ N.offer_id = off.dataset.nsoffer; nsSave(); return renderNet(); }
  if (t.id === "nsNewOffer"){
    const prev = nsOffer(), used = (N.offers || []).map(o => o.label), label = NS_LABELS.find(l => !used.includes(l)) || "Counter";
    const o = { ...(prev ? JSON.parse(JSON.stringify(prev)) : { comm_on_conc: true, title: "other" }), id: crypto.randomUUID(), label };
    (N.offers ||= []).push(o); N.offer_id = o.id; nsSave(); return renderNet();
  }
  if (t.id === "nsDelOffer"){ const o = nsOffer(); if (o && confirm(`Delete ${o.label}?`)){ N.offers = N.offers.filter(x => x !== o); N.offer_id = N.offers[N.offers.length - 1]?.id || null; nsSave(); renderNet(); } return; }
  if (t.id === "nsPrint") return nsPrint();
  if (ov) nsOpenOver(ov.dataset.nsover);
});

// changing one line on one sheet
function nsOpenOver(key){
  const mode = nsMode(), o = mode === "offer" ? nsOffer() : null, N = N_();
  const P = nsPrices(), price = mode === "appt" ? (P.appt.mid || P.appt.high || P.appt.low) : mode === "listing" ? P.listing : o.price;
  const col = nsColumn(mode, price, o), l = col.lines.find(x => x.key === key); if (!l) return;
  nsOverKey = key;
  $("#nsOverTitle").textContent = l.label.replace(/ \(.*\)$/, "");
  $("#nsOverSub").textContent = l.over ? `Changed on this sheet. The usual amount is ${cents(l.std)}.` : "This changes the line on this sheet only. Team defaults are at the bottom of the Net sheet tab.";
  $("#nsOverAmt").value = cents(l.amount); $("#nsOverReset").hidden = !l.over; $("#nsOverErr").hidden = true;
  $("#nsOverDlg").showModal(); $("#nsOverAmt").select();
}
function nsOverStore(){ const mode = nsMode(), N = N_(); return mode === "offer" ? (nsOffer().over ||= {}) : ((N[mode] ||= {}).over ||= {}); }
$("#nsOverForm").addEventListener("submit", e => {
  e.preventDefault();
  const v = parseAmt($("#nsOverAmt").value);
  if (v == null || Number.isNaN(v)){ $("#nsOverErr").textContent = "Type an amount like 85 or $1,250.00."; $("#nsOverErr").hidden = false; return; }
  nsOverStore()[nsOverKey] = v; nsSave(); $("#nsOverDlg").close(); nsRefreshSheet();
});
$("#nsOverReset").addEventListener("click", () => { delete nsOverStore()[nsOverKey]; nsSave(); $("#nsOverDlg").close(); nsRefreshSheet(); });
$("#nsOverCancel").addEventListener("click", () => $("#nsOverDlg").close());

function nsPrint(){
  $("#printArea").innerHTML = `<div class="nssheet print">${nsSheetHtml(nsMode(), true)}</div>`;
  const img = $("#printArea img");
  const go = () => window.print();
  if (img && !img.complete){ img.onload = go; img.onerror = go; } else go();
}

// ---- read a contract ---------------------------------------------------------------------------
// The PDF goes into Files (with a note saying what it is), the listing-contract function reads it, and the terms
// become a new offer or counter. A counter is read on top of the offer on screen, so only what it changes changes.
$("#netTab").addEventListener("change", async e => {
  if (e.target.id !== "nsContract") return;
  const file = e.target.files[0]; e.target.value = ""; if (!file) return;
  const lead = cur, prev = nsOffer();
  if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)){ nsResult = { title: "That isn't a PDF", error: "Save the contract as a PDF and pick it again." }; return renderNet(); }
  nsResult = null; nsBusy = "Uploading the contract…"; renderNet();
  try {
    const path = `${session.user.id}/${lead.id}/${crypto.randomUUID()}.pdf`;
    const up = await sb.storage.from(BUCKET).upload(path, file, { contentType: "application/pdf" }); if (up.error) throw new Error("Couldn't upload it: " + up.error.message);
    let text = ""; try { text = await pdfText(await file.arrayBuffer()); } catch (_) {}
    const { data: item, error } = await sb.from("listing_items").insert({ lead_id: lead.id, kind: "file", title: file.name, note: "Purchase contract or counter, read into the Net sheet's offers.", transcript: text, files: [{ path, name: file.name, type: "application/pdf", size: file.size }] }).select().single();
    if (error) throw new Error("Couldn't save it: " + error.message);
    if (cur === lead){ items.push(item); triedPdf.add(item.id); }
    nsBusy = "Reading the contract. This takes about a minute…"; if (cur === lead && view === "net") renderNet();
    const prevTerms = prev ? Object.fromEntries(Object.entries(prev).filter(([k]) => !["id", "over", "contract_notes", "source"].includes(k))) : null;
    const d = await fn("listing-contract", { lead_id: lead.id, item_id: item.id, previous: prevTerms });
    if (cur !== lead) return;
    const r = d.offer || {}, { notes = [], unclear = [], label, ...terms } = r;
    const N = N_(), used = (N.offers || []).map(x => x.label);
    const name = label && !used.includes(label) ? label : NS_LABELS.find(l => !used.includes(l)) || "Counter";
    const o = { ...(prev ? JSON.parse(JSON.stringify(prev)) : { comm_on_conc: true, title: "other" }), ...terms, id: crypto.randomUUID(), label: name, contract_notes: notes, source: { item_id: item.id, file: file.name }, over: {} };
    if (terms.cc_amt != null) o.cc_pct = null; if (terms.cc_pct != null) o.cc_amt = null;
    (N.offers ||= []).push(o); N.offer_id = o.id; N.mode = "offer"; nsSave();
    nsResult = { title: `${name} filled in from ${file.name}`, notes, unclear };
  } catch (err){ nsResult = { title: "The contract couldn't be read", error: err.message }; }
  nsBusy = ""; if (cur === lead && view === "net") renderNet();
});
