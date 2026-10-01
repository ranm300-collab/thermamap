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
    lines.segments.forEach(seg => seg.setMap(null));
  });
  routePolylines = [];
}

function clearRouteSegments(i) {
  const lines = routePolylines[i];
  if (!lines) return;
  lines.segments.forEach(seg => seg.setMap(null));
  lines.segments = [];
}

// draws one colored polyline per run on top of the route, main line gets hidden in restyleRoutes
function drawRouteSegments(i, runs) {
  clearRouteSegments(i);
  const lines = routePolylines[i];
  if (!lines) return;
  lines.segments = runs.map(run => {
    const seg = new google.maps.Polyline({
      path: run.path,
      map: map,
      strokeColor: HEAT_LEVEL_COLORS[run.level],
      strokeOpacity: 0.95,
      strokeWeight: 6,
      zIndex: 3
    });
    seg.addListener('click', () => selectRoute(i));
    return seg;
  });
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
  return { hit, outline, main, segments: [] };
}

function restyleRoutes() {
  routePolylines.forEach((lines, i) => {
    if (i === selectedRouteIndex) {
      lines.outline.setOptions({ strokeOpacity: 0.9 });
      const hasSegments = lines.segments.length > 0; // segments cover the line, hide main underneath
      lines.main.setOptions({ strokeColor: ROUTE_COLOR, strokeOpacity: hasSegments ? 0 : 0.95, strokeWeight: 6, zIndex: 3 });
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

const ROUTE_LABELS = ['Route A', 'Route B', 'Route C', 'Route D'];
const MOBILE_SHEET_PX = 700; // keep in sync w/ the media query in style.css
let sheetExpanded = false;

function isMobileSheet() {
  return window.matchMedia(`(max-width: ${MOBILE_SHEET_PX}px)`).matches;
}

// map.controls forces its own inline left/top, fights our css, so this stays out of it
function positionRouteCardsPanel() {
  const panel = document.getElementById('route-cards-panel');
  if (isMobileSheet()) {
    panel.style.left = '';
    panel.style.top = '';
    panel.style.width = '';
    return;
  }
  const rect = document.getElementById('search-card').getBoundingClientRect();
  panel.style.left = rect.left + 'px';
  panel.style.top = (rect.bottom + 10) + 'px';
  panel.style.width = rect.width + 'px';
}

window.addEventListener('resize', positionRouteCardsPanel);

function setSheetExpanded(expanded) {
  sheetExpanded = expanded;
  document.getElementById('route-cards-panel').classList.toggle('expanded', expanded);
  // wait for the sheet's own transition before re-measuring its height
  setTimeout(fitSelectedRoute, 220);
}

function renderRouteCards() {
  const panel = document.getElementById('route-cards-panel');
  panel.hidden = !routes.length;
  positionRouteCardsPanel();
  const list = document.getElementById('route-cards');
  list.innerHTML = '';

  routes.forEach((route, i) => {
    const card = document.createElement('div');
    card.className = 'route-card' + (i === selectedRouteIndex ? ' selected' : '');

    const label = document.createElement('div');
    label.className = 'route-card-label';
    label.textContent = ROUTE_LABELS[i] || `Route ${i + 1}`;
    card.appendChild(label);

    const main = document.createElement('div');
    main.className = 'route-card-main';
    main.textContent = `${formatDuration(route.durationMillis)} · ${formatDistance(route.distanceMeters)}`;
    card.appendChild(main);

    const heat = document.createElement('div');
    heat.className = 'route-card-heat';
    heat.textContent = routeCardHeatLine(i);
    card.appendChild(heat);

    const tag = routeTags(i);
    if (tag) {
      const tagEl = document.createElement('div');
      tagEl.className = 'route-card-tag';
      tagEl.textContent = tag;
      card.appendChild(tagEl);
    }

    const compare = routeComparisonText(i);
    if (compare) {
      const compareEl = document.createElement('div');
      compareEl.className = 'route-card-compare';
      compareEl.textContent = compare;
      card.appendChild(compareEl);
    }

    card.addEventListener('click', () => {
      selectRoute(i);
      if (!sheetExpanded) setSheetExpanded(true);
    });
    list.appendChild(card);
  });
}

document.getElementById('route-sheet-handle').addEventListener('click', () => setSheetExpanded(!sheetExpanded));

function fitSelectedRoute() {
  const route = routes[selectedRouteIndex];
  if (!route) return;
  const panel = document.getElementById('route-cards-panel');
  // phone = bottom sheet over the map, pad around however tall it actually is
  const bottomPad = isMobileSheet() && !panel.hidden ? panel.getBoundingClientRect().height + 20 : 40;
  // extra top/left padding, card sits over teh corner of the map
  map.fitBounds(route.viewport, { top: 40, left: 280, right: 40, bottom: bottomPad });
}

function selectRoute(i) {
  selectedRouteIndex = i;
  colorSelectedRoute();
  restyleRoutes();
  renderRouteCards();
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
  sheetExpanded = false;
  document.getElementById('route-cards-panel').classList.remove('expanded');

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
        document.getElementById('route-cards').innerHTML = '';
        document.getElementById('route-cards-panel').hidden = true;
        setRouteError(travelMode === 'BICYCLING' ? "No bike route for this one, try walking" : "No route found for this one");
        return;
      }
      routes = result.routes;
      selectedRouteIndex = 0;
      drawRoutes();
      renderRouteCards();
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
