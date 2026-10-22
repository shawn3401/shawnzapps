// AHG Tools: build and send the report emails (Daily Leadership Dashboard, Agent Hustle Board,
// Pending Tracker). Supabase Edge Function `send-reports` (project pjfiyfljkzcvfvcrdrcj), verify_jwt on.
//  * pg_cron calls it every 15 minutes with no body: it sends every active report_distributions row
//    (an email: subject, one or more reports in order, groups and addresses, schedule) that is due
//    today (Mountain time), past its send time, not sent yet today, and not an Idaho holiday when it
//    skips holidays. Test mode goes only to test_to; live goes to report_recipients(groups, addresses).
//  * An admin calls it from the "Report distribution" page with {reports, name, action: "preview"}
//    (returns the email's HTML) or {reports, name, action: "send", to: [...]} (sends now).
// Sends from reports@andersonhicks.com through the Gmail API with a Google Workspace service account
// that has domain-wide delegation for gmail.send. Secret GOOGLE_SERVICE_ACCOUNT = the key's JSON.
// reports@ is a Google Group, which can't sign in, so the service account signs in as a real user
// (secret REPORTS_SEND_USER) who has reports@ set up under "Send mail as" in Gmail, and the email
// goes out From reports@.
// The numbers come from dlr_data() and hustle_board(), the same functions the pages use.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SENDER = "reports@andersonhicks.com";
const SEND_USER = () => Deno.env.get("REPORTS_SEND_USER") || SENDER;
const SITE = "https://shawnzapps.com/ahg-tools/";
const TZ = "America/Boise";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ---------- dates in Mountain time ----------
function localNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday) + 1;
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === "24" ? "00" : p.hour}:${p.minute}`, dow };
}
const us = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split("-"); return `${+m}/${+d}/${y.slice(2)}`; };
const usLong = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const k = (n: number) => Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + "M" : Math.abs(n) >= 1000 ? Math.round(n / 1000) + "K" : String(Math.round(n));
const pct = (v: number | null) => v == null ? "NA" : Math.round(v * 100) + "%";
const monthName = (iso: string) => new Date(iso.slice(0, 10) + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });

// ---------- email (inline styles only: email programs ignore style sheets) ----------
// Each report is a section; an email stacks one or more sections in order.
function shell(title: string, sub: string, body: string, link: string) {
  return `<tr><td style="padding:18px 0 12px"><div style="font-size:22px;font-weight:bold">${esc(title)}</div><div style="color:#565b62;font-size:14px">${esc(sub)}</div></td></tr>
<tr><td>${body}</td></tr>
<tr><td style="padding:16px 0 18px;border-bottom:2px solid #dededc"><a href="${link}" style="display:inline-block;background:#c8322b;color:#fff;text-decoration:none;font-weight:bold;padding:10px 16px;border-radius:8px">Open in AHG Tools</a></td></tr>`;
}
function emailHtml(sections: string[]) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f2">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2"><tr><td align="center" style="padding:0 10px 18px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:1100px;font-family:Arial,Helvetica,sans-serif;color:#1f2124">
${sections.join("\n")}
<tr><td style="color:#8a9097;font-size:12px;padding:8px 0">Sent by AHG Tools from the Anderson Hicks Group database.</td></tr>
</table></td></tr></table></body></html>`;
}

