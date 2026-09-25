const START_COLOR = '#3d6b5c';
const DEST_COLOR = '#c15a3c';

let startEl = null;
let destEl = null;
let startMarker = null;
let destMarker = null;
let startPlace = null;
let destPlace = null;
let hereMarker = null;
let accuracyCircle = null;

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

function useCurrentLocation() {
  const row = document.getElementById('current-location-row');
  row.textContent = 'Finding you...';
  document.getElementById('location-notice').hidden = true;

  navigator.geolocation.getCurrentPosition(
    pos => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;

      startPlace = { lat, lng, name: 'Current location' };
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
    },
    err => {
      row.textContent = 'Current location';
      if (err.code === err.PERMISSION_DENIED) {
        setLocationNotice('Location is blocked, type a start instead');
      } else {
        setLocationNotice("Couldn't find you, try again or type a start");
      }
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

function fitBothPins() {
  const startPos = startMarker ? startMarker.getPosition() : (hereMarker ? hereMarker.getPosition() : null);
  if (!startPos || !destMarker) return;
  const bounds = new google.maps.LatLngBounds();
  bounds.extend(startPos);
  bounds.extend(destMarker.getPosition());
  map.fitBounds(bounds, 60);
}

function setStartPlace(place) {
  startPlace = { lat: place.location.lat(), lng: place.location.lng(), name: place.displayName };
  clearHereMarker();
  if (startMarker) startMarker.setMap(null);
  startMarker = new google.maps.Marker({
    position: place.location,
    map: map,
    icon: pinIcon(START_COLOR)
  });
  fitBothPins();
  loadRoutes();
}

function setDestPlace(place) {
  destPlace = { lat: place.location.lat(), lng: place.location.lng(), name: place.displayName };
  if (destMarker) destMarker.setMap(null);
  destMarker = new google.maps.Marker({
    position: place.location,
    map: map,
    icon: pinIcon(DEST_COLOR)
  });
  fitBothPins();
  loadRoutes();
}

function wireAutocomplete(el, onPick) {
  el.addEventListener('gmp-select', ({ placePrediction }) => {
    const place = placePrediction.toPlace();
    // gotta fetchFields first, location/name aren't on the prediction itself
    place.fetchFields({ fields: ['displayName', 'location'] })
      .then(() => onPick(place))
      .catch(err => console.error('place fetch failed', err));
  });
}

document.getElementById('swap-btn').addEventListener('click', () => {
  if (!startEl || !destEl) return;

  const tempPlace = startPlace;
  startPlace = destPlace;
  destPlace = tempPlace;

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
});

function initSearch() {
  google.maps.importLibrary('places')
    .then(({ PlaceAutocompleteElement }) => {
      startEl = new PlaceAutocompleteElement();
      startEl.placeholder = 'Start';
      startEl.locationRestriction = METRO_BOUNDS;
      startEl.includedRegionCodes = ['us'];
      document.getElementById('start-slot').appendChild(startEl);
      wireAutocomplete(startEl, setStartPlace);

      // focusin/focusout cross the shadow boundry, plain focus/blur dont
      const locationRow = document.getElementById('current-location-row');
      startEl.addEventListener('focusin', () => { locationRow.hidden = false; });
      startEl.addEventListener('focusout', () => { locationRow.hidden = true; });
      startEl.addEventListener('input', () => {
        locationRow.hidden = true;
        clearHereMarker();
      });
      // without this the row blurs before the click lands, mousedown fires first
      locationRow.addEventListener('mousedown', e => e.preventDefault());
      locationRow.addEventListener('click', useCurrentLocation);

      destEl = new PlaceAutocompleteElement();
      destEl.placeholder = 'Where to?';
      destEl.locationRestriction = METRO_BOUNDS;
      destEl.includedRegionCodes = ['us'];
      document.getElementById('dest-slot').appendChild(destEl);
      wireAutocomplete(destEl, setDestPlace);

      // top left so it stays clear of the zoom buttons
      const card = document.getElementById('search-card');
      card.hidden = false;
      map.controls[google.maps.ControlPosition.TOP_LEFT].push(card);
    })
    .catch(err => {
      console.error('places library failed to load', err);
      document.getElementById('search-error').hidden = false;
      document.getElementById('start-slot').hidden = true;
      document.getElementById('dest-slot').hidden = true;
      document.getElementById('swap-btn').hidden = true;
      // top left so it stays clear of the zoom buttons
      const card = document.getElementById('search-card');
      card.hidden = false;
      map.controls[google.maps.ControlPosition.TOP_LEFT].push(card);
    });
}
