/* ============================================================
   check-battery.js
   Emails you when a collared cow's tracker battery drops to a
   critical voltage, so a dying collar never goes dark unnoticed.
   Opens an alert and auto-resolves once the battery is recharged.

   Runs hourly via GitHub Actions alongside the down-cow + geofence
   checks. Reuses the same Supabase + SMTP secrets — no new secrets.

   Threshold (volts) is read from the `settings` table, key
   'low_batt_volts' (default 2.9). A single-cell LiPo resting near
   3.3 V is ~20%; sagging toward ~2.9 V under load means it can no
   longer power the GPS + cell burst and is about to stop reporting.
   ============================================================ */
const nodemailer = require("nodemailer");

const {
  SUPABASE_URL, SUPABASE_SERVICE_KEY, REMINDER_TO,
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, REMINDER_FROM,
} = process.env;

function need(v, n) { if (!v) { console.error("Missing env: " + n); process.exit(0); } }
need(SUPABASE_URL, "SUPABASE_URL");
need(SUPABASE_SERVICE_KEY, "SUPABASE_SERVICE_KEY");

const HDR = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  "content-type": "application/json",
};
const sb = (path, opts = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { ...HDR, ...(opts.headers || {}) } });

(async () => {
  // 1) threshold volts (+ a recovery margin so it clears after a charge)
  let low = 2.9;
  try {
    const rows = await (await sb(`settings?key=eq.low_batt_volts&select=value`)).json();
    if (Array.isArray(rows) && rows[0]) low = Number(rows[0].value);
  } catch { /* default */ }
  const recovered = low + 0.5;   // considered charged again above this

  // 2) collared, in-herd animals
  const animals = await (await sb(
    `animals?select=id,tag_number,name,device_id&device_id=not.is.null&sale_date=is.null&death_date=is.null`
  )).json();
  if (!Array.isArray(animals) || !animals.length) { console.log("No collared animals."); return; }

  // 3) currently-open low-battery alerts
  const openAlerts = await (await sb(`alerts?type=eq.low_battery&status=eq.open&select=id,animal_id`)).json();
  const openByAnimal = {};
  (Array.isArray(openAlerts) ? openAlerts : []).forEach((a) => (openByAnimal[a.animal_id] = a));

  const newlyLow = [];
  const stillLow = new Set();

  for (const a of animals) {
    const fix = (await (await sb(
      `locations?animal_id=eq.${a.id}&battery=not.is.null&select=battery,recorded_at&order=recorded_at.desc&limit=1`
    )).json())[0];
    if (!fix || fix.battery == null) continue;                 // no voltage reported yet
    const v = Number(fix.battery);
    if (v > recovered) continue;                                // healthy / recharged — no alert (and resolves below)
    if (v <= low) {
      stillLow.add(a.id);
      if (!openByAnimal[a.id]) newlyLow.push({ a, v, when: fix.recorded_at });
    }
  }

  // 4) resolve alerts for collars that have been recharged
  for (const oa of (Array.isArray(openAlerts) ? openAlerts : [])) {
    if (!stillLow.has(oa.animal_id)) {
      await sb(`alerts?id=eq.${oa.id}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "resolved", resolved_at: new Date().toISOString() }),
      });
    }
  }

  // 5) open new alerts
  for (const nd of newlyLow) {
    await sb(`alerts`, {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        animal_id: nd.a.id, device_id: nd.a.device_id, type: "low_battery", status: "open",
        detail: `battery ${nd.v.toFixed(2)} V (threshold ${low} V)`,
      }),
    });
  }

  if (!newlyLow.length) { console.log(`Checked ${animals.length} collar(s); none below ${low} V.`); return; }

  // 6) email
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !REMINDER_TO) {
    console.log(`${newlyLow.length} low battery alert(s) but SMTP/REMINDER_TO not set — stored, no email.`);
    return;
  }
  const name = (a) => a.tag_number ? `Tag ${a.tag_number}` : (a.name || "Animal");
  const li = newlyLow.map((nd) =>
    `<li><b>${name(nd.a)}</b> — battery down to <b>${nd.v.toFixed(2)} V</b> (last check-in ${new Date(nd.when).toLocaleString()})</li>`).join("");
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px">
    <h2 style="color:#b3261e">🔋 Collar battery critical</h2>
    <p style="color:#555">${new Date().toLocaleString()}</p>
    <ul>${li}</ul>
    <p style="color:#888;font-size:12px">A single-cell LiPo this low can no longer power the GPS + cell burst reliably, so the collar is about to stop reporting. Recharge or swap the pack. — Cattle Tracker</p>
  </div>`;
  const transport = nodemailer.createTransport({
    host: SMTP_HOST, port: Number(SMTP_PORT) || 587, secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  await transport.sendMail({
    from: REMINDER_FROM || SMTP_USER, to: REMINDER_TO,
    subject: `🔋 Collar battery critical — ${newlyLow.length}`, html,
  });
  console.log(`Emailed ${newlyLow.length} low-battery alert(s) to ${REMINDER_TO}.`);
})().catch((e) => { console.error(e); process.exit(1); });
