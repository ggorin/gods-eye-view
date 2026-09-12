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

// ---- Pose enrichment: 511NY facings and the camera-model registry ----------

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  build511nyFacingIndex,
  loadNycdotModelRegistry,
  nearest511nyFacing,
} from '../../vite.config.js';

const ny511Row = (overrides = {}) => ({
  ID: 'Skyline-2003',
  Name: 'I-278 at Lee Avenue',
  Latitude: 40.70537,
  Longitude: -73.95441,
  DirectionOfTravel: 'Westbound',
  RoadwayName: 'Brooklyn Queens Expressway (I-278)',
  Disabled: false,
  ...overrides,
});

test('511NY index keeps only rows with a cardinal facing and finite coordinates', () => {
  const index = build511nyFacingIndex([
    ny511Row(),
    ny511Row({ ID: 'unknown', DirectionOfTravel: 'Unknown' }),
    ny511Row({ ID: 'both', DirectionOfTravel: 'Both Directions' }),
    ny511Row({ ID: 'inbound', DirectionOfTravel: 'Inbound' }),
    ny511Row({ ID: 'nolat', Latitude: null }),
    ny511Row({ ID: 'strlat', Latitude: '40.7' }),
    ny511Row({ ID: 'disabled-but-facing', Disabled: true, DirectionOfTravel: 'Northbound' }),
    null,
  ]);

  assert.equal(index.size, 2, 'the facing row and the disabled facing row');
  assert.equal(build511nyFacingIndex(null).size, 0);
  assert.equal(build511nyFacingIndex({}).size, 0);
});

test('511NY nearest facing respects the join radius and prefers the closest row', () => {
  const index = build511nyFacingIndex([
    ny511Row({ ID: 'near', Latitude: 40.70537, Longitude: -73.95441, DirectionOfTravel: 'Westbound' }),
    ny511Row({ ID: 'nearer', Latitude: 40.70540, Longitude: -73.95441, DirectionOfTravel: 'Eastbound' }),
    ny511Row({ ID: 'far', Latitude: 40.70700, Longitude: -73.95441, DirectionOfTravel: 'Southbound' }),
  ]);

  const hit = nearest511nyFacing(index, 40.70541, -73.95441);
  assert.equal(hit?.id, 'nearer');
  assert.equal(hit?.headingDeg, 90);
  assert.ok(hit.distanceM < 5);

  // 'far' sits ~55 m north of this point (0.0005° lat) and the others ~120 m
  // south: nothing inside the 30 m default, 'far' inside 100 m.
  assert.equal(nearest511nyFacing(index, 40.70650, -73.95441), null);
  assert.equal(nearest511nyFacing(index, 40.70650, -73.95441, 100)?.id, 'far');
  assert.equal(nearest511nyFacing(null, 40.7, -73.9), null);
  assert.equal(nearest511nyFacing(build511nyFacingIndex([]), 40.7, -73.9), null);
});

test('511NY facing fills a heading only when the name has no token', () => {
  const facingIndex = build511nyFacingIndex([ny511Row({ Latitude: 40.785302, Longitude: -73.969353, DirectionOfTravel: 'Southbound' })]);
  const [plain, tokened, unmatched] = normalizeNycdotCatalogPayload([
    cameraRow({ id: 'plain', name: 'Central Park West @ 86 St' }),
    cameraRow({ id: 'tokened', name: 'Central Park West NB @ 86 St' }),
    cameraRow({ id: 'unmatched', name: 'FDR Drive @ 122 St', latitude: 40.80, longitude: -73.93 }),
  ], { facingIndex });

  assert.equal(plain.headingDeg, 180);
  assert.equal(plain.headingConfidence, 'high');
  assert.equal(plain.headingProvenance, '511ny');
  assert.equal(plain.fovDeg, 56, 'a real facing earns the confident personality');

  assert.equal(tokened.headingDeg, 0, 'the explicit token wins over the join');
  assert.equal(tokened.headingProvenance, 'name');

  assert.equal(unmatched.headingConfidence, 'low');
  assert.equal(unmatched.headingProvenance, 'fallback');
});

