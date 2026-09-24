const ROUTE_COLOR = '#2f6fb0';
const ALT_ROUTE_COLOR = '#a89f8f';

let travelMode = 'WALKING';
let routes = [];
let selectedRouteIndex = 0;
let routePolylines = [];

function clearRoutePolylines() {
  routePolylines.forEach(line => line.setMap(null));
  routePolylines = [];
}

function styleForIndex(i) {
  if (i === selectedRouteIndex) {
    return { strokeColor: ROUTE_COLOR, strokeWeight: 6, strokeOpacity: 0.95, zIndex: 2 };
  }
  return { strokeColor: ALT_ROUTE_COLOR, strokeWeight: 3, strokeOpacity: 0.7, zIndex: 1 };
}

function drawRoutes() {
  clearRoutePolylines();
  routes.forEach((route, i) => {
    const line = new google.maps.Polyline({
      path: route.path,
      map: map,
      ...styleForIndex(i)
    });
    line.addListener('click', () => selectRoute(i));
    routePolylines.push(line);
  });
}

function formatDuration(ms) {
  return Math.round(ms / 60000) + ' min';
}

function formatDistance(meters) {
  return (meters / 1609.34).toFixed(1) + ' mi';
}

function renderRouteList() {
  const list = document.getElementById('route-list');
  list.innerHTML = '';
  routes.forEach((route, i) => {
    const row = document.createElement('div');
    row.className = 'route-row' + (i === selectedRouteIndex ? ' selected' : '');
    row.textContent = `${formatDuration(route.durationMillis)} · ${formatDistance(route.distanceMeters)}`;
    row.addEventListener('click', () => selectRoute(i));
    list.appendChild(row);
  });
}

function fitSelectedRoute() {
  const route = routes[selectedRouteIndex];
  if (!route) return;
  // extra top/left padding, card sits over that corner of the map
  map.fitBounds(route.viewport, { top: 40, left: 280, right: 40, bottom: 40 });
}

function selectRoute(i) {
  selectedRouteIndex = i;
  drawRoutes();
  renderRouteList();
  fitSelectedRoute();
}

function setRouteError(msg) {
  const el = document.getElementById('route-error');
  el.textContent = msg;
  el.hidden = false;
}

function loadRoutes() {
  if (!startPlace || !destPlace) return;

  document.getElementById('route-error').hidden = true;

  google.maps.importLibrary('routes')
    .then(({ Route }) => {
      const request = {
        origin: { lat: startPlace.lat, lng: startPlace.lng },
        destination: { lat: destPlace.lat, lng: destPlace.lng },
        travelMode: travelMode,
        computeAlternativeRoutes: true,
        fields: ['path', 'distanceMeters', 'durationMillis', 'viewport', 'routeLabels']
      };
      return Route.computeRoutes(request);
    })
    .then(result => {
      if (!result.routes.length) {
        clearRoutePolylines();
        routes = [];
        document.getElementById('route-list').innerHTML = '';
        setRouteError(travelMode === 'BICYCLING' ? "No bike route for this one, try walking" : "No route found for this one");
        return;
      }
      routes = result.routes;
      selectedRouteIndex = 0;
      drawRoutes();
      renderRouteList();
      fitSelectedRoute();
    })
    .catch(err => {
      console.error('routes request failed', err);
      setRouteError("Couldn't get routes, try again");
    });
}

function setMode(mode) {
  if (mode === travelMode) return;
  travelMode = mode;
  document.getElementById('mode-walk').classList.toggle('active', mode === 'WALKING');
  document.getElementById('mode-bike').classList.toggle('active', mode === 'BICYCLING');
  loadRoutes();
}

document.getElementById('mode-walk').addEventListener('click', () => setMode('WALKING'));
document.getElementById('mode-bike').addEventListener('click', () => setMode('BICYCLING'));
