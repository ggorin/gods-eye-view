import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJpegMakeModel } from '../../server/providers/common/jpeg-exif.js';

/** Build a JPEG with one APP1 Exif segment holding Make/Model in IFD0. */
function jpegWithExif({ make = 'AXIS', model = 'Q6055-E', littleEndian = false } = {}) {
  const makeBytes = Buffer.from(`${make}\0`, 'latin1');
  const modelBytes = Buffer.from(`${model}\0`, 'latin1');
  const entries = 2;
  const ifdOffset = 8;
  const dataStart = ifdOffset + 2 + entries * 12 + 4;
  const tiff = Buffer.alloc(dataStart + makeBytes.length + modelBytes.length);
  const w16 = (o, v) => (littleEndian ? tiff.writeUInt16LE(v, o) : tiff.writeUInt16BE(v, o));
  const w32 = (o, v) => (littleEndian ? tiff.writeUInt32LE(v, o) : tiff.writeUInt32BE(v, o));
  tiff.write(littleEndian ? 'II' : 'MM', 0, 'latin1');
  w16(2, 0x2a);
  w32(4, ifdOffset);
  w16(ifdOffset, entries);
  let e = ifdOffset + 2;
  const entry = (tag, count, valueOrOffset, inline) => {
    w16(e, tag); w16(e + 2, 2); w32(e + 4, count);
    if (inline) tiff.write(valueOrOffset, e + 8, 'latin1'); else w32(e + 8, valueOrOffset);
    e += 12;
  };
  entry(0x010f, makeBytes.length, dataStart, false);
  entry(0x0110, modelBytes.length, dataStart + makeBytes.length, false);
  w32(e, 0);
  makeBytes.copy(tiff, dataStart);
  modelBytes.copy(tiff, dataStart + makeBytes.length);
  const app1Payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(app1Payload.length + 2) >> 8, (app1Payload.length + 2) & 0xff]), app1Payload]);
  // A leading APP0 (JFIF) segment before APP1, as real camera JPEGs have.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, app1, Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])]);
}

test('reads Make and Model from a big-endian Exif IFD0', () => {
  assert.deepEqual(parseJpegMakeModel(jpegWithExif()), { make: 'AXIS', model: 'Q6055-E' });
});

test('reads Make and Model from a little-endian Exif IFD0', () => {
  assert.deepEqual(parseJpegMakeModel(jpegWithExif({ make: 'AXIS', model: 'P5655-E', littleEndian: true })), { make: 'AXIS', model: 'P5655-E' });
});

test('returns nulls for JPEGs without Exif and for non-JPEG bytes', () => {
  const plain = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
  assert.deepEqual(parseJpegMakeModel(plain), { make: null, model: null });
  assert.deepEqual(parseJpegMakeModel(Buffer.from('<html>')), { make: null, model: null });
  assert.deepEqual(parseJpegMakeModel(Buffer.alloc(0)), { make: null, model: null });
  assert.deepEqual(parseJpegMakeModel(null), { make: null, model: null });
});

test('never throws on a truncated segment', () => {
  const full = jpegWithExif();
  for (let cut = 0; cut < full.length; cut += 7) {
    assert.doesNotThrow(() => parseJpegMakeModel(full.subarray(0, cut)));
  }
});
