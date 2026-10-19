// ?fieldtest=1 dev tool, log what i actually feel/measure outside and see if it matches the app

const FIELDTEST_KEY = 'fieldtestReadings';

function fieldTestOn() {
  return urlFlag('fieldtest');
}

function loadFieldReadings() {
  try {
    return JSON.parse(localStorage.getItem(FIELDTEST_KEY) || '[]');
  } catch (err) {
    return [];
  }
}

function saveFieldReadings(readings) {
  try {
    localStorage.setItem(FIELDTEST_KEY, JSON.stringify(readings));
  } catch (err) { /* storage blocked, reading just wont stick around */ }
}

let fieldSun = 'sun';
let fieldRelative = 'same';

function setToggleActive(groupSelector, activeId) {
  document.querySelectorAll(groupSelector).forEach(btn => btn.classList.toggle('active', btn.id === activeId));
}

function expectedDirectionForBand(band) {
  if (band === 'Much cooler' || band === 'Cooler') return 'cooler';
  if (band === 'Hotter' || band === 'Much hotter') return 'hotter';
  return 'same';
}

function matchesPrediction(r) {
  if (!r.predictedBand) return null;
  return expectedDirectionForBand(r.predictedBand) === r.feltRelative;
}

// right now, not a planned departure time - this is a reading taken in the field
async function predictAt(lat, lng) {
  const cell = await getGridCell(lat, lng);
  if (!cell || cell.anomaly === null || cell.canopy === null) {
    return { predictedBand: null, predictedAnomaly: null, predictedCanopy: null, predictedShaded: null };
  }
  const frac = shadeFractionFor(cell, new Date());
  return {
    predictedBand: HEAT_BAND_NAMES[bandIndexFor(cell.anomaly)],
    predictedAnomaly: cell.anomaly,
    predictedCanopy: cell.canopy,
    predictedShaded: frac === null ? null : frac >= IN_SHADE_FRAC
  };
}

function openFieldForm() {
  document.getElementById('fieldtest-temp').value = '';
  document.getElementById('fieldtest-note').value = '';
  document.getElementById('fieldtest-status').hidden = true;
  document.getElementById('fieldtest-form').hidden = false;
}

function closeFieldForm() {
  document.getElementById('fieldtest-form').hidden = true;
}

async function saveFieldReading() {
  const statusEl = document.getElementById('fieldtest-status');
  statusEl.hidden = false;
  statusEl.textContent = 'finding you...';

  try {
    const pos = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 })
    );
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const prediction = await predictAt(lat, lng);
    const tempVal = document.getElementById('fieldtest-temp').value;

    const readings = loadFieldReadings();
    readings.push({
      timeMs: Date.now(),
      lat, lng,
      measuredTempF: tempVal === '' ? null : Number(tempVal),
      feltSun: fieldSun,
      feltRelative: fieldRelative,
      note: document.getElementById('fieldtest-note').value.trim(),
      ...prediction
    });
    saveFieldReadings(readings);

    closeFieldForm();
  } catch (err) {
    statusEl.textContent = "couldn't get your location, try again";
  }
}

function fieldReadingRow(r) {
  const match = matchesPrediction(r);
  const matchText = match === null ? 'no data there' : (match ? 'matched' : "didn't match");

  const row = document.createElement('div');
  row.className = 'fieldtest-row';

  const top = document.createElement('div');
  top.className = 'fieldtest-row-top';
  top.textContent = `${formatClockTime(new Date(r.timeMs))} · ${r.feltSun}, felt ${r.feltRelative} · ${matchText}`;
  row.appendChild(top);

  const detail = document.createElement('div');
  detail.className = 'fieldtest-row-detail';
  let detailText = `predicted: ${r.predictedBand || 'no data'}`;
  if (r.measuredTempF !== null) detailText += ` · measured ${r.measuredTempF}°F`;
  if (r.note) detailText += ` · ${r.note}`;
  detail.textContent = detailText;
  row.appendChild(detail);

  return row;
}

