# exports the processed rasters into small files the web app can actually load:
# heat overlay tiles (standard xyz png) and a plain lat/lng grid for route scoring.
#
# grid chunk byte layout (webdata/grid/{col}_{row}.bin.gz), row-major, north row first:
#   100x100 cells per chunk, 15 bytes per cell:
#     byte 0       canopy percent, 0-100, 255 = nodata
#     bytes 1-13   shade percent for hour 7,8,...,19, 0-100 each, 255 = nodata
#     byte 14      temp anomaly f, stored as (value + 30), so 0-60, 255 = nodata
#   see meta.json for origin/cell size/chunk size

import os
import gzip
import numpy as np
import mercantile
from PIL import Image
import rasterio
from rasterio.transform import from_origin, rowcol
from rasterio.warp import reproject, transform as transform_coords, Resampling

BBOX = [-106.85, 34.9, -106.45, 35.35]  # west, south, east, north, same as the map

CANOPY_PATH = 'data/processed/abq_canopy_pct_5m.tif'
ANOM_PATH = 'data/processed/abq_lst_anom.tif'
SHADE_DIR = 'data/processed/shade'
HOURS = list(range(7, 20))

WEB_DIR = 'webdata'
HEAT_DIR = f'{WEB_DIR}/heat'
GRID_DIR = f'{WEB_DIR}/grid'

HEAT_ZOOMS = range(10, 16)
HEAT_CLAMP_F = 15.0
COOL_RGB = (47, 111, 176)
NEUTRAL_RGB = (244, 237, 224)
HOT_RGB = (196, 60, 30)

CELL_DEG = 0.0001  # about 10m at abq's latitude
CHUNK_CELLS = 100  # 100 cells * 0.0001deg = 0.01deg per chunk
BYTES_PER_CELL = 1 + len(HOURS) + 1

def anomaly_to_rgba(anom, valid):
    clamped = np.clip(np.nan_to_num(anom, nan=0.0), -HEAT_CLAMP_F, HEAT_CLAMP_F)
    t = (clamped + HEAT_CLAMP_F) / (2 * HEAT_CLAMP_F)
    t3 = t[..., None]
    cool = np.array(COOL_RGB, dtype='float32')
    neutral = np.array(NEUTRAL_RGB, dtype='float32')
    hot = np.array(HOT_RGB, dtype='float32')
    lower = cool * (1 - 2 * t3) + neutral * (2 * t3)
    upper = neutral * (1 - 2 * (t3 - 0.5)) + hot * (2 * (t3 - 0.5))
    rgb = np.where(t3 < 0.5, lower, upper)
    rgba = np.zeros(anom.shape + (4,), dtype='uint8')
    rgba[..., :3] = np.clip(rgb, 0, 255).astype('uint8')
    rgba[..., 3] = np.where(valid, 255, 0).astype('uint8')
    return rgba

def make_heat_tiles():
    os.makedirs(HEAT_DIR, exist_ok=True)
    written = 0
    skipped = 0
    with rasterio.open(ANOM_PATH) as src:
        src_transform, src_crs, src_nodata = src.transform, src.crs, src.nodata
        src_band = src.read(1)

    for z in HEAT_ZOOMS:
        tiles = list(mercantile.tiles(*BBOX, [z]))
        print(f'zoom {z}: {len(tiles)} candidate tiles...')
        for tile in tiles:
            bounds = mercantile.xy_bounds(tile)
            tile_transform = from_origin(bounds.left, bounds.top, (bounds.right - bounds.left) / 256,
                                          (bounds.top - bounds.bottom) / 256)
            dest = np.full((256, 256), np.nan, dtype='float32')
            reproject(
                source=src_band,
                destination=dest,
                src_transform=src_transform,
                src_crs=src_crs,
                src_nodata=src_nodata,
                dst_transform=tile_transform,
                dst_crs='EPSG:3857',
                dst_nodata=np.nan,
                resampling=Resampling.bilinear
            )
            valid = ~np.isnan(dest)
            if not valid.any():
                skipped += 1
                continue

            rgba = anomaly_to_rgba(dest, valid)
            tile_dir = f'{HEAT_DIR}/{z}/{tile.x}'
            os.makedirs(tile_dir, exist_ok=True)
            Image.fromarray(rgba, 'RGBA').save(f'{tile_dir}/{tile.y}.png')
            written += 1

    print(f'heat tiles: {written} written, {skipped} empty and skipped')

