/* Turnleaf dashboard — guided, single-jar flow. Vanilla JS, no build. */

const $ = (s) => document.querySelector(s);

// ---------- custom titlebar (desktop app; no-op in a plain browser) ----------
(function setupTitlebar() {
  const win = window.__TAURI__?.window?.getCurrentWindow?.();
  if (!win) {
    // Plain browser via `cli gui` — no OS window to control; drop the controls.
    document.getElementById("win-controls")?.remove();
    return;
  }
  $("#tb-min").addEventListener("click", () => win.minimize());
  $("#tb-max").addEventListener("click", () => win.toggleMaximize());
  $("#tb-close").addEventListener("click", () => win.close());
  // Drag + double-click-to-maximize come from data-tauri-drag-region on the header.
  const controls = document.getElementById("win-controls");
  const syncMax = async () => controls.classList.toggle("maximized", await win.isMaximized());
  win.onResized?.(syncMax);
  syncMax();
})();
const esc = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const dots = (s) => String(s).replaceAll("/", ".");
const mb = (n) => (n / 1048576).toFixed(1) + " MB";
const badge = (kind, text) => `<span class="badge ${kind}">${esc(text ?? kind)}</span>`;

const selected = new Map(); // path → { path, name, size, plugin, depend, softDepend }
let library = { tests: [], uploads: [], out: [] }; // last /api/jars payload
let running = false;
let status = {}; // last /api/status payload

const allJars = () => [...library.tests, ...library.uploads, ...library.out];
const firstSelected = () => selected.values().next().value ?? null;

// ---------- status ----------
async function loadStatus() {
  const s = await (await fetch("/api/status")).json();
  status = s;
  const pills = [];
  if (s.serverMc && s.catalogMc && s.serverMc !== s.catalogMc) {
    pills.push(
      `<span class="pill off" title="The region-lock rules were mined from Folia ${esc(s.catalogMc)} but your server jar is ${esc(s.serverMc)}. Conversions still work, but newer region-locked APIs may be missed — update the app when a matching build ships.">rules from ${esc(s.catalogMc)}</span>`,
    );
  }
  $("#status-pills").innerHTML = pills.join("");
  renderStatusIcons();
  if (!$("#out-dir").value) $("#out-dir").value = s.defaultOut;
  $("#out-dir").dataset.default = s.defaultOut;
  $("#hdr-version").textContent = `v${s.version}`;
  renderSettings();
  updateButtons();
  return s;
}

// ---------- header status icons ----------
let foliaDownloading = false;

function renderStatusIcons() {
  const folia = $("#folia-status");
  if (foliaDownloading) {
    folia.className = "status-icon warn";
    folia.title = "Downloading the latest Folia server…";
  } else if (status.serverJar) {
    folia.className = "status-icon ok";
    folia.title = `Folia ${status.serverMc ?? "server"} installed — Test on Folia is ready`;
  } else {
    folia.className = "status-icon bad";
    folia.title = "No Folia server jar — Test on Folia is disabled. Click to add one.";
  }

  const ai = $("#ai-status");
  const a = status.ai ?? {};
  if (a.configured) {
    ai.className = "status-icon ok";
    ai.title = `AI ready: ${a.resolved ?? a.provider}${a.model ? ` (${a.model})` : ""} · strength ${a.strength}`;
  } else {
    ai.className = "status-icon bad";
    ai.title = "No AI key — AI Fix and AI Repair are disabled. Click to add one.";
  }
}

$("#folia-status").addEventListener("click", () => openSettings(false, "server"));
$("#ai-status").addEventListener("click", () => openSettings(false, "ai"));

// ---------- settings / first-run setup ----------
function renderSettings() {
  const server = $("#set-server-state");
  server.textContent = status.serverJar ?? "not set";
  server.className = `pill ${status.serverJar ? "on" : "off"}`;
  const ai = status.ai ?? {};
  const key = $("#set-key-state");
  key.textContent = ai.configured ? `${ai.resolved ?? ai.provider} ✔` : "not set";
  key.className = `pill ${ai.configured ? "on" : "off"}`;
  $("#set-key-clear").classList.toggle("hidden", !ai.configured);
  $("#ai-provider").value = ai.provider ?? "auto";
  $("#ai-strength").value = ai.strength ?? "standard";
  $("#ai-model-setting").value = ai.model ?? "";
  $("#ai-baseurl").value = ai.baseUrl ?? "";
  $("#ai-baseurl-row").classList.toggle("hidden", $("#ai-provider").value !== "custom");
}

$("#ai-provider").addEventListener("change", () => {
  $("#ai-baseurl-row").classList.toggle("hidden", $("#ai-provider").value !== "custom");
});

const gb = (n) => (n / 1073741824 >= 1 ? `${(n / 1073741824).toFixed(1)} GB` : `${(n / 1048576).toFixed(0)} MB`);

async function refreshStorage() {
  try {
    const st = await (await fetch("/api/storage")).json();
    $("#storage-size").textContent = `${gb(st.cleanableBytes)} cleanable`;
  } catch {
    $("#storage-size").textContent = "?";
  }
}

