const ABQ_CENTER = { lat: 35.0844, lng: -106.6504 };

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

// zoom + bounds, was hitting blank map patches
const METRO_BOUNDS = {
  north: 35.3,
  south: 34.9,
  east: -106.45,
  west: -106.85,
};

let map

function initMap() {
  map = new google.maps.Map(document.getElementById('map'), {
    center: ABQ_CENTER,
    zoom: 13,
    // 10 was too far out, city label drops off right at that zoom
    minZoom: 11,
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