// ---------- Daily Leadership Dashboard ----------
const TILE = [
  { key: "gci", title: "GCI", color: "#173a5e", money: true },
  { key: "closings", title: "Closings", color: "#3aa79c" },
  { key: "contracts", title: "Contracts", color: "#d4a514" },
  { key: "reps", title: "Reps signed", color: "#eb5a3c", parts: ["Buyer", "Listing"] },
  { key: "held", title: "Appts held", color: "#2a64a0", parts: ["Buyer", "Listing"] },
  { key: "set", title: "Appts set", color: "#7d1f52", parts: ["Team gen", "Agent gen"] },
];
// A bar as two table cells (filled and empty), which every email program draws.
function bar(value: number, max: number, color: string, goalMark?: number) {
  const w = Math.max(0, Math.min(100, max ? value / max * 100 : 0));
  const mark = goalMark != null && max ? Math.max(0, Math.min(100, goalMark / max * 100)) : null;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="height:12px"><tr>
    ${w > 0 ? `<td width="${w.toFixed(1)}%" style="background:${color};height:12px;font-size:0;line-height:0">&nbsp;</td>` : ""}
    ${w < 100 ? `<td style="background:#e6e6e3;height:12px;font-size:0;line-height:0">&nbsp;</td>` : ""}</tr></table>
    ${mark != null ? `<div style="font-size:11px;color:#8a9097;padding-left:${mark.toFixed(1)}%">&#9650; pace</div>` : ""}`;
}
function dlrEmail(d: any, day: string) {
  const tiles = TILE.map(t => {
    const x = d[t.key];
    const fmt = (n: number) => t.money ? k(n) : (n ?? 0).toLocaleString("en-US");
    const head = x.year_goal ? `${t.title} &middot; ${fmt(x.month_goal)} / ${fmt(x.year_goal)}` : t.title;
    const actual = (m: any) => t.money ? m.actual : t.parts ? m.a + m.b : m.a;
    const max = Math.max(1, ...x.months.map((m: any) => Math.max(m.target || 0, actual(m))));
    const months = x.months.map((m: any) => `<tr>
      <td style="padding:4px 8px 4px 0;font-size:13px;color:#565b62;white-space:nowrap">${monthName(m.month)}</td>
      <td width="100%" style="padding:4px 0">${bar(actual(m), max, t.color)}</td>
      <td style="padding:4px 0 4px 8px;font-size:13px;white-space:nowrap;text-align:right"><b>${fmt(actual(m))}</b>${t.parts ? ` <span style="color:#8a9097">(${m.a} ${t.parts[0].toLowerCase()}, ${m.b} ${t.parts[1].toLowerCase()})</span>` : ""}${m.target ? ` <span style="color:#8a9097">of ${fmt(m.target)}</span>` : ""}</td></tr>
      ${t.money && m.excluded > 0 ? `<tr><td></td><td colspan="2" style="font-size:12px;color:#8a9097;padding:0 0 4px">${k(m.excluded)} left out of projections (${m.excluded_sales} deal${m.excluded_sales === 1 ? "" : "s"})</td></tr>` : ""}`).join("");
    const y = x.year, ya = t.money ? y.actual : t.parts ? y.a + y.b : y.a, ymax = Math.max(1, y.target || 0, ya);
    const year = `<tr><td style="padding:8px 8px 0 0;font-size:13px;font-weight:bold">${day.slice(0, 4)}</td>
      <td style="padding:8px 0 0">${bar(ya, ymax, t.color, y.pace || undefined)}</td>
      <td style="padding:8px 0 0 8px;font-size:13px;white-space:nowrap;text-align:right"><b>${fmt(ya)}</b>${y.target ? ` <span style="color:#8a9097">pace ${fmt(y.pace)} &middot; goal ${fmt(y.target)}</span>` : ""}</td></tr>`;
    return `<td width="50%" valign="top" style="padding:6px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #dededc;border-radius:10px">
        <tr><td style="background:${t.color};color:#fff;font-weight:bold;font-size:15px;padding:8px 12px;border-radius:10px 10px 0 0;text-transform:uppercase">${head}</td></tr>
        <tr><td style="padding:8px 12px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${months}${year}</table></td></tr>
      </table></td>`;
  });
  const rows = [];
  for (let i = 0; i < tiles.length; i += 2) rows.push(`<tr>${tiles[i]}${tiles[i + 1] || "<td></td>"}</tr>`);
  const note = `<tr><td colspan="2" style="font-size:12px;color:#8a9097;padding:6px">Month goals are the year goal spread by the season allocation. Profit (QuickBooks) and new leads (Brivity) aren't connected yet.</td></tr>`;
  return shell("Daily Leadership Dashboard", usLong(day), `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.join("")}${note}</table>`, SITE + "#dlr");
}

