import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  angleDiffDeg,
  bearingDeg,
  buildRoadIndex,
  segmentsFromCscl,
  snapToRoad,
} from '../../server/providers/common/road-snap.js';

// A carriageway running NNE (about 25°) through Brooklyn, one-way in
// coordinate order, plus its opposite carriageway 30 m to the east running SSW.
const NNE = [[40.7000, -73.9900], [40.7020, -73.9888], [40.7040, -73.9876]];
const SSW = NNE.map(([la, lo]) => [la, lo + 0.00036]).reverse();
const roads = [
  { id: 'eb', name: 'BQE eastbound', travel: 'forward', coords: NNE },
  { id: 'wb', name: 'BQE westbound', travel: 'forward', coords: SSW },
];

test('bearing and angle helpers', () => {
  assert.ok(Math.abs(bearingDeg(40.7, -73.99, 40.71, -73.99) - 0) < 0.01, 'north');
  assert.ok(Math.abs(bearingDeg(40.7, -73.99, 40.7, -73.98) - 90) < 0.2, 'east');
  assert.equal(angleDiffDeg(350, 10), 20);
  assert.equal(angleDiffDeg(90, 270), 180);
  assert.equal(angleDiffDeg(45, 45), 0);
});

test('"Eastbound" on a north-running carriageway snaps to the road bearing, not 90°', () => {
  const index = buildRoadIndex(roads);
  // Camera published 40 m east of the eastbound lanes (between the carriageways).
  const hit = snapToRoad(index, 40.7020, -73.9885, 90);
  assert.ok(hit, 'a snap within 80 m');
  assert.equal(hit.segmentId, 'eb', 'the carriageway whose travel agrees with Eastbound');
  assert.ok(Math.abs(hit.headingDeg - bearingDeg(...NNE[0], ...NNE[1])) < 1, 'true bearing of the lanes');
  assert.ok(hit.headingDeg > 15 && hit.headingDeg < 35, `NNE, got ${hit.headingDeg}`);
  assert.ok(hit.distanceM > 5 && hit.distanceM < 80);
  assert.notEqual(hit.lon, -73.9885, 'mount moved onto the centreline');
});

test('"Westbound" picks the opposite carriageway even when it is farther', () => {
  const index = buildRoadIndex(roads);
  const hit = snapToRoad(index, 40.7020, -73.9887, 270); // 8 m from EB, ~25 m from WB
  assert.equal(hit?.segmentId, 'wb');
  assert.ok(hit.headingDeg > 195 && hit.headingDeg < 215, `SSW, got ${hit.headingDeg}`);
});

test('a signed direction that fits no nearby carriageway leaves the prior alone', () => {
  const index = buildRoadIndex(roads);
  // "Northbound" on a road running NNE is fine (25° off) …
  assert.ok(snapToRoad(index, 40.7020, -73.9887, 0));
  // … and so is "Eastbound" (66° off) under the 85° default, but not under a
  // tighter limit; "Southbound" (155° off) never fits the eastbound lanes and
  // the westbound lanes are SSW, so it lands there instead.
  assert.equal(snapToRoad(index, 40.7020, -73.9887, 90, { maxAngleDeg: 60 }), null);
  assert.equal(snapToRoad(index, 40.7020, -73.9887, 180)?.segmentId, 'wb');
  // Out of range: 300 m away.
  assert.equal(snapToRoad(index, 40.7020, -73.9850, 90), null);
  // Empty / malformed inputs.
  assert.equal(snapToRoad(buildRoadIndex([]), 40.7, -73.99, 90), null);
  assert.equal(snapToRoad(null, 40.7, -73.99, 90), null);
  assert.equal(snapToRoad(index, NaN, -73.99, 90), null);
});

test('two-way roads offer both bearings; backward travel reverses coordinate order', () => {
  const twoWay = buildRoadIndex([{ id: 'tw', name: 'Atlantic Ave', travel: 'both', coords: [[40.68, -73.99], [40.68, -73.98]] }]);
  assert.ok(Math.abs(snapToRoad(twoWay, 40.6801, -73.985, 90).headingDeg - 90) < 0.5);
  assert.ok(Math.abs(snapToRoad(twoWay, 40.6801, -73.985, 270).headingDeg - 270) < 0.5);

  const backward = buildRoadIndex([{ id: 'tf', name: 'ramp', travel: 'backward', coords: [[40.68, -73.99], [40.68, -73.98]] }]);
  assert.ok(Math.abs(snapToRoad(backward, 40.6801, -73.985, 270).headingDeg - 270) < 0.5);
  assert.equal(snapToRoad(backward, 40.6801, -73.985, 90), null, 'travel is TF only');
});

test('CSCL rows adapt into segments with travel direction and [lat, lon] coords', () => {
  const rows = [
    { physicalid: '1', full_street_name: 'BQE', trafdir: 'FT', rw_type: '2', the_geom: { type: 'MultiLineString', coordinates: [[[-73.99, 40.70], [-73.98, 40.71]]] } },
    { physicalid: '2', full_street_name: 'BQE', trafdir: 'TF', rw_type: '2', the_geom: { type: 'LineString', coordinates: [[-73.99, 40.70], [-73.98, 40.71]] } },
    { physicalid: '3', full_street_name: 'Two way', trafdir: 'TW', rw_type: '3', the_geom: { type: 'MultiLineString', coordinates: [[[-73.99, 40.70], [-73.98, 40.71]], [[-73.97, 40.72], [-73.96, 40.73]]] } },
    { physicalid: '4', full_street_name: 'Path', trafdir: 'NV', rw_type: '6', the_geom: { type: 'LineString', coordinates: [[-73.99, 40.70], [-73.98, 40.71]] } },
    { physicalid: '5', full_street_name: 'No geom', trafdir: 'FT' },
    { physicalid: '6', full_street_name: 'One point', trafdir: 'FT', the_geom: { type: 'LineString', coordinates: [[-73.99, 40.70]] } },
    null,
  ];
  const segments = segmentsFromCscl(rows);
  assert.deepEqual(segments.map((s) => [s.id, s.travel]), [['1', 'forward'], ['2', 'backward'], ['3/0', 'both'], ['3/1', 'both']]);
  assert.deepEqual(segments[0].coords, [[40.70, -73.99], [40.71, -73.98]]);
  assert.deepEqual(segmentsFromCscl(null), []);
  assert.deepEqual(segmentsFromCscl('x'), []);
});
