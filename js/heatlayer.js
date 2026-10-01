const HEAT_MIN_ZOOM = 10;
const HEAT_MAX_ZOOM = 15; // tiles stop here, past this we overzoom the z15 tile instead
const HEAT_CLAMP_F = 15; // same clamp used to build the tile colors, keeps markers lined up with the bar
const NUDGE_THRESHOLD_PCT = 10;

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

function anomalyToPercent(anomaly) {
  const clamped = Math.max(-HEAT_CLAMP_F, Math.min(HEAT_CLAMP_F, anomaly));
  return ((clamped + HEAT_CLAMP_F) / (2 * HEAT_CLAMP_F)) * 100;
}

function formatAnomaly(anomaly) {
  const rounded = Math.round(anomaly);
  return (rounded >= 0 ? '+' : '') + rounded + '°';
}

function updateLegendVisibility() {
  const bothSet = !!(startPlace && destPlace);
  const legend = document.getElementById('heat-legend');
  legend.hidden = !(heatOn || bothSet);
  legend.classList.toggle('compact', !heatOn && bothSet);
}

function positionMarker(label, elId, nodataId, place) {
  const el = document.getElementById(elId);
  const nodataEl = document.getElementById(nodataId);

  if (!place) {
    el.hidden = true;
    nodataEl.hidden = true;
    return Promise.resolve(null);
  }

  return getGridCell(place.lat, place.lng).then(cell => {
    if (!cell || cell.anomaly === null) {
      el.hidden = true;
      nodataEl.hidden = false;
      return null;
    }
    nodataEl.hidden = true;
    const pct = anomalyToPercent(cell.anomaly);
    el.style.left = pct + '%';
    el.querySelector('.heat-marker-label').textContent = `${label} ${formatAnomaly(cell.anomaly)}`;
    el.hidden = false;
    return pct;
  });
}

function updateHeatMarkers() {
  updateLegendVisibility();
  if (document.getElementById('heat-legend').hidden) return;

  const startLabel = startPlace && startPlace.name === 'Current location' ? 'You' : 'Start';
  Promise.all([
    positionMarker(startLabel, 'heat-marker-start', 'heat-marker-start-nodata', startPlace),
    positionMarker('Dest', 'heat-marker-dest', 'heat-marker-dest-nodata', destPlace)
  ]).then(([startPct, destPct]) => {
    const close = startPct !== null && destPct !== null && Math.abs(startPct - destPct) < NUDGE_THRESHOLD_PCT;
    document.getElementById('heat-marker-dest').classList.toggle('nudge', close);
  });
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