// ---------- Agent Hustle Board ----------
const HB: [string, string, string, (v: any) => string, any[]?][] = [
  ["pendings", "Current Pendings", "#93c47d", v => String(v), [1, 1]],
  ["closings_year", "Closings This Year", "#3b58c4", v => String(v)],
  ["closed_volume", "YTD Closed Vol", "#3b58c4", v => "$" + (v / 1e6).toFixed(1) + " M"],
  ["closings_r90", "Closings R90", "#3b58c4", v => String(v), [3, 5]],
  ["contract_to_close", "Contract to Close YTD", "#3b58c4", pct, [0.8, 0.84]],
  ["contracts_ytd", "Contracts YTD", "#3aa3b8", v => String(v)],
  ["contracts_r90", "Contracts R90", "#3aa3b8", v => String(v), [4, 5]],
  ["contracts_month", "Contracts This Month", "#3aa3b8", v => String(v), [1, 1]],
  ["days_since_contract", "Days Since Last Contract", "#3aa3b8", v => v == null ? "NA" : String(v), [30, 15, "reverse"]],
  ["rep_to_contract", "Rep to Cont (Last 90)", "#3aa3b8", pct, [0.5, 0.85]],
  ["reps_r90", "Reps Signed R90", "#e07a3f", v => String(v), [4, 8]],
  ["reps_month", "Reps Signed This Month", "#e07a3f", v => String(v), [1, 1]],
  ["appt_to_rep", "Appt to Rep R90", "#e07a3f", pct, [0.4, 0.5]],
  ["taken_r90", "Appt Taken R90", "#f1c75b", v => String(v), [9, 17]],
  ["taken_month", "Appt Taken MTD", "#f1c75b", v => String(v), [4, 5]],
  ["take_rate", "Appt Take Rate R90", "#f1c75b", pct, [0.7, 0.79]],
  ["set_r90", "Appt Set R90", "#f1c75b", v => String(v), [13, 23]],
  ["set_month", "Appt Set MTD", "#f1c75b", v => String(v), [5, 7]],
];
function hbColor(v: any, rule?: any[]) {
  if (!rule || v == null) return "";
  const [lo, hi, mode] = rule;
  if (mode === "reverse") return v > lo ? "#b00000" : v < hi ? "#00a344" : "";
  return v < lo ? "#b00000" : v > hi ? "#00a344" : "";
}
function hustleEmail(d: any, day: string) {
  const b = d.box;
  const cell = (label: string, value: string, bg = "#fff", fg = "#1f2124") =>
    `<td align="center" style="border:1px solid #c9c9c6;background:${bg};color:${fg};padding:0"><div style="background:#6b6b6b;color:#fff;font-weight:bold;font-size:13px;padding:5px">${label}</div><div style="font-size:38px;font-weight:bold;padding:8px 14px">${value}</div></td>`;
  const box = `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:14px;background:#fff"><tr>
    <td style="font-size:24px;font-weight:bold;padding:0 16px">Contracts:</td>
    ${cell("Goal", String(b.goal ?? 0))}${cell("Goal Pace", String(b.pace))}${cell("Achieved", String(b.achieved))}
    ${cell("Gap", (b.gap > 0 ? "+" : "") + b.gap, b.gap < 0 ? "#d00000" : "#2f7a4b", "#fff")}
    <td style="padding:0 16px;font-size:16px;font-weight:bold;line-height:2">Achieved Per Day: ${b.per_day ?? 0}<br>Daily Goal: ${b.daily_goal ?? 0}</td></tr></table>`;
  const head = `<tr><th style="background:#fff"></th>${HB.map(([, t, c]) => `<th style="background:${c};color:${c === "#93c47d" || c === "#f1c75b" ? "#1f2124" : "#fff"};font-size:11px;padding:5px 3px;border:1px solid #c9c9c6;font-weight:bold">${t}</th>`).join("")}</tr>`;
  const rows = d.agents.map((a: any, i: number) => `<tr style="background:${i % 2 ? "#f3f3f1" : "#fff"}">
    <td style="font-weight:bold;padding:4px 8px;border:1px solid #d6d6d3;background:${i % 2 ? "#e4e4e1" : "#ececea"}">${esc(a.first)}</td>
    ${HB.map(([key, , , f, rule]) => { const c = hbColor(a[key], rule); return `<td align="center" style="padding:4px 5px;border:1px solid #d6d6d3;font-size:13px;white-space:nowrap;${c ? `color:${c};font-weight:bold` : ""}">${f(a[key])}</td>`; }).join("")}</tr>`).join("");
  const table = `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#fff;font-size:13px">${head}${rows}</table>`;
  return shell("Agent Hustle Board", "As of " + usLong(day), box + table +
    `<div style="font-size:12px;color:#8a9097;padding-top:8px">Green and red follow the KPI platform's thresholds. R90 is the last 90 days, MTD this month to date. Contracts leave out referrals.</div>`, SITE + "#hustle");
}

// ---------- Pending Tracker (closing team) ----------
const TR_STEPS: [string, string][] = [["em", "Earnest money"], ["lc", "Loan commitment"], ["insp", "Inspection"], ["sr", "Seller response"],
  ["br", "Buyer response"], ["appraisal", "Appraisal"], ["close_prep", "Closing scheduled"]];
