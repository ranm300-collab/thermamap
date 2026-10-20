const START_COLOR = '#3d6b5c';
const DEST_COLOR = '#c15a3c';

let startEl = null;
let destEl = null;
let startMarker = null;
let destMarker = null;
let hereMarker = null;
let accuracyCircle = null;
let searchExpanded = false;

function pinIcon(color) {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: 9,
    fillColor: color,
    fillOpacity: 1,
    strokeColor: '#fff',
    strokeWeight: 2
  };
}

// dot + soft ring, like the blue dot on google/apple maps but our colors
function hereIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34">
    <circle cx="17" cy="17" r="15" fill="${START_COLOR}" fill-opacity="0.18"/>
    <circle cx="17" cy="17" r="7" fill="${START_COLOR}" stroke="#fff" stroke-width="2"/>
  </svg>`;
  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(34, 34),
    anchor: new google.maps.Point(17, 17)
  };
}

function clearHereMarker() {
  if (hereMarker) hereMarker.setMap(null);
  if (accuracyCircle) accuracyCircle.setMap(null);
  hereMarker = null;
  accuracyCircle = null;
}

function isInsideMetro(lat, lng) {
  const bounds = new google.maps.LatLngBounds(
    { lat: METRO_BOUNDS.south, lng: METRO_BOUNDS.west },
    { lat: METRO_BOUNDS.north, lng: METRO_BOUNDS.east }
  );
  return bounds.contains({ lat, lng });
}

function setLocationNotice(msg) {
  const el = document.getElementById('location-notice');
  el.textContent = msg;
  el.hidden = false;
}

async function useCurrentLocation() {
  const row = document.getElementById('current-location-row');
  row.textContent = 'Finding you...';
  document.getElementById('location-notice').hidden = true;

  try {
    const pos = await getCurrentPosition({ enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;

    state.start = { lat, lng, name: 'Current location' };
    startEl.value = 'Current location';
    row.textContent = 'Current location';
    row.hidden = true;

    if (startMarker) startMarker.setMap(null);
    startMarker = null;
    clearHereMarker();
    hereMarker = new google.maps.Marker({ position: { lat, lng }, map: map, icon: hereIcon(), zIndex: 10 });
    accuracyCircle = new google.maps.Circle({
      center: { lat, lng },
      radius: pos.coords.accuracy,
      map: map,
      fillColor: START_COLOR,
      fillOpacity: 0.12,
      strokeColor: START_COLOR,
      strokeOpacity: 0.3,
      strokeWeight: 1,
    });

    if (!isInsideMetro(lat, lng)) {
      setLocationNotice("Looks like you're outside ABQ, routes may be off");
    }

    fitBothPins();
    loadRoutes();
    updateHeatMarkers();
  } catch (err) {
    row.textContent = 'Current location';
    if (err.code === err.PERMISSION_DENIED) {
      setLocationNotice('Location is blocked, type a start instead');
    } else {
      setLocationNotice("Couldn't find you, try again or type a start");
    }
  }
}

function fitBothPins() {
  const startPos = startMarker ? startMarker.getPosition() : (hereMarker ? hereMarker.getPosition() : null);
  if (!startPos || !destMarker) return;
  const bounds = new google.maps.LatLngBounds();
  bounds.extend(startPos);
  bounds.extend(destMarker.getPosition());
  map.fitBounds(bounds, 60);
}

// pill shows a short "X to Y" once both ends are picked, otherwise just the placeholder
function updateSearchPillText() {
  document.getElementById('search-pill-text').textContent =
    (state.start && state.dest) ? `${state.start.name} to ${state.dest.name}` : 'Where to?';
}

function setSearchExpanded(expanded) {
  searchExpanded = expanded;
  document.getElementById('search-card').classList.toggle('expanded', expanded);
  document.getElementById('search-pill').classList.toggle('search-pill-hidden', expanded);
  if (!expanded) updateSearchPillText();
}

// everything that depends on having a start+dest pair - routes, scores, detours, the
// legend tags, the bottom sheet. gets called whenever either end goes away, not just a full clear
function clearRouteDisplay() {
  routeRequestId++; // anything already in flight (scoring, detours) should ignore its own result now
  clearRoutePolylines();
  clearDetourMarkers();
  hideDetourStatus();
  routes = [];
  routeScores = [];
  routeRawData = [];
  coolestIndex = -1;
  userPickedRoute = false;
  selectedRouteIndex = 0;
  document.getElementById('route-cards').innerHTML = '';
  document.getElementById('route-cards-panel').hidden = true;
  document.getElementById('route-error').hidden = true;
  setSheetState('collapsed');
  clearBandTags();
  updateHeatMarkers();
}

// full reset - both locations, their pins, and anything route related. back to a clean map
function clearRoute() {
  state.start = null;
  state.dest = null;
  if (startEl) startEl.value = '';
  if (destEl) destEl.value = '';
  clearHereMarker();
  if (startMarker) { startMarker.setMap(null); startMarker = null; }
  if (destMarker) { destMarker.setMap(null); destMarker = null; }
  clearRouteDisplay();
  setSearchExpanded(false);
  updateSearchPillText();
}

document.getElementById('search-pill').addEventListener('click', () => setSearchExpanded(true));
document.getElementById('search-card-close').addEventListener('click', clearRoute);

// tap anywhere outside the open panel to collapse it back to the pill (doesn't clear anything,
// setStartPlace/setDestPlace already updated state.start/dest if a real pick happened)
document.addEventListener('click', e => {
  if (!searchExpanded) return;
  const card = document.getElementById('search-card');
  const pill = document.getElementById('search-pill');
  if (card.contains(e.target) || pill.contains(e.target)) return;
  setSearchExpanded(false);
});

function setStartPlace(place) {
  state.start = { lat: place.location.lat(), lng: place.location.lng(), name: place.displayName };
  clearHereMarker();
  if (startMarker) startMarker.setMap(null);
  startMarker = new google.maps.Marker({
    position: place.location,
    map: map,
    icon: pinIcon(START_COLOR)
  });
  fitBothPins();
  loadRoutes();
  updateHeatMarkers();
}

function setDestPlace(place) {
  state.dest = { lat: place.location.lat(), lng: place.location.lng(), name: place.displayName };
  if (destMarker) destMarker.setMap(null);
  destMarker = new google.maps.Marker({
    position: place.location,
    map: map,
    icon: pinIcon(DEST_COLOR)
  });
  fitBothPins();
  loadRoutes();
  updateHeatMarkers();
}

function wireAutocomplete(el, onPick) {
  el.addEventListener('gmp-select', async ({ placePrediction }) => {
    const place = placePrediction.toPlace();
    try {
      // gotta fetchFields first, location/name aren't on the prediction itself
      await place.fetchFields({ fields: ['displayName', 'location'] });
      onPick(place);
    } catch (err) {
      console.error('place fetch failed', err);
    }
  });
}

document.getElementById('swap-btn').addEventListener('click', () => {
  if (!startEl || !destEl) return;

  const tempPlace = state.start;
  state.start = state.dest;
  state.dest = tempPlace;

  if (hereMarker) {
    // current location moving to dest, it's just a regular pin from here on
    const herePos = hereMarker.getPosition();
    clearHereMarker();
    startMarker = destMarker;
    destMarker = new google.maps.Marker({ position: herePos, map: map, icon: pinIcon(DEST_COLOR) });
  } else {
    // pins don't move, just relabeling which one is start vs dest
    const tempMarker = startMarker;
    startMarker = destMarker;
    destMarker = tempMarker;
  }
  if (startMarker) startMarker.setIcon(pinIcon(START_COLOR));
  if (destMarker) destMarker.setIcon(pinIcon(DEST_COLOR));

  const tempValue = startEl.value;
  startEl.value = destEl.value;
  destEl.value = tempValue;

  loadRoutes();
  updateHeatMarkers();
});

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function formatClockTime(d) {
  let h = d.getHours();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${pad2(d.getMinutes())} ${ampm}`;
}

