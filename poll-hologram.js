/* ============================================================
   poll-hologram.js  —  Hologram -> Supabase bridge (scheduled pull)

   Hologram's newer dashboard replaced "Routes" with beta "Alerts",
   whose webhook does not reliably fire for embedded socket messages.
   So instead of waiting for Hologram to PUSH, this job POLLS Hologram's
   REST API for new GPS messages and inserts them into Supabase.

   Runs on a schedule via GitHub Actions (see .github/workflows/).
   Node 18+ (uses built-in fetch / Buffer) — no dependencies.

   Required GitHub Action secrets:
     HOLOGRAM_API_KEY       Hologram REST API key (Settings -> API keys)
     SUPABASE_SERVICE_KEY   Supabase service_role key (Project Settings -> API)
   Optional:
     HOLOGRAM_DEVICE_ID     restrict to a single Hologram device id
   ============================================================ */

const SUPABASE_URL = "https://pnileizziwrhwefnzicz.supabase.co";
const HOLO_KEY  = process.env.HOLOGRAM_API_KEY;
const SB_KEY    = process.env.SUPABASE_SERVICE_KEY;
const DEVICE_ID = process.env.HOLOGRAM_DEVICE_ID || "";
const ORG_ID    = process.env.HOLOGRAM_ORG_ID || "107673";   // the org that owns the device
const TOPIC     = "gps";

function need(v, name) { if (!v) { console.error("Missing env: " + name); process.exit(1); } }
need(HOLO_KEY, "HOLOGRAM_API_KEY");
need(SB_KEY, "SUPABASE_SERVICE_KEY");

const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "content-type": "application/json" };

(async () => {
  // 1) Watermark: the highest Hologram message id we've already stored.
  const wmRes = await fetch(
    `${SUPABASE_URL}/rest/v1/locations?select=source_id&source_id=not.is.null&order=source_id.desc&limit=1`,
    { headers: sb });
  const wmRows = await wmRes.json();
  const watermark = (Array.isArray(wmRows) && wmRows[0] && wmRows[0].source_id) || 0;

  // 2) Fetch recent messages from Hologram, after the watermark id.
  //    We DON'T filter by topic here (that filter proved unreliable); instead
  //    we keep only messages that decode to valid coordinates, below.
  let url = `https://dashboard.hologram.io/api/1/csr/rdm?orgid=${ORG_ID}&limit=100`;
  if (watermark) url += `&startafter=${watermark}`;
  // NOTE: deviceid filter intentionally omitted for now (one device on the account).
  const auth = "Basic " + Buffer.from("apikey:" + HOLO_KEY).toString("base64");
  const hr = await fetch(url, { headers: { Authorization: auth } });
  if (!hr.ok) { console.error("Hologram API error:", hr.status, await hr.text()); process.exit(1); }
  const hj = await hr.json();
  const msgs = (hj && hj.data) || [];
  console.log(`Hologram returned ${msgs.length} message(s) after id ${watermark}.`);
  if (msgs.length) console.log("First record keys:", Object.keys(msgs[0]).join(", "), "| tags:", JSON.stringify(msgs[0].tags));

  // 3) Parse each message: the record's `data` is a JSON string whose inner
  //    `data` field is the base64 device payload ("lat,lng,battery").
  const rows = [];
  for (const m of msgs) {
    let inner;
    try { inner = typeof m.data === "string" ? JSON.parse(m.data) : m.data; } catch { continue; }
    const b64 = inner && inner.data;
    if (!b64) continue;
    const payload = Buffer.from(b64, "base64").toString("utf8").trim();     // "lat,lng,battery"
    const p = payload.split(/[,|]/).map((s) => s.trim());
    const lat = Number(p[0]), lng = Number(p[1]);
    const battery = p.length > 2 ? Number(p[2]) : null;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
        lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    rows.push({
      source_id: m.id,
      device_id: String(m.deviceid),
      lat, lng,
      battery: Number.isFinite(battery) ? battery : null,
      recorded_at: new Date(String(m.logged).replace(" ", "T") + "Z").toISOString(),
    });
  }
  if (!rows.length) { console.log("No new valid GPS fixes."); return; }

  // 4) Resolve device -> animal (so pins attach to the right cow, if mapped).
  const devices = [...new Set(rows.map((r) => r.device_id))];
  const map = {};
  for (const d of devices) {
    const ar = await fetch(
      `${SUPABASE_URL}/rest/v1/animals?select=id&device_id=eq.${encodeURIComponent(d)}&limit=1`,
      { headers: sb });
    const aj = await ar.json();
    map[d] = (Array.isArray(aj) && aj[0]) ? aj[0].id : null;
  }
  rows.forEach((r) => (r.animal_id = map[r.device_id]));

  // 5) Insert; the unique index on source_id makes this idempotent (dupes ignored).
  const ins = await fetch(`${SUPABASE_URL}/rest/v1/locations?on_conflict=source_id`, {
    method: "POST",
    headers: { ...sb, Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!ins.ok) { console.error("Insert error:", ins.status, await ins.text()); process.exit(1); }
  console.log(`Inserted ${rows.length} fix(es). device_id(s): ${devices.join(", ")}`);
})().catch((e) => { console.error(e); process.exit(1); });
