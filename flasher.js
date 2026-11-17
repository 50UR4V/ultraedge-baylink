// UltraEdge Baylink web flasher: page flow. Design: docs/prds/PRD-baylink-web-flasher.md. Checks live in lib/core.js.
import { openBoard, writeParts, closeBoard } from "./lib/board.js?v=1.0.2";
import {
  FlasherError, KINDS, validateManifest, checkPart, kindName, toHex, transportSupport, withTimeout,
} from "./lib/core.js?v=1.0.2";

const PAGE_VERSION = "1.0.2"; // keep the ?v= tags in index.html, flasher.js and lib/board.js equal to this
const MANIFEST_URL = "firmware/manifest.json";
const T = { manifest: 15000, fileIdle: 20000 };

const $ = (id) => document.getElementById(id);
const state = {
  support: transportSupport(navigator),
  manifest: null,
  images: {},          // kind -> [{name, offset, data}] after checks
  port: null, transport: null, loader: null,
  chip: null,          // { name, mac, flashId, flashBytes, current }
  busy: false,
  retry: null,         // what Retry does after an error
  lastError: null,
  log: [],
};

// ---------- log + diagnostics ----------
function log(line) {
  const t = new Date().toISOString().slice(11, 23);
  state.log.push(`${t} ${line}`);
  if (state.log.length > 2000) state.log.shift();
  const pre = $("log");
  pre.textContent = state.log.slice(-400).join("\n");
  pre.scrollTop = pre.scrollHeight;
}
const terminal = { clean() {}, writeLine: (s) => log(`esptool: ${s}`), write: (s) => log(`esptool: ${s}`) };

