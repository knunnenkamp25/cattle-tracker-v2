/* ============================================================
   check-down-cows.js
   Flags collared cows that haven't moved beyond a small radius for
   longer than the configured window, opens an alert, and emails you.
   Resolves alerts automatically once a cow starts moving again.
   Runs hourly via GitHub Actions. Reuses the same Supabase + SMTP
   secrets as send-reminders.js (no new secrets needed).

   Threshold (hours) is read from the `settings` table, key
   'down_cow_hours' (set from the app). 0 or missing = disabled.
   ============================================================ */
const nodemailer = require("nodemailer");

const {
  SUPABASE_URL, SUPABASE_SERVICE_KEY, REMINDER_TO,
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, REMINDER_FROM,
} = process.env;

function need(v, n) { if (!v) { console.error("Missing env: " + n); process.exit(0); } }
need(SUPABASE_URL, "SUPABASE_URL");
need(SUPABASE_SERVICE_KEY, "SUPABASE_SERVICE_KEY");

const RADIUS_M = Number(process.env.DOWN_RADIUS_M || 30);   // GPS-noise tolerance
const HDR = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  "content-type": "application/json",
};
const sb = (path, opts = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { ...HDR, ...(opts.headers || {}) } });

function haversine(a, b) {
  const R = 6371000, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

(async () => {
  // 1) threshold hours
  let hours = 12;
  try {
    const rows = await (await sb(`settings?key=eq.down_cow_hours&select=value`)).json();
    if (Array.isArray(rows) && rows[0]) hours = Number(rows[0].value);
  } catch { /* default */ }
  if (!hours || hours <= 0) { console.log("Down-cow alerts disabled (hours <= 0)."); return; }

  // 2) collared, in-herd animals
  const animals = await (await sb(
    `animals?select=id,tag_number,name,device_id&device_id=not.is.null&sale_date=is.null&death_date=is.null`
  )).json();
  if (!Array.isArray(animals) || !animals.length) { console.log("No collared animals."); return; }

  const sinceISO = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  // 3) currently-open down alerts
  const openAlerts = await (await sb(`alerts?type=eq.down_cow&status=eq.open&select=id,animal_id`)).json();
  const openByAnimal = {};
  (Array.isArray(openAlerts) ? openAlerts : []).forEach((a) => (openByAnimal[a.animal_id] = a));

  const newlyDown = [];
  const stillDown = new Set();

  for (const a of animals) {
    const pts = (await (await sb(
      `locations?animal_id=eq.${a.id}&recorded_at=gte.${sinceISO}&select=lat,lng,recorded_at&order=recorded_at.asc&limit=2000`
    )).json()).filter((p) => p.lat != null && p.lng != null);
    if (pts.length < 2) continue;                                   // not enough data to judge
    const spanH = (new Date(pts[pts.length - 1].recorded_at) - new Date(pts[0].recorded_at)) / 3600000;
    if (spanH < hours * 0.5) continue;                              // haven't observed a full-ish window
    let maxD = 0;
    for (const p of pts) maxD = Math.max(maxD, haversine(pts[0], p));
    if (maxD > RADIUS_M) continue;                                  // it moved — fine
    stillDown.add(a.id);
    if (!openByAnimal[a.id]) newlyDown.push({ a, spanH, maxD });
  }

  // 4) resolve alerts for animals that are moving again
  for (const oa of (Array.isArray(openAlerts) ? openAlerts : [])) {
    if (!stillDown.has(oa.animal_id)) {
      await sb(`alerts?id=eq.${oa.id}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "resolved", resolved_at: new Date().toISOString() }),
      });
    }
  }

  // 5) open new alerts
  for (const nd of newlyDown) {
    await sb(`alerts`, {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        animal_id: nd.a.id, device_id: nd.a.device_id, type: "down_cow", status: "open",
        detail: `no movement for ~${Math.round(nd.spanH)}h (within ${Math.round(nd.maxD)} m)`,
      }),
    });
  }

  if (!newlyDown.length) { console.log(`Checked ${animals.length} collared animal(s); no new down alerts.`); return; }

  // 6) email
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !REMINDER_TO) {
    console.log(`${newlyDown.length} new down alert(s) but SMTP/REMINDER_TO not set — alerts stored, no email.`);
    return;
  }
  const name = (a) => a.tag_number ? `Tag ${a.tag_number}` : (a.name || "Animal");
  const li = newlyDown.map((nd) =>
    `<li><b>${name(nd.a)}</b> — no movement for ~${Math.round(nd.spanH)}h (stayed within ${Math.round(nd.maxD)} m)</li>`).join("");
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px">
    <h2 style="color:#b3261e">⚠ Possible down cow</h2>
    <p style="color:#555">${new Date().toLocaleString()} · alert threshold ${hours}h</p>
    <ul>${li}</ul>
    <p style="color:#888;font-size:12px">These animals haven't moved beyond ${RADIUS_M} m for the window shown — worth a look. — Cattle Tracker</p>
  </div>`;
  const transport = nodemailer.createTransport({
    host: SMTP_HOST, port: Number(SMTP_PORT) || 587, secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  await transport.sendMail({
    from: REMINDER_FROM || SMTP_USER, to: REMINDER_TO,
    subject: `⚠ Possible down cow — ${newlyDown.length}`, html,
  });
  console.log(`Emailed ${newlyDown.length} new down alert(s) to ${REMINDER_TO}.`);
})().catch((e) => { console.error(e); process.exit(1); });
