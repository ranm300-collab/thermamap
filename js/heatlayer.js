const HEAT_MIN_ZOOM = 12; // matches the map's own minZoom, nothing below this ever gets requested
const HEAT_MAX_ZOOM = 15; // tiles stop here, past this we overzoom the z15 tile instead

// same 5 bands as export_web.py, upper edge of bands 0-3
const HEAT_BAND_THRESHOLDS = [-6, -2, 2, 6];
const HEAT_BAND_NAMES = ['Much cooler', 'Cooler', 'Typical', 'Hotter', 'Much hotter'];

let heatMapType = null;
let heatOn = false;

function heatTileUrl(coord, zoom) {
  let z = zoom, x = coord.x, y = coord.y;
  if (z > HEAT_MAX_ZOOM) {
    const scale = Math.pow(2, z - HEAT_MAX_ZOOM);
    x = Math.floor(x / scale);
    y = Math.floor(y / scale);
    z = HEAT_MAX_ZOOM;
  }
  if (z < HEAT_MIN_ZOOM) return null;
  return `webdata/heat/${z}/${x}/${y}.png`;
}

function toggleHeat() {
  heatOn = !heatOn;
  document.getElementById('heat-toggle').classList.toggle('active', heatOn);
  if (heatOn) {
    map.overlayMapTypes.push(heatMapType);
  } else {
    map.overlayMapTypes.clear();
    closeTapPopup();
  }
  updateHeatMarkers();
}

function bandIndexFor(anomaly) {
  let i = 0;
  while (i < HEAT_BAND_THRESHOLDS.length && anomaly >= HEAT_BAND_THRESHOLDS[i]) i++;
  return i;
}

function updateLegendVisibility() {
  const bothSet = !!(state.start && state.dest);
  const legend = document.getElementById('heat-legend');
  legend.hidden = !(heatOn || bothSet);
  legend.classList.toggle('compact', !heatOn && bothSet);
}

function clearBandTags() {
  for (let i = 0; i < HEAT_BAND_NAMES.length; i++) {
    document.querySelector(`#heat-band-${i} .heat-band-markers`).textContent = '';
  }
}

// little "Start -4°" label above whichever band row it falls into
function tagBand(i, label, anomaly) {
  const markers = document.querySelector(`#heat-band-${i} .heat-band-markers`);
  const el = document.createElement('span');
  el.className = 'heat-band-marker';
  el.textContent = `${label} ${anomaly >= 0 ? '+' : ''}${Math.round(anomaly)}°`;
  markers.appendChild(el);
}

async function positionMarker(label, nodataId, place) {
  const nodataEl = document.getElementById(nodataId);

  if (!place) {
    nodataEl.hidden = true;
    return;
  }

  const cell = await getGridCell(place.lat, place.lng);
  if (!cell || cell.anomaly === null) {
    nodataEl.hidden = false;
    return;
  }
  nodataEl.hidden = true;
  tagBand(bandIndexFor(cell.anomaly), label, cell.anomaly);
}

function updateHeatMarkers() {
  updateLegendVisibility();
  if (document.getElementById('heat-legend').hidden) return;
  clearBandTags();

  const startLabel = state.start && state.start.name === 'Current location' ? 'You' : 'Start';
  Promise.all([
    positionMarker(startLabel, 'heat-marker-start-nodata', state.start),
    positionMarker('Dest', 'heat-marker-dest-nodata', state.dest)
  ]);
}

function initHeatLayer() {
  heatMapType = new google.maps.ImageMapType({
    getTileUrl: heatTileUrl,
    tileSize: new google.maps.Size(256, 256),
    opacity: 0.5,
    name: 'heat'
  });

  const toggle = document.getElementById('heat-toggle');
  map.controls[google.maps.ControlPosition.TOP_RIGHT].push(toggle);
  map.controls[google.maps.ControlPosition.BOTTOM_CENTER].push(document.getElementById('heat-legend'));
  toggle.addEventListener('click', toggleHeat);
  updateHeatMarkers();
  initTapPopup();
}

// popup you get from tapping the map, only live while heat is on
let tapProjection = null;
let tapDotMarker = null;
let tapPopupOpen = false;
let tapRequestId = 0;

const TAP_POPUP_MARGIN = 10;
const TAP_POPUP_DOT_GAP = 16; // clears the dot so the card doesn't sit right on top of it

function latLngToPagePoint(latLng) {
  const projection = tapProjection.getProjection();
  if (!projection) return null;
  const pt = projection.fromLatLngToContainerPixel(latLng);
  const mapRect = map.getDiv().getBoundingClientRect();
  return { x: mapRect.left + pt.x, y: mapRect.top + pt.y };
}

function showTapDot(latLng) {
  clearTapDot();
  tapDotMarker = new google.maps.Marker({
    position: latLng,
    map: map,
    clickable: false,
    zIndex: 8,
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 5,
      fillColor: '#fdf6ee',
      fillOpacity: 1,
      strokeColor: '#2b2620',
      strokeWeight: 2
    }
  });
}

function clearTapDot() {
  if (tapDotMarker) tapDotMarker.setMap(null);
  tapDotMarker = null;
}

// same shade cutoff as the route scoring
function sunLineFor(cell, date, timeLabel) {
  const hour = date.getHours();
  if (hour < SUN_UP_HOUR || hour > SUN_DOWN_HOUR) return 'Sun is down';
  const frac = shadeFractionFor(cell, date);
  if (frac === null) return null;
  const suffix = timeLabel ? `at ${timeLabel}` : 'right now';
  return (frac >= IN_SHADE_FRAC ? 'Shaded' : 'In the sun') + ' ' + suffix;
}

