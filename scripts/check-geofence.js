/* ============================================================
   check-geofence.js
   Emails you when a collared cow's latest fix falls OUTSIDE the
   drawn pasture fence. Opens an alert, and auto-resolves it once
   the cow is back inside (so you don't get repeat emails).

   Runs hourly via GitHub Actions alongside the down-cow check.
   Reuses the same Supabase + SMTP secrets — no new secrets needed.

   Nothing to configure: the fence is whatever polygon is currently
   drawn on the map (public.geofences, active = true). If no fence is
   drawn, or no collar is assigned to a cow, it exits quietly.
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

// Ray-casting point-in-polygon. ring = [[lng,lat], ...].
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    const denom = (yj - yi) || 1e-12;
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / denom + xi)) inside = !inside;
  }
  return inside;
}
function ringFromGeoJSON(gj) {
  if (!gj) return null;
  const c = gj.geometry ? gj.geometry.coordinates : gj.coordinates;
  return (c && c[0]) ? c[0] : null;   // outer ring, [ [lng,lat], ... ]
}

(async () => {
  // 1) active fence
  const fences = await (await sb(`geofences?active=eq.true&select=geojson&order=updated_at.desc&limit=1`)).json();
  const ring = Array.isArray(fences) && fences[0] ? ringFromGeoJSON(fences[0].geojson) : null;
  if (!ring || ring.length < 3) { console.log("No active fence drawn — nothing to check."); return; }

  // 2) collared, in-herd animals
  const animals = await (await sb(
    `animals?select=id,tag_number,name,device_id&device_id=not.is.null&sale_date=is.null&death_date=is.null`
  )).json();
  if (!Array.isArray(animals) || !animals.length) { console.log("No collared animals."); return; }

  // 3) currently-open escape alerts
  const openAlerts = await (await sb(`alerts?type=eq.geofence_escape&status=eq.open&select=id,animal_id`)).json();
  const openByAnimal = {};
  (Array.isArray(openAlerts) ? openAlerts : []).forEach((a) => (openByAnimal[a.animal_id] = a));

  const newlyOut = [];
  const stillOut = new Set();

  for (const a of animals) {
    const fix = (await (await sb(
      `locations?animal_id=eq.${a.id}&lat=not.is.null&lng=not.is.null&select=lat,lng,recorded_at&order=recorded_at.desc&limit=1`
    )).json())[0];
    if (!fix) continue;                                   // no fix yet
    const outside = !pointInRing(fix.lng, fix.lat, ring);
    if (!outside) continue;
    stillOut.add(a.id);
    if (!openByAnimal[a.id]) newlyOut.push({ a, fix });
  }

  // 4) resolve alerts for cows that are back inside
  for (const oa of (Array.isArray(openAlerts) ? openAlerts : [])) {
    if (!stillOut.has(oa.animal_id)) {
      await sb(`alerts?id=eq.${oa.id}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "resolved", resolved_at: new Date().toISOString() }),
      });
    }
  }

  // 5) open new alerts
  for (const nd of newlyOut) {
    await sb(`alerts`, {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        animal_id: nd.a.id, device_id: nd.a.device_id, type: "geofence_escape", status: "open",
        detail: `outside the fence at ${nd.fix.lat.toFixed(5)}, ${nd.fix.lng.toFixed(5)}`,
      }),
    });
  }

  if (!newlyOut.length) { console.log(`Checked ${animals.length} collared animal(s); all inside the fence.`); return; }

  // 6) email
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !REMINDER_TO) {
    console.log(`${newlyOut.length} new escape(s) but SMTP/REMINDER_TO not set — alerts stored, no email.`);
    return;
  }
  const name = (a) => a.tag_number ? `Tag ${a.tag_number}` : (a.name || "Animal");
  const li = newlyOut.map((nd) => {
    const link = `https://www.google.com/maps?q=${nd.fix.lat},${nd.fix.lng}`;
    return `<li><b>${name(nd.a)}</b> — outside the fence · <a href="${link}">${nd.fix.lat.toFixed(5)}, ${nd.fix.lng.toFixed(5)}</a></li>`;
  }).join("");
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px">
    <h2 style="color:#b3261e">⚠ Cow outside the fence</h2>
    <p style="color:#555">${new Date().toLocaleString()}</p>
    <ul>${li}</ul>
    <p style="color:#888;font-size:12px">Their latest position is outside the pasture perimeter you drew on the map. — Cattle Tracker</p>
  </div>`;
  const transport = nodemailer.createTransport({
    host: SMTP_HOST, port: Number(SMTP_PORT) || 587, secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  await transport.sendMail({
    from: REMINDER_FROM || SMTP_USER, to: REMINDER_TO,
    subject: `⚠ Cow outside the fence — ${newlyOut.length}`, html,
  });
  console.log(`Emailed ${newlyOut.length} new escape alert(s) to ${REMINDER_TO}.`);
})().catch((e) => { console.error(e); process.exit(1); });