def reproject_to_grid(path, grid_transform, grid_w, grid_h, resampling):
    with rasterio.open(path) as src:
        dest = np.full((grid_h, grid_w), np.nan, dtype='float32')
        reproject(
            source=rasterio.band(src, 1),
            destination=dest,
            src_transform=src.transform,
            src_crs=src.crs,
            src_nodata=src.nodata,
            dst_transform=grid_transform,
            dst_crs='EPSG:4326',
            dst_nodata=np.nan,
            resampling=resampling
        )
    return dest

def build_grid_stack():
    grid_w = int(np.ceil((BBOX[2] - BBOX[0]) / CELL_DEG))
    grid_h = int(np.ceil((BBOX[3] - BBOX[1]) / CELL_DEG))
    grid_transform = from_origin(BBOX[0], BBOX[3], CELL_DEG, CELL_DEG)
    print(f'grid is {grid_w} x {grid_h} cells')

    print('resampling canopy...')
    canopy = reproject_to_grid(CANOPY_PATH, grid_transform, grid_w, grid_h, Resampling.average)
    canopy_byte = np.where(~np.isnan(canopy), np.clip(np.round(canopy), 0, 100), 255).astype('uint8')

    layers = [canopy_byte]
    for h in HOURS:
        print(f'resampling shade {h:02d}00...')
        shade = reproject_to_grid(f'{SHADE_DIR}/shade_{h:02d}00.tif', grid_transform, grid_w, grid_h, Resampling.average)
        pct = np.clip(np.round(shade * 100), 0, 100)
        layers.append(np.where(~np.isnan(shade), pct, 255).astype('uint8'))

    print('resampling temp anomaly...')
    anom = reproject_to_grid(ANOM_PATH, grid_transform, grid_w, grid_h, Resampling.bilinear)
    anom_clamped = np.clip(np.round(anom), -30, 30)
    layers.append(np.where(~np.isnan(anom), anom_clamped + 30, 255).astype('uint8'))

    stack = np.stack(layers, axis=-1)
    return stack, grid_w, grid_h, grid_transform

def write_grid_chunks(stack, grid_w, grid_h):
    os.makedirs(GRID_DIR, exist_ok=True)
    chunks_x = int(np.ceil(grid_w / CHUNK_CELLS))
    chunks_y = int(np.ceil(grid_h / CHUNK_CELLS))
    written = 0
    skipped = 0

    for row_chunk in range(chunks_y):
        for col_chunk in range(chunks_x):
            r0, c0 = row_chunk * CHUNK_CELLS, col_chunk * CHUNK_CELLS
            r1, c1 = min(r0 + CHUNK_CELLS, grid_h), min(c0 + CHUNK_CELLS, grid_w)

            block = np.full((CHUNK_CELLS, CHUNK_CELLS, BYTES_PER_CELL), 255, dtype='uint8')
            block[:r1 - r0, :c1 - c0, :] = stack[r0:r1, c0:c1, :]

            if np.all(block[..., 0] == 255):
                skipped += 1
                continue

            with gzip.open(f'{GRID_DIR}/{col_chunk}_{row_chunk}.bin.gz', 'wb') as f:
                f.write(block.tobytes())
            written += 1

    print(f'grid chunks: {written} written, {skipped} empty and skipped')
    return chunks_x, chunks_y

