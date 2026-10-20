// looks for a shadier street near the fastest route that google's own alternatives missed.
// only runs on a new search, leave time changes just rescore whatever detour we already found

// first pass, all of these are guesses til we've actually walked a few
const DETOUR_FRACTIONS = [1 / 3, 1 / 2, 2 / 3]; // where along the fastest route to look
const DETOUR_OFFSETS_M = [150, 300, 500]; // how far off to the side to check
const DETOUR_SAMPLE_RADIUS_M = 50; // average shade/canopy over roughly this big a patch
const DETOUR_KEEP_COUNT = 3; // best candidates worth actually routing through
const DETOUR_MIN_SEPARATION_M = 300; // candidates closer than this to a kept one get skipped
const DETOUR_MAX_REQUESTS = 3; // route requests burn quota, hard cap per search
const DETOUR_MIN_SCORE_IMPROVEMENT = 0.15; // needs to beat the best route's score by this much
const DETOUR_MAX_OVERLAP_FRAC = 0.8; // this much overlap with an existing route = not a real option

const OVERLAP_SAMPLE_STRIDE = 5;
const OVERLAP_DIST_M = 25; // within this = "same street" for overlap purposes

let detourDebugMarkers = [];

function debugDetoursOn() {
  return new URLSearchParams(location.search).get('debugdetours') === '1';
}

function showDetourStatus() {
  document.getElementById('detour-status').hidden = false;
}

function hideDetourStatus() {
  document.getElementById('detour-status').hidden = true;
}

function clearDetourMarkers() {
  detourDebugMarkers.forEach(m => m.setMap(null));
  detourDebugMarkers = [];
}

function bearingAt(samples, idx) {
  const a = samples[Math.max(0, idx - 1)];
  const b = samples[Math.min(samples.length - 1, idx + 1)];
  const toRad = Math.PI / 180;
  const lat1 = a.lat * toRad, lat2 = b.lat * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

// standard great circle destination point, gets us a lat/lng N meters away at a given bearing
function offsetPoint(lat, lng, bearingDeg, distM) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const brng = bearingDeg * toRad;
  const lat1 = lat * toRad, lng1 = lng * toRad;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(distM / R) + Math.cos(lat1) * Math.sin(distM / R) * Math.cos(brng));
  const lng2 = lng1 + Math.atan2(
    Math.sin(brng) * Math.sin(distM / R) * Math.cos(lat1),
    Math.cos(distM / R) - Math.sin(lat1) * Math.sin(lat2)
  );
  return { lat: lat2 * (180 / Math.PI), lng: lng2 * (180 / Math.PI) };
}

function areaPoints(lat, lng) {
  const pts = [{ lat, lng }];
  [0, 90, 180, 270].forEach(bearing => pts.push(offsetPoint(lat, lng, bearing, DETOUR_SAMPLE_RADIUS_M)));
  return pts;
}

function buildCandidates(fastestRaw) {
  const samples = fastestRaw.samples;
  const totalDist = samples[samples.length - 1].dist || 1;
  const candidates = [];

  DETOUR_FRACTIONS.forEach(frac => {
    const targetDist = frac * totalDist;
    let idx = 0;
    for (let i = 1; i < samples.length; i++) {
      if (Math.abs(samples[i].dist - targetDist) < Math.abs(samples[idx].dist - targetDist)) idx = i;
    }
    const bearing = bearingAt(samples, idx);
    const base = samples[idx];

    DETOUR_OFFSETS_M.forEach(offsetM => {
      [{ turn: 90, side: 'right' }, { turn: -90, side: 'left' }].forEach(({ turn, side }) => {
        const pt = offsetPoint(base.lat, base.lng, bearing + turn, offsetM);
        candidates.push({ lat: pt.lat, lng: pt.lng, frac, offsetM, side, areaPoints: areaPoints(pt.lat, pt.lng) });
      });
    });
  });

  return candidates;
}

// no separate rooftop flag in the grid, but a rooftop cell has real canopy/anomaly values
// with every shade hour set to nodata (see make_shade.py), that pattern is the real tell
function isRooftopCell(cell) {
  if (!cell || cell.canopy === null || cell.anomaly === null) return false;
  return Object.values(cell.shade).every(v => v === null);
}

function evaluateCandidate(c, fastestRoute) {
  const date = new Date(currentDepartureMs() + c.frac * fastestRoute.durationMillis);

  if (isRooftopCell(c.cells[0])) {
    c.skip = true;
    c.reason = 'rooftop';
    return;
  }

  let shadeSum = 0, canopySum = 0, n = 0;
  c.cells.forEach(cell => {
    if (!cell || cell.anomaly === null || cell.canopy === null) return;
    const shadeFrac = shadeFractionFor(cell, date);
    if (shadeFrac === null) return;
    shadeSum += shadeFrac;
    canopySum += cell.canopy;
    n++;
  });

  if (n === 0) {
    c.skip = true;
    c.reason = 'no data';
    return;
  }
  c.avgShade = shadeSum / n;
  c.avgCanopy = canopySum / n;
}

// shadiest first, then just take the best ones that aren't basically on top of each other
function pickBestCandidates(candidates) {
  const viable = candidates.filter(c => !c.skip).sort((a, b) => b.avgShade - a.avgShade);
  const kept = [];
  viable.forEach(c => {
    if (kept.length >= DETOUR_KEEP_COUNT) return;
    const tooClose = kept.some(k => haversineMeters(k.lat, k.lng, c.lat, c.lng) < DETOUR_MIN_SEPARATION_M);
    if (!tooClose) kept.push(c);
  });
  return kept;
}

