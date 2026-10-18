# bbox/crs/pixel settings shared across the data-scripts, so they dont drift out of sync

TARGET_CRS = 'EPSG:32613'  # utm 13n, what most of our scenes are alredy in

BBOX_MAP = [-106.85, 34.9, -106.45, 35.35]  # west, south, east, north, matches the live map
BBOX_LANDSAT = [-106.95, 34.85, -106.35, 35.40]  # wider, for landsat fetch + lst processing

LANDSAT_PIXEL_SIZE = 30
