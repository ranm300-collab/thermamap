// follow-mode navigation after tapping Start on a route card. tracks the user along
// the selected route, no turn by turn yet, that's a later pass

const NAV_ZOOM = { WALKING: 18, BICYCLING: 17 };
const NAV_MIN_MOVING_MPS = 0.3; // gps reports tiny nonzero speeds sometimes even standing still
const NAV_WALKED_COLOR = '#c9bfa8'; // close to the road color, reads as "already done"

let navActive = false;
let navFollowing = true;
let navWatchId = null;
let navWakeLock = null;
let navDragListener = null;
let navMarker = null;
let navAccuracyCircle = null;
let navWalkedLine = null;
let navLastFix = null;
let navLastHeading = 0;

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

function updateNavProgress(lat, lng) {
  const route = routes[selectedRouteIndex];
  const scored = routeScores[selectedRouteIndex];
  if (!route || !scored || !scored.samples) return;

  const samples = scored.samples;
  const idx = closestSampleIndex(samples, lat, lng);
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
  updateNavProgress(lat, lng);
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

  document.getElementById('search-card').hidden = true;
  document.getElementById('route-cards-panel').hidden = true;
  document.getElementById('nav-bar').hidden = false;

  navActive = true;
  navFollowing = true;
  navLastFix = null;
  navLastHeading = 0;

  map.setZoom(NAV_ZOOM[travelMode] || NAV_ZOOM.WALKING);
  // map stays north up for now - rotating it to match heading needs a vector map id,
  // and this app uses the classic styled raster map for the custom desert colors
  navDragListener = map.addListener('dragstart', onNavDragStart);

  await acquireWakeLock();
  startRealWatch();
}

function endNav() {
  navActive = false;

  if (navWatchId !== null) {
    navigator.geolocation.clearWatch(navWatchId);
    navWatchId = null;
  }
  releaseWakeLock();

  if (navMarker) { navMarker.setMap(null); navMarker = null; }
  if (navAccuracyCircle) { navAccuracyCircle.setMap(null); navAccuracyCircle = null; }
  if (navWalkedLine) { navWalkedLine.setMap(null); navWalkedLine = null; }
  if (navDragListener) { navDragListener.remove(); navDragListener = null; }

  document.getElementById('nav-bar').hidden = true;
  document.getElementById('nav-recenter-btn').hidden = true;
  document.getElementById('nav-location-error').hidden = true;
  document.getElementById('search-card').hidden = false;
  document.getElementById('route-cards-panel').hidden = !routes.length;

  colorSelectedRoute(); // back to the normal full-route heat coloring
}

document.getElementById('nav-end-btn').addEventListener('click', endNav);
document.getElementById('nav-location-exit-btn').addEventListener('click', endNav);
document.getElementById('nav-recenter-btn').addEventListener('click', recenterNav);
