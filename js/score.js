// scores each route for sun exposure using the grid data, picks the coolest one by default

const SAMPLE_SPACING_M = 10;
const SUN_UP_HOUR = 7; // sun's basically not up before this, call it shaded
const SUN_DOWN_HOUR = 19; // our hourly shade data stops at 19:00
const MAX_DETOUR_RATIO = 1.5; // won't win coolest if its way slower than the fastest route
const MAX_DETOUR_EXTRA_MS = 20 * 60000; // ...or if its just flat out more than 20 min extra, whichever is smaller
const MIN_COVERAGE = 0.5; // need data for at least half the route to trust the score
const HEAT_FACTOR_DIVISOR = 30; // hotter than avg ground counts extra, tune later once i've walked some routes
// TODO: shade data is baked for a july 15 sun angle, prob off by winter

// first pass, these are guesses til i've actually walked some hot days
const IN_SHADE_FRAC = 0.5 // over half shaded at a sample counts as "in shade"
const HOT_ANOM_F = 0 // any sunny sample on hotter than avg ground bumps up from warm
const VERY_HOT_ANOM_F = 8
const MIN_RUN_METERS = 40 // runs shorter than this fold into the last one so the line doesn't flicker

const HEAT_LEVEL_COLORS = {
  cool: '#2f6fb0',
  warm: '#d9a443',
  hot: '#c66a2e',
  'very-hot': '#9c2b1f'
};

const BETTER_TIME_STEP_MIN = 30;
const BETTER_TIME_WINDOW_HOURS = 4;
const BETTER_TIME_SUN_CUT_FRAC = 0.3; // needs to cut sun by at least this fraction...
const BETTER_TIME_MIN_SUN_CUT = 3; // ...and at least this many minutes, so tiny routes don't trigger on noise

let routeScores = [];
let routeRawData = []; // {samples, cells} per route, fetched once and reused when leave time changes
let scoring = false;
let coolestIndex = -1;
let userPickedRoute = false; // true once they tap a route themselves, resets on a new search

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// drops a point every ~10m along the path, filling in gaps between google's own vertices
function sampleRoute(path, spacingM) {
  const samples = [{ lat: path[0].lat, lng: path[0].lng, dist: 0 }];
  let total = 0;

  for (let i = 1; i < path.length; i++) {
    const prevLat = path[i - 1].lat;
    const prevLng = path[i - 1].lng;
    const currLat = path[i].lat;
    const currLng = path[i].lng;
    const segDist = haversineMeters(prevLat, prevLng, currLat, currLng);
    const steps = Math.max(1, Math.round(segDist / spacingM));

    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      total += segDist / steps;
      samples.push({
        lat: prevLat + (currLat - prevLat) * t,
        lng: prevLng + (currLng - prevLng) * t,
        dist: total
      });
    }
  }
  return samples;
}

// blends toward the next hour's map instead of snapping, so 2:30 is halfway between
// the 2pm and 3pm shade and the line/numbers don't jump the second the clock ticks over
function shadeFractionFor(cell, date) {
  const hour = date.getHours();
  if (hour < SUN_UP_HOUR || hour > SUN_DOWN_HOUR) return 1;

  const byteA = cell.shade[hour];
  const byteB = hour < SUN_DOWN_HOUR ? cell.shade[hour + 1] : null;
  if (byteA === null && byteB === null) return null;
  if (byteA === null) return byteB / 100;
  if (byteB === null) return byteA / 100;

  const t = date.getMinutes() / 60;
  return (byteA + (byteB - byteA) * t) / 100;
}

// the expensive part: sample the path and fetch grid chunks. done once per route,
// reused for every rescore (leave time changes, the "now" refresh, the better-time check)
async function fetchRouteRawData(route) {
  const samples = sampleRoute(route.path, SAMPLE_SPACING_M);
  const points = samples.map(s => ({ lat: s.lat, lng: s.lng }));
  const cells = await getGridCells(points);
  return { samples, cells };
}

