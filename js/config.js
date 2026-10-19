const GOOGLE_MAPS_KEY_WEB = 'AIzaSyAMR18fdVuEyUqm9vHCltlENWdc28oC1pM';
const GOOGLE_MAPS_KEY_IOS = ''; // paste the thermamap-ios key between these quotes

// capacitor serves the app over a capacitor: url instead of http/https, that's how we tell
// the wrapped ios app apart from a regular browser tab. falls back to the web key if ios is empty
const GOOGLE_MAPS_KEY = (location.protocol === 'capacitor:' && GOOGLE_MAPS_KEY_IOS) ? GOOGLE_MAPS_KEY_IOS : GOOGLE_MAPS_KEY_WEB;
