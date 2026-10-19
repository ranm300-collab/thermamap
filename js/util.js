// small helpers reused in enough places to be worth pulling out

function urlParam(name) {
  return new URLSearchParams(location.search).get(name)
}

function urlFlag(name) {
  return urlParam(name) === '1'
}

async function fetchJson(url, label) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${label} bad status`)
  return res.json()
}

// capacitor injects window.Capacitor inside the ios app shell, never present in a plain browser tab
function isNativeApp() {
  return !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform())
}
