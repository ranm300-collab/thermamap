// ?cleartest=1 dev check, plans one real route then clears it every way a user actually can
// logs what's left on screen after each so i can catch stale sheet/lines/cards without guessing

function clearTestOn() {
  return urlFlag('cleartest');
}

const CLEAR_TEST_START = { lat: 35.084, lng: -106.619, name: 'UNM' };
const CLEAR_TEST_DEST = { lat: 35.081, lng: -106.605, name: 'Nob Hill' };

function sheetReallyHidden() {
  const panel = document.getElementById('route-cards-panel');
  if (panel.hidden) return true;
  const rect = panel.getBoundingClientRect();
  return getComputedStyle(panel).display === 'none' || (rect.width === 0 && rect.height === 0);
}

function clearTestLog(label) {
  const hidden = sheetReallyHidden();
  const cardCount = document.getElementById('route-cards').children.length;
  const pins = (startMarker ? 1 : 0) + (destMarker ? 1 : 0) + (hereMarker ? 1 : 0);
  const ok = hidden && routePolylines.length === 0 && cardCount === 0 && routes.length === 0;
  console.log(`${ok ? 'ok' : 'STILL SHOWING'} - ${label}: sheet hidden=${hidden}, polylines=${routePolylines.length}, cards=${cardCount}, pins=${pins}`);
}

// sets up a fresh route the same way a real pick would, no api calls needed for this
async function clearTestFreshRoute() {
  state.start = { ...CLEAR_TEST_START };
  state.dest = { ...CLEAR_TEST_DEST };
  startEl.value = CLEAR_TEST_START.name;
  destEl.value = CLEAR_TEST_DEST.name;
  if (startMarker) startMarker.setMap(null);
  if (destMarker) destMarker.setMap(null);
  startMarker = new google.maps.Marker({ position: CLEAR_TEST_START, map, icon: pinIcon(START_COLOR) });
  destMarker = new google.maps.Marker({ position: CLEAR_TEST_DEST, map, icon: pinIcon(DEST_COLOR) });
  await loadRoutes();
}

async function runClearTest() {
  console.log('cleartest starting...');

  await clearTestFreshRoute();
  await new Promise(r => setTimeout(r, 600));
  startEl.value = '';
  startEl.dispatchEvent(new Event('input'));
  await new Promise(r => setTimeout(r, 500)); // polling backstop runs every 400ms
  clearTestLog('x on start, never leaving the field');

  await clearTestFreshRoute();
  await new Promise(r => setTimeout(r, 600));
  destEl.value = '';
  destEl.dispatchEvent(new Event('input'));
  await new Promise(r => setTimeout(r, 500));
  clearTestLog('x on destination, never leaving the field');

  await clearTestFreshRoute();
  await new Promise(r => setTimeout(r, 600));
  startEl.value = ''; // same event a real backspace-to-empty fires
  startEl.dispatchEvent(new Event('input'));
  await new Promise(r => setTimeout(r, 100));
  clearTestLog('delete start text by hand');

  await clearTestFreshRoute(); // don't wait for scoring/detours to settle this time
  clearRoute();
  await new Promise(r => setTimeout(r, 2000)); // give any in-flight scoring/detour request time to land late
  clearTestLog('clear while scoring is still running');

  await clearTestFreshRoute();
  await new Promise(r => setTimeout(r, 600));
  startNav();
  await new Promise(r => setTimeout(r, 300));
  endNav();
  await new Promise(r => setTimeout(r, 300));
  clearTestLog('end navigation');

  console.log('cleartest done');
}

function initClearTest() {
  if (!clearTestOn()) return;
  document.getElementById('search-container').hidden = true;
  setTimeout(runClearTest, 1500);
}
