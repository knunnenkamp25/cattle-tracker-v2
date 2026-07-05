# Notehub → Supabase route (collar / Blues Notecard)

This wires the Blues Notecard collar into the **same map** the eartag uses.
Data path:

```
Notecard  →  Notehub (Blues cloud)  →  HTTP Route  →  ingest-notehub Edge Function  →  locations table  →  map
```

It replaces the eartag's Hologram-poller hop with a direct push. Nothing here
touches the eartag path — both can run at once, writing to the same `locations`
table (each row is tagged by `device_id`).

Do this in order once the hardware is on the bench and reporting to Notehub.

---

## 1. Add the de-dup column (Supabase → SQL Editor)

Notehub retries deliveries, so we de-dup on the event UUID. Safe to re-run.

```sql
alter table public.locations add column if not exists source_uid text;
create unique index if not exists locations_source_uid_uidx
  on public.locations (source_uid);
```

## 2. Deploy the Edge Function

The function lives at `supabase/functions/ingest-notehub/index.ts`.

- It reuses the **same `INGEST_SECRET`** already set for `ingest-location`
  (Edge Functions → Manage secrets). No new secret needed.
- Deploy with **Verify JWT = OFF** (Notehub can't send a Supabase JWT), exactly
  like `ingest-location`.

Its URL will be:

```
https://pnileizziwrhwefnzicz.supabase.co/functions/v1/ingest-notehub?key=<INGEST_SECRET>
```

## 3. Create the Notehub Route

In Notehub → your project → **Routes → Create Route → General HTTP/HTTPS Request**:

| Setting | Value |
|---|---|
| Route type | General HTTP/HTTPS Request |
| URL | the `ingest-notehub` URL above, **including** `?key=<INGEST_SECRET>` |
| HTTP method | POST |
| Content type | `application/json` |
| Notefiles filter | `_track.qo` (add `_geolocate.qo` if you use Wi-Fi/tower fallback) |
| Transform data | **None** — the function reads Notehub's native event JSON |

That's it. No JSONata transform required; the function pulls `where_lat`/`where_lon`
(GPS) with a fallback to Notehub's `best_lat`/`best_lon`, plus `voltage` for battery
and `when` for the timestamp.

## 4. Point a cow at the device

So pins attach to an animal instead of showing as an unassigned dot, set that
animal's `device_id` to the Notecard's device id (the `dev:...` string Notehub
shows, e.g. `dev:860322068073292`):

```sql
update public.animals
set device_id = 'dev:XXXXXXXXXXXX'
where tag_number = '<the cow''s tag>';
```

## 5. Verify

- Notehub → **Events**: confirm `_track.qo` events arriving with a location.
- Notehub → **Routes → (this route) → Log**: confirm HTTP 200 responses.
- Supabase → SQL: `select recorded_at, lat, lng, battery, device_id from locations
  where source_uid is not null order by recorded_at desc limit 5;`
- Open the map tab — the collar's pin should appear.

## Notes

- **Battery** is captured from the Notecard's `voltage` field automatically.
- **Ambient temperature** (`body.temp`/`temperature`) is available on the event if
  you later add an `ambient_temp` column — one line in the function to store it.
- **Location quality**: the function prefers real GPS (`where_*`); if only a
  tower/triangulated `best_*` is available it still stores it. `best_location_type`
  ("gps" / "triangulated" / "tower") is returned in the response if you want to
  filter tower-only fixes off the map later.
