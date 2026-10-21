const ABQ_CENTER = {lat: 35.0844, lng: -106.6504};

// colors picked by eye, calmer then default
// parks = shade
const MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#e8e0d0' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#4a4238' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#e8e0d0' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#c9c0b0' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#8a8072' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#a8c5cf' }] },
  { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#b8c9a0' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  // city name label was vanishing right at min zoom, force it on
  { featureType: 'administrative.locality', elementType: 'labels', stylers: [{ visibility: 'on' }] }
];

// inset from the actual heat data extent so thers always real (faded) data past the hard edge
const METRO_BOUNDS = {
  north: 35.35,
  south: 34.90,
  east: -106.40,
  west: -106.90,
};

let map

function initMap() {
  map = new google.maps.Map(document.getElementById('map'), {
    center: ABQ_CENTER,
    zoom: 13,
    // zoomed out past this, a laptop-width window would show past where heat data exists
    minZoom: 12,
    maxZoom: 19,
    restriction: {
      latLngBounds: METRO_BOUNDS,
      strictBounds: true
    },
    backgroundColor: '#e8e0d0',
    styles: MAP_STYLE,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false // does nothing useful here, esp inside the iphone app
  });
  initSearch();
  initHeatLayer();
  initTuneMode();
  initClearTest();
  initFieldTestMode();
}

function loadMapsScript() {
  const script = document.createElement('script');
  script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_KEY}&loading=async&callback=initMap`;
  script.defer = true;
  document.head.appendChild(script);
}

loadMapsScript();
