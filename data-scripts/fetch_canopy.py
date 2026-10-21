# Grabs the meta/wri 1m global canopy height tiles that cover the abq bbox

import os
import json
import ssl
import certifi
import urllib.request
from common import BBOX_MAP

# this python installs own cert bundle is missing, urlretrieve fails ssl verify without this
urllib.request.install_opener(
    urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=certifi.where()))
    )
)

TILES_INDEX_URL = 'https://dataforgood-fb-data.s3.amazonaws.com/forests/v2/global/dinov3_global_chm_v2_ml3/tiles.geojson'
TILE_BASE_URL = 'https://dataforgood-fb-data.s3.amazonaws.com/forests/v2/global/dinov3_global_chm_v2_ml3/chm'
BBOX = BBOX_MAP
INDEX_PATH = 'data/canopy/tiles.geojson'
OUT_DIR = 'data/canopy/raw'


def download(url, path):
    if os.path.exists(path):
        print(f'  {path} already there, skipping')
        return
    print(f'  downloading {os.path.basename(path)}...')
    urllib.request.urlretrieve(url, path)

def find_matching_tiles():
    # tiles are a quadkey grid, the dataset ships a geojson index of tile -> footprint
    # instead of us guessing the quadkey math
    download(TILES_INDEX_URL, INDEX_PATH)
    with open(INDEX_PATH) as f:
        index = json.load(f)

    matches = []
    for feature in index['features']:
        coords = feature['geometry']['coordinates'][0]
        lons = [c[0] for c in coords]
        lats = [c[1] for c in coords]
        tw, te = min(lons), max(lons)
        ts, tn = min(lats), max(lats)
        if tw < BBOX[2] and te > BBOX[0] and ts < BBOX[3] and tn > BBOX[1]:
            matches.append(feature['properties']['tile'])
    return matches

if __name__ == '__main__':
    os.makedirs(OUT_DIR, exist_ok=True)
    tiles = find_matching_tiles()
    print(f'found {len(tiles)} tiles covering the abq bbox')

    for tile in tiles:
        download(f'{TILE_BASE_URL}/{tile}.tif', f'{OUT_DIR}/{tile}.tif')

    total_bytes = sum(
        os.path.getsize(os.path.join(OUT_DIR, f)) for f in os.listdir(OUT_DIR)
    )
    print(f'total size on disk: {total_bytes / (1024 * 1024):.1f} mb')