function diagnostics() {
  const m = state.manifest;
  const c = state.chip;
  return [
    "UltraEdge Baylink flasher diagnostics",
    `time: ${new Date().toISOString()}`,
    `page: ${PAGE_VERSION} at ${location.origin}${location.pathname}`,
    `browser: ${navigator.userAgent}`,
    `usb access: ${state.support}${state.support === "usb" ? " (Web Serial polyfill)" : ""}; secure context: ${isSecureContext}`,
    `firmware: ${m ? `build ${m.build}, ${m.version}, ${m.keys} keys, staged ${m.date}` : "not loaded"}`,
    `chosen: ${kind()} (${KINDS[kind()].label})`,
    `board: ${c ? `${c.name}, MAC ${c.mac}, flash id 0x${c.flashId.toString(16)} (${c.flashBytes >> 20} MB)` : "not connected"}`,
    `found on board: ${c && c.current ? `${c.current.project} ${c.current.version} (${c.current.date})` : "nothing recognised"}`,
    `erase all on the last flash: ${state.lastEraseAll ?? "no flash yet"}`,
    `error: ${state.lastError ? `${state.lastError.code || state.lastError.name}: ${state.lastError.message}` : "none"}`,
    "--- log ---",
    ...state.log.slice(-300),
  ].join("\n");
}
async function copyDiagnostics() {
  try {
    await navigator.clipboard.writeText(diagnostics());
    setStatus("dev-status", "Diagnostics copied. Paste them into your report.", "ok");
  } catch {
    saveDiagnostics();
  }
}
function saveDiagnostics() {
  const blob = new Blob([diagnostics()], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `baylink-flasher-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- UI helpers ----------
const kind = () => document.querySelector('input[name="kind"]:checked').value;
function setStatus(id, text, cls = "") {
  const el = $(id);
  el.textContent = text;
  el.className = `status ${cls}`;
}
function progress(frac, text) {
  $("progress").hidden = frac == null;
  if (frac == null) return;
  $("progress-fill").style.width = `${Math.round(frac * 100)}%`;
  $("progress-text").textContent = text;
}
function refreshButtons() {
  const ready = !!state.images[kind()];
  $("connect").disabled = state.busy || state.support === "none" || !ready;
  $("flash").disabled = state.busy || !ready || !state.loader;
  $("connect").textContent = state.loader ? "Connected" : "Connect";
  document.querySelectorAll('input[name="kind"]').forEach((r) => (r.disabled = state.busy));
  $("erase-all").disabled = state.busy;
}
function showError(err, retry) {
  const e = err instanceof FlasherError ? err : explain(err);
  state.lastError = e;
  state.retry = retry;
  log(`ERROR ${e.code}: ${e.message}${err !== e && err && err.message ? ` [${err.message}]` : ""}`);
  $("error-title").textContent = TITLES[e.code] || "Something went wrong";
  $("error-msg").textContent = e.message;
  $("error-hint").textContent = e.hint || "";
  $("error").hidden = false;
  $("error-retry").hidden = !retry;
  $("error").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function clearError() {
  $("error").hidden = true;
  state.lastError = null;
}
const TITLES = {
  MANIFEST: "Firmware list problem",
  NETWORK: "Download failed",
  CHECKSUM: "Download check failed",
  KIND: "Wrong file on the site",
  NOPORT: "No board picked",
  PORTBUSY: "The port is busy",
  CONNECT: "Couldn't talk to the board",
  NOTC3: "This isn't an ESP32-C3",
  FLASHSIZE: "Not enough flash",
  TIMEOUT: "No answer",
  LOST: "Board disconnected",
  FLASH: "Flashing failed",
};

// Turns browser and esptool errors into a FlasherError with something to do.
function explain(err) {
  const msg = (err && err.message) || String(err);
  if (err && err.name === "NotFoundError")
    return new FlasherError("NOPORT", "No board was picked in the list.",
      "Press Connect again and pick the board. Not in the list? Try another cable (some only charge) or another USB port. On a phone, check its OTG setting is on, if it has one.");
  if (err && (err.name === "InvalidStateError" || err.name === "NetworkError" || /already open|Failed to open/i.test(msg)))
    return new FlasherError("PORTBUSY", "The board's port is in use by another program or tab.",
      "Close Arduino IDE, a serial monitor, idf.py monitor or other flasher tabs, unplug the board, plug it in again and Retry.");
  if (err && err.name === "SecurityError")
    return new FlasherError("PORTBUSY", "The browser blocked access to the board.",
      "Allow USB access for this site in the browser settings, then Retry.");
  return new FlasherError("FLASH", msg, "Unplug the board, plug it in again and press Retry.");
}

// ---------- step 2: firmware ----------
async function fetchBytes(url, onProgress) {
  const ctl = new AbortController();
  let idle;
  const kick = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ctl.abort(), T.fileIdle);
  };
  kick();
  try {
    const res = await fetch(url, { cache: "no-store", signal: ctl.signal });
    if (!res.ok) throw new FlasherError("NETWORK", `The site answered ${res.status} for ${url}.`,
      "Press Retry. If it keeps failing, the site may be mid-update: try again in a few minutes.");
    const total = Number(res.headers.get("content-length")) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      kick();
      chunks.push(value);
      got += value.length;
      onProgress && onProgress(got, total);
    }
    const out = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  } catch (err) {
    if (err instanceof FlasherError) throw err;
    throw new FlasherError("NETWORK", ctl.signal.aborted
      ? `The download of ${url} stalled (nothing for ${T.fileIdle / 1000} s).`
      : `Couldn't download ${url} (${err.message}).`, "Check the internet connection and press Retry.");
  } finally {
    clearTimeout(idle);
  }
}

async function loadManifest() {
  setStatus("fw-status", "Loading the firmware list…");
  $("fw-actions").hidden = true;
  try {
    const bytes = await withTimeout(fetchBytes(MANIFEST_URL), T.manifest, "loading the firmware list");
    let m;
    try { m = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new FlasherError("MANIFEST",
      "The firmware list on the site is not valid JSON.", "This is a problem on our side. Try again later."); }
    state.manifest = validateManifest(m);
    log(`manifest: build ${m.build}, ${m.version}, ${m.keys} keys, staged ${m.date}`);
    showUpdates(m);
    await loadImages();
  } catch (err) {
    setStatus("fw-status", "Couldn't load the firmware.", "bad");
    $("fw-actions").hidden = false;
    showError(err, loadManifest);
  }
}

