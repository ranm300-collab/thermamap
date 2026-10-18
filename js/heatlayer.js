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
    document.querySelector(`#heat-band-${i} .heat-band-tags`).textContent = '';
  }
}

// sticks a "Start"/"Dest" tag on whichever band row the place falls into
function tagBand(i, text) {
  const tagsEl = document.querySelector(`#heat-band-${i} .heat-band-tags`);
  tagsEl.textContent = tagsEl.textContent ? `${tagsEl.textContent}, ${text}` : text;
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
  tagBand(bandIndexFor(cell.anomaly), label);
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
}
