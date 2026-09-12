#!/usr/bin/env node
/**
 * Rebuild config/nycdot_camera_models.json: the camera make/model per NYC DOT
 * camera, read from the EXIF header each frame carries. About half the fleet
 * (the AXIS units) writes EXIF; the rest are recorded as sampled-without-EXIF
 * only in the summary, never in the registry.
 *
 * The registry is a slow-changing prior the catalog loader uses to pick a
 * per-model field-of-view and to flag pan-tilt-zoom units. Re-run it when
 * cameras are replaced; it fetches one frame per online camera (~1,000
 * requests at 4-wide concurrency, a few minutes).
 *
 *   node scripts/nycdot-camera-models.mjs [--out config/nycdot_camera_models.json] [--concurrency 4]
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJpegMakeModel } from '../server/providers/common/jpeg-exif.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_URL = 'https://webcams.nyctmc.org/api/cameras';
const IMAGE_PREFIX = 'https://webcams.nyctmc.org/api/cameras/';
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const outPath = path.resolve(ROOT, arg('--out', 'config/nycdot_camera_models.json'));
const concurrency = Math.max(1, Math.min(8, Number(arg('--concurrency', 4)) || 4));

const catalog = await (await fetch(CATALOG_URL, { headers: { Accept: 'application/json' } })).json();
const online = catalog.filter((row) => String(row?.isOnline) === 'true' && String(row?.imageUrl || '').startsWith(IMAGE_PREFIX));
console.log(`[nycdot-models] ${catalog.length} cameras listed, ${online.length} online`);

const cameras = {};
const tally = { sampled: 0, withExif: 0, failed: 0, models: {} };
let cursor = 0;
async function worker() {
  while (cursor < online.length) {
    const row = online[cursor++];
    try {
      const resp = await fetch(row.imageUrl, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'gods-eye-view-nycdot-models/1.0' } });
      if (!resp.ok) { tally.failed++; continue; }
      const bytes = new Uint8Array(await resp.arrayBuffer());
      tally.sampled++;
      const { make, model } = parseJpegMakeModel(bytes);
      if (!make && !model) continue;
      tally.withExif++;
      const label = [make, model].filter(Boolean).join(' ');
      tally.models[label] = (tally.models[label] || 0) + 1;
      cameras[String(row.id)] = { make, model };
    } catch {
      tally.failed++;
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

const sorted = Object.fromEntries(Object.keys(cameras).sort().map((id) => [id, cameras[id]]));
const registry = {
  generatedAt: new Date().toISOString(),
  source: 'EXIF Make/Model tags read from webcams.nyctmc.org frames (metadata only; no frames are stored)',
  onlineCameras: online.length,
  sampled: tally.sampled,
  withExif: tally.withExif,
  cameras: sorted,
};
writeFileSync(outPath, `${JSON.stringify(registry, null, 2)}\n`);
console.log(`[nycdot-models] sampled ${tally.sampled}, with EXIF ${tally.withExif}, failed ${tally.failed}`);
for (const [label, n] of Object.entries(tally.models).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${label}`);
console.log(`[nycdot-models] wrote ${path.relative(ROOT, outPath)}`);