// the cheap part: turn already-fetched samples/cells into a score for one departure time
function computeRouteScore(route, raw, departureMs) {
  const { samples, cells } = raw;
  const totalDist = samples[samples.length - 1].dist || 1;

  let shadeWeighted = 0;
  let canopyWeighted = 0;
  let anomWeighted = 0;
  let validWeight = 0;
  let sunMs = 0;
  let scoreMs = 0;
  let anyDaylight = false;
  const sampleData = []; // kept around so the route line can be colored later w/o rescoring

  for (let i = 0; i < samples.length; i++) {
    const cell = cells[i];
    const fraction = samples[i].dist / totalDist;
    const sampleDate = new Date(departureMs + fraction * route.durationMillis);
    const hour = sampleDate.getHours();
    if (hour >= SUN_UP_HOUR && hour <= SUN_DOWN_HOUR) anyDaylight = true;

    let shadeFrac = null;
    let anomaly = null;
    if (cell && cell.anomaly !== null && cell.canopy !== null) {
      shadeFrac = shadeFractionFor(cell, sampleDate);
      anomaly = cell.anomaly;
    }
    sampleData.push({ lat: samples[i].lat, lng: samples[i].lng, dist: samples[i].dist, shadeFrac, anomaly });

    if (i === 0 || shadeFrac === null) continue;

    const weight = samples[i].dist - samples[i - 1].dist;
    const stepMs = (weight / totalDist) * route.durationMillis;

    shadeWeighted += weight * shadeFrac;
    canopyWeighted += weight * cell.canopy;
    anomWeighted += weight * anomaly;
    validWeight += weight;

    const sunFrac = 1 - shadeFrac;
    sunMs += stepMs * sunFrac;
    const heatFactor = 1 + Math.max(0, anomaly) / HEAT_FACTOR_DIVISOR;
    scoreMs += stepMs * sunFrac * heatFactor;
  }

  if (validWeight === 0) {
    return {
      shadePct: 0, canopyPct: 0, groundAnom: 0, sunMinutes: 0, score: Infinity, coverage: 0,
      samples: sampleData, afterDark: !anyDaylight
    };
  }

  return {
    shadePct: (shadeWeighted / validWeight) * 100,
    canopyPct: canopyWeighted / validWeight,
    groundAnom: anomWeighted / validWeight,
    sunMinutes: sunMs / 60000,
    score: scoreMs / 60000,
    coverage: validWeight / totalDist,
    samples: sampleData,
    afterDark: !anyDaylight
  };
}

function currentDepartureMs() {
  return state.leaveTimeMs === null ? Date.now() : state.leaveTimeMs;
}

function heatLevel(shadeFrac, anomaly) {
  if (shadeFrac >= IN_SHADE_FRAC) return 'cool';
  if (anomaly >= VERY_HOT_ANOM_F) return 'very-hot';
  if (anomaly > HOT_ANOM_F) return 'hot';
  return 'warm';
}

// groups samples into same-color runs, folding short blips into the run before them
function buildRuns(samples) {
  let lastLevel = 'cool';
  const levels = samples.map(s => {
    if (s.shadeFrac === null) return lastLevel; // no data here, just carry on w/ whatever we had
    lastLevel = heatLevel(s.shadeFrac, s.anomaly);
    return lastLevel;
  });

  const runs = [];
  let start = 0;
  for (let i = 1; i <= samples.length; i++) {
    if (i === samples.length || levels[i] !== levels[start]) {
      runs.push({ start, end: i - 1, level: levels[start] });
      start = i;
    }
  }

  const merged = [];
  runs.forEach(run => {
    const lenM = samples[run.end].dist - samples[run.start].dist;
    if (merged.length && lenM < MIN_RUN_METERS) {
      merged[merged.length - 1].end = run.end;
    } else {
      merged.push(run);
    }
  });

  return merged.map(run => ({
    level: run.level,
    path: samples.slice(run.start, run.end + 1).map(s => ({ lat: s.lat, lng: s.lng }))
  }));
}

