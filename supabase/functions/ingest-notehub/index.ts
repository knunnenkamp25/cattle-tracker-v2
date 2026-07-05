// ============================================================
//  ingest-notehub — Supabase Edge Function
//  Receives a Notehub Route POST (a Notecard event, e.g. _track.qo),
//  pulls out the GPS location + battery, maps the device to an animal,
//  and inserts a row into `locations`.
//
//  This is the collar (Blues Notecard) counterpart to the eartag's
//  Hologram poller. Notecard -> Notehub -> (this route) -> Supabase -> map.
//
//  Secrets (set in Edge Function settings):
//    INGEST_SECRET     shared secret; must match ?key= on the route URL
//    SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   auto-injected by Supabase
//
//  One-time schema add for idempotent de-dup (safe to re-run):
//    alter table public.locations add column if not exists source_uid text;
//    create unique index if not exists locations_source_uid_uidx
//      on public.locations (source_uid);
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INGEST_SECRET = Deno.env.get("INGEST_SECRET") ?? "";

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // ---- shared-secret check (?key= on the URL, or x-webhook-secret header) ----
  const url = new URL(req.url);
  const provided = url.searchParams.get("key") ?? req.headers.get("x-webhook-secret") ?? "";
  if (!INGEST_SECRET || provided !== INGEST_SECRET) return json({ error: "unauthorized" }, 401);

  // ---- parse the Notehub event ----
  let e: Record<string, any> = {};
  try { e = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const body = (e.body ?? {}) as Record<string, any>;

  // Only act on location-bearing events. Notecard tracking events are "_track.qo".
  // We still tolerate other files as long as a valid coordinate is present.
  const file = String(e.file ?? "");

  // Device id: Notehub gives best_id like "dev:86032206...". Fall back to device/sn.
  const device_id = String(e.best_id ?? e.device ?? e.sn ?? "").trim();

  // Location: prefer the GPS "where_*" fields in the body; fall back to the
  // top-level "best_*" (which may be triangulated/tower if no GPS fix yet).
  const lat = num(body.where_lat) ?? num(e.best_lat);
  const lng = num(body.where_lon) ?? num(e.best_lon);
  const loc_type = String(e.best_location_type ?? (body.where_lat != null ? "gps" : "")).trim();

  const battery = num(body.voltage);
  // Notehub 'when' is unix seconds; fall back to received or now.
  const whenSec = num(e.when) ?? num(e.received);
  const recorded_at = whenSec ? new Date(whenSec * 1000).toISOString() : new Date().toISOString();

  const source_uid = String(e.event ?? "").trim() || `${device_id}:${whenSec ?? Date.now()}`;

  if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    // Not an error — plenty of Notehub events carry no location. Ack and move on.
    return json({ ok: true, skipped: "no coordinates", file }, 202);
  }

  // ---- map device -> animal (optional; null if unmapped) ----
  let animal_id: string | null = null;
  if (device_id) {
    const { data: a } = await db.from("animals").select("id").eq("device_id", device_id).limit(1).maybeSingle();
    animal_id = a?.id ?? null;
  }

  // ---- insert; unique index on source_uid makes retries idempotent ----
  const row: Record<string, any> = {
    device_id: device_id || "unknown",
    animal_id, lat, lng, battery, recorded_at, source_uid,
  };
  // best_location_type is handy for trusting/ignoring tower-only fixes on the map.
  if (loc_type) row.accuracy = null; // (placeholder: swap for a real column if desired)

  const { error } = await db
    .from("locations")
    .upsert(row, { onConflict: "source_uid", ignoreDuplicates: true });

  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, device_id, animal_id, lat, lng, loc_type });
});
