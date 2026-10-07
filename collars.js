/* =========================================================
   Collars — assign / reassign which cow a GPS collar is on.

   Loaded AFTER app.js (a classic script), so it shares app.js's
   globals: renderMap, ANIMALS, sb, saveUpdate, esc, toast, OFF.
   Adds a "Manage collars" button to the Map tab and a small
   picker to move a collar (device_id) from one cow to another.

   A collar <-> cow link is just animals.device_id. Reassigning
   only changes FUTURE fixes — each past location row already
   stores the animal_id it came in under, so history stays put.
   ============================================================ */
(function () {
  "use strict";

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

  /* ---- labels ---- */
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
    return [...map.values()];
  }

  /* ---- modal ---- */
  function closeCollarsModal() { const m = document.getElementById("collars-modal"); if (m) m.remove(); }

  function openCollarsManager() {
    closeCollarsModal();
    const wrap = document.createElement("div");
    wrap.id = "collars-modal";
    wrap.className = "modal-overlay";
    wrap.innerHTML =
      '<div class="modal-card" style="max-width:520px">' +
      '<h2 style="margin:0 0 4px">Collars</h2>' +
      '<p class="fab-note" style="margin:0 0 12px">Pick which cow each collar is attached to. ' +
      'Changing it moves the collar to that cow — past tracks stay with whichever cow wore it at the time.</p>' +
      '<div id="collars-list">Loading…</div>' +
      '<div class="btn-row" style="margin-top:14px"><button class="btn" id="collars-close" style="flex:1">Close</button></div>' +
      '</div>';
    document.body.appendChild(wrap);
    wrap.addEventListener("click", e => { if (e.target === wrap) closeCollarsModal(); });
    document.getElementById("collars-close").addEventListener("click", closeCollarsModal);
    renderCollarsList();
  }

  async function renderCollarsList() {
    const host = document.getElementById("collars-list");
    if (!host) return;
    const collars = await gatherCollars();
    if (!collars.length) {
      host.innerHTML = '<div class="fab-note">No collars have reported in yet. Once a collar sends its first ' +
        'location (or is assigned to a cow), it shows up here.</div>';
      return;
    }
    const sortedAnimals = ANIMALS.slice().sort(byLabel);
    const options = (selId) => ['<option value="">— not assigned —</option>']
      .concat(sortedAnimals.map(a =>
        '<option value="' + a.id + '"' + (a.id === selId ? " selected" : "") + '>' + esc(animalLabel(a)) + '</option>'))
      .join("");

    host.innerHTML = collars.map(c => {
      const owner = ANIMALS.find(a => a.device_id === c.device_id);
      const seen = c.recorded_at ? new Date(c.recorded_at).toLocaleString() : "no fixes yet";
      const batt = (c.battery != null && c.battery !== "") ? (" · 🔋 " + esc(String(c.battery))) : "";
      return '<div class="list-item" style="margin:8px 0;align-items:flex-start">' +
        '<div class="thumb">📡</div>' +
        '<div class="li-main" style="flex:1">' +
        '<div class="li-title">' + esc(c.device_id) + '</div>' +
        '<div class="li-sub">last seen ' + esc(seen) + batt + '</div>' +
        '<select data-dev="' + esc(c.device_id) + '" style="margin-top:6px;width:100%;padding:7px 8px;' +
        'border:1px solid var(--line,#ccc);border-radius:8px">' + options(owner ? owner.id : "") + '</select>' +
        '</div></div>';
    }).join("");

    host.querySelectorAll("select[data-dev]").forEach(sel =>
      sel.addEventListener("change", () => reassign(sel.dataset.dev, sel.value)));
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
      toast(target ? ("Collar moved to " + animalLabel(target) + " ✓") : "Collar unassigned ✓");
      renderCollarsList();                                               // reflect new state
    } catch (e) {
      toast("Couldn't reassign: " + (e.message || e));
      renderCollarsList();
    }
  }

  // expose for console/debugging
  window.openCollarsManager = openCollarsManager;
})();
