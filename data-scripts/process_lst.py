# combines the landsat scenes into one summer surface temp map for abq

import os
import glob
import numpy as np
import rasterio
from rasterio.warp import reproject, transform, transform_bounds, Resampling
from rasterio.transform import from_origin, rowcol
import matplotlib.pyplot as plt
from common import BBOX_LANDSAT, TARGET_CRS, LANDSAT_PIXEL_SIZE

LANDSAT_DIR = 'data/landsat'
SHARP_DIR = 'data/landsat/sharp'
OUT_DIR = 'data/processed'
BBOX = BBOX_LANDSAT
PIXEL_SIZE = LANDSAT_PIXEL_SIZE
ST_SCALE = 0.00341802
ST_OFFSET = 149.0
MIN_VALID_SCENES = 3
NODATA = -9999.0

HEIGHTS_PATH = 'data/processed/abq_heights_5m.tif'
TALL_OBSTACLE_M = 3  # same cutoff process_canopy uses for "thats a real tree/building, not noise"
DEVELOPED_RADIUS_PX = 5  # ~150m at our 30m grid
DEVELOPED_DENSITY = 0.12  # at least this much of the area nearby has to be tall, not just one tree

# the wide bbox pulls in a lot of open desert/mesa, which runs hotter than most of the
# actual city and was dragging the "typical abq" baseline up, making the whole city look
# cool by comparison. baseline now comes from developed pixels only (near a building/tree).
# desert far from any development is still scored against that baseline, so it correctly
# shows up hot - we're just not letting it set the baseline itself anymore

# fill(bit0) + dilated cloud(bit1) + cloud(bit3) + cloud shadow(bit4), from usgs qa_pixel docs
BAD_QA_BITS = 0b11011

SPOTS = {
    'rio grande nature center (expect cool)': (35.130, -106.683),
    'sunport (expect hot)': (35.040, -106.609),
    'downtown': (35.084, -106.650),
    'coronado center (expect hot, parking lots)': (35.104, -106.567)
}


def build_target_grid():
    left, bottom, right, top = transform_bounds('EPSG:4326', TARGET_CRS, *BBOX)
    width = int(np.ceil((right - left) / PIXEL_SIZE))
    height = int(np.ceil((top - bottom) / PIXEL_SIZE))
    grid_transform = from_origin(left, top, PIXEL_SIZE, PIXEL_SIZE)
    return grid_transform, width, height

def find_scene_pairs():
    pairs = []
    for st_path in sorted(glob.glob(f'{LANDSAT_DIR}/*_st.tif')):
        name = os.path.basename(st_path).replace('_st.tif', '')
        qa_path = f'{LANDSAT_DIR}/{name}_qa.tif'
        if os.path.exists(qa_path):
            pairs.append((name, st_path, qa_path))
    return pairs

def load_scene_fahrenheit(st_path, qa_path, grid_transform, width, height):
    with rasterio.open(st_path) as st_src:
        st_raw = np.zeros((height, width), dtype='float32')
        reproject(
            source=rasterio.band(st_src, 1),
            destination=st_raw,
            src_transform=st_src.transform,
            src_crs=st_src.crs,
            src_nodata=0,
            dst_transform=grid_transform,
            dst_crs=TARGET_CRS,
            dst_nodata=0,
            resampling=Resampling.bilinear
        )

    with rasterio.open(qa_path) as qa_src:
        qa = np.zeros((height, width), dtype='uint16')
        reproject(
            source=rasterio.band(qa_src, 1),
            destination=qa,
            src_transform=qa_src.transform,
            src_crs=qa_src.crs,
            src_nodata=1,
            dst_transform=grid_transform,
            dst_crs=TARGET_CRS,
            dst_nodata=1,
            resampling=Resampling.nearest
        )

    kelvin = st_raw * ST_SCALE + ST_OFFSET
    fahrenheit = (kelvin - 273.15) * 9 / 5 + 32

    bad = (st_raw == 0) | ((qa & BAD_QA_BITS) != 0)
    fahrenheit[bad] = np.nan

    # anything below 40f or above 180f in abq summer is a bad pixel, not real weather
    fahrenheit[(fahrenheit < 40) | (fahrenheit > 180)] = np.nan

    return fahrenheit

def load_sharpened_fahrenheit(sharp_path, grid_transform, width, height):
    with rasterio.open(sharp_path) as src:
        fahrenheit = np.zeros((height, width), dtype='float32')
        reproject(
            source=rasterio.band(src, 1),
            destination=fahrenheit,
            src_transform=src.transform,
            src_crs=src.crs,
            src_nodata=src.nodata,
            dst_transform=grid_transform,
            dst_crs=TARGET_CRS,
            dst_nodata=np.nan,
            resampling=Resampling.bilinear
        )
    fahrenheit[(fahrenheit < 40) | (fahrenheit > 180)] = np.nan
    return fahrenheit

def write_geotiff(path, array, grid_transform):
    profile = {
        'driver': 'GTiff',
        'height': array.shape[0],
        'width': array.shape[1],
        'count': 1,
        'dtype': 'float32',
        'crs': TARGET_CRS,
        'transform': grid_transform,
        'nodata': NODATA,
    }
    out = np.where(np.isnan(array), NODATA, array).astype('float32')
    with rasterio.open(path, 'w', **profile) as dst:
        dst.write(out, 1)