// recolors the selected route from its stored samples, no rescoring or refetching.
// nav.js owns the route coloring once navigating (walked vs remaining), so stay out of its way
function colorSelectedRoute() {
  if (navActive) return;
  routes.forEach((route, i) => clearRouteSegments(i));

  const s = routeScores[selectedRouteIndex];
  if (!s || !s.samples || s.afterDark) return;

  drawRouteSegments(selectedRouteIndex, buildRuns(s.samples));
}

function pickCoolestRoute() {
  const fastestMs = Math.min(...routes.map(r => r.durationMillis));
  let bestIndex = 0;
  let bestScore = Infinity;

  routes.forEach((route, i) => {
    const s = routeScores[i];
    if (!s || s.coverage < MIN_COVERAGE) return;
    if (route.durationMillis > maxAllowedDurationMs(fastestMs)) return;
    if (s.score < bestScore) {
      bestScore = s.score;
      bestIndex = i;
    }
  });

  coolestIndex = bestIndex;
  if (userPickedRoute) {
    // they picked their own route already, just refresh its line/cards, don't yank the selection
    colorSelectedRoute();
    renderRouteCards();
  } else {
    selectRoute(bestIndex);
  }
}

// 1.5x alone was way too loose on long trips, a 4hr walk could pick a route 2hrs longer.
// capped at whichever is smaller so short trips still get some slack
function maxAllowedDurationMs(fastestMs) {
  return Math.min(fastestMs * MAX_DETOUR_RATIO, fastestMs + MAX_DETOUR_EXTRA_MS);
}

function fastestRouteIndex() {
  let best = 0;
  routes.forEach((r, i) => { if (r.durationMillis < routes[best].durationMillis) best = i; });
  return best;
}

// the heat line on a route card, routes.js calls this
function routeCardHeatLine(i) {
  if (scoring) return 'checking shade...';
  const s = routeScores[i];
  if (!s) return '';
  if (s.afterDark) return 'after dark, shade does not matter much right now';
  const anomStr = (s.groundAnom >= 0 ? '+' : '') + Math.round(s.groundAnom) + '°';
  return `${Math.round(s.shadePct)}% shade · ${anomStr} ground`;
}

function routeTags(i) {
  if (scoring) return '';
  const isFastest = i === fastestRouteIndex();
  const isCoolest = i === coolestIndex;
  if (isFastest && isCoolest) return 'fastest and coolest';
  if (isCoolest) return 'coolest';
  if (isFastest) return 'fastest';
  return '';
}

// trade off vs the fastest route, in plain words. skipped for the fastest card itself
function routeComparisonText(i) {
  if (scoring) return '';
  const fastestIndex = fastestRouteIndex();
  if (i === fastestIndex) return '';

  const s = routeScores[i];
  const fastest = routeScores[fastestIndex];
  if (!s || !fastest) return '';

  const minutesLonger = Math.round((routes[i].durationMillis - routes[fastestIndex].durationMillis) / 60000);
  const sunDiff = fastest.sunMinutes - s.sunMinutes; // + means less sun than the fastest route
  const anomDiff = fastest.groundAnom - s.groundAnom; // + means cooler ground than the fastest route

  const parts = [];
  if (minutesLonger >= 1) parts.push(`${minutesLonger} min longer`);

  if (Math.abs(sunDiff) < 2 && Math.abs(anomDiff) < 1) {
    parts.push('about the same heat as the fastest');
  } else {
    if (Math.abs(sunDiff) >= 2) {
      parts.push(`${Math.round(Math.abs(sunDiff))} ${sunDiff > 0 ? 'fewer' : 'more'} min in direct sun`);
    }
    if (Math.abs(anomDiff) >= 1) {
      parts.push(`ground ~${Math.round(Math.abs(anomDiff))}°F ${anomDiff > 0 ? 'cooler' : 'hotter'}`);
    }
  }

  return parts.join(' · ');
}

