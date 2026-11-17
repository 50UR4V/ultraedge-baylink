// UltraEdge Baylink web flasher: everything that talks to the board (esptool-js), with no DOM, so the page and the
// Node bench (test/bench.mjs, a real C3 over node-serialport) run the same code. Design: docs/prds/PRD-baylink-web-flasher.md.
import { ESPLoader, Transport } from "../vendor/esptool-js-0.7.0/bundle.js";
import { FlasherError, FLASH_BYTES, readAppDesc, withTimeout } from "./core.js?v=1.0.1";
import { md5 } from "./md5.js?v=1.0.1";

export const TIMEOUTS = { connect: 30000, flashIdle: 30000, eraseExtra: 30000, reset: 8000 };

/**
 * Opens the port, wakes the C3's ROM loader, checks chip and flash size and reads the firmware already at ota_0.
 * port: a Web Serial SerialPort (or anything with the same open/readable/writable/setSignals/getInfo/close).
 * Returns { transport, loader, info: { chipDesc, chipName, mac, flashId, flashBytes, current } }. Throws FlasherError;
 * on any error the port is closed again.
 */
export async function openBoard(port, { terminal, onLost, log = () => {}, baudrate = 460800, debug = false } = {}) {
  const transport = new Transport(port, debug);
  if (onLost && transport.setDeviceLostCallback) transport.setDeviceLostCallback(onLost);
  const loader = new ESPLoader({ transport, baudrate, terminal, debugLogging: debug });
  try {
    let chipDesc;
    try {
      chipDesc = await withTimeout(loader.main(), TIMEOUTS.connect, "connecting to the board");
    } catch (err) {
      throw new FlasherError(err.code === "TIMEOUT" ? "TIMEOUT" : "CONNECT", `The board didn't answer (${err.message}).`,
        "Hold the BOOT button, plug the board in (or press RESET), let go of BOOT, then press Retry. " +
        "Also check the cable carries data.");
    }
    const chipName = loader.chip.CHIP_NAME;
    log(`chip: ${chipDesc}`);
    if (!/ESP32-C3/i.test(chipName))
      throw new FlasherError("NOTC3", `This board is an ${chipName}. The Baylink needs an ESP32-C3.`,
        "Use an ESP32-C3 board (for example a C3 SuperMini, WeAct C3 or XIAO ESP32C3).");
    const mac = await loader.chip.readMac(loader);
    const flashId = await loader.readFlashId();
    const flashBytes = 2 ** ((flashId >> 16) & 0xff);
    log(`MAC ${mac}, flash id 0x${flashId.toString(16)}, ${Math.round(flashBytes / 2 ** 20)} MB`);
    if (flashBytes < FLASH_BYTES)
      throw new FlasherError("FLASHSIZE", `This board has ${Math.round(flashBytes / 2 ** 20)} MB of flash; the Baylink needs 4 MB.`,
        "Use an ESP32-C3 board with 4 MB flash (most C3 boards have it).");
    let current = null;
    try {
      current = readAppDesc(await loader.readFlash(0x20000, 0x100));
    } catch (err) {
      log(`couldn't read the current firmware (${err.message}); carrying on`);
    }
    if (current) log(`on the board: ${current.project} ${current.version} (${current.date} ${current.time})`);
    return { transport, loader, info: { chipDesc, chipName, mac, flashId, flashBytes, current } };
  } catch (err) {
    await closeBoard(transport, log);
    throw err;
  }
}

/**
 * Writes the checked parts ([{ name, offset, data }], offsets from core.js ALLOWED_PARTS) with a read-back MD5 check
 * of each, then restarts the board. onProgress(fraction, label). Throws FlasherError("TIMEOUT") when nothing moves for
 * TIMEOUTS.flashIdle; any other esptool error is passed on for the caller to explain.
 */
export async function writeParts(loader, parts, { eraseAll = false, onProgress = () => {}, log = () => {} } = {}) {
  const total = parts.reduce((s, p) => s + p.data.length, 0);
  const before = parts.map((_, i) => parts.slice(0, i).reduce((s, p) => s + p.data.length, 0));
  const limit = TIMEOUTS.flashIdle + (eraseAll ? TIMEOUTS.eraseExtra : 0);
  let lastAt = Date.now();
  let idle;
  const watchdog = new Promise((_, rej) => {
    idle = setInterval(() => {
      if (Date.now() - lastAt > limit)
        rej(new FlasherError("TIMEOUT", `The board stopped answering while flashing (nothing for ${limit / 1000} s).`,
          "Unplug the board, plug it in again, press Connect and then Flash. The board is safe to re-flash."));
    }, 1000);
  });
  try {
    log(`writing ${parts.length} parts, ${total} B, erase all ${eraseAll}`);
    onProgress(0, eraseAll ? "Erasing the whole chip (up to 30 s)" : "Starting");
    await Promise.race([
      loader.writeFlash({
        fileArray: parts.map((p) => ({ data: p.data, address: p.offset })),
        flashMode: "keep", flashFreq: "keep", flashSize: "keep",
        eraseAll, compress: true,
        reportProgress: (i, written, size) => {
          lastAt = Date.now();
          const frac = (before[i] + (written / size) * parts[i].data.length) / total;
          onProgress(frac, `Writing ${parts[i].name} (${i + 1} of ${parts.length}) · ${Math.round(frac * 100)}%`);
        },
        // esptool-js compares this with the chip's own MD5 of the written region: the read-back check of each part
        calculateMD5Hash: (image) => md5(image),
      }),
      watchdog,
    ]);
  } finally {
    clearInterval(idle);
  }
  log("all parts written and verified");
  onProgress(1, "Written and checked. Restarting the board…");
  try {
    await withTimeout(hardReset(loader.transport), TIMEOUTS.reset, "restarting the board");
  } catch (err) {
    log(`restart: ${err.message} (unplug and plug in to start it)`);
  }
}

// esptool.py's hard reset: EN low through RTS with IO9 (DTR) released, then EN high, so the chip boots the new app.
// esptool-js 0.7.0's HardReset only releases RTS (already released after connect), so the chip stayed in the loader
// until replugged (bench 2026-11-16).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function hardReset(transport) {
  await transport.setDTR(false);
  await transport.setRTS(true);
  await sleep(200);
  await transport.setRTS(false);
  await sleep(200);
}

export async function closeBoard(transport, log = () => {}) {
  if (!transport) return;
  try {
    await transport.disconnect();
  } catch (err) {
    log(`disconnect: ${err.message}`);
  }
}
