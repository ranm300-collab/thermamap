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

function initMap() {
  new google.maps.Map(document.getElementById('map'), {
    center: ABQ_CENTER,
    zoom: 13,
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
