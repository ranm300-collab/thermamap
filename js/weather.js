const WX_COORDS = { lat: 35.0844, lng: -106.6504 };

let lastReadingTime = null;
let lastFeelsLike = null;
let lastUV = null;

function updateFreshnessText() {
  const el = document.getElementById('wx-time');
  if (!lastReadingTime) return;
  const mins = Math.round((Date.now() - lastReadingTime) / 60000);
  const text = mins < 1 ? 'just now' : mins === 1 ? '1 min ago' : `${mins} min ago`;
  el.textContent = 'as of ' + text;
}

function loadFromNWS() {
  // google down, fall back to nws
  fetch('https://api.weather.gov/stations/KABQ/observations/latest')
    .then(res => {
      if (!res.ok) throw new Error('nws bad status');
      return res.json();
    })
    .then(data => {
      const c = data.properties.temperature.value;
      if (c === null) throw new Error('nws temp null');
      const f = c * 9 / 5 + 32;
      document.getElementById('temp-now').textContent = Math.round(f) + '°F';
      document.getElementById('temp-detail').textContent = '';
      lastFeelsLike = f;
      lastUV = null;
      lastReadingTime = new Date(data.properties.timestamp);
      updateFreshnessText();
    })
    .catch(err => console.error('nws fallback failed', err));
}

function loadWeather() {
  let retries = 0
  const url = `https://weather.googleapis.com/v1/currentConditions:lookup?key=${GOOGLE_MAPS_KEY}&location.latitude=${WX_COORDS.lat}&location.longitude=${WX_COORDS.lng}&unitsSystem=IMPERIAL`;

  fetch(url)
    .then(res => {
      if (!res.ok) throw new Error('bad status');
      return res.json();
    })
    .then(data => {
      const f = data.temperature.degrees;
      const feels = data.feelsLikeTemperature.degrees;
      const uv = data.uvIndex;
      document.getElementById('temp-now').textContent = Math.round(f) + '°F';
      document.getElementById('temp-detail').textContent = `feels ${Math.round(feels)}° · uv ${uv}`;
      lastFeelsLike = feels;
      lastUV = uv;
      lastReadingTime = new Date(data.currentTime);
      updateFreshnessText();
    })
    .catch(err => {
      console.error('google wx failed', err);
      loadFromNWS();
    });
}

const ALERT_URL = 'https://api.weather.gov/alerts/active?point=35.0844,-106.6504';
const ALERT_RANK = ['Extreme Heat Warning', 'Extreme Heat Watch', 'Heat Advisory']
// ?fakealert=1 to see the banner, no real heat alerts in sept lol
const FAKE_ALERT = {
  event: 'Heat Advisory',
  ends: '2026-09-23T20:00:00-06:00',
  instruction: 'Drink plenty of fluids and take breaks in shade or ac during the hottest part of the day.'
};

function formatAlertEnd(iso) {
  const d = new Date(iso);
  let h = d.getHours();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h} ${ampm}`;
}
function pickWorstAlert(features) {
  let best = null;
  features.forEach(f => {
    const rank = ALERT_RANK.indexOf(f.properties.event);
    if (rank === -1) return;
    if (!best || rank < ALERT_RANK.indexOf(best.event)) best = f.properties;
  });
  return best;
}

let lastAlertData = null;

const HEAT_TIPS = [
  'walking home from school, leave a little early and stick to shade',
  'older folks, skip outdoor errands til it cools off tonight',
  'waiting on the bus, find shade or duck inside somewhere close',
  'working outside, take more water breaks than feels necessary'
];

// heat index can run up to 15f hotter in full sun, why shade routes matter
function getHeatLabel(feels) {
  if (feels >= 103) return 'Danger';
  if (feels >= 90) return 'Extreme caution';
  return null;
}

function getEffectiveFeelsLike() {
  const fake = new URLSearchParams(location.search).get('fakeheat');
  if (fake !== null) return Number(fake);
  return lastFeelsLike;
}

function buildHeatTips() {
  const tips = HEAT_TIPS.slice();
  if (lastUV !== null && lastUV >= 8) tips.push('uv is brutal today too, shade matters more than usual');
  return tips.join('\n');
}

function showHeatRisk(label, feels) {
  const banner = document.getElementById('alert-banner');
  document.getElementById('alert-headline').textContent = `${label} · feels like ${Math.round(feels)}°`;
  document.getElementById('alert-instruction').textContent = buildHeatTips();
  banner.classList.remove('severe', 'caution', 'expanded');
  banner.classList.add(label === 'Danger' ? 'severe' : 'caution');
  banner.hidden = false;
  google.maps.event.trigger(map, 'resize');
  map.setCenter(ABQ_CENTER);
}

function updateBanner() {
  if (lastAlertData) {
    showAlert(lastAlertData);
    return;
  }
  const feels = getEffectiveFeelsLike();
  const label = feels === null ? null : getHeatLabel(feels);
  if (label) showHeatRisk(label, feels);
  else hideAlert();
}

function showAlert(alert) {
  const banner = document.getElementById('alert-banner');
  document.getElementById('alert-headline').textContent = `${alert.event} until ${formatAlertEnd(alert.ends)}`;
  document.getElementById('alert-instruction').textContent = alert.instruction;
  banner.classList.remove('severe', 'caution', 'expanded');
  banner.classList.add(alert.event === 'Extreme Heat Warning' ? 'severe' : 'caution');
  banner.hidden = false;
  google.maps.event.trigger(map, 'resize');
  map.setCenter(ABQ_CENTER);
}

function hideAlert() {
  const banner = document.getElementById('alert-banner');
  if (banner.hidden) return;
  banner.hidden = true;
  google.maps.event.trigger(map, 'resize');
  map.setCenter(ABQ_CENTER);
}

function loadAlerts() {
  if (new URLSearchParams(location.search).get('fakealert') === '1') {
    lastAlertData = FAKE_ALERT;
    updateBanner();
    return;
  }
  fetch(ALERT_URL)
    .then(res => {
      if (!res.ok) throw new Error('alerts bad status');
      return res.json();
    })
    .then(data => {
      lastAlertData = pickWorstAlert(data.features);
      updateBanner();
    })
    .catch(err => console.error('alerts fetch failed', err));
}

document.getElementById('alert-banner').addEventListener('click', () => {
  document.getElementById('alert-banner').classList.toggle('expanded');
});
