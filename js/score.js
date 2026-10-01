// scores each route for sun exposure using the grid data, picks the coolest one by default

const SAMPLE_SPACING_M = 10;
const SUN_UP_HOUR = 7; // sun's basically not up before this, call it shaded
const SUN_DOWN_HOUR = 19; // our hourly shade data stops at 19:00
const MAX_DETOUR_RATIO = 1.5; // won't win coolest if its way slower than the fastest route
const MIN_COVERAGE = 0.5; // need data for at least half the route to trust the score
const HEAT_FACTOR_DIVISOR = 30; // hotter than avg ground counts extra, tune later once we've walked some routes
// TODO: shade data is baked for a july 15 sun angle, prob off by winter

// first pass, these are guesses til we've actually walked some hot days
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

let routeScores = [];
let scoring = false;
let coolestIndex = -1;

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

function shadeFractionFor(cell, hour) {
  if (hour < SUN_UP_HOUR || hour > SUN_DOWN_HOUR) return 1;
  const byte = cell.shade[hour];
  return byte === null ? null : byte / 100;
}

function scoreRoute(route, departureMs) {
  const samples = sampleRoute(route.path, SAMPLE_SPACING_M);
  const totalDist = samples[samples.length - 1].dist || 1;
  const points = samples.map(s => ({ lat: s.lat, lng: s.lng }));

  return getGridCells(points).then(cells => {
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
      const hour = new Date(departureMs + fraction * route.durationMillis).getHours();
      if (hour >= SUN_UP_HOUR && hour <= SUN_DOWN_HOUR) anyDaylight = true;

      let shadeFrac = null;
      let anomaly = null;
      if (cell && cell.anomaly !== null && cell.canopy !== null) {
        shadeFrac = shadeFractionFor(cell, hour);
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
  });
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

// recolors the selected route from its stored samples, no rescoring or refetching
function colorSelectedRoute() {
  routes.forEach((route, i) => clearRouteSegments(i));

  const s = routeScores[selectedRouteIndex];
  document.getElementById('route-night-note').hidden = !(s && s.afterDark);
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
    if (route.durationMillis > fastestMs * MAX_DETOUR_RATIO) return;
    if (s.score < bestScore) {
      bestScore = s.score;
      bestIndex = i;
    }
  });

  coolestIndex = bestIndex;
  selectRoute(bestIndex);
}

// second line under each route row, routes.js calls this
function routeRowSubtext(i) {
  if (scoring) return 'checking shade...';
  const s = routeScores[i];
  if (!s) return '';
  const anomStr = (s.groundAnom >= 0 ? '+' : '') + Math.round(s.groundAnom) + '°';
  let text = `${Math.round(s.shadePct)}% shade · ${anomStr} ground`;
  if (i === coolestIndex) text += ' · coolest';
  return text;
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

function scoreAllRoutes() {
  if (!routes.length) return;
  scoring = true;
  coolestIndex = -1;
  renderRouteList();

  const departureMs = Date.now();
  Promise.all(routes.map(route => scoreRoute(route, departureMs)))
    .then(results => {
      routeScores = results;
      scoring = false;
      pickCoolestRoute();
      if (new URLSearchParams(location.search).get('debugscore') === '1') logScoreTable();
    })
    .catch(err => {
      console.error('route scoring failed', err);
      scoring = false;
      renderRouteList();
    });
}