function trCell(due: string | null, done: string | null, na: boolean, today: string) {
  const box = (bg: string, fg: string, t: string) => `<span style="background:${bg};color:${fg};padding:2px 6px;border-radius:4px;font-weight:bold;white-space:nowrap">${t}</span>`;
  if (na) return `<span style="color:#8a9097">NA</span>`;
  if (done) return box("#e8e8e4", "#203864", "&#10003; " + us(done));
  if (!due) return "";
  const days = Math.round((Date.parse(due) - Date.parse(today)) / 864e5);
  return days <= 0 ? box("#FFC7CE", "#9C0006", us(due)) : days <= 2 ? box("#FFEB9C", "#7A5A00", us(due)) : box("#C6EFCE", "#006100", us(due));
}
function trackerEmail(rows: any[], day: string) {
  const th = (t: string) => `<th style="background:#4a4d52;color:#fff;font-size:11px;padding:6px 4px;border:1px solid #c9c9c6">${t}</th>`;
  const head = `<tr>${["Client", "Type", "Agent", "TC", "Contract", ...TR_STEPS.map(x => x[1]), "Close"].map(th).join("")}</tr>`;
  const first = (n: string) => (n || "").split(" ")[0];
  const body = rows.map((r, i) => `<tr style="background:${i % 2 ? "#f6f6f4" : "#fff"}">
    <td style="padding:4px 6px;border:1px solid #d6d6d3;font-size:13px"><b>${esc(r.client_last_name)}</b><br><span style="color:#8a9097;font-size:12px">${esc(r.address)}</span></td>
    <td style="padding:4px 6px;border:1px solid #d6d6d3;font-size:13px">${esc(r.sale_type)}</td>
    <td style="padding:4px 6px;border:1px solid #d6d6d3;font-size:13px">${esc(first(r.agent))}</td>
    <td style="padding:4px 6px;border:1px solid #d6d6d3;font-size:13px">${esc(first(r.tc))}</td>
    <td style="padding:4px 6px;border:1px solid #d6d6d3;font-size:13px;white-space:nowrap">${r.contract_date ? us(r.contract_date) : ""}</td>
    ${TR_STEPS.map(([k]) => `<td style="padding:4px 6px;border:1px solid #d6d6d3;font-size:12px">${trCell(r[k + "_due"], r[k + "_done"], ["insp", "sr", "br"].includes(k) && !r.inspection, day)}</td>`).join("")}
    <td style="padding:4px 6px;border:1px solid #d6d6d3;font-size:12px">${trCell(r.close_date, r.closed, false, day)}</td></tr>`).join("");
  const legend = `<div style="font-size:12px;color:#565b62;padding:8px 0">Red: due today or overdue. Yellow: due within 2 days. Green: later. &#10003; done.</div>`;
  return shell("Pending Tracker", `${rows.length} pending sales, soonest closing first · ${usLong(day)}`,
    `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#fff">${head}${body}</table>${legend}`, SITE + "#tracker");
}

// ---------- Gmail API through the service account ----------
const b64 = (data: Uint8Array | string) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let s = ""; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
};
const b64url = (data: Uint8Array | string) => b64(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function gmailToken(sa: any) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({ iss: sa.client_email, sub: SEND_USER(), scope: "https://www.googleapis.com/auth/gmail.send",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${claim}`)));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${b64url(sig)}` }) });
  const d = await r.json();
  if (!d.access_token) throw new Error(`Google sign-in as ${SEND_USER()} failed: ` + (d.error_description || d.error || r.status));
  return d.access_token as string;
}
async function sendMail(to: string[], subject: string, html: string) {
  const raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT");
  if (!raw) throw new Error("Email sending isn't set up yet (secret GOOGLE_SERVICE_ACCOUNT is missing).");
  const token = await gmailToken(JSON.parse(raw));
  const encSubject = "=?UTF-8?B?" + b64(subject) + "?=";
  const mime = [`From: AHG Reports <${SENDER}>`, `To: ${to.join(", ")}`, `Subject: ${encSubject}`, "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
    b64(html).replace(/.{76}/g, "$&\r\n")].join("\r\n");
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ raw: b64url(mime) }) });
  if (!r.ok) throw new Error(`Gmail refused the email (${r.status}): ${(await r.text()).slice(0, 300)}`);
}

