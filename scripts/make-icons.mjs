/**
 * Draw the Cuesheet mark and write the PNGs `electron-builder` and the tray
 * need.
 *
 * Why a script rather than committed art: the app had no icon at all, and
 * `electron-builder` silently ships Electron's default when it finds none —
 * a released app wearing somebody else's logo. This produces a real mark in
 * the Desk's own palette, deterministically, with no design tool and no image
 * dependency. **Replace it the moment there is real art**; the pipeline is
 * the point, not the drawing.
 *
 * One PNG is enough for packaging: `electron-builder` generates `.icns` and
 * `.ico` from a ≥512px `icon.png` itself, so there is no `iconutil` (macOS
 * only) or hand-rolled ICO container in the build path — which is what makes
 * a Windows installer buildable from a Linux or macOS runner.
 *
 * ```
 * node scripts/make-icons.mjs
 * ```
 */
import { deflateSync } from "node:zlib";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const out = fileURLToPath(
  new URL("../packages/desktop/assets/", import.meta.url),
);

/** The Desk's tokens, so the icon and the window agree. See ui/src/styles.css. */
const PALETTE = {
  tile: [0x14, 0x18, 0x1d],
  track: [0x26, 0x2d, 0x36],
  cap: [0x8b, 0x95, 0xa3],
  live: [0x6e, 0xa8, 0xfe],
};

/**
 * Three channel strips with their caps at different heights, one of them
 * live. A mixing desk is what the whole app is a metaphor for, and it still
 * reads as *something* at 16 pixels, which a wordmark does not.
 *
 * Coordinates are fractions of the canvas so one description serves every
 * size. Anti-aliasing is 4×4 supersampling rather than a real rasteriser:
 * exact, tiny, and no dependency.
 */
const FADERS = [
  { x: 0.305, cap: 0.63, live: false },
  { x: 0.5, cap: 0.35, live: true },
  { x: 0.695, cap: 0.56, live: false },
];

const SAMPLES = 4;

/** Signed-distance test for a rounded rectangle, in unit coordinates. */
function inRoundedRect(px, py, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * @param {number} size
 * @param {boolean} template macOS tray icons must be black plus alpha only —
 *   the OS recolours them for light, dark, and the highlighted menu. A
 *   coloured tray icon is the single most common way a Mac app looks wrong.
 */
function drawMark(size, template) {
  const rgba = new Uint8Array(size * size * 4);
  const step = 1 / (size * SAMPLES);

  // The tray glyph fills its canvas; the app icon sits in a margin, the way
  // every other icon in a dock does.
  const inset = template ? 0.06 : 0.085;
  const tile = { x0: inset, y0: inset, x1: 1 - inset, y1: 1 - inset };
  const tileRadius = (tile.x1 - tile.x0) * 0.225;

  const trackW = template ? 0.085 : 0.07;
  const capW = template ? 0.2 : 0.185;
  const capH = template ? 0.1 : 0.085;
  const trackTop = 0.255;
  const trackBottom = 0.745;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const px = (x * SAMPLES + sx + 0.5) * step;
          const py = (y * SAMPLES + sy + 0.5) * step;

          let colour = null;

          if (
            !template &&
            inRoundedRect(
              px,
              py,
              tile.x0,
              tile.y0,
              tile.x1,
              tile.y1,
              tileRadius,
            )
          ) {
            colour = PALETTE.tile;
          }
          if (template || colour !== null) {
            for (const fader of FADERS) {
              const half = trackW / 2;
              if (
                inRoundedRect(
                  px,
                  py,
                  fader.x - half,
                  trackTop,
                  fader.x + half,
                  trackBottom,
                  half,
                )
              ) {
                colour = template ? [0, 0, 0] : PALETTE.track;
              }
            }
            for (const fader of FADERS) {
              if (
                inRoundedRect(
                  px,
                  py,
                  fader.x - capW / 2,
                  fader.cap - capH / 2,
                  fader.x + capW / 2,
                  fader.cap + capH / 2,
                  capH / 2,
                )
              ) {
                colour = template
                  ? [0, 0, 0]
                  : fader.live
                    ? PALETTE.live
                    : PALETTE.cap;
              }
            }
          }

          if (colour !== null) {
            r += colour[0];
            g += colour[1];
            b += colour[2];
            a += 255;
          }
        }
      }

      const total = SAMPLES * SAMPLES;
      const i = (y * size + x) * 4;
      const cover = a / total;
      if (cover > 0) {
        // Un-premultiply, or every edge pixel darkens toward black.
        const hits = a / 255;
        rgba[i] = Math.round(r / hits);
        rgba[i + 1] = Math.round(g / hits);
        rgba[i + 2] = Math.round(b / hits);
        rgba[i + 3] = Math.round(cover);
      }
    }
  }

  return rgba;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Minimal 8-bit RGBA PNG. No interlacing, filter 0 on every scanline. */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(
      raw,
      y * (size * 4 + 1) + 1,
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * An `.ico` containing several PNGs.
 *
 * `electron-builder` generates the *installer's* icon from `icon.png` at
 * package time, but the tray needs a real file at runtime, and Windows wants
 * `.ico` — a PNG tray icon works but resamples badly at the DPI scales a
 * Windows taskbar actually uses. Vista and later accept PNG payloads inside
 * the container, so this is a header, a directory, and the encoder above.
 */
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(entries.length * 16);
  let offset = header.length + directory.length;

  entries.forEach((entry, i) => {
    const at = i * 16;
    // 0 means 256 in this field; none of these sizes hit that, but the
    // convention is why the field is one byte wide.
    directory[at] = entry.size === 256 ? 0 : entry.size;
    directory[at + 1] = entry.size === 256 ? 0 : entry.size;
    directory[at + 2] = 0; // palette size, 0 for truecolour
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(entry.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([
    header,
    directory,
    ...entries.map((entry) => entry.png),
  ]);
}

await mkdir(out, { recursive: true });

const targets = [
  // electron-builder converts this one into .icns and .ico itself.
  { file: "icon.png", size: 1024, template: false },
  // Step 22's tray. macOS picks these by name: `Template` means "recolour me".
  { file: "iconTemplate.png", size: 16, template: true },
  { file: "iconTemplate@2x.png", size: 32, template: true },
];

for (const target of targets) {
  const png = encodePng(target.size, drawMark(target.size, target.template));
  await writeFile(path.join(out, target.file), png);
  console.log(
    `${target.file.padEnd(22)} ${target.size}×${target.size}  ${png.length.toLocaleString()} bytes`,
  );
}

// The Windows tray. Coloured rather than monochrome: the macOS template
// convention has no equivalent there, and a Windows taskbar can be light or
// dark, so the mark carries its own dark tile the way every other tray icon
// with a background does.
const TRAY_SIZES = [16, 24, 32, 48];
const ico = encodeIco(
  TRAY_SIZES.map((size) => ({
    size,
    png: encodePng(size, drawMark(size, false)),
  })),
);
await writeFile(path.join(out, "tray.ico"), ico);
console.log(
  `${"tray.ico".padEnd(22)} ${TRAY_SIZES.join(", ")}  ${ico.length.toLocaleString()} bytes`,
);