function logCandidates(candidates, keptSet) {
  const rows = candidates.map(c => ({
    side: c.side,
    offsetM: c.offsetM,
    pct: Math.round(c.frac * 100),
    status: c.skip ? `skip: ${c.reason}` : (keptSet.has(c) ? 'kept' : 'not kept'),
    shade: c.skip ? null : Math.round(c.avgShade * 100),
    canopy: c.skip ? null : Math.round(c.avgCanopy)
  }));
  console.table(rows);
}

function drawDebugMarkers(candidates, keptSet) {
  candidates.forEach(c => {
    const marker = new google.maps.Marker({
      position: { lat: c.lat, lng: c.lng },
      map: map,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 5,
        fillColor: keptSet.has(c) ? '#2f6fb0' : '#9c2b1f',
        fillOpacity: 0.9,
        strokeWeight: 0
      },
      zIndex: 6
    });
    detourDebugMarkers.push(marker);
  });
}

async function requestDetourRoute(candidate) {
  const { Route } = await google.maps.importLibrary('routes');
  return Route.computeRoutes({
    origin: { lat: state.start.lat, lng: state.start.lng },
    destination: { lat: state.dest.lat, lng: state.dest.lng },
    travelMode: travelMode,
    intermediates: [{ location: { lat: candidate.lat, lng: candidate.lng }, via: true }],
    // legs is the smallest field the api takes that includes steps, cant request a narrower path
    fields: ['path', 'distanceMeters', 'durationMillis', 'viewport', 'routeLabels', 'legs']
  });
}

async function requestAndScoreDetour(candidate) {
  try {
    const result = await requestDetourRoute(candidate);
    const route = result.routes && result.routes[0];
    if (!route) return null;
    const raw = await fetchRouteRawData(route);
    return { route, raw, score: computeRouteScore(route, raw, currentDepartureMs()) };
  } catch (err) {
    console.error('detour route request failed', err);
    return null;
  }
}

// rough but cheap: strides through both paths instead of comparing every single point
function routeOverlapFraction(raw, otherRaws) {
  const samples = raw.samples;
  let total = 0;
  let overlapping = 0;

  for (let i = 0; i < samples.length; i += OVERLAP_SAMPLE_STRIDE) {
    const s = samples[i];
    total++;
    const isClose = otherRaws.some(other => other.samples.some((os, j) =>
      j % OVERLAP_SAMPLE_STRIDE === 0 && haversineMeters(s.lat, s.lng, os.lat, os.lng) < OVERLAP_DIST_M
    ));
    if (isClose) overlapping++;
  }
  return total === 0 ? 0 : overlapping / total;
}

function pickBestDetour(results, fastestDurationMs, bestExistingScore, existingRaws) {
  const viable = results.filter(Boolean).filter(r => {
    if (r.score.coverage < MIN_COVERAGE) return false;
    if (r.route.durationMillis > maxAllowedDurationMs(fastestDurationMs)) return false;
    if (r.score.score > bestExistingScore * (1 - DETOUR_MIN_SCORE_IMPROVEMENT)) return false;
    if (routeOverlapFraction(r.raw, existingRaws) > DETOUR_MAX_OVERLAP_FRAC) return false;
    return true;
  });
  if (!viable.length) return null;
  viable.sort((a, b) => a.score.score - b.score.score);
  return viable[0];
}

function addDetourRoute(best) {
  best.route.isDetour = true;
  routes.push(best.route);
  routeRawData.push(best.raw);
  routeScores.push(best.score);
  drawRoutes();
  pickCoolestRoute();
}

async function findShadyDetour() {
  if (navActive) return; // only ever runs from a fresh search anyway, but just in case
  const requestId = routeRequestId;
  clearDetourMarkers();
  hideDetourStatus();
  if (!state.start || !state.dest) return;

  const fastestIdx = fastestRouteIndex();
  const fastestRoute = routes[fastestIdx];
  const fastestRaw = routeRawData[fastestIdx];
  if (!fastestRoute || !fastestRaw) return;

  const candidates = buildCandidates(fastestRaw);
  const allPoints = [];
  candidates.forEach(c => allPoints.push(...c.areaPoints));

  showDetourStatus();

  let cellsFlat;
  try {
    cellsFlat = await getGridCells(allPoints);
  } catch (err) {
    console.error('detour grid lookup failed', err); // status was stuck on "looking for shadier streets" forever without this
    hideDetourStatus();
    return;
  }
  if (requestId !== routeRequestId) return; // route got cleared/replaced while that was in flight
  let idx = 0;
  candidates.forEach(c => {
    c.cells = c.areaPoints.map(() => cellsFlat[idx++]);
    evaluateCandidate(c, fastestRoute);
  });

  const kept = pickBestCandidates(candidates);
  const keptSet = new Set(kept);

  if (debugDetoursOn()) {
    logCandidates(candidates, keptSet);
    drawDebugMarkers(candidates, keptSet);
  }

  if (!kept.length) {
    hideDetourStatus();
    return;
  }

  const bestExistingScore = Math.min(...routeScores.map(s => s.score));
  const existingRaws = routeRawData.slice();

  const results = await Promise.all(kept.slice(0, DETOUR_MAX_REQUESTS).map(requestAndScoreDetour));
  hideDetourStatus();
  if (requestId !== routeRequestId) return;
  const best = pickBestDetour(results, fastestRoute.durationMillis, bestExistingScore, existingRaws);
  if (best) addDetourRoute(best);
}