function isTomorrow(d) {
  return d.toDateString() !== new Date().toDateString();
}

function leaveLabelText() {
  if (state.leaveTimeMs === null) return 'Leaving now';
  const d = new Date(state.leaveTimeMs);
  return 'Leaving ' + (isTomorrow(d) ? 'tomorrow ' : '') + formatClockTime(d);
}

function leaveButtonText() {
  return leaveLabelText() + ' ▾';
}

// cards panel wants lowercase, reads into a sentence there instead of standing alone like the button
function leaveTimeCardsLabel() {
  if (state.leaveTimeMs === null) return 'leaving now';
  const d = new Date(state.leaveTimeMs);
  return 'leaving ' + (isTomorrow(d) ? 'tomorrow ' : '') + formatClockTime(d);
}

function closeLeaveTimePicker() {
  document.getElementById('leave-label-btn').hidden = false;
  document.getElementById('leave-time-input').hidden = true;
  document.getElementById('leave-reset-btn').hidden = true;
}

function setLeaveTime(ms) {
  state.leaveTimeMs = ms;
  document.getElementById('leave-label-btn').textContent = leaveButtonText();
  closeLeaveTimePicker();
  rescoreAllFromCache();
}

const LEAVE_HINT_KEY = 'seenLeaveHint';

function leaveHintSeen() {
  try {
    return localStorage.getItem(LEAVE_HINT_KEY) === '1';
  } catch (err) {
    return false; // private browsing etc, just show the hint every time, no big deal
  }
}