async function loadImages() {
  const k = kind();
  if (state.images[k]) return showFirmware();
  const parts = state.manifest.kinds[k].parts;
  const total = parts.reduce((s, p) => s + p.size, 0);
  const out = [];
  let done = 0;
  for (const p of parts) {
    const data = await fetchBytes(new URL(p.file, new URL(MANIFEST_URL, location.href)).href, (got) =>
      setStatus("fw-status", `Downloading the ${KINDS[k].label} image… ${Math.round(((done + got) / total) * 100)}%`));
    const sha = toHex(await crypto.subtle.digest("SHA-256", data));
    checkPart(p, data, sha, k, state.manifest.build);
    log(`${k}/${p.name}: ${data.length} B at 0x${p.offset.toString(16)}, SHA-256 ok`);
    out.push({ name: p.name, offset: p.offset, data });
    done += p.size;
  }
  if (k !== kind()) return loadImages(); // the pilot switched while downloading
  state.images[k] = out;
  showFirmware();
}

// Bluetooth update files (Story 11 / D15): one download per kind, picked in the app
function updateLink(m, u, text) {
  const li = document.createElement("li");
  const a = document.createElement("a");
  a.href = new URL(u.file, new URL(MANIFEST_URL, location.href)).href;
  a.download = u.file.split("/").pop();
  a.textContent = text;
  li.append(a, ` (${Math.round(u.size / 1024)} KB)`);
  return li;
}

function showUpdates(m) {
  const ul = $("update-links"), tl = $("update-test-links");
  ul.textContent = tl.textContent = "";
  for (const k of Object.keys(KINDS)) {
    const { update, updateFromTest } = m.kinds[k];
    if (update) ul.append(updateLink(m, update, `${KINDS[k].label}: build ${m.build}`));
    if (updateFromTest) tl.append(updateLink(m, updateFromTest, `${KINDS[k].label}: build ${m.build}, from a test build`));
  }
  $("update-test").hidden = !tl.children.length;
  $("updates").hidden = !ul.children.length;
}

function showFirmware() {
  const m = state.manifest;
  const test = m.keys === "TEST" ? " · test build" : "";
  setStatus("fw-status", `${KINDS[kind()].label} image ready: build ${m.build}${test}. Checked.`, "ok");
  $("fw-actions").hidden = true;
  refreshButtons();
}

async function onKindChange() {
  clearError();
  refreshButtons();
  if (!state.manifest) return;
  try { await loadImages(); } catch (err) {
    setStatus("fw-status", "Couldn't load the firmware.", "bad");
    $("fw-actions").hidden = false;
    showError(err, onKindChange);
  }
}

// ---------- step 3: connect ----------
async function requestPort() {
  if (state.support === "serial") return navigator.serial.requestPort();
  const { serial } = await import("./vendor/web-serial-polyfill-1.0.15/serial.js");
  return serial.requestPort();
}

async function connect() {
  clearError();
  state.busy = true;
  refreshButtons();
  try {
    if (!state.port) state.port = await requestPort();
    const info = state.port.getInfo ? state.port.getInfo() : {};
    log(`port: VID 0x${(info.usbVendorId || 0).toString(16)} PID 0x${(info.usbProductId || 0).toString(16)}`);
    setStatus("dev-status", "Connecting to the board…");
    progress(0.02, "Waking the board's loader");
    const b = await openBoard(state.port, { terminal, onLost, log });
    state.transport = b.transport;
    state.loader = b.loader;
    const c = b.info;
    state.chip = { name: c.chipDesc, mac: c.mac, flashId: c.flashId, flashBytes: c.flashBytes, current: c.current };
    const again = c.current && c.current.project === "ue_c3_bridge"
      ? " It already has Baylink firmware; flashing keeps its paired phones and activation." : "";
    setStatus("dev-status", `Connected: ESP32-C3, ${Math.round(c.flashBytes / 2 ** 20)} MB.${again}`, "ok");
    progress(null);
  } catch (err) {
    progress(null);
    await disconnect();
    setStatus("dev-status", "Not connected.", "bad");
    showError(err, connect);
  } finally {
    state.busy = false;
    refreshButtons();
  }
}

