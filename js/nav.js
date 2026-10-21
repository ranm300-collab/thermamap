// follow-mode navigation after tapping Start on a route card, plus turn-by-turn instructions

const NAV_ZOOM = {WALKING: 18, BICYCLING: 17};
const NAV_MIN_MOVING_MPS = 0.3; // gps reports tiny nonzero speeds sometimes even standing still
const NAV_WALKED_COLOR = '#c9bfa8';

const NAV_STEP_ADVANCE_M = 15;
const NAV_THEN_LOOKAHEAD_M = 90;
const NAV_ARRIVE_M = 20;

const NAV_DIST_MILE_CUTOFF_M = 160;
const NAV_DIST_FINE_FT_M = 30;

const NAV_HEAT_WINDOW_MS = 2.5 * 60000;
const NAV_HEAT_SHADY_FRAC = 0.7;
const NAV_HEAT_SUNNY_FRAC = 0.3;

const NAV_OFF_ROUTE_M = { WALKING: 40, BICYCLING: 50 };
const NAV_OFF_ROUTE_STREAK = 3;
const NAV_OFF_ROUTE_MAX_ACCURACY_M = 50;

const NAV_REROUTE_COOLDOWN_MS = 30000;
const NAV_REROUTE_MAX_PER_TRIP = 10; // the routes api has a daily quota, dont burn it chasing gps noise

const NAV_SPEECH_FAR_M = { WALKING: 91, BICYCLING: 183 };
const NAV_SPEECH_NEAR_M = { WALKING: 15, BICYCLING: 30 };

// dev only, tests the whole flow from a laptop w/o real gps
const SIM_SPEEDS_MPS = {WALKING: 7, BICYCLING: 22.5};
const SIM_STEP_MS = 500;
const NAV_SIM_DRIFT_AT_FRAC = 0.3;
const NAV_SIM_DRIFT_MS = 15000;
const NAV_SIM_DRIFT_OFFSET_M = 70;

let navActive = false;
let navFollowing = true;
let navWatch = null; // {clear()} from js/geo.js, hides native vs browser id shape
let navSimTimer = null;
let navWakeLock = null;
let navDragListener = null;
let navMarker = null;
let navAccuracyCircle = null;
let navWalkedLine = null;
let navLastFix = null;
let navLastHeading = 0;
let navLastRedrawMs = 0;
const NAV_REDRAW_MIN_MS = 1500;

let navSteps = [];
let navStepBoundaryDists = [];
let navStepIndex = 0;
let navArrived = false;
let navStepsListOpen = false;

let navOffRouteStreak = 0;
let navRerouting = false;
let navLastRerouteMs = 0;
let navRerouteCount = 0;

let navVoiceOn = true;
let navSpokenFar = false;
let navSpokenNear = false;
let navLastHeatKind = null;

let navSimDist = 0;
let navSimDriftUntilMs = null;
let navSimDriftDone = false;

function simNavOn() {
  return urlFlag('simnav');
}

