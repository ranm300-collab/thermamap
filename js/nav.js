// follow-mode navigation after tapping Start on a route card, plus turn by turn
// instructions along the way

const NAV_ZOOM = { WALKING: 18, BICYCLING: 17 };
const NAV_MIN_MOVING_MPS = 0.3; // gps reports tiny nonzero speeds sometimes even standing still
const NAV_WALKED_COLOR = '#c9bfa8'; // close to the road color, reads as "already done"

const NAV_STEP_ADVANCE_M = 15; // this close to the maneuver point (or already past it) = move on
const NAV_THEN_LOOKAHEAD_M = 90; // about 300 ft, shows the "then" preview once the next step is this short
const NAV_ARRIVE_M = 20; // this close to the destination counts as arrived

const NAV_DIST_MILE_CUTOFF_M = 160; // about 0.1 mi, switch from feet to miles past this
const NAV_DIST_FINE_FT_M = 30; // about 100 ft, round to the nearest 10ft instead of 50 once this close

// how far ahead (in time) to judge the next stretch, and how shaded/sunny it has to be to say so
const NAV_HEAT_WINDOW_MS = 2.5 * 60000;
const NAV_HEAT_SHADY_FRAC = 0.7;
const NAV_HEAT_SUNNY_FRAC = 0.3;

// dev only, lets me test the whole flow from a laptop w/o real gps. ~5x real speed
const SIM_SPEEDS_MPS = { WALKING: 7, BICYCLING: 22.5 };
const SIM_STEP_MS = 500;

let navActive = false;
let navFollowing = true;
let navWatchId = null;
let navSimTimer = null;
let navWakeLock = null;
let navDragListener = null;
let navMarker = null;
let navAccuracyCircle = null;
let navWalkedLine = null;
let navLastFix = null;
let navLastHeading = 0;

let navSteps = [];
let navStepBoundaryDists = [];
let navStepIndex = 0;
let navArrived = false;
let navStepsListOpen = false;

function simNavOn() {
  return urlFlag('simnav');
}

// a plain symbol path instead of an svg icon like hereIcon(), since only symbols support rotation
function navArrowIcon(heading) {
  return {
    path: 'M 0,-10 L 7,8 L 0,4 L -7,8 Z',
    fillColor: START_COLOR,
    fillOpacity: 1,
    strokeColor: '#fff',
    strokeWeight: 2,
    scale: 1.3,
    rotation: heading,
    anchor: new google.maps.Point(0, 0)
  };
}