function openSettings(firstRun, focus) {
  $("#settings-title").textContent = firstRun ? "Quick setup" : "Settings";
  $("#settings-intro").classList.toggle("hidden", !firstRun);
  $("#settings-close").textContent = firstRun ? "Done — take me to the app" : "Done";
  renderSettings();
  refreshStorage();
  $("#settings-overlay").classList.remove("hidden");
  const modal = document.querySelector(".modal");
  if (focus === "ai") $("#ai-setting").scrollIntoView({ block: "start" });
  else modal.scrollTop = 0;
}

$("#download-folia-btn").addEventListener("click", async () => {
  const btn = $("#download-folia-btn");
  btn.disabled = true;
  btn.textContent = "Downloading (~50 MB)…";
  foliaDownloading = true;
  renderStatusIcons();
  try {
    const r = await (await fetch("/api/settings/download-folia", { method: "POST" })).json();
    if (r.error) alert(r.error);
  } finally {
    foliaDownloading = false;
    btn.disabled = false;
    btn.textContent = "Download latest Folia ↓";
    await loadStatus();
  }
});

$("#cleanup-btn").addEventListener("click", async () => {
  const btn = $("#cleanup-btn");
  btn.disabled = true;
  try {
    const r = await (await fetch("/api/cleanup", { method: "POST" })).json();
    if (r.ok) $("#storage-size").textContent = `freed ${gb(r.freedBytes)}`;
  } finally {
    btn.disabled = false;
  }
});

$("#settings-btn").addEventListener("click", () => openSettings(false));

// Closing settings (Done button OR clicking the faded backdrop) always saves
// the AI fields — nothing typed in there gets silently lost.
async function closeSettings() {
  if ($("#settings-overlay").classList.contains("hidden")) return;
  $("#settings-overlay").classList.add("hidden");
  const provider = $("#ai-provider").value;
  if (!(provider === "custom" && !$("#ai-baseurl").value.trim())) {
    await fetch("/api/settings/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
        strength: $("#ai-strength").value,
        apiKey: $("#set-key-input").value.trim(),
        keepKey: true,
        baseUrl: $("#ai-baseurl").value.trim(),
        model: $("#ai-model-setting").value.trim(),
      }),
    });
    $("#set-key-input").value = "";
  }
  await fetch("/api/settings/setup-done", { method: "POST" });
  loadStatus();
}

$("#settings-close").addEventListener("click", closeSettings);
$("#settings-overlay").addEventListener("click", (e) => {
  if (e.target === $("#settings-overlay")) closeSettings();
});

$("#set-server-btn").addEventListener("click", async () => {
  const btn = $("#set-server-btn");
  btn.disabled = true;
  btn.textContent = "Opening…";
  try {
    const r = await (await fetch("/api/settings/server-jar", { method: "POST" })).json();
    if (r.error) alert(r.error);
    else if (r.serverJar) await loadStatus();
  } finally {
    btn.disabled = false;
    btn.textContent = "Choose server jar…";
  }
});

async function saveAiSettings(clearKey) {
  const body = {
    provider: $("#ai-provider").value,
    strength: $("#ai-strength").value,
    apiKey: clearKey ? "" : $("#set-key-input").value.trim(),
    keepKey: !clearKey, // blank key field = keep the saved one
    baseUrl: $("#ai-baseurl").value.trim(),
    model: $("#ai-model-setting").value.trim(),
  };
  if (body.provider === "custom" && !body.baseUrl) return alert("A custom provider needs a base URL.");
  const r = await (
    await fetch("/api/settings/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  ).json();
  if (r.error) alert(r.error);
  $("#set-key-input").value = "";
  await loadStatus();
}

$("#set-key-save").addEventListener("click", () => saveAiSettings(false));
$("#set-key-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#set-key-save").click();
});
$("#set-key-clear").addEventListener("click", () => saveAiSettings(true));

// ---------- crash-log analyzer ----------
$("#analyze-crash").addEventListener("click", async () => {
  const logText = $("#crash-log").value;
  if (!logText.trim()) return alert("Paste a crash log into the box first.");
  const btn = $("#analyze-crash");
  btn.disabled = true;
  try {
    const r = await (
      await fetch("/api/analyze-crash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logText }),
      })
    ).json();
    $("#output").classList.remove("hidden");
    $("#out-title").textContent = "Crash analysis";
    $("#job-state").textContent = `${r.incidents?.length ?? 0} incident(s)`;
    $("#job-state").className = "pill";
    $("#console").textContent = "";
    const el = $("#results");
    if (!r.incidents || r.incidents.length === 0) {
      el.innerHTML = `<div class="kv">No plugin stack traces found in that log. (Server-internal errors and dependency notices are filtered out.)</div>`;
    } else {
      el.innerHTML = r.incidents
        .map(
          (inc, i) => `
        <div class="banner fail" style="font-size:0.95rem">${esc(inc.header.slice(0, 140))}</div>
        <div class="kv">Plugin jar: <b>${inc.jars.map(esc).join(", ") || "(unknown — no classloader prefix in the trace)"}</b></div>
        <div class="kv">Diagnosis: ${badge(inc.tag === "region-thread-violation" || inc.tag === "scheduler-api" ? "blocker" : "warning", inc.tag)} ${esc(inc.suggestion)}</div>
        <div class="kv">Plugin code involved: <span class="mono">${inc.classes.map((c) => esc(c.replaceAll("/", "."))).join(", ")}</span></div>
        <button class="link report-issue" data-i="${i}">Report this to Turnleaf ↗</button>
        <details class="log-wrap"><summary>trace excerpt</summary><pre class="console">${esc(inc.excerpt)}</pre></details>`,
        )
        .join("<hr style='border-color:var(--border);margin:18px 0'>");
      for (const btn of el.querySelectorAll(".report-issue")) {
        btn.addEventListener("click", () => reportIssue(r.incidents[Number(btn.dataset.i)]));
      }
    }
    $("#output").scrollIntoView({ behavior: "smooth", block: "start" });
  } finally {
    btn.disabled = false;
  }
});