test('camera-model registry sets the datasheet FOV and the PTZ flag', () => {
  const models = {
    'q6055': { make: 'AXIS', model: 'Q6055-E' },
    'q6075': { make: 'AXIS', model: 'Q6075-E' },
    'p5655': { make: 'AXIS', model: 'P5655-E' },
    'm5525': { make: 'AXIS', model: 'M5525-E' },
    'other': { make: 'Bosch', model: 'MIC IP' },
    'blank': { make: '', model: null },
  };
  const byId = Object.fromEntries(normalizeNycdotCatalogPayload([
    cameraRow({ id: 'q6055' }), cameraRow({ id: 'q6075' }), cameraRow({ id: 'p5655' }),
    cameraRow({ id: 'm5525' }), cameraRow({ id: 'other' }), cameraRow({ id: 'blank' }), cameraRow({ id: 'unlisted' }),
  ], { models }).map((camera) => [camera.id.replace(/^nycdot-/, ''), camera]));

  assert.equal(byId.q6055.fovDeg, 62.8);
  assert.equal(byId.q6055.cameraModel, 'AXIS Q6055-E');
  assert.equal(byId.q6055.ptz, true);
  assert.equal(byId.q6075.fovDeg, 65.1);
  assert.equal(byId.p5655.fovDeg, 58.3);
  assert.equal(byId.p5655.ptz, true);
  assert.equal(byId.m5525.ptz, true, 'M55xx is a PTZ family without a FOV entry');
  assert.equal(byId.m5525.fovDeg, 44);

  assert.equal(byId.other.cameraModel, 'Bosch MIC IP');
  assert.equal(byId.other.ptz, false);
  assert.equal(byId.other.fovDeg, 44, 'unknown model keeps the personality prior');

  assert.equal(byId.blank.cameraModel, undefined);
  assert.equal(byId.unlisted.cameraModel, undefined);
  assert.equal(byId.unlisted.ptz, undefined);
});

test('camera-model registry file is optional and malformed content is ignored', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nycdot-models-'));
  const good = path.join(dir, 'good.json');
  writeFileSync(good, JSON.stringify({ generatedAt: 'x', cameras: { abc: { make: 'AXIS', model: 'Q6055-E' } } }));
  assert.deepEqual(loadNycdotModelRegistry(good), { abc: { make: 'AXIS', model: 'Q6055-E' } });

  const bad = path.join(dir, 'bad.json');
  writeFileSync(bad, '{not json');
  assert.deepEqual(loadNycdotModelRegistry(bad), {});

  const wrongShape = path.join(dir, 'shape.json');
  writeFileSync(wrongShape, JSON.stringify({ cameras: ['a', 'b'] }));
  assert.deepEqual(loadNycdotModelRegistry(wrongShape), {});

  assert.deepEqual(loadNycdotModelRegistry(path.join(dir, 'missing.json')), {});
});

// ---- 511NY pack -------------------------------------------------------------

import { normalizeNy511CatalogPayload } from '../../vite.config.js';

const ny511PackRow = (overrides = {}) => ({
  ID: 'Skyline-2003',
  Name: 'I-278 at Lee Avenue',
  Latitude: 40.70537,
  Longitude: -73.95441,
  DirectionOfTravel: 'Westbound',
  RoadwayName: 'Brooklyn Queens Expressway (I-278) [Kings]',
  Url: 'https://511ny.org/map/Cctv/2003',
  VideoUrl: 'https://s9.nysdot.skyvdn.com/rtplive/R11_123/playlist.m3u8',
  Disabled: false,
  Blocked: false,
  ...overrides,
});

test('511NY pack keeps enabled, unblocked, in-region rows with an official still page', () => {
  const cameras = normalizeNy511CatalogPayload([
    ny511PackRow({ ID: 'ok' }),
    ny511PackRow({ ID: 'disabled', Disabled: true }),
    ny511PackRow({ ID: 'blocked', Blocked: true }),
    ny511PackRow({ ID: 'nolat', Latitude: null }),
    ny511PackRow({ ID: 'strlon', Longitude: '-73.9' }),
    ny511PackRow({ ID: 'null-island', Latitude: 0, Longitude: 0 }),
    ny511PackRow({ ID: 'albany', Latitude: 42.6526, Longitude: -73.7562 }),
    ny511PackRow({ ID: 'other-host', Url: 'https://example.com/map/Cctv/9' }),
    ny511PackRow({ ID: 'no-url', Url: '' }),
    ny511PackRow({ ID: 'ok', Name: 'duplicate id' }),
    null,
  ]);

  assert.deepEqual(cameras.map((c) => c.id), ['ny511-ok']);
  const [camera] = cameras;
  assert.equal(camera.provider, 'NYSDOT 511NY');
  assert.equal(camera.sourceKind, 'ny511-open-data');
  assert.equal(camera.feedType, 'image');
  assert.equal(camera.url, 'https://511ny.org/map/Cctv/2003', 'the map page is the still');
  assert.equal(camera.city, 'Brooklyn Queens Expressway (I-278)', 'county suffix stripped');
  assert.equal(camera.cityId, 'nyc');
  assert.equal(camera.groundElevationM, 15);
});

test('511NY pack statewide keeps upstate rows with the statewide prior', () => {
  const cameras = normalizeNy511CatalogPayload([
    ny511PackRow({ ID: 'albany', Latitude: 42.6526, Longitude: -73.7562, RoadwayName: '' }),
  ], { statewide: true });

  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].cityId, 'ny');
  assert.equal(cameras[0].city, 'New York State');
  assert.equal(cameras[0].groundElevationM, 120);
});