// same band names as the legend, so the popup and legend say the same thing
function groundLineFor(anomaly) {
  const name = HEAT_BAND_NAMES[bandIndexFor(anomaly)];
  if (name === 'Typical') return 'Typical: about typical ABQ ground';
  const rounded = Math.round(anomaly);
  const dir = rounded >= 0 ? 'above' : 'below';
  return `${name}: about ${Math.abs(rounded)}°F ${dir} typical ABQ ground`;
}

function buildTapPopupData(cell) {
  if (!cell || cell.anomaly === null || cell.canopy === null || isRooftopCell(cell)) {
    return { nodata: true };
  }
  const departureMs = currentDepartureMs();
  const date = new Date(departureMs);
  const timeLabel = state.leaveTimeMs === null ? null : formatClockTime(date);
  return {
    nodata: false,
    groundLine: groundLineFor(cell.anomaly),
    canopyLine: `${Math.round(cell.canopy)}% tree cover`,
    sunLine: sunLineFor(cell, date, timeLabel)
  };
}

function renderTapPopup(data) {
  const content = document.getElementById('tap-popup-content');
  content.textContent = '';

  if (data.loading) {
    const line = document.createElement('div');
    line.className = 'tap-popup-loading';
    line.textContent = 'checking...';
    content.appendChild(line);
    return;
  }

  if (data.nodata) {
    const line = document.createElement('div');
    line.className = 'tap-popup-nodata';
    line.textContent = 'No street level data here';
    content.appendChild(line);
    return;
  }

  [data.groundLine, data.canopyLine, data.sunLine].forEach(text => {
    if (!text) return;
    const line = document.createElement('div');
    line.className = 'tap-popup-line';
    line.textContent = text;
    content.appendChild(line);
  });

  const footnote = document.createElement('div');
  footnote.className = 'tap-popup-footnote';
  footnote.textContent = 'summer satellite average';
  content.appendChild(footnote);
}

// phone width has a bottom sheet over the map, the popup needs to float above it
function tapPopupMaxBottom() {
  if (!isMobileSheet()) return window.innerHeight - TAP_POPUP_MARGIN;
  const panel = document.getElementById('route-cards-panel');
  if (panel.hidden) return window.innerHeight - TAP_POPUP_MARGIN;
  return panel.getBoundingClientRect().top - TAP_POPUP_MARGIN;
}

function positionTapPopup(pagePoint) {
  const popup = document.getElementById('tap-popup');
  const rect = popup.getBoundingClientRect();
  const maxBottom = tapPopupMaxBottom();

  let left = pagePoint.x - rect.width / 2;
  left = Math.max(TAP_POPUP_MARGIN, Math.min(left, window.innerWidth - rect.width - TAP_POPUP_MARGIN));

  // prefer sitting above the tapped spot, flip below it if that would run off the top
  let top = pagePoint.y - TAP_POPUP_DOT_GAP - rect.height;
  if (top < TAP_POPUP_MARGIN) top = pagePoint.y + TAP_POPUP_DOT_GAP;
  top = Math.min(top, maxBottom - rect.height);
  top = Math.max(TAP_POPUP_MARGIN, top);

  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
}

function closeTapPopup() {
  tapPopupOpen = false;
  tapRequestId++;
  document.getElementById('tap-popup').hidden = true;
  clearTapDot();
}

async function openTapPopup(latLng) {
  const requestId = ++tapRequestId;
  tapPopupOpen = true;
  showTapDot(latLng);

  renderTapPopup({ loading: true });
  const popup = document.getElementById('tap-popup');
  popup.hidden = false;
  const pagePoint = latLngToPagePoint(latLng);
  if (pagePoint) positionTapPopup(pagePoint);

  const cell = await getGridCell(latLng.lat(), latLng.lng());
  if (requestId !== tapRequestId) return; // closed or tapped elsewhere while this was loading

  renderTapPopup(buildTapPopupData(cell));
  if (pagePoint) positionTapPopup(pagePoint); // real content is a different size than "checking..."
}

function initTapPopup() {
  // google isn't loaded when this file first runs, so build the overlay class in here
  function TapProjection() {}
  TapProjection.prototype = Object.create(google.maps.OverlayView.prototype);
  TapProjection.prototype.onAdd = function () {};
  TapProjection.prototype.draw = function () {};
  TapProjection.prototype.onRemove = function () {};

  tapProjection = new TapProjection();
  tapProjection.setMap(map);

  map.addListener('click', e => {
    if (!heatOn) return;
    openTapPopup(e.latLng);
  });
  // position is a one-time calc, not synced on pan/zoom, so just close instead
  map.addListener('dragstart', closeTapPopup);
  map.addListener('zoom_changed', closeTapPopup);

  document.getElementById('tap-popup-close').addEventListener('click', closeTapPopup);
  document.addEventListener('click', e => {
    if (!tapPopupOpen) return;
    if (document.getElementById('tap-popup').contains(e.target)) return;
    if (isMapSurfaceClick(e.target)) return; // real map taps go through the listener above
    closeTapPopup();
  });
}

// map.controls puts search-card/heat-toggle/heat-legend inside #map's dom, gotta exclude those
function isMapSurfaceClick(target) {
  const mapDiv = document.getElementById('map');
  if (!mapDiv.contains(target)) return false;
  const controlIds = ['search-card', 'heat-toggle', 'heat-legend'];
  return !controlIds.some(id => document.getElementById(id).contains(target));
}
