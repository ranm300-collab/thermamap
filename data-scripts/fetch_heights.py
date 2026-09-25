# pulls usgs 3dep lidar height-above-ground and builds a 5m obstacle grid (buildings + trees)

import os
import ssl
import certifi
import urllib.request
import numpy as np
import pystac_client
import planetary_computer
import rasterio
from rasterio import Affine
from rasterio.windows import Window, from_bounds
from rasterio.transform import array_bounds
from rasterio.warp import reproject, transform_bounds, Resampling

urllib.request.install_opener(
    urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=certifi.where()))
    )
)

STAC_URL = 'https://planetarycomputer.microsoft.com/api/stac/v1'
COLLECTION = '3dep-lidar-hag'
BBOX = [-106.85, 34.9, -106.45, 35.35]  # west, south, east, north, same as the map
RAW_DIR = 'data/heights/raw'
CANOPY_PCT_PATH = 'data/processed/abq_canopy_pct_5m.tif'
CANOPY_HEIGHT_PATH = 'data/processed/abq_canopy_height_5m.tif'
OUT_PATH = 'data/processed/abq_heights_5m.tif'
TARGET_CRS = 'EPSG:32613'
CHUNK_ROWS = 300
LIDAR_NODATA = -9999.0
MAX_OBSTACLE_M = 60  # taller than anything real in abq, clips lidar noise near steep terrain

def find_and_download_tiles():
    catalog = pystac_client.Client.open(STAC_URL, modifier=planetary_computer.sign_inplace)
    items = list(catalog.search(collections=[COLLECTION], bbox=BBOX, limit=100).items())
    print(f'found {len(items)} lidar tiles covering the abq bbox')

    paths = []
    for item in items:
        path = f'{RAW_DIR}/{item.id}.tif'
        if os.path.exists(path):
            print(f'  {path} already there, skipping')
        else:
            print(f'  downloading {item.id}...')
            urllib.request.urlretrieve(item.assets['data'].href, path)
        paths.append(path)
    return paths

def reproject_chunk_from_tiles(tile_paths, dst_transform, dst_w, dst_h):
    # tiles are NAD83, not WGS84 like our grid, but reproject() handles the datum shift itself
    dest = np.full((dst_h, dst_w), LIDAR_NODATA, dtype='float32')
    left, bottom, right, top = array_bounds(dst_h, dst_w, dst_transform)

    for tile_path in tile_paths:
        with rasterio.open(tile_path) as src:
            # stac metadata says nodata is "nan", the actual files use -9999, trust the file
            tile_bounds = transform_bounds(TARGET_CRS, src.crs, left, bottom, right, top)
            full_window = Window(0, 0, src.width, src.height)
            try:
                win = from_bounds(*tile_bounds, transform=src.transform).intersection(full_window)
            except rasterio.errors.WindowError:
                continue
            if win.width <= 0 or win.height <= 0:
                continue
            data = src.read(1, window=win)
            temp = np.full((dst_h, dst_w), LIDAR_NODATA, dtype='float32')
            reproject(
                source=data,
                destination=temp,
                src_transform=src.window_transform(win),
                src_crs=src.crs,
                src_nodata=src.nodata,
                dst_transform=dst_transform,
                dst_crs=TARGET_CRS,
                dst_nodata=LIDAR_NODATA,
                resampling=Resampling.max
            )
            # a few surveys overlap in spots, max keeps whichever saw the taller thing
            dest = np.where(temp != LIDAR_NODATA, np.maximum(dest, temp), dest)
    return dest

def build_height_grid(tile_paths):
    with rasterio.open(CANOPY_PCT_PATH) as ref:
        transform_5 = ref.transform
        width_5 = ref.width
        height_5 = ref.height

    with rasterio.open(CANOPY_HEIGHT_PATH) as ch:
        canopy_height = ch.read(1)
        canopy_nodata = ch.nodata

    profile = {
        'driver': 'GTiff', 'height': height_5, 'width': width_5, 'count': 1,
        'dtype': 'float32', 'crs': TARGET_CRS, 'transform': transform_5
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with rasterio.open(OUT_PATH, 'w', **profile) as dst:
        for row0 in range(0, height_5, CHUNK_ROWS):
            row1 = min(row0 + CHUNK_ROWS, height_5)
            n_rows = row1 - row0
            print(f'building height grid rows {row0}-{row1} of {height_5}...')

            chunk_top = transform_5.f - row0 * 5
            chunk_transform = Affine(5, 0, transform_5.c, 0, -5, chunk_top)
            lidar_chunk = reproject_chunk_from_tiles(tile_paths, chunk_transform, width_5, n_rows)

            canopy_chunk = canopy_height[row0:row1]
            canopy_valid = ~np.isnan(canopy_chunk) if canopy_nodata is None else canopy_chunk != canopy_nodata
            lidar_valid = lidar_chunk != LIDAR_NODATA

            # no lidar or tree reading here just means no known obstacle, ground level is fine
            combined = np.where(lidar_valid, lidar_chunk, 0)
            combined = np.where(canopy_valid, np.maximum(combined, canopy_chunk), combined)
            # lidar ground classifier chokes on steep terrain near the sandia foothills, saw
            # one pixel at 835m, nothing in abq is actually taller than a few dozen meters
            combined = np.clip(combined, 0, MAX_OBSTACLE_M)

            dst.write(combined.astype('float32'), 1, window=Window(0, row0, width_5, n_rows))

    return OUT_PATH

if __name__ == '__main__':
    os.makedirs(RAW_DIR, exist_ok=True)
    tile_paths = find_and_download_tiles()

    total_bytes = sum(os.path.getsize(p) for p in tile_paths)
    print(f'lidar tiles on disk: {total_bytes / (1024 * 1024):.1f} mb')

    build_height_grid(tile_paths)
    print('done, wrote', OUT_PATH)
