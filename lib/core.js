// UltraEdge Baylink web flasher: the checks that decide whether a file may be written. No DOM, no Web Serial here, so
// Node runs the same code in test/core.test.mjs. Design: docs/prds/PRD-baylink-web-flasher.md.

// The only flash regions the flasher writes in a normal flash (partitions.csv). nvs (0x9000, paired phones), uelic
// (0x12000, the licence token), ota_1 and uelog are never touched, so a re-flash keeps pairings and registration.
export const ALLOWED_PARTS = Object.freeze({
  bootloader: 0x0,
  "partition-table": 0x8000,
  otadata: 0xf000,
  app: 0x20000,
});
export const APP_MAX = 0x180000;      // ota_0 size
export const FLASH_BYTES = 0x400000;  // the image needs a 4 MB C3
export const KINDS = Object.freeze({
  bay: { byte: 1, label: "Module bay" },
  aux: { byte: 0, label: "AUX1 port" },
});
const MARK = [0x55, 0x45, 0x42, 0x55, 0x49, 0x4c, 0x44, 0x32]; // "UEBUILD2" (licence.c UE_BUILD_MARK)
const HEX64 = /^[0-9a-f]{64}$/;
const MD5HEX = /^[0-9a-f]{32}$/;

export class FlasherError extends Error {
  // code: a short stable id for diagnostics; hint: what the pilot can do
  constructor(code, message, hint = "") {
    super(message);
    this.name = "FlasherError";
    this.code = code;
    this.hint = hint;
  }
}

/** A manifest file name: a relative path under the manifest's folder. No leading "/", no "//host/…", no "..", no
 *  scheme, so a download or an update link can never leave the page's own site. */
export function safeFile(f) {
  return typeof f === "string" && f.length <= 200 && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(f) && !f.includes("..");
}

const bad = (msg) => new FlasherError("MANIFEST", `The firmware list on the site is not valid: ${msg}.`,
  "This is a problem on our side. Try again later, or report it with the diagnostics.");

/** Checks manifest.json (schema 1) and returns it. Throws FlasherError("MANIFEST") with the first problem. */
export function validateManifest(m) {
  if (!m || typeof m !== "object") throw bad("not a JSON object");
  if (m.schema !== 1) throw bad(`schema ${m.schema} (this page reads schema 1)`);
  if (m.chip !== "ESP32-C3") throw bad(`chip ${m.chip}`);
  if (typeof m.version !== "string" || !m.version) throw bad("no version");
  if (!Number.isInteger(m.build) || m.build <= 0) throw bad("no build number");
  if (m.keys !== "TEST" && m.keys !== "RELEASE") throw bad(`key set ${m.keys}`);
  if (!m.kinds || typeof m.kinds !== "object") throw bad("no kinds");
  for (const [kind, def] of Object.entries(KINDS)) {
    const k = m.kinds[kind];
    if (!k) throw bad(`no ${def.label} image`);
    if (k.kindByte !== def.byte) throw bad(`${kind}: kind byte ${k.kindByte}`);
    if (!Array.isArray(k.parts)) throw bad(`${kind}: no parts`);
    const seen = new Set();
    for (const p of k.parts) {
      if (!(p.name in ALLOWED_PARTS)) throw bad(`${kind}: unknown part ${p.name}`);
      if (seen.has(p.name)) throw bad(`${kind}: ${p.name} twice`);
      seen.add(p.name);
      if (p.offset !== ALLOWED_PARTS[p.name]) throw bad(`${kind}: ${p.name} at 0x${Number(p.offset).toString(16)}`);
      if (!safeFile(p.file))
        throw bad(`${kind}: file name ${p.file}`);
      if (!Number.isInteger(p.size) || p.size <= 0) throw bad(`${kind}: ${p.name} size`);
      if (p.name === "app" && p.size > APP_MAX) throw bad(`${kind}: app larger than its slot`);
      if (!HEX64.test(p.sha256 || "")) throw bad(`${kind}: ${p.name} SHA-256`);
      if (!MD5HEX.test(p.md5 || "")) throw bad(`${kind}: ${p.name} MD5`);
    }
    for (const name of Object.keys(ALLOWED_PARTS)) if (!seen.has(name)) throw bad(`${kind}: no ${name}`);
    for (const f of ["update", "updateFromTest"])
      if (k[f] && (!safeFile(k[f].file) || !HEX64.test(k[f].sha256 || "")))
        throw bad(`${kind}: ${f} file`);
  }
  return m;
}

