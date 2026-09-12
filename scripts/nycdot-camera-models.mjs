#!/usr/bin/env node
/**
 * Rebuild config/nycdot_camera_models.json: per NYC DOT camera, the make/model
 * from the EXIF header each frame carries, and the FACING the encoder burns
 * into the caption strip ("Facing West Sat Sep 12 …") read by OCR.
 *
 * About half the fleet (the AXIS units) writes EXIF; roughly a third captions
 * a facing. Cameras with neither are recorded only in the summary, never in
 * the registry. The registry is a slow-changing prior the catalog loader uses
 * for a per-model field of view, a PTZ flag, and a compass heading. Re-run it
 * when cameras are replaced; it fetches one frame per online camera (~1,000
 * requests at 4-wide concurrency, several minutes with OCR).
 *
 * OCR needs `tesseract` on PATH (brew install tesseract) and the `sharp`
 * devDependency; without tesseract the script still records EXIF and says so.
 *
 *   node scripts/nycdot-camera-models.mjs [--out config/nycdot_camera_models.json] [--concurrency 4] [--no-ocr]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJpegMakeModel } from '../server/providers/common/jpeg-exif.js';
import { parseCaptionFacing } from '../server/providers/common/caption-facing.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_URL = 'https://webcams.nyctmc.org/api/cameras';
const IMAGE_PREFIX = 'https://webcams.nyctmc.org/api/cameras/';
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const outPath = path.resolve(ROOT, arg('--out', 'config/nycdot_camera_models.json'));
const concurrency = Math.max(1, Math.min(8, Number(arg('--concurrency', 4)) || 4));
const wantOcr = !process.argv.includes('--no-ocr');
const hasTesseract = wantOcr && (() => { try { execFileSync('tesseract', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
if (wantOcr && !hasTesseract) console.warn('[nycdot-models] tesseract not found on PATH — recording EXIF only (brew install tesseract)');
/** Tesseract cannot read /tmp inside some sandboxes; keep scratch under the repo cache. */
const scratchDir = path.join(ROOT, '.gev-cache', 'nycdot-ocr');
mkdirSync(scratchDir, { recursive: true });
const sharp = hasTesseract ? (await import('sharp')).default : null;

/**
 * OCR the caption strip along the top of a frame and return the text.
 * The strip is cropped, upscaled 4x and normalised so the small bitmap font
 * reads cleanly; one line mode (psm 7).
 */
async function readCaption(bytes, slot) {
  const image = sharp(Buffer.from(bytes));
  const meta = await image.metadata();
  if (!meta.width || !meta.height) return '';
  const png = path.join(scratchDir, `strip-${slot}.png`);
  await sharp(Buffer.from(bytes))
    .extract({ left: 0, top: 0, width: meta.width, height: Math.min(22, meta.height) })
    .resize({ width: meta.width * 4, kernel: 'lanczos3' })
    .grayscale().normalise().png().toFile(png);
  try {
    return execFileSync('tesseract', [png, 'stdout', '--psm', '7'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

const catalog = await (await fetch(CATALOG_URL, { headers: { Accept: 'application/json' } })).json();
const online = catalog.filter((row) => String(row?.isOnline) === 'true' && String(row?.imageUrl || '').startsWith(IMAGE_PREFIX));
console.log(`[nycdot-models] ${catalog.length} cameras listed, ${online.length} online`);

const cameras = {};
const tally = { sampled: 0, withExif: 0, withFacing: 0, failed: 0, models: {}, facings: {} };
let cursor = 0;
async function worker(slot) {
  while (cursor < online.length) {
    const row = online[cursor++];
    try {
      const resp = await fetch(row.imageUrl, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'gods-eye-view-nycdot-models/1.0' } });
      if (!resp.ok) { tally.failed++; continue; }
      const bytes = new Uint8Array(await resp.arrayBuffer());
      tally.sampled++;
      const { make, model } = parseJpegMakeModel(bytes);
      const entry = {};
      if (make || model) {
        tally.withExif++;
        const label = [make, model].filter(Boolean).join(' ');
        tally.models[label] = (tally.models[label] || 0) + 1;
        entry.make = make;
        entry.model = model;
      }
      if (hasTesseract) {
        const caption = await readCaption(bytes, slot);
        const facing = parseCaptionFacing(caption);
        if (facing) {
          tally.withFacing++;
          tally.facings[facing.facing] = (tally.facings[facing.facing] || 0) + 1;
          entry.facing = facing.facing;
          entry.facingHeadingDeg = facing.headingDeg;
        }
      }
      if (Object.keys(entry).length) cameras[String(row.id)] = entry;
    } catch {
      tally.failed++;
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, (_, slot) => worker(slot)));

const sorted = Object.fromEntries(Object.keys(cameras).sort().map((id) => [id, cameras[id]]));
const registry = {
  generatedAt: new Date().toISOString(),
  source: 'EXIF Make/Model tags and OCR of the burned-in caption strip ("Facing West …") read from webcams.nyctmc.org frames (metadata only; no frames are stored)',
  onlineCameras: online.length,
  sampled: tally.sampled,
  withExif: tally.withExif,
  withFacing: tally.withFacing,
  ocr: hasTesseract,
  cameras: sorted,
};
writeFileSync(outPath, `${JSON.stringify(registry, null, 2)}\n`);
console.log(`[nycdot-models] sampled ${tally.sampled}, with EXIF ${tally.withExif}, with caption facing ${tally.withFacing}${hasTesseract ? '' : ' (OCR off)'}, failed ${tally.failed}`);
for (const [label, n] of Object.entries(tally.models).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${label}`);
for (const [facing, n] of Object.entries(tally.facings).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  facing ${facing}`);
console.log(`[nycdot-models] wrote ${path.relative(ROOT, outPath)}`);
