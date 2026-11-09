// Collar telemetry summary — run by .github/workflows/collar-report.yml
// Reads recent location/battery rows from Supabase (public anon key) for each
// collar and writes telemetry/collar-report.json. A scheduled job emails it.
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.SB_URL;
const KEY = process.env.SB_KEY;

const COLLARS = {
  "2-cell": "dev:868531060199697",
  "3-cell": "dev:868531063312784",
  "4-cell": "dev:868531063304930",
};
const WINDOW_DAYS = 7;
const CUTOFF_V = 3.3;   // assumed low-battery cutoff for runtime projection
const MOVE_M = 25;      // metres: a fix farther than this counts as "moved"

const toRad = (d) => (d * Math.PI) / 180;
function haversine(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// A scoped, security-definer function returns the 3 test collars' recent rows
// (ordered oldest-first) to the public key; the raw table stays login-only.
async function fetchAll() {
  const u = new URL(BASE + "/rest/v1/rpc/collar_report");
  const r = await fetch(u, {
    method: "POST",
    headers: {
      apikey: KEY,
      Authorization: "Bearer " + KEY,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!r.ok) throw new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 200));
  return r.json();
}

function summarize(rows) {
  if (!rows.length) return { fixes: 0 };
  const batt = rows.filter((r) => r.battery != null);
  const first = batt[0];
  const last = batt[batt.length - 1];
  let drainPerDay = null;
  let projDays = null;
  if (batt.length >= 2) {
    const days = (new Date(last.recorded_at) - new Date(first.recorded_at)) / 864e5;
    if (days > 0.2) {
      drainPerDay = (first.battery - last.battery) / days; // +ve = draining
      if (drainPerDay > 0.0005) projDays = (last.battery - CUTOFF_V) / drainPerDay;
    }
  }
  let distM = 0;
  let dist24 = 0;
  const cut24 = Date.now() - 864e5;
  for (let i = 1; i < rows.length; i++) {
    const d = haversine(rows[i - 1], rows[i]);
    distM += d;
    if (new Date(rows[i].recorded_at).getTime() >= cut24) dist24 += d;
  }
  const newest = rows[rows.length - 1];
  return {
    fixes: rows.length,
    last_seen: newest.recorded_at,
    last_location: { lat: newest.lat, lng: newest.lng },
    battery_now: last ? last.battery : null,
    battery_window_start: first ? first.battery : null,
    battery_min: batt.length ? Math.min(...batt.map((r) => r.battery)) : null,
    battery_max: batt.length ? Math.max(...batt.map((r) => r.battery)) : null,
    drain_v_per_day: drainPerDay,
    projected_days_to_cutoff: projDays,
    cutoff_v: CUTOFF_V,
    distance_m_window: Math.round(distM),
    distance_m_24h: Math.round(dist24),
    moving_recently: dist24 > MOVE_M,
  };
}

const out = { generated_at: new Date().toISOString(), window_days: WINDOW_DAYS, collars: {} };
let all = null;
let fetchError = null;
try {
  all = await fetchAll();
} catch (e) {
  fetchError = String((e && e.message) || e);
}
const byDev = {};
if (all) for (const row of all) (byDev[row.device_id] ||= []).push(row);
for (const [label, dev] of Object.entries(COLLARS)) {
  if (fetchError) {
    out.collars[label] = { device_id: dev, error: fetchError };
  } else {
    out.collars[label] = { device_id: dev, ...summarize(byDev[dev] || []) };
  }
}
mkdirSync("telemetry", { recursive: true });
writeFileSync("telemetry/collar-report.json", JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
