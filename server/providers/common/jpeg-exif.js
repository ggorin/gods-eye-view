/**
 * Minimal JPEG EXIF reader: Make (0x010F) and Model (0x0110) from IFD0.
 *
 * Dependency-free on purpose — it runs inside the CCTV catalog tooling and
 * must not pull an image library into the server. Reads only the APP1 Exif
 * segment's first IFD; anything malformed returns nulls rather than throwing.
 *
 * @param {Buffer|Uint8Array} bytes - JPEG file bytes.
 * @returns {{make: string|null, model: string|null}}
 */
export function parseJpegMakeModel(bytes) {
  const none = { make: null, model: null };
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return none;
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) return none;
    const marker = buf[pos + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { pos += 2; continue; }
    if (marker === 0xda || marker === 0xd9) return none; // SOS/EOI: no APP1 before image data
    const length = (buf[pos + 2] << 8) | buf[pos + 3];
    if (length < 2 || pos + 2 + length > buf.length) return none;
    if (marker === 0xe1) {
      const seg = buf.subarray(pos + 4, pos + 2 + length);
      const parsed = parseExifSegment(seg);
      if (parsed) return parsed;
    }
    pos += 2 + length;
  }
  return none;
}

/** @param {Uint8Array} seg - APP1 payload (after the length bytes). */
function parseExifSegment(seg) {
  if (seg.length < 14) return null;
  if (String.fromCharCode(seg[0], seg[1], seg[2], seg[3]) !== 'Exif' || seg[4] !== 0 || seg[5] !== 0) return null;
  const tiff = seg.subarray(6);
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  const be = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!le && !be) return null;
  const u16 = (o) => (o + 2 <= tiff.length ? (le ? tiff[o] | (tiff[o + 1] << 8) : (tiff[o] << 8) | tiff[o + 1]) : NaN);
  const u32 = (o) => (o + 4 <= tiff.length
    ? (le
      ? (tiff[o] | (tiff[o + 1] << 8) | (tiff[o + 2] << 16) | (tiff[o + 3] << 24)) >>> 0
      : ((tiff[o] << 24) | (tiff[o + 1] << 16) | (tiff[o + 2] << 8) | tiff[o + 3]) >>> 0)
    : NaN);
  if (u16(2) !== 0x2a) return null;
  const ifd = u32(4);
  const count = u16(ifd);
  if (!Number.isFinite(count) || count > 512) return null;
  let make = null;
  let model = null;
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    const tag = u16(e);
    const type = u16(e + 2);
    const n = u32(e + 4);
    if (tag !== 0x010f && tag !== 0x0110) continue;
    if (type !== 2 || !Number.isFinite(n) || n === 0 || n > 256) continue;
    const start = n <= 4 ? e + 8 : u32(e + 8);
    if (!Number.isFinite(start) || start + n > tiff.length) continue;
    const text = Buffer.from(tiff.subarray(start, start + n)).toString('latin1').replace(/\0+$/, '').trim();
    if (!text) continue;
    if (tag === 0x010f) make = text;
    else model = text;
  }
  return make || model ? { make, model } : null;
}