// quietly checks a few departure times for the selected route, cached data only (no fetching).
// only worth mentioning if it meaningfully cuts time in direct sun
function betterLeaveTimeTip(i) {
  if (scoring) return null;
  const route = routes[i];
  const raw = routeRawData[i];
  if (!route || !raw) return null;

  const baseMs = currentDepartureMs();
  const baseScore = computeRouteScore(route, raw, baseMs);
  if (baseScore.sunMinutes <= 0) return null;

  const steps = (BETTER_TIME_WINDOW_HOURS * 60) / BETTER_TIME_STEP_MIN;
  let best = null;

  for (let step = 1; step <= steps; step++) {
    const tryMs = baseMs + step * BETTER_TIME_STEP_MIN * 60000;
    const tryScore = computeRouteScore(route, raw, tryMs);
    const cut = baseScore.sunMinutes - tryScore.sunMinutes;
    const bigEnough = cut >= BETTER_TIME_MIN_SUN_CUT && cut / baseScore.sunMinutes >= BETTER_TIME_SUN_CUT_FRAC;
    if (bigEnough && (!best || tryScore.sunMinutes < best.sunMinutes)) {
      best = { ms: tryMs, sunMinutes: tryScore.sunMinutes };
    }
  }
  if (!best) return null;

  return {
    ms: best.ms,
    text: `Leaving at ${formatClockTime(new Date(best.ms))} cuts direct sun to ${Math.round(best.sunMinutes)} min`
  };
}

function logScoreTable() {
  const rows = routes.map((route, i) => {
    const s = routeScores[i] || {};
    return {
      route: i,
      coolest: i === coolestIndex,
      score: s.score != null ? Math.round(s.score * 10) / 10 : null,
      shadePct: s.shadePct != null ? Math.round(s.shadePct) : null,
      canopyPct: s.canopyPct != null ? Math.round(s.canopyPct) : null,
      groundAnom: s.groundAnom != null ? Math.round(s.groundAnom * 10) / 10 : null,
      sunMinutes: s.sunMinutes != null ? Math.round(s.sunMinutes * 10) / 10 : null,
      coverage: s.coverage != null ? Math.round(s.coverage * 100) : null
    };
  });
  console.table(rows);
}

function debugScoreOn() {
  return new URLSearchParams(location.search).get('debugscore') === '1';
}

// turns already-fetched raw data into scores for whatever the current leave time is.
// no network calls here, so this is cheap enough to run on every leave time change
function rescoreAllFromCache() {
  if (!routes.length) return;
  const departureMs = currentDepartureMs();
  routeScores = routes.map((route, i) => computeRouteScore(route, routeRawData[i], departureMs));
  pickCoolestRoute();
  if (debugScoreOn()) logScoreTable();
}

async function scoreAllRoutes() {
  if (!routes.length) return;
  const requestId = routeRequestId;
  scoring = true;
  coolestIndex = -1;
  routeRawData = [];
  renderRouteCards();

  try {
    const raw = await Promise.all(routes.map(route => fetchRouteRawData(route)));
    if (requestId !== routeRequestId) return; // route got cleared/replaced while this was fetching
    routeRawData = raw;
    scoring = false;
    rescoreAllFromCache();
    findShadyDetour(); // new search only, leave time changes just rescore what we already found
  } catch (err) {
    if (requestId !== routeRequestId) return;
    console.error('route scoring failed', err);
    scoring = false;
    renderRouteCards();
  }
}

// keeps the "now" numbers honest as the clock moves, only matters when not following a picked time.
// skips during nav too - nav.js has its own progress math and this would fight its route coloring
function rescoreIfFollowingNow() {
  if (state.leaveTimeMs !== null || scoring || navActive) return;
  rescoreAllFromCache();
}

// refresh.js loads before this file so it can't reference this fn by name itself,
// registering it from here instead works the same since registerJob already exists by now
registerJob('rescore', 5 * 60 * 1000, rescoreIfFollowingNow);
