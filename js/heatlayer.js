const HEAT_MIN_ZOOM = 10;
const HEAT_MAX_ZOOM = 15; // tiles stop here, past this we overzoom the z15 tile instead

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
  document.getElementById('heat-legend').hidden = !heatOn;
  if (heatOn) {
    map.overlayMapTypes.push(heatMapType);
  } else {
    map.overlayMapTypes.clear();
  }
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
}
