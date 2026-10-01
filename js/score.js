// scores each route for sun exposure using the grid data, picks the coolest one by default

const SAMPLE_SPACING_M = 10;
const SUN_UP_HOUR = 7; // sun's basically not up before this, call it shaded
const SUN_DOWN_HOUR = 19; // our hourly shade data stops at 19:00
const MAX_DETOUR_RATIO = 1.5; // won't win coolest if its way slower than the fastest route
const MIN_COVERAGE = 0.5; // need data for at least half the route to trust the score
const HEAT_FACTOR_DIVISOR = 30; // hotter than avg ground counts extra, tune later once we've walked some routes
// TODO: shade data is baked for a july 15 sun angle, prob off by winter

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

    for (let i = 1; i < samples.length; i++) {
      const cell = cells[i];
      if (!cell || cell.anomaly === null || cell.canopy === null) continue;

      const fraction = samples[i].dist / totalDist;
      const timeMs = departureMs + fraction * route.durationMillis;
      const hour = new Date(timeMs).getHours();
      const shadeFrac = shadeFractionFor(cell, hour);
      if (shadeFrac === null) continue;

      const weight = samples[i].dist - samples[i - 1].dist;
      const stepMs = (weight / totalDist) * route.durationMillis;

      shadeWeighted += weight * shadeFrac;
      canopyWeighted += weight * cell.canopy;
      anomWeighted += weight * cell.anomaly;
      validWeight += weight;

      const sunFrac = 1 - shadeFrac;
      sunMs += stepMs * sunFrac;
      const heatFactor = 1 + Math.max(0, cell.anomaly) / HEAT_FACTOR_DIVISOR;
      scoreMs += stepMs * sunFrac * heatFactor;
    }

    if (validWeight === 0) {
      return { shadePct: 0, canopyPct: 0, groundAnom: 0, sunMinutes: 0, score: Infinity, coverage: 0 };
    }

    return {
      shadePct: (shadeWeighted / validWeight) * 100,
      canopyPct: canopyWeighted / validWeight,
      groundAnom: anomWeighted / validWeight,
      sunMinutes: sunMs / 60000,
      score: scoreMs / 60000,
      coverage: validWeight / totalDist
    };
  });
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