async function disconnect() {
  const t = state.transport;
  state.loader = null;
  state.transport = null;
  await closeBoard(t, log);
}

function onLost() {
  if (!state.transport) return;
  log("the board was unplugged");
  state.loader = null;
  state.transport = null;
  state.port = null;
  if (state.busy) return; // the running step reports it
  setStatus("dev-status", "The board was unplugged.", "bad");
  refreshButtons();
}

// ---------- step 3: flash ----------
async function flash() {
  clearError();
  const k = kind();
  const parts = state.images[k];
  const loader = state.loader;
  if (!parts || !loader) return;
  state.busy = true;
  refreshButtons();
  const eraseAll = $("erase-all").checked;
  if (eraseAll && !confirm("Erase the whole chip first?\n\nThis also forgets the module's paired phones and its " +
      "activation, and any activation request still waiting for its code. You'll pair and activate it again in the app.")) {
    state.busy = false;
    refreshButtons();
    return;
  }
  state.lastEraseAll = eraseAll;
  try {
    log(`flash: ${k}, build ${state.manifest.build}, erase all ${eraseAll}`);
    setStatus("dev-status", eraseAll ? "Erasing the whole chip… (up to 30 s)" : "Flashing…");
    await writeParts(loader, parts, { eraseAll, onProgress: progress, log });
    await disconnect();
    state.port = null;
    $("erase-all").checked = false; // never carried over to the next board
    log(`done: ${k}, build ${state.manifest.build}, restart sent`);
    progress(null);
    setStatus("dev-status", "");
    $("done-msg").textContent = `${KINDS[k].label} firmware, build ${state.manifest.build}, is on the board` +
      (state.chip ? ` (${state.chip.mac}).` : ".");
    $("done").hidden = false;
    $("done").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    progress(null);
    await disconnect();
    setStatus("dev-status", "Not flashed.", "bad");
    const e = err instanceof FlasherError ? err
      : !state.port ? new FlasherError("LOST", "The board was unplugged while flashing.",
          "Plug it in again, press Connect, then Flash. A half-flashed board is fine to flash again.")
      : new FlasherError("FLASH", `Flashing stopped: ${err.message || err}.`,
          "Unplug the board, plug it in again, press Connect, then Flash. A half-flashed board is fine to flash again.");
    showError(e, async () => { await connect(); if (state.loader) await flash(); });
  } finally {
    state.busy = false;
    refreshButtons();
  }
}

function again() {
  $("done").hidden = true;
  clearError();
  state.chip = null;
  setStatus("dev-status", "");
  refreshButtons();
  $("step-flash").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- start ----------
function start() {
  log(`page ${PAGE_VERSION}; usb access: ${state.support}; secure context: ${isSecureContext}`);
  if (state.support === "none" || !isSecureContext) {
    $("unsupported").hidden = false;
    $("unsupported-why").textContent = !isSecureContext
      ? "The page must be opened over https (or on localhost) for USB access."
      : "This browser has neither Web Serial nor WebUSB.";
  }
  $("erase-all").checked = false; // the browser may restore a ticked box on reload
  document.querySelectorAll('input[name="kind"]').forEach((r) => r.addEventListener("change", onKindChange));
  $("fw-retry").addEventListener("click", () => { clearError(); loadManifest(); });
  $("connect").addEventListener("click", connect);
  $("flash").addEventListener("click", flash);
  $("error-retry").addEventListener("click", () => { const r = state.retry; clearError(); r && r(); });
  $("diag-copy").addEventListener("click", copyDiagnostics);
  $("diag-save").addEventListener("click", saveDiagnostics);
  $("diag-save-done").addEventListener("click", saveDiagnostics);
  $("again").addEventListener("click", again);
  if (navigator.serial) navigator.serial.addEventListener("disconnect", (e) => { if (e.target === state.port) onLost(); });
  window.addEventListener("beforeunload", (e) => { if (state.busy) { e.preventDefault(); e.returnValue = ""; } });
  refreshButtons();
  loadManifest();
}
start();

// for the console while testing: window.ueFlasher.diagnostics()
window.ueFlasher = { diagnostics, state, kindName };