// ---------- "what changed?" diff viewer ----------
$("#diff-btn").addEventListener("click", async () => {
  const jar = firstSelected();
  if (!jar) return;
  const info = await (await fetch(`/api/diff-info?path=${encodeURIComponent(jar.path)}`)).json();
  $("#output").classList.remove("hidden");
  $("#out-title").textContent = `What changed — ${jar.name}`;
  $("#job-state").textContent = `${info.classes?.length ?? 0} class(es) rewritten`;
  $("#job-state").className = "pill";
  $("#console").textContent = "";
  const el = $("#results");
  if (info.hint) {
    el.innerHTML = `<div class="kv">${esc(info.hint)}</div>`;
  } else if (!info.original) {
    el.innerHTML = `<div class="kv">The original jar isn't in the library anymore — upload it again to compare against.</div>`;
  } else {
    el.innerHTML = `
      <p class="say">Pick a class — both versions are decompiled and compared. <span class="mono">- red</span> is the original, <span class="mono">+ green</span> is the converted code.</p>
      <div class="deps" style="margin-bottom:14px">${info.classes
        .map((c) => `<button class="dep-chip add diff-cls" data-cls="${esc(c)}">${esc(c.split("/").pop())}</button>`)
        .join("")}</div>
      <div id="diff-view"></div>`;
    for (const btn of el.querySelectorAll(".diff-cls")) {
      btn.addEventListener("click", async () => {
        $("#diff-view").innerHTML = `<div class="kv">Decompiling both versions…</div>`;
        const r = await (
          await fetch("/api/diff", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ converted: jar.path, original: info.original, cls: btn.dataset.cls }),
          })
        ).json();
        if (r.error) {
          $("#diff-view").innerHTML = `<div class="kv">${esc(r.error)}</div>`;
          return;
        }
        const html = r.diff
          .split("\n")
          .map((line) => {
            const cls = line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del" : "diff-ctx";
            return `<span class="${cls}">${esc(line)}</span>`;
          })
          .join("\n");
        $("#diff-view").innerHTML = `<pre class="console diff">${html}</pre>`;
      });
    }
  }
  $("#output").scrollIntoView({ behavior: "smooth", block: "start" });
});

// Open a prefilled (privacy-scrubbed) GitHub issue for a crash incident.
async function reportIssue(inc) {
  const r = await (
    await fetch("/api/report-issue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(inc),
    })
  ).json();
  if (r.error) alert(r.error);
}

// ---------- live server watching ----------
let watchEs = null;

function setWatchState(on, label) {
  $("#watch-state").textContent = label;
  $("#watch-state").className = `pill ${on ? "on" : "off"}`;
  $("#watch-toggle").textContent = on ? "Stop watching" : "Start watching";
}

$("#watch-pick").addEventListener("click", async () => {
  const r = await (await fetch("/api/pick-log", { method: "POST" })).json();
  if (r.error) alert(r.error);
  else if (r.path) $("#watch-file").value = r.path;
});

