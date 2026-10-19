// ?tune=1 dev harness, runs a fixed set of real abq trips through the real routing/scoring/
// detour code so i can sanity check the heat score against reality instead of just guessing

const TUNE_TRIPS = [
  { name: 'UNM to Nob Hill', mode: 'WALKING', origin: { lat: 35.084, lng: -106.619 }, dest: { lat: 35.081, lng: -106.605 } },
  { name: 'Old Town to Rio Grande Nature Center', mode: 'BICYCLING', origin: { lat: 35.098, lng: -106.669 }, dest: { lat: 35.130, lng: -106.683 } },
  { name: 'Downtown to Sunport', mode: 'BICYCLING', origin: { lat: 35.084, lng: -106.650 }, dest: { lat: 35.040, lng: -106.609 } },
  { name: 'West Side (volcano cliffs area)', mode: 'BICYCLING', origin: { lat: 35.150, lng: -106.720 }, dest: { lat: 35.135, lng: -106.700 } },
  { name: 'North Valley near the bosque', mode: 'WALKING', origin: { lat: 35.160, lng: -106.650 }, dest: { lat: 35.155, lng: -106.672 } },
  { name: 'Foothills', mode: 'BICYCLING', origin: { lat: 35.147, lng: -106.527 }, dest: { lat: 35.110, lng: -106.550 } },
  { name: 'Downtown to Old Town', mode: 'WALKING', origin: { lat: 35.084, lng: -106.650 }, dest: { lat: 35.098, lng: -106.669 } },
  { name: 'UNM to Coronado Center', mode: 'BICYCLING', origin: { lat: 35.084, lng: -106.619 }, dest: { lat: 35.104, lng: -106.567 } },
  { name: 'Nob Hill to Downtown', mode: 'WALKING', origin: { lat: 35.081, lng: -106.605 }, dest: { lat: 35.084, lng: -106.650 } },
  { name: 'Rio Grande Nature Center to Old Town', mode: 'BICYCLING', origin: { lat: 35.130, lng: -106.683 }, dest: { lat: 35.098, lng: -106.669 } }
];

const TUNE_HOURS = [9, 13, 17];
const TUNE_DETOUR_HOUR = 13; // only check detours at one time per trip or the request count blows up

function tuneOn() {
  return urlFlag('tune');
}

