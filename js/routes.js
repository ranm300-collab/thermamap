const ROUTE_COLOR = '#2f6fb0';
const ROUTE_OUTLINE = '#fdf6ee';
// alts were basically invisible, that gray was too close to the road color
const ALT_ROUTE_COLOR = '#736b5c';

let travelMode = 'WALKING';
let routes = [];
let selectedRouteIndex = 0;
let routePolylines = [];
let routeRequestId = 0; // bumped on every new search and on clear, late async results check this and bail

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
    seg.addListener('click', () => selectRouteByUser(i));
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
  hit.addListener('click', () => selectRouteByUser(i));
  main.addListener('click', () => selectRouteByUser(i));
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

function routeArriveText(route) {
  const d = new Date(currentDepartureMs() + route.durationMillis);
  return 'arrive ' + (isTomorrow(d) ? 'tomorrow ' : '') + formatClockTime(d);
}

const ROUTE_LABELS = ['Route A', 'Route B', 'Route C', 'Route D'];
const MOBILE_SHEET_PX = 700; // keep in sync w/ the media query in style.css
let sheetExpanded = false;

const LONG_WALK_MIN = 45;
const LONG_WALK_HOT_F = 90;

// nudge, not a nag - only for a genuinely long walk when its also actually hot out
function longHotWalkNote(route) {
  if (travelMode !== 'WALKING' || route.durationMillis / 60000 < LONG_WALK_MIN) return null;
  const feels = state.weather.feelsLike;
  const bannerShowing = !document.getElementById('alert-banner').hidden;
  if ((feels !== null && feels >= LONG_WALK_HOT_F) || bannerShowing) {
    return "That's a long walk in this heat, biking or the bus might be safer";
  }
  return null;
}

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

// heat-legend is a map control anchored near the bottom too, so on the phone-width bottom
// sheet it needs to get pushed up above the sheet instead of sitting underneath it
function positionHeatLegendAboveSheet() {
  const legend = document.getElementById('heat-legend');
  const panel = document.getElementById('route-cards-panel');
  if (!isMobileSheet() || panel.hidden) {
    legend.style.marginBottom = '';
    return;
  }
  legend.style.marginBottom = (panel.getBoundingClientRect().height + 8) + 'px';
}

window.addEventListener('resize', () => {
  positionRouteCardsPanel();
  positionHeatLegendAboveSheet();
});

function setSheetExpanded(expanded) {
  sheetExpanded = expanded;
  document.getElementById('route-cards-panel').classList.toggle('expanded', expanded);
  // wait for the sheet's own transition before re-measuring its height
  setTimeout(() => {
    fitSelectedRoute();
    positionHeatLegendAboveSheet();
  }, 220);
}

function renderRouteCards() {
  const panel = document.getElementById('route-cards-panel');
  panel.hidden = !routes.length;
  positionRouteCardsPanel();
  document.getElementById('leave-time-label').textContent = leaveTimeCardsLabel();
  const list = document.getElementById('route-cards');
  list.innerHTML = '';

  routes.forEach((route, i) => {
    const card = document.createElement('div');
    card.className = 'route-card' + (i === selectedRouteIndex ? ' selected' : '');
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');

    const top = document.createElement('div');
    top.className = 'route-card-top';

    const label = document.createElement('div');
    label.className = 'route-card-label';
    label.textContent = route.isDetour ? 'Shady detour' : (ROUTE_LABELS[i] || `Route ${i + 1}`);
    top.appendChild(label);

    if (i === selectedRouteIndex) {
      const startBtn = document.createElement('button');
      startBtn.type = 'button';
      startBtn.className = 'route-card-start-btn';
      startBtn.textContent = 'Start';
      startBtn.addEventListener('click', e => {
        e.stopPropagation();
        startNav();
      });
      top.appendChild(startBtn);
    }

    card.appendChild(top);

    const main = document.createElement('div');
    main.className = 'route-card-main';
    main.textContent = `${formatDuration(route.durationMillis)} · ${routeArriveText(route)} · ${formatDistance(route.distanceMeters)}`;
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

    if (i === selectedRouteIndex) {
      const heatNote = longHotWalkNote(route);
      if (heatNote) {
        const heatNoteEl = document.createElement('div');
        heatNoteEl.className = 'route-card-heat-note';
        heatNoteEl.textContent = heatNote;
        card.appendChild(heatNoteEl);
      }

      const tip = betterLeaveTimeTip(i);
      if (tip) {
        const tipEl = document.createElement('button');
        tipEl.type = 'button';
        tipEl.className = 'route-card-tip';
        tipEl.textContent = tip.text;
        tipEl.addEventListener('click', e => {
          e.stopPropagation();
          setLeaveTime(tip.ms);
        });
        card.appendChild(tipEl);
      }
    }

    const pickThisCard = () => {
      selectRouteByUser(i);
      if (!sheetExpanded) setSheetExpanded(true);
    };
    card.addEventListener('click', pickThisCard);
    card.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault(); // space would otherwise scroll the sheet
      pickThisCard();
    });
    list.appendChild(card);
  });

  // measured after the cards are actually in the dom, so it accounts for their real height
  positionHeatLegendAboveSheet();
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

// a tap, not the auto coolest pick, so stop auto-switching the selection til the next search
function selectRouteByUser(i) {
  userPickedRoute = true;
  selectRoute(i);
}

function setRouteError(msg) {
  const el = document.getElementById('route-error');
  el.textContent = msg;
  el.hidden = false;
}

function showRouteLoading() {
  const panel = document.getElementById('route-cards-panel');
  panel.hidden = false;
  positionRouteCardsPanel();
  document.getElementById('leave-time-label').textContent = '';
  const list = document.getElementById('route-cards');
  list.innerHTML = '';
  const loading = document.createElement('div');
  loading.className = 'route-loading';
  loading.textContent = 'Finding the best route...';
  list.appendChild(loading);
}

async function loadRoutes() {
  if (!state.start || !state.dest) return;
  const requestId = ++routeRequestId;

  document.getElementById('route-error').hidden = true;
  routeScores = [];
  coolestIndex = -1;
  userPickedRoute = false;
  sheetExpanded = false;
  document.getElementById('route-cards-panel').classList.remove('expanded');
  showRouteLoading();

  try {
    const { Route } = await google.maps.importLibrary('routes');
    const result = await Route.computeRoutes({
      origin: { lat: state.start.lat, lng: state.start.lng },
      destination: { lat: state.dest.lat, lng: state.dest.lng },
      travelMode: travelMode,
      computeAlternativeRoutes: true,
      // legs is for turn by turn during nav (steps w/ maneuver, instructions, distance, endLocation).
      // the api wont take a narrower dotted path like legs.steps.maneuver, legs is the smallest unit
      fields: ['path', 'distanceMeters', 'durationMillis', 'viewport', 'routeLabels', 'legs']
    });
    if (requestId !== routeRequestId) return; // route got cleared or another search started while this was in flight

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
    showLeaveHintIfNew();
    setSearchExpanded(false);
  } catch (err) {
    if (requestId !== routeRequestId) return;
    console.error('routes request failed', err);
    document.getElementById('route-cards-panel').hidden = true;
    setRouteError("Couldn't get routes, try again");
  }
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

// keeps "arrive 4:37 pm" honest as the clock moves, only matters when following "now"
function refreshArrivalTimesIfNow() {
  if (state.leaveTimeMs !== null || !routes.length) return;
  renderRouteCards();
}

registerJob('arrival-times', 30 * 1000, refreshArrivalTimesIfNow);