def write_meta(grid_w, grid_h, chunks_x, chunks_y):
    import json
    meta = {
        'origin': {'lng': BBOX[0], 'lat': BBOX[3]},
        'row_order': 'north to south, west to east within a row',
        'cell_size_deg': CELL_DEG,
        'grid_width': grid_w,
        'grid_height': grid_h,
        'chunk_size_cells': CHUNK_CELLS,
        'chunks_x': chunks_x,
        'chunks_y': chunks_y,
        'hours': HOURS,
        'bytes_per_cell': BYTES_PER_CELL,
        'layout': [
            'canopy_pct (0-100, 255=nodata)',
            'shade_pct for hours 7..19, 13 bytes (0-100, 255=nodata)',
            'temp_anom_f stored as value+30 (0-60, 255=nodata)'
        ]
    }
    with open(f'{GRID_DIR}/meta.json', 'w') as f:
        json.dump(meta, f, indent=2)

def dir_stats(path):
    total = 0
    count = 0
    for root, _, files in os.walk(path):
        for name in files:
            total += os.path.getsize(os.path.join(root, name))
            count += 1
    return count, total / (1024 * 1024)

def sample_raster_point(path, lat, lng):
    with rasterio.open(path) as src:
        xs, ys = transform_coords('EPSG:4326', src.crs, [lng], [lat])
        row, col = rowcol(src.transform, xs[0], ys[0])
        return src.read(1)[row, col]

def check_point(grid_transform, grid_h, label, lat, lng):
    col = int((lng - BBOX[0]) / CELL_DEG)
    row = int((BBOX[3] - lat) / CELL_DEG)
    row_chunk, col_chunk = row // CHUNK_CELLS, col // CHUNK_CELLS
    local_row, local_col = row % CHUNK_CELLS, col % CHUNK_CELLS

    chunk_path = f'{GRID_DIR}/{col_chunk}_{row_chunk}.bin.gz'
    with gzip.open(chunk_path, 'rb') as f:
        block = np.frombuffer(f.read(), dtype='uint8').reshape(CHUNK_CELLS, CHUNK_CELLS, BYTES_PER_CELL)
    cell = block[local_row, local_col]
    grid_canopy = cell[0]
    grid_shade_noon = cell[1 + HOURS.index(12)]
    grid_anom = int(cell[-1]) - 30

    raw_canopy = sample_raster_point(CANOPY_PATH, lat, lng)
    raw_shade_noon = sample_raster_point(f'{SHADE_DIR}/shade_1200.tif', lat, lng)
    raw_shade_pct = 'nodata' if raw_shade_noon == 255 else f'{raw_shade_noon * 100}%'
    raw_anom = sample_raster_point(ANOM_PATH, lat, lng)

    print(f'{label}:')
    print(f'  grid chunk:  canopy={grid_canopy}%  shade@noon={grid_shade_noon}%  anom={grid_anom:+d}f')
    print(f'  raw pixel:   canopy={raw_canopy:.0f}%  shade@noon={raw_shade_pct}  anom={raw_anom:+.1f}f')
    print('  (grid values are averaged over a ~10m cell, raw is one pixel, close but not identical is normal)')

if __name__ == '__main__':
    make_heat_tiles()

    stack, grid_w, grid_h, grid_transform = build_grid_stack()
    chunks_x, chunks_y = write_grid_chunks(stack, grid_w, grid_h)
    write_meta(grid_w, grid_h, chunks_x, chunks_y)

    heat_count, heat_mb = dir_stats(HEAT_DIR)
    grid_count, grid_mb = dir_stats(GRID_DIR)
    total_mb = heat_mb + grid_mb
    print()
    print(f'heat: {heat_count} files, {heat_mb:.1f} mb')
    print(f'grid: {grid_count} files, {grid_mb:.1f} mb')
    print(f'total: {total_mb:.1f} mb')
    if total_mb > 60:
        print('over the ~60mb budget, could cut a zoom level off the heat tiles or drop some shade hours')

    print()
    check_point(grid_transform, grid_h, 'rio grande nature center', 35.130, -106.683)
    check_point(grid_transform, grid_h, 'sunport', 35.040, -106.609)