test('511NY pack takes a cardinal DirectionOfTravel as a high-confidence heading', () => {
  const [west, unknown, both] = normalizeNy511CatalogPayload([
    ny511PackRow({ ID: 'w', DirectionOfTravel: 'Westbound' }),
    ny511PackRow({ ID: 'u', DirectionOfTravel: 'Unknown' }),
    ny511PackRow({ ID: 'b', DirectionOfTravel: 'Both Directions' }),
  ]);

  assert.equal(west.headingDeg, 270);
  assert.equal(west.headingConfidence, 'high');
  assert.equal(west.headingProvenance, '511ny');
  assert.equal(west.mountHeightM, 12);
  for (const camera of [unknown, both]) {
    assert.equal(camera.headingConfidence, 'low');
    assert.equal(camera.headingProvenance, 'fallback');
    assert.ok(Number.isFinite(camera.headingDeg));
  }
});

test('511NY pack drops rows on the same mount as an NYC DOT camera', () => {
  const nycdot = [{ lat: 40.70537, lon: -73.95441 }];
  const cameras = normalizeNy511CatalogPayload([
    ny511PackRow({ ID: 'shared' }), // 0 m from the city camera
    ny511PackRow({ ID: 'across', Latitude: 40.70580 }), // ~48 m: opposite carriageway, kept
  ], { excludeNear: nycdot });

  assert.deepEqual(cameras.map((c) => c.id), ['ny511-across']);
  assert.equal(normalizeNy511CatalogPayload([ny511PackRow({ ID: 'shared' })], { excludeNear: [] }).length, 1);
  assert.equal(normalizeNy511CatalogPayload([ny511PackRow({ ID: 'shared' })], { excludeNear: null }).length, 1);
});

test('511NY pack ids are sanitized and stable', () => {
  const build = () => normalizeNy511CatalogPayload([ny511PackRow({ ID: 'NYSDOT-01o3upkjrwu' })])[0];
  assert.equal(build().id, 'ny511-nysdot-01o3upkjrwu');
  assert.equal(build().headingDeg, build().headingDeg);
  assert.deepEqual(normalizeNy511CatalogPayload(null), []);
  assert.deepEqual(normalizeNy511CatalogPayload({}), []);
  assert.deepEqual(normalizeNy511CatalogPayload([{}]), []);
});

// ---- Road snap applied to pack cameras --------------------------------------

import { applyRoadSnap } from '../../vite.config.js';
import { buildRoadIndex } from '../../server/providers/common/road-snap.js';

test('road snap moves high-confidence cameras onto the agreeing carriageway and keeps the rest', () => {
  // Eastbound lanes running NNE; the camera sits 25 m east of them saying "Eastbound".
  const index = buildRoadIndex([
    { id: 'eb', name: 'BQE', travel: 'forward', coords: [[40.7000, -73.9900], [40.7040, -73.9876]] },
  ]);
  const cameras = [
    { id: 'a', lat: 40.7020, lon: -73.9885, headingDeg: 90, headingConfidence: 'high', headingProvenance: '511ny' },
    { id: 'b', lat: 40.7020, lon: -73.9885, headingDeg: 90, headingConfidence: 'low', headingProvenance: 'fallback' },
    { id: 'c', lat: 40.7020, lon: -73.9885, headingDeg: 270, headingConfidence: 'high', headingProvenance: 'name' }, // no westbound lanes here
    { id: 'd', lat: 40.7300, lon: -73.9885, headingDeg: 90, headingConfidence: 'high', headingProvenance: '511ny' }, // 3 km away
  ];

  assert.equal(applyRoadSnap(cameras, index), 1);
  const [a, b, c, d] = cameras;
  assert.ok(a.headingDeg > 15 && a.headingDeg < 35, `true bearing, got ${a.headingDeg}`);
  assert.equal(a.headingProvenance, '511ny+road');
  assert.equal(a.sourceLon, -73.9885, 'catalog point preserved');
  assert.notEqual(a.lon, -73.9885, 'mount moved');
  assert.ok(a.roadSnappedM > 5 && a.roadSnappedM < 80);
  for (const untouched of [b, c, d]) {
    assert.equal(untouched.lon, -73.9885);
    assert.equal(untouched.roadSnappedM, undefined);
    assert.ok(!String(untouched.headingProvenance).endsWith('+road'));
  }
  assert.equal(b.headingDeg, 90);
  assert.equal(c.headingDeg, 270);

  assert.equal(applyRoadSnap(cameras, null), 0);
  assert.equal(applyRoadSnap(null, index), 0);
});
