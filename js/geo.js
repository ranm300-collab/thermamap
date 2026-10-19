// one geolocation shape whether we're wrapped in capacitor or a plain browser tab

const GEO_CODES = { PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };

// the native plugin's errors dont carry the browser's numeric .code, so guess from the
// message instead - keeps the existing permission denied / unavailable text working either way
function normalizeGeoError(err) {
  const msg = ((err && err.message) || '').toLowerCase();
  let code = GEO_CODES.POSITION_UNAVAILABLE;
  if (msg.includes('denied') || msg.includes('permission')) code = GEO_CODES.PERMISSION_DENIED;
  else if (msg.includes('timeout')) code = GEO_CODES.TIMEOUT;
  return { ...GEO_CODES, code, message: err && err.message };
}

async function getCurrentPosition(options) {
  if (isNativeApp()) {
    try {
      return await Capacitor.Plugins.Geolocation.getCurrentPosition(options);
    } catch (err) {
      throw normalizeGeoError(err);
    }
  }
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, options));
}

// returns {clear} either way - watchPosition's own id shape differs between the two apis
// (plain number vs an async string), easier to just hide it behind one method
function watchPosition(options, onSuccess, onError) {
  if (isNativeApp()) {
    let watchId = null;
    let cleared = false;
    Capacitor.Plugins.Geolocation.watchPosition(options, (pos, err) => {
      if (cleared) return;
      if (err) onError(normalizeGeoError(err));
      else onSuccess(pos);
    }).then(id => {
      watchId = id;
      if (cleared) Capacitor.Plugins.Geolocation.clearWatch({ id });
    });
    return { clear: () => { cleared = true; if (watchId) Capacitor.Plugins.Geolocation.clearWatch({ id: watchId }); } };
  }
  const id = navigator.geolocation.watchPosition(onSuccess, onError, options);
  return { clear: () => navigator.geolocation.clearWatch(id) };
}