function simOffOn() {
  return urlFlag('simoff');
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

// browser heading when trustworthy, otherwise derive from movement, keep last if standing still
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

// used when the real instructions text is missing, happens now and then, idk why
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

// real instructions sometimes carry extra lines tacked on, first line reads cleanest alone
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

// same rounding as formatBigDistance but spelled out, "ft"/"mi" read weird out loud
function speechDistance(meters) {
  if (meters >= NAV_DIST_MILE_CUTOFF_M) return (meters / 1609.34).toFixed(1) + ' miles';
  const feet = meters * 3.28084;
  const rounded = meters <= NAV_DIST_FINE_FT_M ? Math.round(feet / 10) * 10 : Math.round(feet / 50) * 50;
  return Math.max(rounded, 0) + ' feet';
}

const SPEECH_SUFFIXES = [
  [/\bNE\b/g, 'Northeast'], [/\bNW\b/g, 'Northwest'], [/\bSE\b/g, 'Southeast'], [/\bSW\b/g, 'Southwest'],
  [/\bAve\b/g, 'Avenue'], [/\bBlvd\b/g, 'Boulevard'], [/\bRd\b/g, 'Road'], [/\bDr\b/g, 'Drive'],
  [/\bLn\b/g, 'Lane'], [/\bCt\b/g, 'Court'], [/\bPl\b/g, 'Place'], [/\bSt\b/g, 'Street']
];

function speechify(text) {
  return SPEECH_SUFFIXES.reduce((out, [pattern, word]) => out.replace(pattern, word), text);
}

// web speechSynthesis is safari-only, wkwebview doesn't get it, app uses @capacitor-community/text-to-speech there instead
function speak(text) {
  if (!navVoiceOn) return;
  if (isNativeApp()) {
    Capacitor.Plugins.TextToSpeech.stop()
      .catch(() => {})
      .then(() => Capacitor.Plugins.TextToSpeech.speak({ text }))
      .catch(() => {});
    return;
  }
  if (!('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel(); // newest announcement wins, dont let them stack up
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  } catch (err) { /* speech api flaky in some browsers despite the feature check, just skip it */ }
}

function stopSpeech() {
  if (isNativeApp()) {
    Capacitor.Plugins.TextToSpeech.stop().catch(() => {});
    return;
  }
  if (!('speechSynthesis' in window)) return;
  try { speechSynthesis.cancel(); } catch (err) { /* nothing to stop, fine */ }
}

function toggleVoice() {
  navVoiceOn = !navVoiceOn;
  document.getElementById('nav-voice-toggle').textContent = navVoiceOn ? 'Voice on' : 'Voice off';
  if (!navVoiceOn) stopSpeech();
}

// not tied to the voice toggle on purpose, a quiet tap is welcome even w/ voice off
function haptic(style) {
  if (!isNativeApp()) return;
  Capacitor.Plugins.Haptics.impact({ style }).catch(() => {});
}

function speakTurn(step, distRemaining) {
  speak(`In ${speechDistance(distRemaining)}, ${lowerFirst(speechify(cleanInstruction(step)))}`);
  haptic('LIGHT');
}

// builds the per-step markers once from the already-scored samples, advancing is just comparing numbers
function setupNavSteps() {
  navStepIndex = 0;
  navArrived = false;
  navSpokenFar = false;
  navSpokenNear = false;
  navLastHeatKind = null;
  navOffRouteStreak = 0;
  navSimDist = 0;
  navLastRedrawMs = 0; // redraw right away on the next fix instead of waiting out the throttle
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
    navSpokenFar = false;
    navSpokenNear = false;
  }
}

// looks at the next couple minutes of samples, reports mostly-shaded or mostly-sunny for that window
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

  // card reads fine abbreviated, speech wants the full word and a touch more sentence shape
  const frac = shaded / total;
  const minutes = Math.round(NAV_HEAT_WINDOW_MS / 60000);
  if (frac >= NAV_HEAT_SHADY_FRAC) {
    return {
      kind: 'shady',
      cardText: `Shady for the next ${formatBigDistance(windowDist)}`,
      speechText: `Shady for the next ${speechDistance(windowDist)}`
    };
  }
  if (frac <= NAV_HEAT_SUNNY_FRAC) {
    return {
      kind: 'sunny',
      cardText: `Sunny stretch ahead, about ${minutes} min`,
      speechText: `Sunny stretch ahead for about ${minutes} minute${minutes === 1 ? '' : 's'}`
    };
  }
  return null; // mixed, dont clutter the card
}

// NAV_STEP_ADVANCE_M and the near speech distance are both ~15m, this has to speak before advanceNavStep moves on
function checkTurnSpeech(userDist) {
  const upcoming = navSteps[navStepIndex + 1];
  if (!upcoming) return;

  const distToManeuver = Math.max(0, navStepBoundaryDists[navStepIndex] - userDist);
  const farM = NAV_SPEECH_FAR_M[travelMode] || NAV_SPEECH_FAR_M.WALKING;
  const nearM = NAV_SPEECH_NEAR_M[travelMode] || NAV_SPEECH_NEAR_M.WALKING;

  if (!navSpokenFar && distToManeuver <= farM) {
    navSpokenFar = true;
    speakTurn(upcoming, distToManeuver);
  } else if (navSpokenFar && !navSpokenNear && distToManeuver <= nearM) {
    navSpokenNear = true;
    speakTurn(upcoming, distToManeuver);
  }
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
  const heatHint = heatHintFor(route, samples, userDist);
  heatEl.textContent = heatHint ? heatHint.cardText : '';
  heatEl.hidden = !heatHint;

  const heatKind = heatHint ? heatHint.kind : null;
  if (heatKind === 'sunny' && navLastHeatKind !== 'sunny') speak(heatHint.speechText);
  navLastHeatKind = heatKind;

  card.hidden = false;
}