$("#watch-toggle").addEventListener("click", async () => {
  if (watchEs) {
    watchEs.close();
    watchEs = null;
    await fetch("/api/watch", { method: "DELETE" });
    setWatchState(false, "not watching");
    return;
  }
  const file = $("#watch-file").value.trim();
  if (!file) return alert("Choose the server's logs\\latest.log first.");
  const r = await (
    await fetch("/api/watch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file }) })
  ).json();
  if (r.error) return alert(r.error);
  $("#watch-feed").innerHTML = `<div class="kv">Watching… errors will appear here the moment they hit the log.</div>`;
  setWatchState(true, "watching live");

  watchEs = new EventSource("/api/watch/stream");
  watchEs.addEventListener("incident", (ev) => {
    const inc = JSON.parse(ev.data);
    const feed = $("#watch-feed");
    if (feed.querySelector(".kv")) feed.innerHTML = "";
    const card = document.createElement("div");
    card.className = "watch-incident";
    card.innerHTML = `
      <div class="watch-head">${badge(inc.tag === "region-thread-violation" || inc.tag === "scheduler-api" ? "blocker" : "warning", inc.tag)}
        <b>${inc.jars.map(esc).join(", ") || "unknown plugin"}</b>
        <span class="watch-time">${new Date().toLocaleTimeString()}</span></div>
      <div class="kv">${esc(inc.header.slice(0, 140))}</div>
      <div class="kv">${esc(inc.suggestion)}</div>
      <button class="link send-repair">Send to AI Repair →</button>
      <button class="link report-btn">Report ↗</button>
      <details class="log-wrap"><summary>trace</summary><pre class="console">${esc(inc.excerpt)}</pre></details>`;
    card.querySelector(".report-btn").addEventListener("click", () => reportIssue(inc));
    card.querySelector(".send-repair").addEventListener("click", () => {
      $("#crash-log").value = inc.excerpt;
      // Pre-select the matching converted jar when it's in the library.
      const jarName = inc.jars[0];
      const match = allJars().find((j) => j.name === jarName);
      if (match) {
        selected.clear();
        selected.set(match.path, match);
        renderSelection();
      }
      document.querySelector(".more").open = true;
      $("#crash-log").scrollIntoView({ behavior: "smooth", block: "center" });
    });
    feed.prepend(card);
  });
  watchEs.addEventListener("stopped", () => {
    watchEs?.close();
    watchEs = null;
    setWatchState(false, "not watching");
  });
  watchEs.onerror = () => {
    watchEs?.close();
    watchEs = null;
    setWatchState(false, "connection lost");
  };
});

// ---------- update check ----------
async function checkUpdates(force) {
  try {
    const u = await (await fetch(`/api/update-check${force ? "?force=1" : ""}`)).json();
    $("#app-version").textContent = `Turnleaf v${u.current}`;
    if (u.hasUpdate) {
      const pill = $("#update-pill");
      pill.textContent = `v${u.latest} available ↗`;
      pill.classList.remove("hidden");
    }
    return u;
  } catch {
    return null; // offline — stay quiet
  }
}

$("#update-pill").addEventListener("click", () => fetch("/api/open-release", { method: "POST" }));

$("#check-updates").addEventListener("click", async () => {
  const btn = $("#check-updates");
  btn.textContent = "Checking…";
  const u = await checkUpdates(true);
  btn.textContent = "Check for updates";
  if (!u || u.error) alert("Could not reach GitHub to check — are you online?");
  else if (u.disabled) alert("Update checking isn't configured for this build.");
  else if (u.hasUpdate) alert(`Version ${u.latest} is available (you have ${u.current}).\nClick the blue pill in the header to open the download page.`);
  else alert(`You're up to date (v${u.current}).`);
});

// ---------- jar library (multi-select) ----------
async function loadJars() {
  library = await (await fetch("/api/jars")).json();
  const groups = [
    ["Test corpus", library.tests],
    ["Uploaded", library.uploads],
    ["Converted output", library.out],
  ];
  $("#lib-count").textContent = allJars().length;
  $("#jar-list").innerHTML = groups
    .filter(([, jars]) => jars.length)
    .map(
      ([title, jars]) =>
        `<div class="group-title">${title}</div>` +
        jars
          .map(
            (j) =>
              `<div class="jar ${selected.has(j.path) ? "selected" : ""}" data-path="${esc(j.path)}">
                 <span>${esc(j.name)}</span>
                 ${j.plugin ? "" : `<span class="badge warning">not a plugin</span>`}
                 ${j.stale ? `<span class="badge warning" title="Converted by an older version (${esc(j.convertedWith ?? "?")}) — the converter has improved since">outdated</span>` : ""}
                 <span class="size">${mb(j.size)}</span></div>`,
          )
          .join(""),
    )
    .join("");
  for (const el of document.querySelectorAll(".jar")) {
    el.addEventListener("click", () => {
      const jar = allJars().find((j) => j.path === el.dataset.path);
      if (jar) toggle(jar);
    });
  }
  renderStaleBar();
  renderSelection();
}

// ---------- stale conversions ----------
function renderStaleBar() {
  const stale = library.out.filter((j) => j.stale);
  let bar = $("#stale-bar");
  if (stale.length === 0) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "stale-bar";
    bar.className = "stale-bar";
    $("#jar-list").parentElement.prepend(bar);
  }
  bar.innerHTML = `⟳ <b>${stale.length}</b> converted jar(s) were made by an older version of this tool —
    <button id="reconvert-stale" class="link">re-convert them now</button>`;
  $("#reconvert-stale").addEventListener("click", () => {
    const sources = [...library.tests, ...library.uploads];
    const found = [];
    const missing = [];
    for (const j of stale) {
      // Pre-0.3.0 stamps had no original-name — derive it from the output name.
      const origName = j.originalName || j.name.replace(/-folia(-t3|-repaired)?\.jar$/, ".jar");
      const orig = sources.find((s) => s.name === origName);
      if (orig) found.push(orig);
      else missing.push(origName);
    }
    if (missing.length > 0) {
      alert(`Original jar(s) not found for: ${missing.join(", ")}.\nUpload them again to re-convert those.`);
    }
    if (found.length === 0) return;
    selected.clear();
    for (const jar of found) selected.set(jar.path, jar);
    renderSelection();
    run("convert");
  });
}

function toggle(jar) {
  if (selected.has(jar.path)) selected.delete(jar.path);
  else selected.set(jar.path, jar);
  renderSelection();
}

