/**
 * Road snap for highway cameras with a SIGNED facing.
 *
 * A feed that says a camera faces "Eastbound" names the carriageway, not a
 * compass bearing: I-278 eastbound through Brooklyn runs north-northeast. Read
 * literally, "Eastbound" points the frustum across the neighbourhood instead
 * of down the road. This module resolves the signed direction against real
 * road geometry: find nearby carriageway pieces, keep those whose direction
 * of travel agrees with the signed heading, and take the nearest one's true
 * bearing — and its centreline point as the mount.
 *
 * Pure geometry, no I/O. Segment sources adapt into `RoadSegment` records
 * (see `segmentsFromCscl` for NYC's street centerline).
 *
 * @typedef {object} RoadSegment
 * @property {string} id
 * @property {string} name
 * @property {'forward'|'backward'|'both'} travel - Direction of travel relative to coordinate order.
 * @property {Array<[number, number]>} coords - [lat, lon] pairs, at least two.
 */

const EARTH_RADIUS_M = 6371000;
const CELL_DEG = 0.01;

/** @param {number} deg */
const toRad = (deg) => (deg * Math.PI) / 180;
/** @param {number} rad */
const toDeg = (rad) => (rad * 180) / Math.PI;

/** Initial bearing from A to B, degrees [0, 360). */
export function bearingDeg(latA, lonA, latB, lonB) {
  const φ1 = toRad(latA);
  const φ2 = toRad(latB);
  const Δλ = toRad(lonB - lonA);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest absolute difference between two bearings, degrees [0, 180]. */
export function angleDiffDeg(a, b) {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Nearest point on the segment AB to P, in a local flat frame (fine at the
 * tens-of-metres scale this is used at). Returns the point and distance.
 */
function projectOntoPiece(pLat, pLon, aLat, aLon, bLat, bLon) {
  const kx = Math.cos(toRad(pLat)) * (Math.PI / 180) * EARTH_RADIUS_M;
  const ky = (Math.PI / 180) * EARTH_RADIUS_M;
  const ax = (aLon - pLon) * kx;
  const ay = (aLat - pLat) * ky;
  const bx = (bLon - pLon) * kx;
  const by = (bLat - pLat) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  return {
    lat: pLat + qy / ky,
    lon: pLon + qx / kx,
    distanceM: Math.hypot(qx, qy),
  };
}

/**
 * Index road segments as two-point pieces on a 0.01° grid.
 * @param {Array<RoadSegment>} segments
 * @returns {{cells: Map<string, Array<object>>, pieces: number}}
 */
export function buildRoadIndex(segments) {
  const cells = new Map();
  let pieces = 0;
  for (const segment of Array.isArray(segments) ? segments : []) {
    const coords = Array.isArray(segment?.coords) ? segment.coords : [];
    const travel = segment?.travel === 'backward' || segment?.travel === 'both' ? segment.travel : 'forward';
    for (let i = 0; i + 1 < coords.length; i++) {
      const [aLat, aLon] = coords[i];
      const [bLat, bLon] = coords[i + 1];
      if (![aLat, aLon, bLat, bLon].every(Number.isFinite)) continue;
      const piece = { id: String(segment.id ?? ''), name: String(segment.name ?? ''), travel, aLat, aLon, bLat, bLon };
      // Register in every cell the piece's bounding box touches so a lookup
      // in the neighbouring 3×3 cells always sees it.
      const latCells = [Math.floor(Math.min(aLat, bLat) / CELL_DEG), Math.floor(Math.max(aLat, bLat) / CELL_DEG)];
      const lonCells = [Math.floor(Math.min(aLon, bLon) / CELL_DEG), Math.floor(Math.max(aLon, bLon) / CELL_DEG)];
      for (let cy = latCells[0]; cy <= latCells[1]; cy++) {
        for (let cx = lonCells[0]; cx <= lonCells[1]; cx++) {
          const key = `${cy}:${cx}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(piece);
        }
      }
      pieces++;
    }
  }
  return { cells, pieces };
}

/**
 * Resolve a signed facing against the road index.
 *
 * Candidates are pieces within `maxDistanceM` whose travel bearing (forward,
 * backward, or either for two-way roads) is within `maxAngleDeg` of the signed
 * heading. The nearest candidate wins; its travel bearing is the heading and
 * its projection point is the mount. Null when nothing qualifies — the caller
 * keeps its prior rather than inventing a snap.
 *
 * `maxAngleDeg` defaults to 85: a signed direction can sit almost 90° from
 * the compass (I-278 "eastbound" runs due north through Brooklyn Heights),
 * and 85 still separates the two carriageways, which differ by 180.
 *
 * @param {{cells: Map}|null} index
 * @param {number} lat
 * @param {number} lon
 * @param {number} signedHeadingDeg - Compass reading of the signed direction (Eastbound → 90).
 * @param {{maxDistanceM?: number, maxAngleDeg?: number}} [options]
 * @returns {{lat:number, lon:number, headingDeg:number, distanceM:number, segmentId:string, name:string}|null}
 */
export function snapToRoad(index, lat, lon, signedHeadingDeg, { maxDistanceM = 80, maxAngleDeg = 85 } = {}) {
  if (!index?.cells?.size || ![lat, lon, signedHeadingDeg].every(Number.isFinite)) return null;
  const cy = Math.floor(lat / CELL_DEG);
  const cx = Math.floor(lon / CELL_DEG);
  const seen = new Set();
  let best = null;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const bucket = index.cells.get(`${cy + dy}:${cx + dx}`);
      if (!bucket) continue;
      for (const piece of bucket) {
        if (seen.has(piece)) continue;
        seen.add(piece);
        const projected = projectOntoPiece(lat, lon, piece.aLat, piece.aLon, piece.bLat, piece.bLon);
        if (projected.distanceM > maxDistanceM) continue;
        if (best && projected.distanceM >= best.distanceM) continue;
        const forward = bearingDeg(piece.aLat, piece.aLon, piece.bLat, piece.bLon);
        const candidates = piece.travel === 'both'
          ? [forward, (forward + 180) % 360]
          : [piece.travel === 'backward' ? (forward + 180) % 360 : forward];
        let heading = NaN;
        let bestAngle = Infinity;
        for (const candidate of candidates) {
          const diff = angleDiffDeg(candidate, signedHeadingDeg);
          if (diff <= maxAngleDeg && diff < bestAngle) {
            bestAngle = diff;
            heading = candidate;
          }
        }
        if (!Number.isFinite(heading)) continue;
        best = {
          lat: projected.lat,
          lon: projected.lon,
          headingDeg: Math.round(heading * 10) / 10,
          distanceM: projected.distanceM,
          segmentId: piece.id,
          name: piece.name,
        };
      }
    }
  }
  return best;
}

/**
 * Adapt NYC Street Centerline (CSCL, NYC Open Data `inkn-q76z`) rows.
 * `trafdir`: FT = travel follows coordinate order, TF = against it, TW = both;
 * NV (non-vehicular) and anything else is skipped. Geometry is GeoJSON
 * MultiLineString/LineString in [lon, lat] order.
 *
 * @param {unknown} rows
 * @returns {Array<RoadSegment>}
 */
export function segmentsFromCscl(rows) {
  const segments = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const dir = String(row?.trafdir || '').toUpperCase();
    const travel = dir === 'FT' ? 'forward' : dir === 'TF' ? 'backward' : dir === 'TW' ? 'both' : null;
    if (!travel) continue;
    const geom = row?.the_geom;
    const lines = geom?.type === 'MultiLineString' ? geom.coordinates
      : geom?.type === 'LineString' ? [geom.coordinates] : [];
    for (let i = 0; i < lines.length; i++) {
      const coords = (Array.isArray(lines[i]) ? lines[i] : [])
        .map((pt) => [Number(pt?.[1]), Number(pt?.[0])])
        .filter(([la, lo]) => Number.isFinite(la) && Number.isFinite(lo));
      if (coords.length < 2) continue;
      segments.push({
        id: `${String(row?.physicalid ?? '')}${lines.length > 1 ? `/${i}` : ''}`,
        name: String(row?.full_street_name || '').trim(),
        travel,
        coords,
      });
    }
  }
  return segments;
}