function checkArrival(lat, lng) {
  if (navArrived || !state.dest) return;
  if (haversineMeters(lat, lng, state.dest.lat, state.dest.lng) > NAV_ARRIVE_M) return;

  navArrived = true;
  speak('You have arrived');
  haptic('MEDIUM');
  if (navStepsListOpen) toggleStepsList();
  document.getElementById('nav-instruction-arrow').innerHTML = maneuverArrow('DESTINATION');
  document.getElementById('nav-instruction-distance').textContent = "You've arrived";
  document.getElementById('nav-instruction-text').textContent = state.dest.name || '';
  document.getElementById('nav-instruction-then').hidden = true;
  document.getElementById('nav-instruction-heat').hidden = true;
  document.getElementById('nav-instruction').hidden = false;
}

// gps jitters a lot near buildings, so one bad fix should never be enough to trigger a reroute
function checkOffRoute(lat, lng, accuracyM, samples, idx) {
  if (accuracyM > NAV_OFF_ROUTE_MAX_ACCURACY_M) return;

  const limitM = travelMode === 'BICYCLING' ? NAV_OFF_ROUTE_M.BICYCLING : NAV_OFF_ROUTE_M.WALKING;
  const distOffRoute = haversineMeters(lat, lng, samples[idx].lat, samples[idx].lng);
  navOffRouteStreak = distOffRoute > limitM ? navOffRouteStreak + 1 : 0;

  if (navOffRouteStreak >= NAV_OFF_ROUTE_STREAK) {
    navOffRouteStreak = 0;
    tryReroute(lat, lng);
  }
}

function showRerouting() {
  document.getElementById('nav-instruction-distance').textContent = '';
  document.getElementById('nav-instruction-text').textContent = 'Rerouting...';
  document.getElementById('nav-instruction-then').hidden = true;
  document.getElementById('nav-instruction-heat').hidden = true;
  document.getElementById('nav-instruction').hidden = false;
}

// same scoring rules as a fresh search (score.js), just skips the route cards ui nav hides
async function applyReroute(newRoutes) {
  const raws = await Promise.all(newRoutes.map(route => fetchRouteRawData(route)));
  const departureMs = Date.now();
  const scores = newRoutes.map((route, i) => computeRouteScore(route, raws[i], departureMs));

  const fastestMs = Math.min(...newRoutes.map(r => r.durationMillis));
  let bestIndex = 0, bestScore = Infinity;
  scores.forEach((s, i) => {
    if (s.coverage < MIN_COVERAGE) return;
    if (newRoutes[i].durationMillis > maxAllowedDurationMs(fastestMs)) return;
    if (s.score < bestScore) { bestScore = s.score; bestIndex = i; }
  });

  // only the winner matters once rerouted, theres no cards to let the user pick an alternative
  routes = [newRoutes[bestIndex]];
  routeRawData = [raws[bestIndex]];
  routeScores = [scores[bestIndex]];
  selectedRouteIndex = 0;
  coolestIndex = 0;

  drawRoutes();
  setupNavSteps();
  document.getElementById('nav-reroute-status').hidden = true;
}

async function tryReroute(lat, lng) {
  if (navRerouting) return;
  const now = Date.now();
  if (now - navLastRerouteMs < NAV_REROUTE_COOLDOWN_MS) return;
  if (navRerouteCount >= NAV_REROUTE_MAX_PER_TRIP) return;

  navRerouting = true;
  navLastRerouteMs = now;
  navRerouteCount++;
  document.getElementById('nav-reroute-status').hidden = true;
  showRerouting();
  speak('Rerouting');

  try {
    const { Route } = await google.maps.importLibrary('routes');
    const result = await Route.computeRoutes({
      origin: { lat, lng },
      destination: { lat: state.dest.lat, lng: state.dest.lng },
      travelMode: travelMode,
      computeAlternativeRoutes: true,
      fields: ['path', 'distanceMeters', 'durationMillis', 'viewport', 'routeLabels', 'legs']
    });
    if (!result.routes.length) throw new Error('no routes back');
    // no shady detour search here, that's its own computeRoutes call and reroutes already spend quota
    await applyReroute(result.routes);
  } catch (err) {
    console.error("reroute didn't go through", err);
    document.getElementById('nav-reroute-status').textContent = "Couldn't reroute, keep going or end";
    document.getElementById('nav-reroute-status').hidden = false;
  }

  navRerouting = false;
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
  const walkedPath = samples.slice(0, idx + 1).map(s => ({ lat: s.lat, lng: s.lng }));
  if (navWalkedLine) {
    navWalkedLine.setPath(walkedPath);
  } else {
    navWalkedLine = new google.maps.Polyline({
      path: walkedPath,
      map: map,
      strokeColor: NAV_WALKED_COLOR,
      strokeOpacity: 0.9,
      strokeWeight: 6,
      zIndex: 4
    });
  }
  drawRouteSegments(selectedRouteIndex, buildRuns(samples.slice(idx)));
}