function renderSelection() {
  const n = selected.size;
  $("#chosen").classList.toggle("hidden", n === 0);
  $("#drop").classList.toggle("hidden", n > 0);
  $("#chosen-list").innerHTML = [...selected.values()]
    .map(
      (j) =>
        `<span class="chosen-item">${esc(j.name)} <span class="chosen-size">${mb(j.size)}</span>
         <button class="unpick" data-path="${esc(j.path)}" title="remove">✕</button></span>`,
    )
    .join("");
  for (const el of document.querySelectorAll(".unpick")) {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      selected.delete(el.dataset.path);
      renderSelection();
    });
  }
  for (const el of document.querySelectorAll(".jar")) {
    el.classList.toggle("selected", selected.has(el.dataset.path));
  }
  renderDeps();
  updateButtons();
}

// ---------- dependency + version awareness ----------
const verParts = (v) => String(v).split(".").map((n) => Number.parseInt(n, 10) || 0);
function verNewer(a, b) {
  const [x, y] = [verParts(a), verParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// api-version is the MINIMUM API a plugin declares, not what it "targets" —
// most plugins declare an old one on purpose and support everything newer.
// So only two version facts are worth interrupting the user for:
//   · api-version NEWER than the server → genuinely won't load
//   · no api-version at all → legacy pre-1.13 plugin, a real risk on modern MC
// Old-but-valid declarations stay quiet; the Scan report covers NMS risks.
function versionChips(jar) {
  const server = status.serverMc;
  const chips = [];
  const who = esc(jar.plugin ?? jar.name);
  if (jar.plugin && !jar.apiVersion) {
    chips.push(
      `<span class="dep-chip missing">${who} has no api-version — a legacy (pre-1.13) plugin. It likely breaks on modern Minecraft regardless of Folia; expect problems.</span>`,
    );
  } else if (jar.apiVersion && server && verNewer(jar.apiVersion, server)) {
    chips.push(
      `<span class="dep-chip missing">${who} needs Minecraft ≥ <b>${esc(jar.apiVersion)}</b> but your Folia is <b>${esc(server)}</b> — it will not load.</span>`,
    );
  }
  return chips;
}

function renderDeps() {
  const el = $("#deps");
  if (selected.size === 0) {
    el.classList.add("hidden");
    return;
  }
  const selectedNames = new Set([...selected.values()].map((j) => j.plugin).filter(Boolean));
  const chips = [];
  for (const jar of selected.values()) chips.push(...versionChips(jar));
  for (const jar of selected.values()) {
    for (const dep of jar.depend ?? []) {
      if (selectedNames.has(dep)) continue; // satisfied within the selection
      // Prefer a converted jar of the dependency; fall back to any jar of it.
      const candidates = allJars().filter((j) => j.plugin === dep);
      const candidate = candidates.find((j) => j.path.startsWith("out/")) ?? candidates[0];
      if (candidate) {
        chips.push(
          `<button class="dep-chip add" data-path="${esc(candidate.path)}" title="click to select ${esc(candidate.name)}">
             ${esc(jar.plugin ?? jar.name)} requires <b>${esc(dep)}</b> — click to add ${candidate.path.startsWith("out/") ? "(converted)" : "(NOT converted yet)"}</button>`,
        );
      } else {
        chips.push(
          `<span class="dep-chip missing">${esc(jar.plugin ?? jar.name)} requires <b>${esc(dep)}</b> — not in your library: download, convert, and install it too</span>`,
        );
      }
    }
  }
  el.innerHTML = chips.length
    ? `<div class="deps-title">Before you convert</div>${chips.join("")}`
    : "";
  el.classList.toggle("hidden", chips.length === 0);
  for (const btn of document.querySelectorAll(".dep-chip.add")) {
    btn.addEventListener("click", () => {
      const jar = allJars().find((j) => j.path === btn.dataset.path);
      if (jar) toggle(jar);
    });
  }
}

$("#clear-chosen").addEventListener("click", () => {
  selected.clear();
  renderSelection();
});

$("#select-out").addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  selected.clear();
  for (const j of library.out) {
    if (j.plugin) selected.set(j.path, j);
  }
  renderSelection();
});

const SINGLE_ONLY = new Set(["scan", "analyze", "ai", "repair"]);

function updateButtons() {
  const n = selected.size;
  for (const el of document.querySelectorAll("[data-action]")) {
    const single = SINGLE_ONLY.has(el.dataset.action);
    el.disabled = running || n === 0 || (single && n > 1);
    el.title = single && n > 1 ? "This tool works on one jar — deselect down to one" : "";
  }
  // Diff viewer: exactly one CONVERTED jar.
  const diffBtn = $("#diff-btn");
  const one = n === 1 ? firstSelected() : null;
  diffBtn.disabled = running || !one || !one.converted;
  diffBtn.title = one && !one.converted ? "Select a converted jar (from your output folder)" : "";
  // Tools with prerequisites the user can add in ⚙ Settings.
  const verify = document.querySelector('[data-action="verify"]');
  if (!verify.disabled && !status.serverJar) {
    verify.disabled = true;
    verify.title = "Add a Folia server jar in ⚙ Settings first";
  }
  for (const action of ["ai", "repair"]) {
    const el = document.querySelector(`[data-action="${action}"]`);
    if (!el.disabled && !status.deepseekKey) {
      el.disabled = true;
      el.title = "Add your AI key in ⚙ Settings first";
    }
  }
}