def save_preview(anomaly, path):
    masked = np.ma.masked_invalid(anomaly)
    fig, ax = plt.subplots(figsize=(8, 8))
    cmap = plt.get_cmap('RdBu_r').copy()
    cmap.set_bad('#f4ede0')
    im = ax.imshow(masked, cmap=cmap, vmin=-10, vmax=10)
    ax.set_title('abq summer surface temp anomaly (f)')
    ax.axis('off')
    fig.colorbar(im, ax=ax, label='degrees f vs citywide median')
    fig.savefig(path, dpi=100, bbox_inches='tight')
    plt.close(fig)

def local_tall_fraction(mask, radius):
    # % of cells within radius pixels that are tall. a single tree 150m away used to be
    # enough to count a desert pixel as "developed" - needed actual density, not just presence
    padded = np.pad(mask.astype('float32'), radius, mode='constant', constant_values=0)
    total = np.zeros(mask.shape, dtype='float32')
    n = 0
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dy * dy + dx * dx > radius * radius:
                continue
            total += padded[radius + dy:radius + dy + mask.shape[0], radius + dx:radius + dx + mask.shape[1]]
            n += 1
    return total / n

def load_developed_mask(grid_transform, width, height):
    with rasterio.open(HEIGHTS_PATH) as src:
        tall = np.zeros((height, width), dtype='float32')
        reproject(
            source=rasterio.band(src, 1),
            destination=tall,
            src_transform=src.transform,
            src_crs=src.crs,
            dst_transform=grid_transform,
            dst_crs=TARGET_CRS,
            resampling=Resampling.max  # a tall pixel anywhere in the 30m cell counts
        )
    density = local_tall_fraction(tall >= TALL_OBSTACLE_M, DEVELOPED_RADIUS_PX)
    return density >= DEVELOPED_DENSITY

def sample_spots(anomaly, grid_transform):
    results = {}
    for label, (lat, lng) in SPOTS.items():
        xs, ys = transform('EPSG:4326', TARGET_CRS, [lng], [lat])
        row, col = rowcol(grid_transform, xs[0], ys[0])
        val = anomaly[row, col]
        results[label] = val
        print(f'  {label}: {val:+.1f}f' if not np.isnan(val) else f'  {label}: no data')
    return results


if __name__ == '__main__':
    os.makedirs(OUT_DIR, exist_ok=True)
    grid_transform, width, height = build_target_grid()

    pairs = find_scene_pairs()
    print(f'found {len(pairs)} scene pairs to process')

    stack = np.full((len(pairs), height, width), np.nan, dtype='float32')
    sharp_used = 0
    for i, (name, st_path, qa_path) in enumerate(pairs):
        print(f'processing {name} ({i + 1}/{len(pairs)})...')
        sharp_path = f'{SHARP_DIR}/{name}_lst_sharp.tif'
        if os.path.exists(sharp_path):
            stack[i] = load_sharpened_fahrenheit(sharp_path, grid_transform, width, height)
            sharp_used += 1
        else:
            # sharpen_lst never touched this one, prob missing an sr band, fall back to plain
            stack[i] = load_scene_fahrenheit(st_path, qa_path, grid_transform, width, height)

    print('combining scenes...')
    valid_count = np.sum(~np.isnan(stack), axis=0).astype('float32')
    # median not mean, one hazy or weirdly cold day shouldnt drag the whole pixel around
    median_f = np.nanmedian(stack, axis=0)
    median_f[valid_count < MIN_VALID_SCENES] = np.nan

    print('finding developed areas for the baseline...')
    developed = load_developed_mask(grid_transform, width, height)
    citywide_median = np.nanmedian(median_f[developed])
    anomaly = median_f - citywide_median  # still applied to every pixel, desert included

    write_geotiff(f'{OUT_DIR}/abq_lst_f.tif', median_f, grid_transform)
    write_geotiff(f'{OUT_DIR}/abq_lst_count.tif', valid_count, grid_transform)
    write_geotiff(f'{OUT_DIR}/abq_lst_anom.tif', anomaly, grid_transform)
    save_preview(anomaly, f'{OUT_DIR}/abq_lst_preview.png')

    west, south, east, north = transform_bounds(TARGET_CRS, 'EPSG:4326', *rasterio.transform.array_bounds(height, width, grid_transform))
    print()
    print(f'covered bounds: {west:.4f}, {south:.4f}, {east:.4f}, {north:.4f}')
    print(f'{len(pairs)} scenes used, {sharp_used} from sharpened data, {len(pairs) - sharp_used} plain fallback')
    print(f'baseline (developed areas only): {citywide_median:.1f}f, from {developed.sum()} developed cells')
    print(f'5th percentile: {np.nanpercentile(median_f, 5):.1f}f')
    print(f'95th percentile: {np.nanpercentile(median_f, 95):.1f}f')
    print('spot checks:')
    spots = sample_spots(anomaly, grid_transform)

    cool_key = 'rio grande nature center (expect cool)'
    hot_keys = ['sunport (expect hot)', 'coronado center (expect hot, parking lots)']
    for hot_key in hot_keys:
        if spots[cool_key] >= spots[hot_key]:
            print(f'something is off: {cool_key} is not cooler than {hot_key}')
