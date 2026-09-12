import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCaptionFacing } from '../../server/providers/common/caption-facing.js';

test('reads the eight compass facings from a caption', () => {
  assert.deepEqual(parseCaptionFacing('Facing West Sat Sep 12 2026 06:16:41 AM'), { facing: 'west', headingDeg: 270 });
  assert.deepEqual(parseCaptionFacing('Facing North 2026-09-12 06:17:53 AM'), { facing: 'north', headingDeg: 0 });
  assert.deepEqual(parseCaptionFacing('Facing South Sat >Ep 12 2026'), { facing: 'south', headingDeg: 180 });
  assert.deepEqual(parseCaptionFacing('Facing East 2026-09-12'), { facing: 'east', headingDeg: 90 });
  assert.deepEqual(parseCaptionFacing('Facing Northeast Sat'), { facing: 'northeast', headingDeg: 45 });
  assert.deepEqual(parseCaptionFacing('Facing South-West 09/12/26'), { facing: 'southwest', headingDeg: 225 });
});

test('tolerates the bitmap-font misreads OCR produces', () => {
  assert.equal(parseCaptionFacing('Facing Wiest Sat >Ep 12 2026 06:17:57 AM :')?.facing, 'west');
  assert.equal(parseCaptionFacing('Facing Wiest 2026-09-12 06:17:57 AM')?.facing, 'west');
  assert.equal(parseCaptionFacing('Facing Nortn Sat Sep 12')?.facing, 'north');
  assert.equal(parseCaptionFacing('Facing Eest 2026')?.facing, 'east');
  assert.equal(parseCaptionFacing('Facing West | j Sat Sep 12')?.facing, 'west');
});

test('refuses captions without a facing and junk after the keyword', () => {
  assert.equal(parseCaptionFacing('Sat Sep 12 2026 06:17:53 AM'), null);
  assert.equal(parseCaptionFacing('09/12/2026 06:17:55 AM'), null);
  assert.equal(parseCaptionFacing('tA ee:'), null);
  assert.equal(parseCaptionFacing('Facing 2026-09-12'), null);
  assert.equal(parseCaptionFacing('Facing Qwerty Sat'), null);
  assert.equal(parseCaptionFacing(''), null);
  assert.equal(parseCaptionFacing(null), null);
});