// ---------- upload (drop or browse) ----------
async function uploadFile(file) {
  if (!file.name.endsWith(".jar")) {
    alert("Please choose a .jar file.");
    return;
  }
  const dropText = $("#drop").querySelector(".drop-text");
  dropText.textContent = `Uploading ${file.name}…`;
  try {
    const r = await (
      await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      })
    ).json();
    if (!r.path) {
      alert(`Upload failed: ${r.error ?? "unknown error"}`);
      return;
    }
    await loadJars();
    const jar = allJars().find((j) => j.path === r.path);
    if (jar && !selected.has(jar.path)) toggle(jar);
  } catch (e) {
    alert(`Upload failed: ${e.message}`);
  } finally {
    dropText.textContent = "Drop a plugin .jar here";
  }
}

const drop = $("#drop");
drop.addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", (e) => {
  if (e.target.files[0]) uploadFile(e.target.files[0]);
  e.target.value = "";
});
["dragover", "dragenter"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add("hover");
  }),
);
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove("hover");
  }),
);
drop.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) uploadFile(file);
});

// A file dropped anywhere else in the window would otherwise make the webview
// navigate to it — swallow those so only the drop zone above acts on files.
["dragover", "drop"].forEach((ev) => window.addEventListener(ev, (e) => e.preventDefault()));

$("#reset-out").addEventListener("click", () => {
  $("#out-dir").value = $("#out-dir").dataset.default || "";
});

$("#browse-out").addEventListener("click", async () => {
  const btn = $("#browse-out");
  btn.disabled = true;
  btn.textContent = "Opening…";
  try {
    const r = await (
      await fetch("/api/pick-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: $("#out-dir").value }),
      })
    ).json();
    if (r.path) $("#out-dir").value = r.path;
    else if (r.error) alert(r.error);
  } finally {
    btn.disabled = false;
    btn.textContent = "Browse…";
  }
});

// ---------- run ----------
for (const el of document.querySelectorAll("[data-action]")) {
  el.addEventListener("click", () => run(el.dataset.action));
}

const TITLES = {
  scan: "Scanning",
  convert: "Converting to Folia",
  analyze: "Analyzing thread-safety",
  ai: "AI-fixing hard cases",
  verify: "Booting on Folia",
  repair: "AI-repairing crashes",
  migrate: "Migrating server",
};

async function run(action) {
  if (selected.size === 0) return;
  const jars = SINGLE_ONLY.has(action) ? [firstSelected().path] : [...selected.keys()];
  const body = {
    action,
    jars,
    outDir: $("#out-dir").value,
    options: {
      t2: $("#opt-t2").checked,
      logText: action === "repair" ? $("#crash-log").value : undefined,
    },
  };
  await streamJob(action, body, `${TITLES[action]} — ${jars.length === 1 ? firstSelected().name : `${jars.length} plugins`}`);
}

async function streamJob(action, body, title) {
  running = true;
  updateButtons();
  $("#output").classList.remove("hidden");
  $("#out-title").textContent = title;
  $("#job-state").textContent = "working…";
  $("#job-state").className = "pill busy";
  $("#results").innerHTML = "";
  $("#console").textContent = "";
  $("#output").scrollIntoView({ behavior: "smooth", block: "start" });

  const { id, error } = await (
    await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  ).json();
  if (error) {
    $("#console").textContent = `Error: ${error}`;
    return finish(action, -1);
  }

  const es = new EventSource(`/api/jobs/${id}/stream`);
  es.onmessage = (ev) => {
    const c = $("#console");
    c.textContent += JSON.parse(ev.data) + "\n";
    c.scrollTop = c.scrollHeight;
  };
  es.addEventListener("done", (ev) => {
    es.close();
    finish(action, JSON.parse(ev.data).code);
  });
  es.onerror = () => {
    es.close();
    finish(action, -1);
  };
}