/** (build, kind) from the app image's single "UEBUILD2" marker, or null. More than one marker = null. */
export function readBuildMark(bytes) {
  let at = -1;
  outer: for (let i = 0; i + 16 <= bytes.length; i++) {
    for (let j = 0; j < 8; j++) if (bytes[i + j] !== MARK[j]) continue outer;
    if (at >= 0) return null;
    at = i;
  }
  if (at < 0) return null;
  const build = (bytes[at + 8] | (bytes[at + 9] << 8) | (bytes[at + 10] << 16) | (bytes[at + 11] << 24)) >>> 0;
  return { build, kind: bytes[at + 12] };
}

/** esp_app_desc_t of an app image (or of the flash at an app slot): { version, project, time, date } or null. */
export function readAppDesc(bytes) {
  if (bytes.length < 0x90 || bytes[0] !== 0xe9) return null;
  const magic = (bytes[0x20] | (bytes[0x21] << 8) | (bytes[0x22] << 16) | (bytes[0x23] << 24)) >>> 0;
  if (magic !== 0xabcd5432) return null;
  const str = (a, n) => {
    let s = "";
    for (let i = a; i < a + n && bytes[i]; i++) s += String.fromCharCode(bytes[i]);
    return s;
  };
  return { version: str(0x30, 32), project: str(0x50, 32), time: str(0x70, 16), date: str(0x80, 16) };
}

export function toHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Checks one downloaded part against the manifest and, for the app, its own marker. sha256hex is computed by the
 * caller (WebCrypto in the browser and in Node). Throws FlasherError("CHECKSUM" | "KIND").
 */
export function checkPart(part, bytes, sha256hex, kind, manifestBuild) {
  if (bytes.length !== part.size || sha256hex !== part.sha256)
    throw new FlasherError("CHECKSUM", `The downloaded ${part.name} file doesn't match its checksum.`,
      "The download was damaged or the site is mid-update. Press Retry to download it again.");
  if (part.name === "app") {
    const mark = readBuildMark(bytes);
    if (!mark || mark.kind !== KINDS[kind].byte || mark.build !== manifestBuild)
      throw new FlasherError("KIND", `The ${KINDS[kind].label} file on the site is not a ${KINDS[kind].label} image.`,
        "This is a problem on our side; nothing was written. Report it with the diagnostics.");
  }
}

/** Kind name from a kind byte, for diagnostics. */
export function kindName(byte) {
  for (const [k, d] of Object.entries(KINDS)) if (d.byte === byte) return k;
  return `unknown(${byte})`;
}

/** Browser support: "serial" (Web Serial), "usb" (WebUSB, with the polyfill), or "none".
 *  Android goes through WebUSB even when it has Web Serial: Chrome on Android lists only the wired ports the phone's
 *  OS exposes, which on most phones is none, so its picker stays empty for a USB board (owner's phone, 2026-11-17). */
export function transportSupport(nav) {
  const android = !!nav && /Android/i.test(nav.userAgent || "");
  if (android && "usb" in nav) return "usb";
  if (nav && "serial" in nav) return "serial";
  if (nav && "usb" in nav) return "usb";
  return "none";
}

/** Promise with a deadline; the error says what was being waited for. */
export function withTimeout(promise, ms, what) {
  let t;
  const timer = new Promise((_, rej) => {
    t = setTimeout(() => rej(new FlasherError("TIMEOUT", `No answer while ${what} (waited ${Math.round(ms / 1000)} s).`)), ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}
