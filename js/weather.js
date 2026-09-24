const WX_COORDS = { lat: 35.0844, lng: -106.6504 }

function loadFromNWS() {
  // google api down, fall back to nws
  fetch('https://api.weather.gov/stations/KABQ/observations/latest')
    .then(res => {
      if (!res.ok) throw new Error('nws bad status')
      return res.json()
    })
    .then(data => {
      const c = data.properties.temperature.value
      if (c === null) throw new Error('nws temp null')
      const f = c * 9 / 5 + 32
      document.getElementById('temp-now').textContent = Math.round(f) + '°F'
      document.getElementById('temp-detail').textContent = ''
    })
    .catch(err => console.error('nws fallback failed', err))
}

function loadWeather() {
  const url = `https://weather.googleapis.com/v1/currentConditions:lookup?key=${GOOGLE_MAPS_KEY}&location.latitude=${WX_COORDS.lat}&location.longitude=${WX_COORDS.lng}&unitsSystem=IMPERIAL`

  fetch(url)
    .then(res => {
      if (!res.ok) throw new Error('bad status')
      return res.json()
    })
    .then(data => {
      const f = data.temperature.degrees
      const feels = data.feelsLikeTemperature.degrees
      const uv = data.uvIndex
      document.getElementById('temp-now').textContent = Math.round(f) + '°F'
      document.getElementById('temp-detail').textContent = `feels ${Math.round(feels)}° · uv ${uv}`
    })
    .catch(err => {
      console.error('google wx failed', err)
      loadFromNWS()
    })
}

loadWeather()
setInterval(loadWeather, 10 * 60 * 1000)
