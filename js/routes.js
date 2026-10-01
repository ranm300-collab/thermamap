const ROUTE_COLOR = '#2f6fb0';
const ROUTE_OUTLINE = '#fdf6ee';
// alts were basically invisible, that gray was too close to the road color
const ALT_ROUTE_COLOR = '#736b5c';

let travelMode = 'WALKING';
let routes = [];
let selectedRouteIndex = 0;
let routePolylines = [];

function clearRoutePolylines() {
  routePolylines.forEach(lines => {
    lines.hit.setMap(null);
    lines.outline.setMap(null);
    lines.main.setMap(null);
  });
  routePolylines = [];
}


function makeRouteLines(route, i) {
  // wide + invisible, just so the thin alt lines are actually tappable
  const hit = new google.maps.Polyline({
    path: route.path,
    map: map,
    strokeOpacity: 0,
    strokeWeight: 18,
    zIndex: 5,
  });
  const outline = new google.maps.Polyline({
    path: route.path,
    map: map,
    strokeColor: ROUTE_OUTLINE,
    strokeOpacity: 0,
    strokeWeight: 10,
    zIndex: 1
  });
  const main = new google.maps.Polyline({
    path: route.path,
    map: map,
    zIndex: 2
  });
  hit.addListener('click', () => selectRoute(i));
  main.addListener('click', () => selectRoute(i));
  return { hit, outline, main };
}

function restyleRoutes() {
  routePolylines.forEach((lines, i) => {
    if (i === selectedRouteIndex) {
      lines.outline.setOptions({ strokeOpacity: 0.9 });
      lines.main.setOptions({ strokeColor: ROUTE_COLOR, strokeOpacity: 0.95, strokeWeight: 6, zIndex: 3 });
    } else {
      lines.outline.setOptions({ strokeOpacity: 0 });
      lines.main.setOptions({ strokeColor: ALT_ROUTE_COLOR, strokeOpacity: 0.8, strokeWeight: 5, zIndex: 2 });
    }
  });
}

function drawRoutes() {
  clearRoutePolylines();
  routes.forEach((route, i) => {
    routePolylines.push(makeRouteLines(route, i));
  });
  restyleRoutes();
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

    const main = document.createElement('div');
    main.textContent = `${formatDuration(route.durationMillis)} · ${formatDistance(route.distanceMeters)}`;
    row.appendChild(main);

    const sub = document.createElement('div');
    sub.className = 'route-row-sub';
    sub.textContent = routeRowSubtext(i);
    row.appendChild(sub);

    row.addEventListener('click', () => selectRoute(i));
    list.appendChild(row);
  });
}

function fitSelectedRoute() {
  const route = routes[selectedRouteIndex];
  if (!route) return;
  // extra top/left padding, card sits over teh corner of the map
  map.fitBounds(route.viewport, { top: 40, left: 280, right: 40, bottom: 40 });
}

function selectRoute(i) {
  selectedRouteIndex = i;
  restyleRoutes();
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
  routeScores = [];
  coolestIndex = -1;

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
      scoreAllRoutes();
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
