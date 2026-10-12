(() => {
  "use strict";
  const root = document.getElementById("server-statistics");
  if (!root) return;
  const endpoint = root.dataset.endpoint;
  const interval = 5 * 60 * 1000;
  const cacheKey = "edframe.public-catalog-statistics.v1";
  const format = new Intl.NumberFormat("en-GB");
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle:"medium", timeStyle:"short" });
  const button = root.querySelector("[data-refresh]");
  const badge = root.querySelector("[data-status]");
  const notice = root.querySelector("[data-notice]");
  let snapshot = null, busy = false, timer = null, lastAttempt = 0;

  const numeric = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const count = value => numeric(value) === null ? "—" : format.format(value);
  const percent = (value, total) => numeric(value) !== null && numeric(total) !== null && total > 0 ? Math.min(100, value / total * 100) : 0;
  const set = (key, value) => root.querySelectorAll(`[data-stat="${key}"]`).forEach(node => { node.textContent = value; });
  const validDate = value => typeof value === "string" && Number.isFinite(Date.parse(value));
  const setTime = (key, value) => {
    const node = root.querySelector(`[data-time="${key}"]`);
    node.textContent = validDate(value) ? dateFormat.format(new Date(value)) : "Unknown";
    if (validDate(value)) { node.dateTime = value; node.title = new Date(value).toISOString(); }
    else { node.removeAttribute("datetime"); node.removeAttribute("title"); }
  };
  const validate = data => {
    if (!data || !validDate(data.generatedAt) || !data.counts || numeric(data.counts.markets) === null)
      throw new Error("Invalid public catalog snapshot");
    return data;
  };

  function render(data, saved = false) {
    const c = data.counts, q = data.completeness || {}, flow = data.collector24h || {};
    ["systems", "stations", "markets", "commodities", "sites", "yield_samples", "measured_sites",
     "module_offers", "outfitting_stations", "priced_module_offers", "ship_offers", "shipyard_stations",
     "catalog_ships", "state_bgs_snapshots", "state_signal_sightings"].forEach(key => set(key, count(c[key])));
    ["freshMarkets1h", "freshMarkets24h"].forEach(key => set(key, count(q[key])));
    set("siteHotspotPercent", numeric(q.siteHotspotPercent) === null ? "—" : `${q.siteHotspotPercent.toFixed(1)}%`);
    ["messages", "usedMessages", "ignoredMessages", "errors"].forEach(key => set(key, count(flow[key])));
    const used = percent(flow.usedMessages, flow.messages);
    set("usedPercent", numeric(flow.messages) === null ? "—" : `${used.toFixed(1)}%`);
    set("projectedRows", count(flow.projectedRows));
    ["used", "ignored", "errors"].forEach((name, i) => {
      const value = [flow.usedMessages, flow.ignoredMessages, flow.errors][i];
      root.querySelector(`[data-meter="${name}"]`).style.width = `${percent(value, flow.messages)}%`;
    });
    const meter = root.querySelector("[data-meter-label]");
    meter.setAttribute("aria-label", `${count(flow.usedMessages)} messages used; ${count(flow.ignoredMessages)} not projected; ${count(flow.errors)} errors`);
    setTime("snapshot", data.generatedAt);
    setTime("receipt", data.collector?.last_received_at);
    const snapshotAge = Date.now() - Date.parse(data.generatedAt);
    // Allow the bounded background refresh (120 s) plus its 30 s poll interval.
    const refreshSeconds = numeric(data.cache?.refreshSeconds) ?? 300;
    const old = snapshotAge > 15 * 60 * 1000 ||
      (data.cache?.stale === true && snapshotAge > (refreshSeconds + 150) * 1000);
    const receiving = validDate(data.collector?.last_received_at) && Date.now() - Date.parse(data.collector.last_received_at) < 3 * 60 * 1000;
    badge.dataset.state = saved || old || !receiving ? "delayed" : "current";
    badge.textContent = saved ? "Saved snapshot" : old ? "Snapshot delayed" : receiving ? "Receiving data" : "No recent relay receipt";
    notice.hidden = !(saved || old || !receiving);
    notice.textContent = saved ? "Showing a saved snapshot while checking the server. Its original date is retained."
      : old ? "The statistics snapshot is older than expected. These are last-known figures."
      : "The catalog responded, but the last relay receipt is not recent. Stored records remain available.";
    renderSchemas(Array.isArray(flow.schemas) ? flow.schemas : []);
  }

  function renderSchemas(rows) {
    const labels = { "journal/1":"Journal · systems, stations & mining", "commodity/3":"Commodity markets",
      "fssbodysignals/1":"Body & ring signals", "fsssignaldiscovered/1":"FSS signal sightings",
      "outfitting/2":"Module availability", "outfitting/3":"Priced module inventories", "shipyard/2":"Ship inventories" };
    const body = root.querySelector("[data-schemas]");
    const fragment = document.createDocumentFragment();
    rows.filter(row => row && typeof row.schema === "string").slice().sort((a,b) => (numeric(b.messages) || 0) - (numeric(a.messages) || 0)).forEach(row => {
      const tr = document.createElement("tr");
      const title = document.createElement("td");
      title.textContent = labels[row.schema] || "Other relay message type";
      const code = document.createElement("code"); code.textContent = row.schema; title.append(code); tr.append(title);
      ["messages", "usedMessages", "projectedRows", "errors"].forEach(key => {
        const cell = document.createElement("td"); cell.textContent = count(row[key]); tr.append(cell);
      });
      fragment.append(tr);
    });
    body.replaceChildren(fragment);
  }

  async function refresh() {
    if (busy || document.hidden) return;
    clearTimeout(timer); busy = true; lastAttempt = Date.now();
    button.disabled = true; root.setAttribute("aria-busy", "true");
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(endpoint, { signal:controller.signal, credentials:"omit", cache:"no-store" });
      if (!response.ok) throw new Error(`Catalog status ${response.status}`);
      const data = validate(await response.json());
      // A backward response cannot silently replace newer last-known figures.
      if (snapshot && Date.parse(data.generatedAt) < Date.parse(snapshot.generatedAt))
        throw new Error("Catalog snapshot moved backwards");
      snapshot = data; render(snapshot);
      try { localStorage.setItem(cacheKey, JSON.stringify(snapshot)); } catch (_) { /* Optional public-data cache. */ }
    } catch (_) {
      if (snapshot) render(snapshot, true);
      badge.dataset.state = "unavailable"; badge.textContent = "Check unavailable";
      notice.hidden = false;
      notice.textContent = snapshot ? "The server check failed. Showing the last successful snapshot with its original date; retry when ready."
        : "The server statistics could not be loaded. Figures remain unknown until a successful check. Try refreshing.";
    } finally {
      clearTimeout(deadline); busy = false; button.disabled = false; root.setAttribute("aria-busy", "false");
      if (!document.hidden) timer = setTimeout(refresh, interval);
    }
  }
  try { const saved = localStorage.getItem(cacheKey); if (saved) { snapshot = validate(JSON.parse(saved)); render(snapshot, true); } } catch (_) { snapshot = null; }
  button.addEventListener("click", refresh);
  document.addEventListener("visibilitychange", () => {
    clearTimeout(timer);
    if (!document.hidden && !busy) {
      if (Date.now() - lastAttempt >= interval) refresh();
      else timer = setTimeout(refresh, Math.max(0, interval - (Date.now() - lastAttempt)));
    }
  });
  refresh();
})();
