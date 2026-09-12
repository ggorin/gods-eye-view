import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNycdotCatalogPayload } from '../../vite.config.js';

const IMAGE = (id) => `https://webcams.nyctmc.org/api/cameras/${id}/image`;

/** One online row in the shape webcams.nyctmc.org/api/cameras returns. */
function cameraRow(overrides = {}) {
  const id = overrides.id ?? '8a6bc417-4877-4ebe-8052-88c1b261baf1';
  return {
    id,
    name: 'Central Park West @ 86 St',
    latitude: 40.785302,
    longitude: -73.969353,
    area: 'Manhattan',
    isOnline: 'true',
    imageUrl: IMAGE(id),
    ...overrides,
  };
}

test('NYC DOT catalog keeps only online cameras with finite in-city coordinates', () => {
  const cameras = normalizeNycdotCatalogPayload([
    cameraRow({ id: 'a', name: 'a' }),
    cameraRow({ id: 'b', name: 'b', isOnline: 'false' }),
    cameraRow({ id: 'c', name: 'c', isOnline: false }),
    cameraRow({ id: 'd', name: 'd', latitude: null }),
    cameraRow({ id: 'e', name: 'e', longitude: 'not-a-number' }),
    cameraRow({ id: 'f', name: 'f', latitude: 0, longitude: 0 }),
    cameraRow({ id: 'g', name: 'g', latitude: '40.78', longitude: '-73.97' }),
    cameraRow({ id: 'h', name: 'h', latitude: 42.6526, longitude: -73.7562 }), // Albany
    null,
    'garbage',
  ]);

  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].name, 'a');
  assert.equal(cameras[0].id, 'nycdot-a');
  assert.equal(cameras[0].provider, 'NYC DOT');
  assert.equal(cameras[0].cityId, 'nyc');
  assert.equal(cameras[0].city, 'Manhattan, NYC');
  assert.equal(cameras[0].feedType, 'image');
  assert.equal(cameras[0].sourceKind, 'nycdot-tmc');
  assert.equal(cameras[0].url, IMAGE('a'));
});

test('NYC DOT catalog accepts a boolean online flag as well as the string', () => {
  const cameras = normalizeNycdotCatalogPayload([cameraRow({ isOnline: true })]);
  assert.equal(cameras.length, 1);
});

test('NYC DOT catalog pins frames to the official origin', () => {
  const cameras = normalizeNycdotCatalogPayload([
    cameraRow({ id: 'ok' }),
    cameraRow({ id: 'cdn', imageUrl: 'https://cdn.example.com/cameras/cdn/image' }),
    cameraRow({ id: 'http', imageUrl: 'http://webcams.nyctmc.org/api/cameras/http/image' }),
    cameraRow({ id: 'lookalike', imageUrl: 'https://webcams.nyctmc.org.evil.example/api/cameras/x/image' }),
    cameraRow({ id: 'empty', imageUrl: '' }),
  ]);

  assert.deepEqual(cameras.map((c) => c.id), ['nycdot-ok']);
});

test('NYC DOT catalog dedupes repeated ids', () => {
  const cameras = normalizeNycdotCatalogPayload([
    cameraRow({ id: 'twice', name: 'first' }),
    cameraRow({ id: 'twice', name: 'second' }),
  ]);

  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].name, 'first');
});

test('NYC DOT heading comes from an explicit travel token, never a street-name cardinal', () => {
  const [eastbound, westbound, west, northern, plain] = normalizeNycdotCatalogPayload([
    cameraRow({ id: 'eb', name: 'BQE EB @ Atlantic Ave' }),
    cameraRow({ id: 'wb', name: 'Westbound LIE @ Van Dam St' }),
    cameraRow({ id: 'west', name: 'West St @ Chambers St' }),
    cameraRow({ id: 'northern', name: 'Northern Blvd @ 61 St' }),
    cameraRow({ id: 'plain', name: 'FDR Drive @ 122 St' }),
  ]);
  const [thruway] = normalizeNycdotCatalogPayload([
    cameraRow({ id: 'ne', name: 'NE Thruway @ Conner St' }), // New England Thruway
  ]);

  assert.equal(eastbound.headingDeg, 90);
  assert.equal(eastbound.headingConfidence, 'high');
  assert.equal(westbound.headingDeg, 270);
  assert.equal(westbound.headingConfidence, 'high');

  for (const camera of [west, northern, plain, thruway]) {
    assert.equal(camera.headingConfidence, 'low', `${camera.name} must not claim a heading`);
    assert.ok(Number.isFinite(camera.headingDeg), 'headingless cameras still get a stable fallback');
  }
});

test('NYC DOT camera ids and fallback headings are stable across runs', () => {
  const build = () => normalizeNycdotCatalogPayload([cameraRow({ id: 'stable', name: 'Plain' })])[0];
  const first = build();
  const second = build();

  assert.equal(first.id, second.id);
  assert.equal(first.headingDeg, second.headingDeg);
});

test('NYC DOT ground elevation uses a per-borough prior', () => {
  const at = (area) => normalizeNycdotCatalogPayload([cameraRow({ area })])[0].groundElevationM;

  assert.equal(at('Manhattan'), 12);
  assert.equal(at('Staten Island'), 30);
  assert.equal(at('Bronx'), 28);
  assert.equal(at(''), 15, 'unknown borough falls back to the city prior');
  assert.equal(normalizeNycdotCatalogPayload([cameraRow({ area: '' })])[0].city, 'New York City');
});

test('NYC DOT catalog tolerates a malformed payload', () => {
  assert.deepEqual(normalizeNycdotCatalogPayload(null), []);
  assert.deepEqual(normalizeNycdotCatalogPayload({}), []);
  assert.deepEqual(normalizeNycdotCatalogPayload('[]'), []);
  assert.deepEqual(normalizeNycdotCatalogPayload([{}]), []);
});