function renderFieldPanel() {
  const readings = loadFieldReadings();
  const list = document.getElementById('fieldtest-list');
  list.textContent = '';
  readings.slice().reverse().forEach(r => list.appendChild(fieldReadingRow(r)));

  const judged = readings.filter(r => matchesPrediction(r) !== null);
  const matched = judged.filter(r => matchesPrediction(r));
  document.getElementById('fieldtest-summary').textContent = judged.length
    ? `${matched.length} of ${judged.length} matched the app's prediction`
    : 'no readings yet';
}

function openFieldPanel() {
  renderFieldPanel();
  document.getElementById('fieldtest-panel').hidden = false;
}

function closeFieldPanel() {
  document.getElementById('fieldtest-panel').hidden = true;
}

function exportFieldCsv() {
  const readings = loadFieldReadings();
  const header = 'time,lat,lng,measured_f,felt_sun,felt_relative,note,predicted_band,predicted_anomaly,predicted_canopy,predicted_shaded,matched';
  const rows = readings.map(r => [
    new Date(r.timeMs).toISOString(), r.lat, r.lng,
    r.measuredTempF === null ? '' : r.measuredTempF,
    r.feltSun, r.feltRelative,
    `"${r.note.replace(/"/g, '""')}"`,
    r.predictedBand || '',
    r.predictedAnomaly === null ? '' : r.predictedAnomaly,
    r.predictedCanopy === null ? '' : r.predictedCanopy,
    r.predictedShaded === null ? '' : r.predictedShaded,
    matchesPrediction(r) === null ? '' : matchesPrediction(r)
  ].join(','));

  const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'thermamap-field-log.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function initFieldTestMode() {
  if (!fieldTestOn()) return;

  const logBtn = document.getElementById('fieldtest-log-btn');
  const panelBtn = document.getElementById('fieldtest-panel-btn');
  logBtn.hidden = false;
  panelBtn.hidden = false;
  map.controls[google.maps.ControlPosition.TOP_RIGHT].push(logBtn);
  map.controls[google.maps.ControlPosition.TOP_RIGHT].push(panelBtn);

  logBtn.addEventListener('click', openFieldForm);
  panelBtn.addEventListener('click', openFieldPanel);
  document.getElementById('fieldtest-form-close').addEventListener('click', closeFieldForm);
  document.getElementById('fieldtest-panel-close').addEventListener('click', closeFieldPanel);
  document.getElementById('fieldtest-save-btn').addEventListener('click', saveFieldReading);
  document.getElementById('fieldtest-export-btn').addEventListener('click', exportFieldCsv);

  document.getElementById('fieldtest-sun-btn').addEventListener('click', () => {
    fieldSun = 'sun';
    setToggleActive('#fieldtest-sun-toggle .fieldtest-toggle-btn', 'fieldtest-sun-btn');
  });
  document.getElementById('fieldtest-shade-btn').addEventListener('click', () => {
    fieldSun = 'shade';
    setToggleActive('#fieldtest-sun-toggle .fieldtest-toggle-btn', 'fieldtest-shade-btn');
  });
  document.getElementById('fieldtest-hotter-btn').addEventListener('click', () => {
    fieldRelative = 'hotter';
    setToggleActive('#fieldtest-relative-toggle .fieldtest-toggle-btn', 'fieldtest-hotter-btn');
  });
  document.getElementById('fieldtest-same-btn').addEventListener('click', () => {
    fieldRelative = 'same';
    setToggleActive('#fieldtest-relative-toggle .fieldtest-toggle-btn', 'fieldtest-same-btn');
  });
  document.getElementById('fieldtest-cooler-btn').addEventListener('click', () => {
    fieldRelative = 'cooler';
    setToggleActive('#fieldtest-relative-toggle .fieldtest-toggle-btn', 'fieldtest-cooler-btn');
  });
}