function updateNavProgress(route, samples, idx) {
  const totalDist = samples[samples.length - 1].dist || 1;
  const distRemaining = totalDist - samples[idx].dist;
  const timeRemainingMs = route.durationMillis * (distRemaining / totalDist);
  const arrival = new Date(Date.now() + timeRemainingMs);

  document.getElementById('nav-progress').textContent =
    `${formatDuration(timeRemainingMs)} · ${formatDistance(distRemaining)} · arrive ${formatClockTime(arrival)}`;

  // redraw throttled so heat segments don't rebuild on literally every gps fix
  const now = Date.now();
  if (now - navLastRedrawMs < NAV_REDRAW_MIN_MS) return;
  navLastRedrawMs = now;
  redrawNavRoute(samples, idx);
}

function showNavLocationError(msg) {
  document.getElementById('nav-location-error-text').textContent = msg;
  document.getElementById('nav-location-error').hidden = false;
}

function handleNavFix(lat, lng, heading, speed, accuracyM) {
  document.getElementById('nav-location-error').hidden = true;

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
      checkOffRoute(lat, lng, accuracyM, scored.samples, idx);
      // mid-reroute the old route/steps are about to be replaced, leave the card on "Rerouting..."
      if (!navRerouting) {
        checkTurnSpeech(userDist);
        advanceNavStep(userDist);
        updateNavInstruction(route, scored.samples, userDist);
      }
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
  if (!isNativeApp() && !navigator.geolocation) {
    showNavLocationError("This browser can't share your location");
    return;
  }
  navWatch = watchPosition(
    { enableHighAccuracy: true },
    pos => handleNavFix(pos.coords.latitude, pos.coords.longitude, pos.coords.heading, pos.coords.speed, pos.coords.accuracy),
    onNavPositionError
  );
}

function samplePointAtDist(samples, dist) {
  const total = samples[samples.length - 1].dist;
  if (dist >= total) return null;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].dist >= dist) {
      const a = samples[i - 1], b = samples[i];
      const t = (dist - a.dist) / (b.dist - a.dist || 1);
      return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    }
  }
  return samples[samples.length - 1];
}

// ?simoff=1 dev tool, steps off the route so rerouting is easy to watch (reuses detours.js's offsetPoint)
function simDriftPoint(samples, dist) {
  const base = samplePointAtDist(samples, dist) || samples[samples.length - 1];
  const ahead = samplePointAtDist(samples, dist + 10) || base;
  const bearing = bearingBetween(base.lat, base.lng, ahead.lat, ahead.lng);
  return offsetPoint(base.lat, base.lng, bearing + 90, NAV_SIM_DRIFT_OFFSET_M);
}

// ?simnav=1 dev tool, fakes movement on a timer so this can be tested from a laptop, real nav uses watchPosition
function startSimNav() {
  const speed = SIM_SPEEDS_MPS[travelMode] || SIM_SPEEDS_MPS.WALKING;
  navSimTimer = setInterval(() => {
    navSimDist += speed * (SIM_STEP_MS / 1000);
    const samples = routeScores[selectedRouteIndex].samples;

    if (simOffOn() && !navSimDriftDone && navSimDriftUntilMs === null) {
      const totalDist = samples[samples.length - 1].dist;
      if (navSimDist >= totalDist * NAV_SIM_DRIFT_AT_FRAC) navSimDriftUntilMs = Date.now() + NAV_SIM_DRIFT_MS;
    }

    let point;
    if (navSimDriftUntilMs !== null && Date.now() < navSimDriftUntilMs) {
      point = simDriftPoint(samples, navSimDist);
    } else {
      if (navSimDriftUntilMs !== null) { navSimDriftUntilMs = null; navSimDriftDone = true; }
      point = samplePointAtDist(samples, navSimDist);
    }

    if (!point) {
      clearInterval(navSimTimer);
      navSimTimer = null;
      return;
    }
    handleNavFix(point.lat, point.lng, null, speed, 15);
  }, SIM_STEP_MS);
}