function tuneDepartureMs(hour) {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

// sessionStorage not a plain var bc tuning the scoring needs a page reload to pick up,
// and a plain in memory array wouldn't survive that
const TUNE_CACHE_KEY = 'tuneRouteCache';
const TUNE_DETOUR_CACHE_KEY = 'tuneDetourCache'; // separate from the base cache, findShadyDetour makes its own requests
const TUNE_SNAPSHOT_KEY = 'tuneResultsSnapshot';

function loadTuneJSON(key, fallback) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

function saveTuneJSON(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch (err) { /* storage full or blocked, worst case this just doesnt carry over a reload */ }
}

function tuneLogTable(trip, hour, routesForTrip, scoresForTrip) {
  const rows = routesForTrip.map((r, i) => ({
    route: r.isDetour ? 'detour' : `route ${i + 1}`,
    picked: i === coolestIndex ? '<-- picked' : '',
    min: Math.round(r.durationMillis / 60000),
    mi: (r.distanceMeters / 1609.34).toFixed(1),
    shade: scoresForTrip[i].coverage < MIN_COVERAGE ? 'no data' : Math.round(scoresForTrip[i].shadePct) + '%',
    groundAnom: (scoresForTrip[i].groundAnom >= 0 ? '+' : '') + scoresForTrip[i].groundAnom.toFixed(1),
    sunMin: scoresForTrip[i].sunMinutes.toFixed(1),
    score: scoresForTrip[i].score === Infinity ? 'n/a' : scoresForTrip[i].score.toFixed(1)
  }));
  console.log(`-- ${trip.name} (${trip.mode}) @ ${hour}:00 --`);
  console.table(rows);
}

async function tuneFetchRoutes(trip, hour, cache, counter) {
  const key = `${trip.name}_${hour}`;
  if (cache[key]) return cache[key];

  const { Route } = await google.maps.importLibrary('routes');
  const result = await Route.computeRoutes({
    origin: trip.origin,
    destination: trip.dest,
    travelMode: trip.mode,
    computeAlternativeRoutes: true,
    fields: ['path', 'distanceMeters', 'durationMillis', 'viewport', 'routeLabels', 'legs']
  });
  counter.count++;
  cache[key] = result.routes.map(r => ({ path: r.path, distanceMeters: r.distanceMeters, durationMillis: r.durationMillis }));
  return cache[key];
}

function compareTuneResults(before, after) {
  if (!before) {
    console.log('no earlier run saved yet, this run is now the baseline for next time');
    return;
  }
  let changed = 0;
  after.forEach((a, i) => {
    const b = before[i];
    if (!b || b.trip !== a.trip || b.hour !== a.hour) return;
    if (b.picked !== a.picked) {
      changed++;
      console.log(`changed: ${a.trip} @ ${a.hour}:00, was "${b.picked}" (score ${b.score}) now "${a.picked}" (score ${a.score})`);
    }
  });
  console.log(`${changed} of ${after.length} picks changed since the last run`);
}

async function runTuneHarness() {
  console.log('tune harness starting...');
  const cache = loadTuneJSON(TUNE_CACHE_KEY, {});
  const detourCache = loadTuneJSON(TUNE_DETOUR_CACHE_KEY, {});
  const counter = { count: 0 };
  const results = [];

  for (const trip of TUNE_TRIPS) {
    for (const hour of TUNE_HOURS) {
      state.start = { lat: trip.origin.lat, lng: trip.origin.lng, name: trip.name };
      state.dest = { lat: trip.dest.lat, lng: trip.dest.lng, name: trip.name };
      travelMode = trip.mode;
      userPickedRoute = false;

      const cached = await tuneFetchRoutes(trip, hour, cache, counter);
      routes = cached.map(r => ({ ...r }));
      selectedRouteIndex = 0;

      const departureMs = tuneDepartureMs(hour);
      state.leaveTimeMs = departureMs; // detour code reads this via currentDepartureMs()
      routeRawData = await Promise.all(routes.map(r => fetchRouteRawData(r)));
      routeScores = routes.map((r, i) => computeRouteScore(r, routeRawData[i], departureMs));
      pickCoolestRoute();

      if (hour === TUNE_DETOUR_HOUR) {
        const dKey = `${trip.name}_${hour}`;
        if (dKey in detourCache) {
          // already checked this trip on an earlier run, replay the result instead of re-requesting
          if (detourCache[dKey]) {
            const route = { ...detourCache[dKey], isDetour: true };
            const raw = await fetchRouteRawData(route);
            routes.push(route);
            routeRawData.push(raw);
            routeScores.push(computeRouteScore(route, raw, departureMs));
            drawRoutes();
            pickCoolestRoute();
          }
        } else {
          await findShadyDetour();
          const added = routes.find(r => r.isDetour);
          detourCache[dKey] = added ? { path: added.path, distanceMeters: added.distanceMeters, durationMillis: added.durationMillis } : null;
        }
      }

      tuneLogTable(trip, hour, routes, routeScores);
      const picked = routes[coolestIndex];
      results.push({
        trip: trip.name, hour,
        picked: picked.isDetour ? 'detour' : `route ${coolestIndex + 1}`,
        score: routeScores[coolestIndex].score === Infinity ? null : Math.round(routeScores[coolestIndex].score * 10) / 10,
        detourAdded: routes.some(r => r.isDetour)
      });
    }
  }

  saveTuneJSON(TUNE_CACHE_KEY, cache);
  saveTuneJSON(TUNE_DETOUR_CACHE_KEY, detourCache);
  console.log(`done. ${counter.count} new route requests this run, ${TUNE_TRIPS.length * TUNE_HOURS.length} scenarios total`);
  console.log('--- before/after ---');
  compareTuneResults(loadTuneJSON(TUNE_SNAPSHOT_KEY, null), results);
  saveTuneJSON(TUNE_SNAPSHOT_KEY, results);
  return results;
}

function initTuneMode() {
  if (!tuneOn()) return;
  document.getElementById('search-card').hidden = true;
  // give maps/grid data a sec to finish loading before hammering it with requests
  setTimeout(runTuneHarness, 1500);
}
