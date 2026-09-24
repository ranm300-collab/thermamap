const START_COLOR = '#3d6b5c';
const DEST_COLOR = '#c15a3c';

let startEl = null;
let destEl = null;
let startMarker = null;
let destMarker = null;
let startPlace = null;
let destPlace = null;

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

function fitBothPins() {
  if (!startMarker || !destMarker) return;
  const bounds = new google.maps.LatLngBounds();
  bounds.extend(startMarker.getPosition());
  bounds.extend(destMarker.getPosition());
  map.fitBounds(bounds, 60);
}

function setStartPlace(place) {
  startPlace = { lat: place.location.lat(), lng: place.location.lng(), name: place.displayName };
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

  // pins don't move, just relabeling which one is start vs dest
  const tempMarker = startMarker;
  startMarker = destMarker;
  destMarker = tempMarker;
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
