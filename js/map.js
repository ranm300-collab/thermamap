const ABQ_CENTER = { lat: 35.0844, lng: -106.6504 };

// picked these by eye, sandy land and soft roads read calmer than default gmaps colors
// keeping poi.park visible since shade coverage from parks matters for the routing later
const MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#e8e0d0' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#4a4238' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#e8e0d0' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#c9c0b0' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#8a8072' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#a8c5cf' }] },
  { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#b8c9a0' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] }
];

// was getting "no imagery here" patches when zooming in too far or drifting off the city
const METRO_BOUNDS = {
  north: 35.30,
  south: 34.90,
  east: -106.45,
  west: -106.85
};

function initMap() {
  new google.maps.Map(document.getElementById('map'), {
    center: ABQ_CENTER,
    zoom: 13,
    minZoom: 10,
    maxZoom: 19,
    restriction: {
      latLngBounds: METRO_BOUNDS,
      strictBounds: false
    },
    backgroundColor: '#e8e0d0',
    styles: MAP_STYLE,
    mapTypeControl: false,
    streetViewControl: false
  });
}

function loadMapsScript() {
  const script = document.createElement('script');
  script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_KEY}&loading=async&callback=initMap`;
  script.defer = true;
  document.head.appendChild(script);
}

loadMapsScript();
