# grabs summer landsat surface temp scenes over abq from planetary computer, download only for now

import os
import time
import pystac_client
import planetary_computer
import rasterio
from rasterio.windows import from_bounds
from rasterio.warp import transform_bounds

STAC_URL = 'https://planetarycomputer.microsoft.com/api/stac/v1'
COLLECTION = 'landsat-c2-l2'
BBOX = [-106.95, 34.85, -106.35, 35.40]  # west, south, east, north, wider than the map now, more scenes to work with
YEARS = list(range(2019, 2027))
PLATFORMS = ['landsat-8', 'landsat-9']  # lowercase w/ dash, not "Landsat 8"
MAX_CLOUD = 10
OUT_DIR = 'data/landsat'


def covers_bbox(item):
    ib = item.bbox
    return ib[0] <= BBOX[0] and ib[1] <= BBOX[1] and ib[2] >= BBOX[2] and ib[3] >= BBOX[3]

def scene_name(item):
    d = item.datetime.strftime('%Y%m%d')
    code = 'LC08' if item.properties['platform'] == 'landsat-8' else 'LC09'
    return f'{code}_{d}'

def find_scenes(max_cloud):
    # pc's stac api warns it doesn't declare QUERY conformance, filtering works fine anyway
    catalog = pystac_client.Client.open(STAC_URL, modifier=planetary_computer.sign_inplace)
    items = []
    for year in YEARS:
        search = catalog.search(
            collections=[COLLECTION],
            bbox=BBOX,
            datetime=f'{year}-05-20/{year}-09-30',  # late may through sept, not just peak summer
            query={
                'eo:cloud_cover': {'lt': max_cloud},
                'platform': {'in': PLATFORMS}
            }
        )
        for item in search.items():
            if covers_bbox(item):
                items.append(item)
    return items


def download_band(item, asset_key, out_path):
    if os.path.exists(out_path):
        print(f'  {out_path} already there, skipping')
        return
    href = item.assets[asset_key].href
    with rasterio.open(href) as src:
        left, bottom, right, top = transform_bounds('EPSG:4326', src.crs, *BBOX)
        window = from_bounds(left, bottom, right, top, src.transform)
        data = src.read(1, window=window)
        profile = src.profile.copy()
        profile.update(
            height=data.shape[0],
            width=data.shape[1],
            transform=src.window_transform(window)
        )
        with rasterio.open(out_path, 'w', **profile) as dst:
            dst.write(data, 1)

def fetch_all(max_cloud):
    os.makedirs(OUT_DIR, exist_ok=True)
    print(f'searching, cloud cover under {max_cloud}%...')
    items = find_scenes(max_cloud)
    print(f'found {len(items)} scenes covering the whole bbox')

    for item in items:
        name = scene_name(item)
        print(f'downloading {name}...')
        # lwir11 is the actual asset key, ST_B10 is just the band's title/description
        download_band(item, 'lwir11', f'{OUT_DIR}/{name}_st.tif')
        download_band(item, 'qa_pixel', f'{OUT_DIR}/{name}_qa.tif')

    return items


def print_summary(items):
    total_bytes = sum(
        os.path.getsize(os.path.join(OUT_DIR, f)) for f in os.listdir(OUT_DIR)
    )
    print()
    print(f'{len(items)} scenes downloaded:')
    for item in items:
        print(' ', scene_name(item), f"{item.properties['eo:cloud_cover']}% cloud")
    print(f'total size on disk: {total_bytes / (1024 * 1024):.1f} mb')

if __name__ == '__main__':
    scenes = fetch_all(MAX_CLOUD)
    if len(scenes) < 5:
        print(f'only got {len(scenes)}, loosening cloud cover to 20% and retrying')
        scenes = fetch_all(20)
    print_summary(scenes)
