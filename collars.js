/* ============================================================
   Collars — assign / reassign which cow a GPS collar is on,
   and give each collar a human label (e.g. "2-cell test").

   Loaded AFTER app.js (a classic script), so it shares app.js's
   globals: renderMap, ANIMALS, sb, saveUpdate, esc, toast, OFF.
   Adds a "Manage collars" button to the Map tab and a small
   picker to move a collar (device_id) from one cow to another.

   A collar <-> cow link is just animals.device_id. Reassigning
   only changes FUTURE fixes — each past location row already
   stores the animal_id it came in under, so history stays put.

   Labels are stored in the existing `settings` table under the
   key "collar_labels" as a JSON map { device_id: label }. No
   schema change needed. A label is independent of the cow the
   collar is on, so you can tag the 2-/3-/4-cell test collars and
   still assign each to any animal.
   ============================================================ */
(function () {
  "use strict";

  var COLLAR_LABELS = {}; // device_id -> label (loaded from settings)
  var droneMap = null;    // leaflet map used by the "locate for drone" view

  /* ---- hook the Map tab render to add our button ---- */
  const _origRenderMap = window.renderMap;
  if (typeof _origRenderMap === "function") {
    window.renderMap = function () {
      _origRenderMap.apply(this, arguments);
      try { addCollarsButton(); } catch (_) {}
    };
  }

  function addCollarsButton() {
    const refresh = document.getElementById("map-refresh");
    if (!refresh || document.getElementById("collars-btn")) return;
    const btn = document.createElement("button");
    btn.id = "collars-btn";
    btn.className = "btn btn-sm";
    btn.textContent = "Manage collars";
    btn.style.marginLeft = "6px";
    refresh.insertAdjacentElement("afterend", btn);
    btn.addEventListener("click", openCollarsManager);
  }

  function online() { try { return window.OFF ? OFF.isOnline() : navigator.onLine; } catch (_) { return navigator.onLine; } }

  /* ---- labels (persisted in the settings table) ---- */
  async function loadLabels() {
    if (!sb || !online()) return;
    try {
      const { data } = await sb.from("settings").select("value").eq("key", "collar_labels").maybeSingle();
      COLLAR_LABELS = (data && data.value) ? (JSON.parse(data.value) || {}) : {};
    } catch (_) { /* keep whatever we have */ }
  }
  async function saveLabel(deviceId, label) {
    label = (label || "").trim();
    if (label) COLLAR_LABELS[deviceId] = label; else delete COLLAR_LABELS[deviceId];
    if (!sb || !online()) { toast("Offline — label will need a connection to save"); return; }
    try {
      await sb.from("settings").upsert({ key: "collar_labels", value: JSON.stringify(COLLAR_LABELS), updated_at: new Date().toISOString() });
      toast(label ? ("Labeled “" + label + "” ✓") : "Label cleared");
    } catch (e) { toast("Couldn't save label: " + (e.message || e)); }
  }
  function labelFor(deviceId) { return COLLAR_LABELS[deviceId] || ""; }

  /* ---- animal labels ---- */
  function animalLabel(a) {
    const base = a.tag_number ? ("Tag " + a.tag_number) : (a.name || "No tag");
    const extra = [(a.name && a.tag_number) ? a.name : null, a.breed || null].filter(Boolean).join(" · ");
    return extra ? (base + " — " + extra) : base;
  }
  function byLabel(a, b) { return animalLabel(a).localeCompare(animalLabel(b)); }

  /* ---- gather collars: newest fix per device + any already-assigned device ---- */
  async function gatherCollars() {
    const map = new Map(); // device_id -> { device_id, recorded_at, battery }
    if (sb && online()) {
      try {
        const { data } = await sb.from("locations")
          .select("device_id,recorded_at,battery")
          .order("recorded_at", { ascending: false }).limit(3000);
        (data || []).forEach(r => {
          if (r.device_id && !map.has(r.device_id)) {
            map.set(r.device_id, { device_id: r.device_id, recorded_at: r.recorded_at, battery: r.battery });
          }
        });
      } catch (_) { /* offline / error — fall back to assigned collars below */ }
    }
    ANIMALS.forEach(a => {
      if (a.device_id && !map.has(a.device_id)) {
        map.set(a.device_id, { device_id: a.device_id, recorded_at: null, battery: null });
      }
    });
    // also surface any labeled-but-not-yet-reporting collars so you can pre-label them
    Object.keys(COLLAR_LABELS).forEach(dev => {
      if (dev && !map.has(dev)) map.set(dev, { device_id: dev, recorded_at: null, battery: null });
    });
    return [...map.values()];
  }

  /* ---- modal ---- */
  function closeCollarsModal() { const m = document.getElementById("collars-modal"); if (m) m.remove(); }

  async function openCollarsManager() {
    closeCollarsModal();
    const wrap = document.createElement("div");
    wrap.id = "collars-modal";
    wrap.className = "modal-overlay";
    wrap.innerHTML =
      '<div class="modal-card" style="max-width:560px">' +
      '<h2 style="margin:0 0 4px">Collars</h2>' +
      '<p class="fab-note" style="margin:0 0 12px">Give each collar a label (e.g. “2-cell test”) and pick which cow it’s on. ' +
      'The label stays with the collar; changing the cow moves future tracks — past tracks stay with whichever cow wore it at the time.</p>' +
      '<div style="margin:0 0 10px"><button class="btn btn-sm" id="collars-add">+ Add a collar by ID</button></div>' +
      '<div id="collars-list">Loading…</div>' +
      '<div class="btn-row" style="margin-top:14px"><button class="btn" id="collars-close" style="flex:1">Close</button></div>' +
      '</div>';
    document.body.appendChild(wrap);
    wrap.addEventListener("click", e => { if (e.target === wrap) closeCollarsModal(); });
    document.getElementById("collars-close").addEventListener("click", closeCollarsModal);
    document.getElementById("collars-add").addEventListener("click", addCollarById);
    await loadLabels();
    renderCollarsList();
  }

  /* ---- add a collar by its device id before it has reported (so you can pre-label it) ---- */
  async function addCollarById() {
    let res = null;
    if (typeof window.openForm === "function") {
      res = await window.openForm({
        title: "Add a collar",
        fields: [
          { key: "dev", label: "Device ID", placeholder: "dev:xxxxxxxxxxxxxxx", hint: "(the Notecard DeviceUID)" },
          { key: "label", label: "Label", placeholder: "e.g. 2-cell test" }
        ],
        submitText: "Add"
      });
    } else {
      const dev = window.prompt("Collar device ID (Notecard DeviceUID, e.g. dev:xxxxxxxxxxxxxxx):", "");
      if (dev) res = { dev: dev, label: window.prompt("Label (e.g. “2-cell test”):", "") || "" };
    }
    if (!res) return;
    const dev = (res.dev || "").trim();
    if (!dev) return;
    if (!COLLAR_LABELS[dev]) COLLAR_LABELS[dev] = "";   // register it so it shows in the list
    await saveLabel(dev, res.label || "");
    renderCollarsList();
  }

  async function renderCollarsList() {
    const host = document.getElementById("collars-list");
    if (!host) return;
    const collars = await gatherCollars();
    if (!collars.length) {
      host.innerHTML = '<div class="fab-note">No collars yet. Once a collar sends its first ' +
        'location it shows up here — or tap “+ Add a collar by ID” to pre-label one before it reports.</div>';
      return;
    }
    // labeled first, then by device id
    collars.sort((a, b) => {
      const la = labelFor(a.device_id), lb = labelFor(b.device_id);
      if (la && !lb) return -1;
      if (lb && !la) return 1;
      return (la || a.device_id).localeCompare(lb || b.device_id);
    });
    const sortedAnimals = ANIMALS.slice().sort(byLabel);
    const options = (selId) => ['<option value="">— not assigned —</option>']
      .concat(sortedAnimals.map(a =>
        '<option value="' + a.id + '"' + (a.id === selId ? " selected" : "") + '>' + esc(animalLabel(a)) + '</option>'))
      .join("");

    host.innerHTML = collars.map(c => {
      const owner = ANIMALS.find(a => a.device_id === c.device_id);
      const seen = c.recorded_at ? new Date(c.recorded_at).toLocaleString() : "no fixes yet";
      const batt = (c.battery != null && c.battery !== "") ? (" · 🔋 " + esc(String(c.battery))) : "";
      const lbl = labelFor(c.device_id);
      const title = lbl ? esc(lbl) : esc(c.device_id);
      const sub = (lbl ? esc(c.device_id) + " · " : "") + "last seen " + esc(seen) + batt;
      return '<div class="list-item" style="margin:8px 0;align-items:flex-start">' +
        '<div class="thumb">📡</div>' +
        '<div class="li-main" style="flex:1">' +
        '<div class="li-title">' + title + '</div>' +
        '<div class="li-sub">' + sub + '</div>' +
        '<label style="display:block;font-size:11px;color:var(--muted,#888);margin-top:6px">Label</label>' +
        '<input type="text" data-label="' + esc(c.device_id) + '" value="' + esc(lbl) + '" ' +
        'placeholder="e.g. 2-cell test" style="width:100%;padding:7px 8px;' +
        'border:1px solid var(--line,#ccc);border-radius:8px">' +
        '<label style="display:block;font-size:11px;color:var(--muted,#888);margin-top:8px">On cow</label>' +
        '<select data-dev="' + esc(c.device_id) + '" style="width:100%;padding:7px 8px;' +
        'border:1px solid var(--line,#ccc);border-radius:8px">' + options(owner ? owner.id : "") + '</select>' +
        (c.recorded_at ? '<button class="btn btn-sm" data-locate="' + esc(c.device_id) + '" style="margin-top:8px">📍 Locate for drone</button>' : '') +
        '</div></div>';
    }).join("");

    host.querySelectorAll("select[data-dev]").forEach(sel =>
      sel.addEventListener("change", () => reassign(sel.dataset.dev, sel.value)));
    host.querySelectorAll("input[data-label]").forEach(inp => {
      const commit = () => { if (inp.value !== (labelFor(inp.dataset.label))) saveLabel(inp.dataset.label, inp.value).then(renderCollarsList); };
      inp.addEventListener("change", commit);
      inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } });
    });
    host.querySelectorAll("button[data-locate]").forEach(b =>
      b.addEventListener("click", () => openDroneLocate(b.dataset.locate)));
  }

  /* ============================================================
     Locate for drone — show the cow on a SATELLITE map so you can
     match the spot on the Potensic app's satellite view and drop a
     waypoint there. The Potensic app shows no coordinates, so the
     only way across is matching ground features by eye; the drone's
     camera closes the last gap once it arrives.
     ============================================================ */
  async function fetchFixes(deviceId) {
    if (!sb || !online()) return [];
    try {
      const { data } = await sb.from("locations")
        .select("lat,lng,recorded_at,battery")
        .eq("device_id", deviceId)
        .order("recorded_at", { ascending: false }).limit(12);
      return (data || []).filter(r => r.lat != null && r.lng != null);
    } catch (_) { return []; }
  }
  function _toR(x) { return x * Math.PI / 180; }
  function haversine(aLat, aLng, bLat, bLng) {
    const R = 6371000, dLat = _toR(bLat - aLat), dLng = _toR(bLng - aLng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(_toR(aLat)) * Math.cos(_toR(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function bearingDeg(aLat, aLng, bLat, bLng) {
    const y = Math.sin(_toR(bLng - aLng)) * Math.cos(_toR(bLat));
    const x = Math.cos(_toR(aLat)) * Math.sin(_toR(bLat)) - Math.sin(_toR(aLat)) * Math.cos(_toR(bLat)) * Math.cos(_toR(bLng - aLng));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function compass(deg) { return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8]; }
  function fmtDist(m) { return m >= 1609 ? (m / 1609.34).toFixed(2) + " mi" : Math.round(m) + " m"; }
  function fixAgo(iso) {
    if (!iso) return "unknown";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 90) return "just now";
    if (s < 5400) return Math.round(s / 60) + " min ago";
    if (s < 172800) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " d ago";
  }
  function closeDroneLocate() {
    if (droneMap) { try { droneMap.remove(); } catch (_) {} droneMap = null; }
    const m = document.getElementById("drone-modal"); if (m) m.remove();
  }
  async function openDroneLocate(deviceId) {
    closeDroneLocate();
    const lbl = labelFor(deviceId) || deviceId;
    const fixes = await fetchFixes(deviceId);
    const wrap = document.createElement("div");
    wrap.id = "drone-modal";
    wrap.className = "modal-overlay";
    if (!fixes.length) {
      wrap.innerHTML = '<div class="modal-card" style="max-width:520px">' +
        '<h2 style="margin:0 0 8px">Locate for drone</h2>' +
        '<p class="fab-note">' + esc(lbl) + ' has no GPS fix on record yet, so there’s nothing to pin. Once it reports a ' +
        'location from open sky, this shows it on a satellite map you can match in the Potensic app.</p>' +
        '<div class="btn-row" style="margin-top:12px"><button class="btn" id="drone-close" style="flex:1">Close</button></div></div>';
      document.body.appendChild(wrap);
      wrap.addEventListener("click", e => { if (e.target === wrap) closeDroneLocate(); });
      document.getElementById("drone-close").addEventListener("click", closeDroneLocate);
      return;
    }
    const latest = fixes[0];
    const coord = latest.lat.toFixed(6) + ", " + latest.lng.toFixed(6);
    const mapsUrl = "https://www.google.com/maps/dir/?api=1&destination=" + latest.lat + "," + latest.lng;
    wrap.innerHTML =
      '<div class="modal-card" style="max-width:560px">' +
      '<h2 style="margin:0 0 4px">Locate for drone — ' + esc(lbl) + '</h2>' +
      '<p class="fab-note" style="margin:0 0 8px">Find this same spot on the Potensic app’s <b>satellite</b> map and drop your waypoint there. ' +
      'Get within sight before you launch — the drone’s camera finds the cow from the air.</p>' +
      '<div id="drone-map" style="height:46vh;border-radius:10px;overflow:hidden;background:#111"></div>' +
      '<div id="drone-info" class="li-sub" style="margin-top:8px;line-height:1.5"></div>' +
      '<div class="btn-row" style="margin-top:12px">' +
      '<a class="btn btn-primary" href="' + mapsUrl + '" target="_blank" rel="noopener" style="flex:1;text-align:center;text-decoration:none">Drive here (Maps)</a>' +
      '<button class="btn" id="drone-close" style="flex:1">Close</button></div>' +
      '</div>';
    document.body.appendChild(wrap);
    wrap.addEventListener("click", e => { if (e.target === wrap) closeDroneLocate(); });
    document.getElementById("drone-close").addEventListener("click", closeDroneLocate);

    const info = document.getElementById("drone-info");
    info.innerHTML = "📍 <b>" + esc(coord) + "</b><br>Fix " + fixAgo(latest.recorded_at) +
      (latest.battery != null && latest.battery !== "" ? " · 🔋 " + esc(String(latest.battery)) : "") +
      '<span id="drone-youare"></span>';

    if (window.L) {
      droneMap = L.map("drone-map", { zoomControl: true }).setView([latest.lat, latest.lng], 18);
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 19, attribution: "Imagery © Esri" }).addTo(droneMap);
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 19, opacity: 0.9 }).addTo(droneMap);
      const pts = fixes.slice().reverse().map(f => [f.lat, f.lng]);
      if (pts.length > 1) L.polyline(pts, { color: "#ffd400", weight: 2, opacity: 0.85, dashArray: "4,4" }).addTo(droneMap);
      L.circleMarker([latest.lat, latest.lng], { radius: 8, color: "#fff", weight: 2, fillColor: "#d9342b", fillOpacity: 1 })
        .addTo(droneMap).bindPopup("<b>" + esc(lbl) + "</b><br>" + esc(coord));
      setTimeout(() => droneMap && droneMap.invalidateSize(), 150);
    } else {
      document.getElementById("drone-map").innerHTML =
        '<div class="fab-note" style="padding:12px">Map didn’t load — the coordinates above and the Maps button still work.</div>';
    }

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => {
        const d = haversine(pos.coords.latitude, pos.coords.longitude, latest.lat, latest.lng);
        const b = bearingDeg(pos.coords.latitude, pos.coords.longitude, latest.lat, latest.lng);
        const el = document.getElementById("drone-youare");
        if (el) el.innerHTML = "<br>➡️ " + fmtDist(d) + " " + compass(b) + " of you";
      }, () => {}, { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 });
    }
  }

  /* ---- the actual reassignment (uses app.js's offline-safe saveUpdate) ---- */
  async function reassign(deviceId, newAnimalId) {
    try {
      const current = ANIMALS.find(a => a.device_id === deviceId);
      if (current && current.id === newAnimalId) return;                 // no change
      if (current && current.id !== newAnimalId) {                       // take it off the old cow first
        await saveUpdate(current.id, { device_id: null });
      }
      if (newAnimalId) {                                                 // put it on the chosen cow
        await saveUpdate(newAnimalId, { device_id: deviceId });
      }
      const target = newAnimalId ? ANIMALS.find(a => a.id === newAnimalId) : null;
      const who = labelFor(deviceId) || deviceId;
      toast(target ? (who + " → " + animalLabel(target) + " ✓") : (who + " unassigned ✓"));
      renderCollarsList();                                               // reflect new state
    } catch (e) {
      toast("Couldn't reassign: " + (e.message || e));
      renderCollarsList();
    }
  }

  /* ============================================================
     Wire "locate for drone" into the Map tab's alert banners.
     We override app.js's loadDownAlerts / loadFenceAlerts with
     the same render plus a per-row "locate for drone" link. Each
     alert row carries its collar's device_id, so an emergency can
     jump straight to the satellite locator.
     ============================================================ */
  function makeAlertLoader(type, bannerId, title, defDetail) {
    return async function () {
      const el = document.getElementById(bannerId);
      if (!el || !sb) return;
      try {
        const { data } = await sb.from("alerts").select("*")
          .eq("type", type).eq("status", "open").order("opened_at", { ascending: false });
        const rows = data || [];
        if (!rows.length) { el.style.display = "none"; el.innerHTML = ""; return; }
        const item = (r) => {
          const a = ANIMALS.find(x => x.id === r.animal_id);
          const dev = r.device_id || (a && a.device_id) || "";
          const nm = a ? (a.tag_number ? ("Tag " + a.tag_number) : (a.name || "Animal")) : ("Device " + (r.device_id || ""));
          const view = a ? ' <a href="#" data-open="' + a.id + '" class="alert-open" style="color:#7a1c14;text-decoration:underline">view</a>' : "";
          const loc = dev ? ' <a href="#" data-locate="' + esc(dev) + '" class="alert-locate" style="color:#7a1c14;text-decoration:underline">📍 locate for drone</a>' : "";
          return '<li>' + esc(nm) + ' — ' + esc(r.detail || defDetail) + view + loc + '</li>';
        };
        el.style.display = "block";
        el.innerHTML = '<b>' + title + ' (' + rows.length + '):</b>' +
          '<ul style="margin:4px 0 0;padding-left:18px">' + rows.map(item).join("") + '</ul>';
        el.querySelectorAll(".alert-open").forEach(x => x.addEventListener("click", ev => {
          ev.preventDefault(); if (typeof window.openProfile === "function") window.openProfile(x.dataset.open);
        }));
        el.querySelectorAll(".alert-locate").forEach(x => x.addEventListener("click", ev => {
          ev.preventDefault(); openDroneLocate(x.dataset.locate);
        }));
      } catch (e) { el.style.display = "none"; }
    };
  }
  window.loadDownAlerts = makeAlertLoader("down_cow", "down-banner", "⚠ Possibly down", "no movement");
  window.loadFenceAlerts = makeAlertLoader("geofence_escape", "fence-banner", "⚠ Outside the fence", "outside the fence");

  // expose for console/debugging
  window.openCollarsManager = openCollarsManager;
  window.openDroneLocate = openDroneLocate;
})();