// ---------- migrate a whole server ----------
$("#migrate-btn").addEventListener("click", async () => {
  const btn = $("#migrate-btn");
  btn.disabled = true;
  btn.textContent = "Opening…";
  try {
    const r = await (
      await fetch("/api/pick-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: "" }),
      })
    ).json();
    if (r.error) return alert(r.error);
    if (!r.path) return;
    if (
      !confirm(
        `Convert every plugin in\n${r.path}\nto Folia, in place?\n\n` +
          `• Plugins that already support Folia are left alone\n` +
          `• Originals are backed up to plugins\\pre-folia-backup\\\n` +
          `• Filenames stay the same, so configs keep working`,
      )
    )
      return;
    await streamJob("migrate", { action: "migrate", dir: r.path, options: { t2: $("#opt-t2").checked } }, `Migrating server — ${r.path}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Choose server folder…";
  }
});

function finish(action, code) {
  running = false;
  updateButtons();
  $("#job-state").textContent = code === 0 ? "done ✔" : `failed (exit ${code})`;
  $("#job-state").className = `pill ${code === 0 ? "on" : "off"}`;
  loadJars();
  renderResults(action).catch((e) => ($("#results").innerHTML = `<div class="kv">Could not render report: ${esc(e.message)}</div>`));
}

// ---------- results ----------
async function fetchReport(name) {
  const res = await fetch(`/api/reports/${encodeURIComponent(name)}`);
  return res.ok ? res.json() : null;
}
const base = () => firstSelected().name.replace(/\.jar$/, "");

async function renderResults(action) {
  const el = $("#results");
  if (action === "verify") {
    const pass = /Verdict\s+PASS/.test($("#console").textContent);
    el.innerHTML = `<div class="banner ${pass ? "pass" : "fail"}">${pass ? "Everything booted cleanly on Folia ✔" : "It did NOT boot cleanly — see the log below"}</div>`;
    return;
  }
  if (action === "convert" && selected.size > 1) {
    const failed = ($("#console").textContent.match(/✖ .* failed:/g) ?? []).length;
    el.innerHTML = `<div class="banner ${failed === 0 ? "pass" : "fail"}">
      ${failed === 0 ? `All ${selected.size} plugins converted ✔` : `${failed} of ${selected.size} conversions failed — see the log`}
      </div>
      <p class="say">Per-plugin details are in the log above. The converted jars are in your output folder — select them and hit <b>Test on Folia</b> to boot them together.</p>`;
    return;
  }
  if (action === "scan") return renderScan(el, await fetchReport(`${base()}.scan.json`));
  if (action === "convert") return renderConvert(el, await fetchReport(`${base()}.convert.json`));
  if (action === "analyze") return renderAnalysis(el, await fetchReport(`${base()}.analysis.json`));
  if (action === "ai") return renderTier3(el, await fetchReport(`${base()}.tier3.json`));
  if (action === "repair") return renderRepair(el, await fetchReport(`${base()}.repair.json`));
  if (action === "migrate") return renderMigrate(el, await fetchReport("migrate-latest.json"));
}

const MIGRATE_BADGE = {
  converted: "ok",
  reconverted: "ok",
  "already-current": "review",
  "folia-ready": "review",
  "not-a-plugin": "warning",
  failed: "blocker",
};

function renderMigrate(el, r) {
  if (!r) return void (el.innerHTML = `<div class="kv">No report found.</div>`);
  const failed = r.entries.filter((e) => e.status === "failed").length;
  const done = r.entries.filter((e) => e.status === "converted" || e.status === "reconverted").length;
  el.innerHTML = `
    <div class="banner ${failed === 0 ? "pass" : "fail"}">
      ${failed === 0 ? `Server migrated — ${done} plugin(s) converted ✔` : `${failed} plugin(s) failed — originals left in place`}
    </div>
    <div class="kv">Originals backed up to <b>${esc(r.backupDir)}</b></div>
    <table><tr><th>Plugin</th><th>Status</th><th>Detail</th></tr>
      ${r.entries
        .map(
          (e) =>
            `<tr><td class="mono">${esc(e.file)}</td><td>${badge(MIGRATE_BADGE[e.status] ?? "review", e.status)}</td><td>${esc(e.detail)}</td></tr>`,
        )
        .join("")}
    </table>
    <p class="say">Start the server on Folia and watch the log — or point <b>Watch</b> at it once it's running.</p>`;
}

function renderRepair(el, r) {
  if (!r) return void (el.innerHTML = `<div class="kv">No report found.</div>`);
  const rows = r.passes.flatMap((p, i) =>
    p.results.map(
      (t) => `<tr><td>${badge(t.status)}</td><td class="mono">${esc(t.header.slice(0, 90))}</td><td>${esc(t.notes ?? t.detail)}</td></tr>`,
    ),
  );
  const boot =
    r.finalBootOk === undefined
      ? ""
      : `<div class="kv">Verification boot: ${r.finalBootOk ? "PASS ✔" : "still failing — check the log above"}</div>`;
  el.innerHTML = `
    ${r.repairedJar
      ? `<div class="banner pass">Repairs landed · ${dl(r.repairedJar, "download the repaired jar")}</div>`
      : `<div class="banner fail">No repairs landed — the jar is unchanged.</div>`}
    ${boot}
    <table><tr><th>Result</th><th>Crash</th><th>What the AI did</th></tr>${rows.join("")}</table>`;
}

function dl(absPath, label) {
  return `<a class="dl" href="/api/download?path=${encodeURIComponent(absPath)}">${esc(label)} ↓</a>`;
}

function renderScan(el, r) {
  if (!r) return void (el.innerHTML = `<div class="kv">No report found.</div>`);
  const sev = { blocker: 0, warning: 0, review: 0 };
  for (const f of r.findings) sev[f.severity]++;
  el.innerHTML = `
    <div class="kv">Plugin <b>${esc(r.plugin?.name ?? "?")} ${esc(r.plugin?.version ?? "")}</b> — scanned ${r.classCount} classes.</div>
    <div class="kv" style="margin:12px 0">${badge("blocker", `${sev.blocker} must-fix`)} ${badge("warning", `${sev.warning} warnings`)} ${badge("review", `${sev.review} review`)}</div>
    <p class="say">${sev.blocker > 0 ? `This plugin uses ${sev.blocker} things that break on Folia. Click <b>Convert to Folia</b> to fix them.` : "Nothing must-fix was found by the current rules."}</p>
    <h3>Examples</h3>
    <table><tr><th>In class</th><th>Uses</th><th></th></tr>
      ${r.findings.slice(0, 20).map((f) => `<tr><td class="mono">${esc(dots(f.className))}</td><td class="mono">${esc(f.invocation.name)}</td><td>${badge(f.severity)}</td></tr>`).join("")}
    </table>`;
}

function renderConvert(el, r) {
  if (!r) return void (el.innerHTML = `<div class="kv">No report found.</div>`);
  const after = r.postScan.findings.filter((f) => f.severity === "blocker").length;
  const rewrites = Object.values(r.result.rewrites).reduce((a, b) => a + b, 0);
  const fixes = r.result.concurrencyFixes.filter((f) => f.sites > 0).length;
  const region = (r.regionViolations || []).filter((v) => v.mutation);
  el.innerHTML = `
    <div class="banner ${after === 0 ? "pass" : "fail"}">
      ${after === 0 ? "Done — your plugin is now Folia-ready ✔" : `${after} things still need attention`}
      &nbsp;·&nbsp; ${dl(r.outputJar, "download the converted jar")}
    </div>
    <div class="kv">Saved to <b>${esc(r.outputJar)}</b></div>
    <div class="kv" style="margin-top:12px">
      Rewrote <b>${rewrites}</b> scheduling calls · applied <b>${fixes}</b> automatic thread-safety fixes ·
      <b>${r.tier3Targets.length}</b> hard case(s) left for <b>AI Fix</b>.
    </div>
    <div class="kv" style="margin-top:8px">
      Region-lock safety: ${region.length === 0 ? badge("ok", "no risky off-region mutations ✔") : badge("warning", `${region.length} to review`)}
    </div>
    ${r.tier3Targets.length ? `<p class="say" style="margin-top:12px">Want those last ${r.tier3Targets.length} handled too? Run <b>AI Fix</b> from “Other tools”.</p>` : ""}
    ${regionViolationsHtml(region, "Region-lock risks — test these (not auto-fixed)")}`;
}

function regionViolationsHtml(violations, title) {
  if (!violations || violations.length === 0) return "";
  const rows = violations
    .slice(0, 40)
    .map((v) => {
      const where = `${dots(v.className)}#${v.method.slice(0, v.method.indexOf("("))}`;
      const call = `${v.call.owner.slice(v.call.owner.lastIndexOf("/") + 1)}.${v.call.name}`;
      return `<tr><td>${v.contexts.map((c) => badge(v.async ? "high" : "medium", c)).join(" ")}</td><td class="mono">${esc(where)}</td><td class="mono">${esc(call)}</td></tr>`;
    })
    .join("");
  return `<h3>${esc(title)} — ${violations.length}</h3>
    <p class="say">Region-locked mutations reached from a thread that won't own the entity/block. On Folia these throw — fix by running them on the entity/region scheduler.</p>
    <table><tr><th>From context</th><th>In</th><th>Calls</th></tr>${rows}</table>
    ${violations.length > 40 ? `<div class="hint">…and ${violations.length - 40} more (see JSON report)</div>` : ""}`;
}

function renderAnalysis(el, r) {
  if (!r) return void (el.innerHTML = `<div class="kv">No report found.</div>`);
  const g = { high: [], medium: [], low: [] };
  for (const f of r.findings) g[f.risk].push(f);
  const row = (f) => `<tr><td class="mono">${esc(dots(f.owner))}.${esc(f.field)}</td><td class="mono">${esc(dots(f.desc.slice(1, -1)))}</td><td>${f.contexts.join(" + ")}</td></tr>`;
  const mutations = (r.regionViolations || []).filter((v) => v.mutation);
  el.innerHTML = `
    <div class="kv" style="margin-bottom:12px">${badge("high", `${g.high.length} high risk`)} ${badge("medium", `${g.medium.length} medium`)} ${badge("low", `${g.low.length} low`)} ${badge("blocker", `${mutations.length} region-lock`)}</div>
    <p class="say">“High risk” = data changed by more than one thread at once. “Region-lock” = an entity/block mutation on a thread that won't own its region (throws on Folia).</p>
    <h3>Shared state — high risk</h3>
    <table><tr><th>Field</th><th>Type</th><th>Touched by</th></tr>${g.high.map(row).join("") || "<tr><td colspan=3>none 🎉</td></tr>"}</table>
    ${regionViolationsHtml(mutations, "Region-lock violations")}`;
}

function renderTier3(el, r) {
  if (!r) return void (el.innerHTML = `<div class="kv">No report found.</div>`);
  el.innerHTML = `
    ${r.finalJar ? `<div class="banner pass">AI patches verified and saved · ${dl(r.finalJar.replaceAll("\\", "/"), "download the AI-fixed jar")}</div>` : `<div class="kv">No patches were applied.</div>`}
    <table><tr><th>Result</th><th>Field</th><th>What the AI did</th></tr>
      ${r.results.map((t) => `<tr><td>${badge(t.status)}</td><td class="mono">${esc(t.field)}</td><td>${esc(t.notes ?? t.detail)}</td></tr>`).join("")}
    </table>`;
}

loadStatus().then((s) => {
  if (!s.setupDone) openSettings(true);
});
loadJars();
checkUpdates(false);