function bearingBetween(lat1, lng1, lat2, lng2) {
  const toRad = Math.PI / 180;
  const y = Math.sin((lng2 - lng1) * toRad) * Math.cos(lat2 * toRad);
  const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
    Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos((lng2 - lng1) * toRad);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

// browser heading when it's actually trustworthy, otherwise derive it from movement,
// and just keep whatever we had last if standing still
function headingFor(lat, lng, heading, speed) {
  const isMoving = speed !== null && speed > NAV_MIN_MOVING_MPS;
  if (heading !== null && isMoving) {
    navLastHeading = heading;
  } else if (navLastFix) {
    const moved = haversineMeters(navLastFix.lat, navLastFix.lng, lat, lng);
    if (moved > 2) navLastHeading = bearingBetween(navLastFix.lat, navLastFix.lng, lat, lng);
  }
  return navLastHeading;
}

function updateNavMarker(lat, lng, heading) {
  const pos = { lat, lng };
  if (!navMarker) {
    navMarker = new google.maps.Marker({ position: pos, map: map, icon: navArrowIcon(heading), zIndex: 10 });
  } else {
    navMarker.setPosition(pos);
    navMarker.setIcon(navArrowIcon(heading));
  }
}

function updateNavAccuracy(lat, lng, accuracyM) {
  if (!navAccuracyCircle) {
    navAccuracyCircle = new google.maps.Circle({
      center: { lat, lng },
      radius: accuracyM,
      map: map,
      fillColor: START_COLOR,
      fillOpacity: 0.12,
      strokeColor: START_COLOR,
      strokeOpacity: 0.3,
      strokeWeight: 1
    });
  } else {
    navAccuracyCircle.setCenter({ lat, lng });
    navAccuracyCircle.setRadius(accuracyM);
  }
}

function closestSampleIndex(samples, lat, lng) {
  let best = 0;
  let bestDist = Infinity;
  samples.forEach((s, i) => {
    const d = haversineMeters(lat, lng, s.lat, s.lng);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

// plain rotation of one arrow shape covers most maneuvers, 0deg points straight ahead
const NAV_ARROW_ROTATION = {
  STRAIGHT: 0, TURN_SLIGHT_RIGHT: 30, TURN_RIGHT: 90, TURN_SHARP_RIGHT: 135,
  TURN_SLIGHT_LEFT: -30, TURN_LEFT: -90, TURN_SHARP_LEFT: -135
};

function maneuverArrow(maneuver) {
  if (maneuver === 'DESTINATION') {
    return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="currentColor"/></svg>';
  }
  if (maneuver === 'UTURN_LEFT' || maneuver === 'UTURN_RIGHT') {
    const flip = maneuver === 'UTURN_RIGHT' ? ' transform="scale(-1,1) translate(-24,0)"' : '';
    return `<svg viewBox="0 0 24 24"><g${flip}>
      <path d="M9 17V10a5 5 0 0 1 10 0v2" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M15 9 L19.5 12.5 L15 16 Z" fill="currentColor"/>
    </g></svg>`;
  }
  const rotation = NAV_ARROW_ROTATION[maneuver] || 0;
  return `<svg viewBox="0 0 24 24" style="transform: rotate(${rotation}deg)">
    <path d="M12 3 L19 13 L14 13 L14 21 L10 21 L10 13 L5 13 Z" fill="currentColor"/>
  </svg>`;
}

// used when the real instructions text is missing, which happens now and then
function maneuverFallbackText(maneuver) {
  const names = {
    TURN_LEFT: 'Turn left', TURN_RIGHT: 'Turn right',
    TURN_SLIGHT_LEFT: 'Turn slightly left', TURN_SLIGHT_RIGHT: 'Turn slightly right',
    TURN_SHARP_LEFT: 'Turn sharply left', TURN_SHARP_RIGHT: 'Turn sharply right',
    UTURN_LEFT: 'Make a u-turn', UTURN_RIGHT: 'Make a u-turn',
    STRAIGHT: 'Continue straight', NAME_CHANGE: 'Continue', DEPART: 'Head out',
    DESTINATION: "You've arrived"
  };
  return names[maneuver] || 'Continue';
}

// real instructions sometimes come with extra lines tacked on, like "pass by starbucks" or
// "destination will be on the left" - just the first line reads cleanly on the card
function cleanInstruction(step) {
  const firstLine = step.instructions && step.instructions.split('\n')[0].trim();
  return firstLine || maneuverFallbackText(step.maneuver);
}

function lowerFirst(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function formatBigDistance(meters) {
  if (meters >= NAV_DIST_MILE_CUTOFF_M) return (meters / 1609.34).toFixed(1) + ' mi';
  const feet = meters * 3.28084;
  const rounded = meters <= NAV_DIST_FINE_FT_M ? Math.round(feet / 10) * 10 : Math.round(feet / 50) * 50;
  return Math.max(rounded, 0) + ' ft';
}

// builds the per-step distance-along-route markers once, reusing the same scored samples
// nav part 1 already fetches - so advancing steps is just comparing numbers, no new geometry
function setupNavSteps() {
  navStepIndex = 0;
  navArrived = false;
  const leg = routes[selectedRouteIndex].legs && routes[selectedRouteIndex].legs[0];
  navSteps = (leg && leg.steps) || [];

  const scored = routeScores[selectedRouteIndex];
  if (!navSteps.length || !scored || !scored.samples) {
    navStepBoundaryDists = [];
    return;
  }
  const samples = scored.samples;
  navStepBoundaryDists = navSteps.map(step => {
    if (!step.endLocation) return samples[samples.length - 1].dist;
    return samples[closestSampleIndex(samples, step.endLocation.lat, step.endLocation.lng)].dist;
  });
}

function advanceNavStep(userDist) {
  while (navStepIndex < navSteps.length - 1 && navStepBoundaryDists[navStepIndex] - userDist <= NAV_STEP_ADVANCE_M) {
    navStepIndex++;
  }
}

// looks at the next couple minutes of samples and says if its mostly shaded or mostly sunny.
// reports the lookahead window itself rather than trying to find exactly where it changes -
// that was giving "about 0 min" whenever a single sample near the start broke the streak
function heatHintFor(route, samples, userDist) {
  const hour = new Date().getHours();
  if (hour < SUN_UP_HOUR || hour > SUN_DOWN_HOUR) return null;

  const totalDist = samples[samples.length - 1].dist || 1;
  const paceMsPerM = route.durationMillis / totalDist;
  const windowDist = NAV_HEAT_WINDOW_MS / paceMsPerM;

  let shaded = 0, total = 0;
  samples.forEach(s => {
    if (s.dist < userDist || s.dist > userDist + windowDist || s.shadeFrac === null) return;
    total++;
    if (s.shadeFrac >= IN_SHADE_FRAC) shaded++;
  });
  if (total === 0) return null;

  const frac = shaded / total;
  if (frac >= NAV_HEAT_SHADY_FRAC) return `Shady for the next ${formatBigDistance(windowDist)}`;
  if (frac <= NAV_HEAT_SUNNY_FRAC) return `Sunny stretch ahead, about ${Math.round(NAV_HEAT_WINDOW_MS / 60000)} min`;
  return null; // mixed, dont clutter the card
}

function updateNavInstruction(route, samples, userDist) {
  const card = document.getElementById('nav-instruction');
  if (navArrived || !navSteps.length) return;

  const upcoming = navSteps[navStepIndex + 1];
  let distToManeuver, maneuver, text;

  if (upcoming) {
    distToManeuver = Math.max(0, navStepBoundaryDists[navStepIndex] - userDist);
    maneuver = upcoming.maneuver;
    text = cleanInstruction(upcoming);
  } else {
    // already on the last step, nothing left to turn for, just the final stretch in
    distToManeuver = Math.max(0, samples[samples.length - 1].dist - userDist);
    maneuver = 'STRAIGHT';
    text = 'Continue to your destination';
  }

  document.getElementById('nav-instruction-arrow').innerHTML = maneuverArrow(maneuver);
  document.getElementById('nav-instruction-distance').textContent = formatBigDistance(distToManeuver);
  document.getElementById('nav-instruction-text').textContent = text;

  const afterNext = navSteps[navStepIndex + 2];
  const thenEl = document.getElementById('nav-instruction-then');
  if (upcoming && afterNext && upcoming.distanceMeters < NAV_THEN_LOOKAHEAD_M) {
    thenEl.textContent = 'Then ' + lowerFirst(cleanInstruction(afterNext));
    thenEl.hidden = false;
  } else {
    thenEl.hidden = true;
  }

  const heatEl = document.getElementById('nav-instruction-heat');
  const heatText = heatHintFor(route, samples, userDist);
  heatEl.textContent = heatText || '';
  heatEl.hidden = !heatText;

  card.hidden = false;
}

function checkArrival(lat, lng) {
  if (navArrived || !state.dest) return;
  if (haversineMeters(lat, lng, state.dest.lat, state.dest.lng) > NAV_ARRIVE_M) return;

  navArrived = true;
  if (navStepsListOpen) toggleStepsList();
  document.getElementById('nav-instruction-arrow').innerHTML = maneuverArrow('DESTINATION');
  document.getElementById('nav-instruction-distance').textContent = "You've arrived";
  document.getElementById('nav-instruction-text').textContent = state.dest.name || '';
  document.getElementById('nav-instruction-then').hidden = true;
  document.getElementById('nav-instruction-heat').hidden = true;
  document.getElementById('nav-instruction').hidden = false;
}

function renderStepsList() {
  const list = document.getElementById('nav-steps-list-items');
  list.textContent = '';
  for (let i = navStepIndex + 1; i < navSteps.length; i++) {
    const step = navSteps[i];
    const row = document.createElement('div');
    row.className = 'nav-steps-list-item';

    const arrow = document.createElement('div');
    arrow.className = 'nav-steps-list-arrow';
    arrow.innerHTML = maneuverArrow(step.maneuver);
    row.appendChild(arrow);

    const text = document.createElement('div');
    text.className = 'nav-steps-list-text';
    text.textContent = cleanInstruction(step);
    row.appendChild(text);

    const dist = document.createElement('div');
    dist.className = 'nav-steps-list-dist';
    dist.textContent = formatBigDistance(step.distanceMeters);
    row.appendChild(dist);

    list.appendChild(row);
  }
}

function toggleStepsList() {
  navStepsListOpen = !navStepsListOpen;
  if (navStepsListOpen) renderStepsList();
  document.getElementById('nav-steps-list').hidden = !navStepsListOpen;
}

// walked part fades out, the rest keeps the normal heat colors like a selected route does
function redrawNavRoute(samples, idx) {
  if (navWalkedLine) navWalkedLine.setMap(null);
  const walkedPath = samples.slice(0, idx + 1).map(s => ({ lat: s.lat, lng: s.lng }));
  navWalkedLine = new google.maps.Polyline({
    path: walkedPath,
    map: map,
    strokeColor: NAV_WALKED_COLOR,
    strokeOpacity: 0.9,
    strokeWeight: 6,
    zIndex: 4
  });
  drawRouteSegments(selectedRouteIndex, buildRuns(samples.slice(idx)));
}

function updateNavProgress(route, samples, idx) {
  const totalDist = samples[samples.length - 1].dist || 1;
  const distRemaining = totalDist - samples[idx].dist;
  const timeRemainingMs = route.durationMillis * (distRemaining / totalDist);
  const arrival = new Date(Date.now() + timeRemainingMs);

  document.getElementById('nav-progress').textContent =
    `${formatDuration(timeRemainingMs)} · ${formatDistance(distRemaining)} · arrive ${formatClockTime(arrival)}`;

  redrawNavRoute(samples, idx);
}

function showNavLocationError(msg) {
  document.getElementById('nav-location-error-text').textContent = msg;
  document.getElementById('nav-location-error').hidden = false;
}

function handleNavFix(lat, lng, heading, speed, accuracyM) {
  document.getElementById('nav-location-error').hidden = true; // got a fix, any earlier error is stale now

  const effectiveHeading = headingFor(lat, lng, heading, speed);
  navLastFix = { lat, lng };
  updateNavMarker(lat, lng, effectiveHeading);
  updateNavAccuracy(lat, lng, accuracyM);

  checkArrival(lat, lng);

  const route = routes[selectedRouteIndex];
  const scored = routeScores[selectedRouteIndex];
  if (route && scored && scored.samples) {
    const idx = closestSampleIndex(scored.samples, lat, lng);
    const userDist = scored.samples[idx].dist;
    updateNavProgress(route, scored.samples, idx);
    if (!navArrived) {
      advanceNavStep(userDist);
      updateNavInstruction(route, scored.samples, userDist);
    }
  }

  if (navFollowing) map.panTo({ lat, lng });
}

function onNavPositionError(err) {
  if (err.code === err.PERMISSION_DENIED) {
    showNavLocationError("Location is blocked, can't navigate without it");
  } else {
    showNavLocationError("Lost your location, can't keep navigating right now");
  }
}

function startRealWatch() {
  if (!navigator.geolocation) {
    showNavLocationError("This browser can't share your location");
    return;
  }
  navWatchId = navigator.geolocation.watchPosition(
    pos => handleNavFix(pos.coords.latitude, pos.coords.longitude, pos.coords.heading, pos.coords.speed, pos.coords.accuracy),
    onNavPositionError,
    { enableHighAccuracy: true }
  );
}

function samplePointAtDist(samples, dist) {
  const total = samples[samples.length - 1].dist;
  if (dist >= total) return null; // reached the end, sim just stops there
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].dist >= dist) {
      const a = samples[i - 1], b = samples[i];
      const t = (dist - a.dist) / (b.dist - a.dist || 1);
      return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    }
  }
  return samples[samples.length - 1];
}

// dev tool only (?simnav=1) - fakes movement along the route on a timer so this can be
// tested from a laptop. real navigation never uses a timer, watchPosition drives it instead
function startSimNav() {
  const samples = routeScores[selectedRouteIndex].samples;
  const speed = SIM_SPEEDS_MPS[travelMode] || SIM_SPEEDS_MPS.WALKING;
  let simDist = 0;
  navSimTimer = setInterval(() => {
    simDist += speed * (SIM_STEP_MS / 1000);
    const point = samplePointAtDist(samples, simDist);
    if (!point) {
      clearInterval(navSimTimer);
      navSimTimer = null;
      return;
    }
    handleNavFix(point.lat, point.lng, null, speed, 15);
  }, SIM_STEP_MS);
}

async function acquireWakeLock() {
  try {
    navWakeLock = await navigator.wakeLock.request('screen');
  } catch (err) {
    navWakeLock = null; // not supported, or denied - navigating still works fine without it
  }
}

async function releaseWakeLock() {
  if (!navWakeLock) return;
  try {
    await navWakeLock.release();
  } catch (err) { /* already gone, fine */ }
  navWakeLock = null;
}

function onNavDragStart() {
  navFollowing = false;
  document.getElementById('nav-recenter-btn').hidden = false;
}

function recenterNav() {
  navFollowing = true;
  document.getElementById('nav-recenter-btn').hidden = true;
  if (navLastFix) map.panTo(navLastFix);
}

async function startNav() {
  if (!routes.length) return;
  setLeaveTime(null); // leaving now, so the route scoring and arrival math line up w/ reality
  setupNavSteps();

  document.getElementById('search-card').hidden = true;
  document.getElementById('route-cards-panel').hidden = true;
  document.getElementById('nav-bar').hidden = false;
  document.getElementById('top-bar').classList.add('nav-compact'); // frees up room for the instruction card

  navActive = true;
  navFollowing = true;
  navLastFix = null;
  navLastHeading = 0;

  map.setZoom(NAV_ZOOM[travelMode] || NAV_ZOOM.WALKING);
  // map stays north up for now - rotating it to match heading needs a vector map id,
  // and this app uses the classic styled raster map for the custom desert colors
  navDragListener = map.addListener('dragstart', onNavDragStart);

  await acquireWakeLock();

  if (simNavOn()) {
    startSimNav();
  } else {
    startRealWatch();
  }
}

function endNav() {
  navActive = false;

  if (navWatchId !== null) {
    navigator.geolocation.clearWatch(navWatchId);
    navWatchId = null;
  }
  if (navSimTimer) {
    clearInterval(navSimTimer);
    navSimTimer = null;
  }
  releaseWakeLock();

  if (navMarker) { navMarker.setMap(null); navMarker = null; }
  if (navAccuracyCircle) { navAccuracyCircle.setMap(null); navAccuracyCircle = null; }
  if (navWalkedLine) { navWalkedLine.setMap(null); navWalkedLine = null; }
  if (navDragListener) { navDragListener.remove(); navDragListener = null; }

  document.getElementById('nav-bar').hidden = true;
  document.getElementById('nav-recenter-btn').hidden = true;
  document.getElementById('nav-location-error').hidden = true;
  document.getElementById('nav-instruction').hidden = true;
  document.getElementById('top-bar').classList.remove('nav-compact');
  if (navStepsListOpen) toggleStepsList();
  document.getElementById('search-card').hidden = false;

  // navActive is already false above, so this rescore redraws the normal full-route
  // coloring and refreshes the cards/panel itself, no need to touch them separately here
  rescoreAllFromCache();
}

document.getElementById('nav-end-btn').addEventListener('click', endNav);
document.getElementById('nav-location-exit-btn').addEventListener('click', endNav);
document.getElementById('nav-recenter-btn').addEventListener('click', recenterNav);

document.getElementById('nav-instruction').addEventListener('click', () => {
  if (!navArrived) toggleStepsList();
});
document.getElementById('nav-steps-list').addEventListener('click', toggleStepsList);
document.getElementById('nav-steps-list-close').addEventListener('click', e => {
  e.stopPropagation();
  toggleStepsList();
});