// ---------- building one report ----------
const REPORTS = ["dlr", "hustle", "tracker"];
async function buildEmail(db: any, reports: string[], day: string) {
  const sections = [];
  for (const r of reports) sections.push(await build(db, r, day));
  return emailHtml(sections);
}
async function build(db: any, report: string, day: string) {
  if (report === "dlr") {
    const { data, error } = await db.rpc("dlr_data", { p_today: day });
    if (error) throw new Error(error.message);
    return dlrEmail(data, day);
  }
  if (report === "hustle") {
    const { data, error } = await db.rpc("hustle_board", { p_today: day });
    if (error) throw new Error(error.message);
    return hustleEmail(data, day);
  }
  if (report === "tracker") {
    const { data, error } = await db.from("pending_tracker").select("*").order("close_date", { ascending: true, nullsFirst: false });
    if (error) throw new Error(error.message);
    return trackerEmail(data, day);
  }
  throw new Error("Unknown report " + report);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const now = localNow();
  let body: any = {};
  try { body = await req.json(); } catch { /* the cron call has no body */ }

  // An admin, from the Report distribution page: preview or send now (the form as it stands).
  if (body.action) {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: who } = await db.auth.getUser(token);
    const email = who?.user?.email?.toLowerCase();
    const { data: me } = await db.from("app_users").select("role, active").eq("email", email ?? "").maybeSingle();
    if (!me || !me.active || me.role !== "admin") return json({ error: "Only admins can do this." }, 403);
    const day = body.day || now.day;
    const reports: string[] = (body.reports || (body.report ? [body.report] : [])).filter((r: string) => REPORTS.includes(r));
    if (!reports.length) return json({ error: "Pick at least one report." }, 400);
    try {
      const html = await buildEmail(db, reports, day);
      if (body.action === "preview") return json({ html });
      const to = (body.to as string[] || []).map(s => s.trim().toLowerCase()).filter(Boolean);
      if (!to.length) return json({ error: "No recipients." }, 400);
      await sendMail(to, `${body.name || "AHG Reports"} ${us(day)}`, html);
      await db.from("report_sends").insert({ distribution_id: body.distribution_id || null, report: reports.join(","), mode: "manual", recipients: to, ok: true, detail: "sent by " + email });
      return json({ sent: to });
    } catch (e) {
      await db.from("report_sends").insert({ distribution_id: body.distribution_id || null, report: reports.join(","), mode: "manual", recipients: body.to || [], ok: false, detail: (e as Error).message });
      return json({ error: (e as Error).message }, 500);
    }
  }

  // The schedule (pg_cron every 15 minutes): send every distribution due today that hasn't gone out.
  const { data: dist } = await db.from("report_distributions").select("*").eq("active", true);
  const results: Record<string, string> = {};
  const lastDay = new Date(Date.UTC(+now.day.slice(0, 4), +now.day.slice(5, 7), 0)).getUTCDate();
  const dom = +now.day.slice(8, 10);
  const { data: hol } = await db.from("holidays").select("name").eq("day", now.day).maybeSingle();
  for (const s of dist ?? []) {
    const dueToday = s.frequency === "daily" || (s.frequency === "weekdays" && now.dow <= 5) ||
      (s.frequency === "days" && (s.days || []).includes(now.dow)) ||
      (s.frequency === "monthly" && (s.month_day === dom || (s.month_day > lastDay && dom === lastDay)));
    if (!dueToday || now.time < s.send_time.slice(0, 5) || s.last_sent_on === now.day) continue;
    if (hol && s.skip_holidays) { results[`${s.id} ${s.name}`] = "skipped, " + hol.name; continue; }
    let to: string[] = [s.test_to].filter(Boolean);
    if (s.mode === "live") {
      const { data: r, error } = await db.rpc("report_recipients", { p_audiences: s.audiences || [], p_extra: s.recipients || [] });
      if (error) { results[`${s.id} ${s.name}`] = "error: " + error.message; continue; }
      to = r || [];
    }
    const label = `${s.id} ${s.name}`;
    if (!to.length) { results[label] = "no recipients"; continue; }
    try {
      await sendMail(to, `${s.name} ${us(now.day)}${s.mode === "test" ? " (test)" : ""}`, await buildEmail(db, s.reports, now.day));
      await db.from("report_distributions").update({ last_sent_on: now.day }).eq("id", s.id);
      await db.from("report_sends").insert({ distribution_id: s.id, report: s.reports.join(","), mode: s.mode, recipients: to, ok: true });
      results[label] = "sent to " + to.join(", ");
    } catch (e) {
      // mark the day so a broken setup doesn't retry every 15 minutes; the error shows on the page
      await db.from("report_distributions").update({ last_sent_on: now.day }).eq("id", s.id);
      await db.from("report_sends").insert({ distribution_id: s.id, report: s.reports.join(","), mode: s.mode, recipients: to, ok: false, detail: (e as Error).message });
      results[label] = "error: " + (e as Error).message;
    }
  }
  console.log("send-reports", now, JSON.stringify(results));
  return json({ now, results });
});