function dismissLeaveHint() {
  document.getElementById('leave-hint').hidden = true;
  try {
    localStorage.setItem(LEAVE_HINT_KEY, '1');
  } catch (err) { /* storage blocked, hint just comes back next visit, fine */ }
}

// routes.js calls this once a route is actually on screen
function showLeaveHintIfNew() {
  if (leaveHintSeen()) return;
  document.getElementById('leave-hint').hidden = false;
}

function openLeaveTimePicker() {
  dismissLeaveHint();
  const input = document.getElementById('leave-time-input');
  const base = state.leaveTimeMs === null ? new Date() : new Date(state.leaveTimeMs);
  input.value = `${pad2(base.getHours())}:${pad2(base.getMinutes())}`;
  document.getElementById('leave-label-btn').hidden = true;
  input.hidden = false;
  document.getElementById('leave-reset-btn').hidden = false;
  input.focus();
  // chrome/android can pop the native picker right away instead of waiting for a second tap,
  // but it throws in some contexts (no real user gesture, policy stuff), input still works either way
  if (input.showPicker) {
    try { input.showPicker(); } catch (err) { /* fine, they can just tap the field */ }
  }
}

document.getElementById('leave-label-btn').addEventListener('click', openLeaveTimePicker);
document.getElementById('leave-reset-btn').addEventListener('click', () => setLeaveTime(null));
document.getElementById('leave-time-input').addEventListener('change', () => {
  const val = document.getElementById('leave-time-input').value;
  if (!val) return;
  const [h, m] = val.split(':').map(Number);
  const picked = new Date();
  picked.setHours(h, m, 0, 0);
  if (picked.getTime() < Date.now()) picked.setDate(picked.getDate() + 1); // already passed today, must mean tomorrow
  setLeaveTime(picked.getTime());
});

async function initSearch() {
  try {
    const { PlaceAutocompleteElement } = await google.maps.importLibrary('places');

    startEl = new PlaceAutocompleteElement();
    startEl.placeholder = 'Start';
    startEl.locationRestriction = METRO_BOUNDS;
    startEl.includedRegionCodes = ['us'];
    document.getElementById('start-slot').appendChild(startEl);
    wireAutocomplete(startEl, setStartPlace);

    // focusin/focusout cross the shadow boundry, plain focus/blur dont
    const locationRow = document.getElementById('current-location-row');
    startEl.addEventListener('focusin', () => { locationRow.hidden = false; });
    startEl.addEventListener('focusout', e => {
      if (e.relatedTarget === locationRow) return; // tabbing into the button, dont yank it away
      locationRow.hidden = true;
    });
    startEl.addEventListener('input', () => {
      locationRow.hidden = true;
      clearHereMarker();
      // field went empty - stale pin/route for the old start shouldn't stick around
      if (startEl.value === '' && state.start) {
        state.start = null;
        if (startMarker) { startMarker.setMap(null); startMarker = null; }
        clearRouteDisplay();
      }
    });
    // without this the row blurs before the click lands, mousedown fires first
    locationRow.addEventListener('mousedown', e => e.preventDefault());
    locationRow.addEventListener('click', useCurrentLocation);

    destEl = new PlaceAutocompleteElement();
    destEl.placeholder = 'Where are you headed?';
    destEl.locationRestriction = METRO_BOUNDS;
    destEl.includedRegionCodes = ['us'];
    document.getElementById('dest-slot').appendChild(destEl);
    wireAutocomplete(destEl, setDestPlace);
    destEl.addEventListener('input', () => {
      if (destEl.value === '' && state.dest) {
        state.dest = null;
        if (destMarker) { destMarker.setMap(null); destMarker = null; }
        clearRouteDisplay();
      }
    });

    // top left so it stays clear of the zoom buttons. one container pushed in, not two -
    // maps lays out multiple pushed elements side by side instead of letting them overlap
    const container = document.getElementById('search-container');
    container.hidden = false;
    map.controls[google.maps.ControlPosition.TOP_LEFT].push(container);
  } catch (err) {
    console.error('places library failed to load', err);
    document.getElementById('search-error').hidden = false;
    document.getElementById('start-slot').hidden = true;
    document.getElementById('dest-slot').hidden = true;
    document.getElementById('swap-btn').hidden = true;
    // no autocomplete to collapse away from, just show the card open and skip the pill
    const container = document.getElementById('search-container');
    container.hidden = false;
    document.getElementById('search-pill').hidden = true;
    document.getElementById('search-card').classList.add('expanded');
    map.controls[google.maps.ControlPosition.TOP_LEFT].push(container);
  }
}