// keep-awake plugin inside the app, browser's own wake lock api otherwise (unreliable in a wkwebview)
async function acquireWakeLock() {
  if (isNativeApp()) {
    try {
      await Capacitor.Plugins.KeepAwake.keepAwake();
      navWakeLock = 'native';
    } catch (err) {
      navWakeLock = null;
    }
    return;
  }
  try {
    navWakeLock = await navigator.wakeLock.request('screen');
  } catch (err) {
    navWakeLock = null; // not supported or denied, navigating still works fine without it
  }
}

async function releaseWakeLock() {
  if (!navWakeLock) return;
  if (navWakeLock === 'native') {
    try { await Capacitor.Plugins.KeepAwake.allowSleep(); } catch (err) { /* already gone, fine */ }
    navWakeLock = null;
    return;
  }
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
  if (!routes.length || navActive) return; // a second tap here would double up the dragstart listener
  // ios safari only allows speech from a direct tap, this "unlocks" it or later announcements stay silent
  speak('Starting route');

  setLeaveTime(null); // leaving now, so the route scoring and arrival math line up w/ reality
  setupNavSteps();

  document.getElementById('search-container').hidden = true;
  document.getElementById('route-cards-panel').hidden = true;
  document.getElementById('nav-bar').hidden = false;
  document.getElementById('top-bar').classList.add('nav-compact');

  navActive = true;
  navFollowing = true;
  navLastFix = null;
  navLastHeading = 0;
  navRerouting = false;
  navLastRerouteMs = 0;
  navRerouteCount = 0;
  navSimDriftUntilMs = null;
  navSimDriftDone = false;

  map.setZoom(NAV_ZOOM[travelMode] || NAV_ZOOM.WALKING);
  // map stays north up, rotating to match heading needs a vector map id (this uses the classic raster map for the desert colors)
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
  stopSpeech();

  if (navWatch) {
    navWatch.clear();
    navWatch = null;
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
  document.getElementById('nav-reroute-status').hidden = true;
  document.getElementById('nav-recenter-btn').hidden = true;
  document.getElementById('nav-location-error').hidden = true;
  document.getElementById('nav-instruction').hidden = true;
  document.getElementById('top-bar').classList.remove('nav-compact');
  if (navStepsListOpen) toggleStepsList();
  document.getElementById('search-container').hidden = false;

  // trip's over, back to a blank map instead of showing the route they just walked
  clearRoute();
}

document.getElementById('nav-end-btn').addEventListener('click', endNav);
document.getElementById('nav-location-exit-btn').addEventListener('click', endNav);
document.getElementById('nav-recenter-btn').addEventListener('click', recenterNav);
document.getElementById('nav-voice-toggle').addEventListener('click', toggleVoice);

document.getElementById('nav-instruction').addEventListener('click', () => {
  if (!navArrived) toggleStepsList();
});
document.getElementById('nav-steps-list').addEventListener('click', toggleStepsList);
document.getElementById('nav-steps-list-close').addEventListener('click', e => {
  e.stopPropagation();
  toggleStepsList();
});

// visibilitychange isn't reliable once ios suspends the app, @capacitor/app's resume event is the real signal
// true background tracking would need location permission, skipped on purpose, this just catches up after
function initAppResume() {
  if (!isNativeApp()) return;
  Capacitor.Plugins.App.addListener('resume', async () => {
    if (!navActive) {
      tick();
      return;
    }
    try {
      const pos = await getCurrentPosition({ enableHighAccuracy: true });
      handleNavFix(pos.coords.latitude, pos.coords.longitude, pos.coords.heading, pos.coords.speed, pos.coords.accuracy);
    } catch (err) { /* next watchPosition fix will catch it up anyway */ }
  });
}

initAppResume();
