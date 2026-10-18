# turns the raw 1m canopy tiles into 5m and 30m canopy grids for abq, chunked so it fits in memory

import os
import glob
import numpy as np
import rasterio
from rasterio import Affine
from rasterio.windows import Window, from_bounds
from rasterio.transform import array_bounds, rowcol
from rasterio.warp import reproject, transform, transform_bounds, Resampling
from common import TARGET_CRS

RAW_DIR = 'data/canopy/raw'
OUT_DIR = 'data/processed'
# reading this file's own grid instead of recomputing bounds, so the 30m canopy
# and lst grids land on the exact same pixels no matter what
LST_GRID_PATH = 'data/processed/abq_lst_f.tif'
TREE_HEIGHT_M = 3  # shrubs and short stuff dont really shade someone walking
# raw tiles are uint8 meters straight up, no nodata flag in the file, 0 = ground
CHUNK_ROWS_30 = 50
NODATA = -9999.0

SPOTS = {
    'rio grande nature center / bosque (expect high)': (35.130, -106.683),
    'los ranchos (expect fairly high)': (35.160, -106.650),
    'sunport (expect very low)': (35.040, -106.609),
    'west side, volcano cliffs (expect very low)': (35.150, -106.720)
}


def reproject_chunk_from_tiles(tile_paths, dst_transform, dst_w, dst_h):
    dest = np.zeros((dst_h, dst_w), dtype='uint8')
    left, bottom, right, top = array_bounds(dst_h, dst_w, dst_transform)
    chunk_bounds_3857 = transform_bounds(TARGET_CRS, 'EPSG:3857', left, bottom, right, top)

    for tile_path in tile_paths:
        with rasterio.open(tile_path) as src:
            full_window = Window(0, 0, src.width, src.height)
            # most tiles don't overlap a given chunk at all, intersection() throws instead of empty
            try:
                win = from_bounds(*chunk_bounds_3857, transform=src.transform).intersection(full_window)
            except rasterio.errors.WindowError:
                continue
            if win.width <= 0 or win.height <= 0:
                continue
            data = src.read(1, window=win)
            src_transform = src.window_transform(win)

            temp = np.zeros((dst_h, dst_w), dtype='uint8')
            reproject(
                source=data,
                destination=temp,
                src_transform=src_transform,
                src_crs=src.crs,
                dst_transform=dst_transform,
                dst_crs=TARGET_CRS,
                resampling=Resampling.nearest
            )

            # reproject fills dest pixels outside THIS tile's coverage with 0, which
            # would overwrite real data another tile already placed there, so mosaic
            # with a coverage mask instead of just writing straight into dest
            covered = np.zeros((dst_h, dst_w), dtype='uint8')
            reproject(
                source=np.ones(data.shape, dtype='uint8'),
                destination=covered,
                src_transform=src_transform,
                src_crs=src.crs,
                dst_transform=dst_transform,
                dst_crs=TARGET_CRS,
                resampling=Resampling.nearest
            )
            dest = np.where(covered > 0, temp, dest)
    return dest

def process():
    with rasterio.open(LST_GRID_PATH) as lst:
        transform_30 = lst.transform
        width_30 = lst.width
        height_30 = lst.height

    width_5 = width_30 * 6
    height_5 = height_30 * 6
    transform_5 = Affine(5, 0, transform_30.c, 0, -5, transform_30.f)

    tile_paths = sorted(glob.glob(f'{RAW_DIR}/*.tif'))
    print(f'using {len(tile_paths)} raw canopy tiles')

    profile_pct5 = {
        'driver': 'GTiff', 'height': height_5, 'width': width_5, 'count': 1,
        'dtype': 'uint8', 'crs': TARGET_CRS, 'transform': transform_5
    }
    profile_height5 = dict(profile_pct5, dtype='float32', nodata=NODATA)
    profile_pct30 = {
        'driver': 'GTiff', 'height': height_30, 'width': width_30, 'count': 1,
        'dtype': 'uint8', 'crs': TARGET_CRS, 'transform': transform_30,
    }

    pct5_path = f'{OUT_DIR}/abq_canopy_pct_5m.tif'
    height5_path = f'{OUT_DIR}/abq_canopy_height_5m.tif'
    pct30_path = f'{OUT_DIR}/abq_canopy_pct_30m.tif'

    with rasterio.open(pct5_path, 'w', **profile_pct5) as pct5_dst, \
         rasterio.open(height5_path, 'w', **profile_height5) as height5_dst, \
         rasterio.open(pct30_path, 'w', **profile_pct30) as pct30_dst:

        for row0_30 in range(0, height_30, CHUNK_ROWS_30):
            row1_30 = min(row0_30 + CHUNK_ROWS_30, height_30)
            n_rows_30 = row1_30 - row0_30
            print(f'processing rows {row0_30}-{row1_30} of {height_30}...')

            row0_5 = row0_30 * 6
            n_rows_5 = n_rows_30 * 6
            chunk_top = transform_30.f - row0_5 * 5
            chunk_transform_5 = Affine(5, 0, transform_30.c, 0, -5, chunk_top)
            chunk_transform_1m = Affine(1, 0, transform_30.c, 0, -1, chunk_top)

            raw = reproject_chunk_from_tiles(tile_paths, chunk_transform_1m, width_5 * 5, n_rows_5 * 5)
            tree_mask = raw >= TREE_HEIGHT_M

            # reshape to (rows,5,cols,5) blocks then mean over axis 1&3, standard block-reduce trick
            tree_mask_5 = tree_mask.reshape(n_rows_5, 5, width_5, 5)
            pct_chunk = (tree_mask_5.mean(axis=(1, 3)) * 100).astype('uint8')

            raw_5 = raw.reshape(n_rows_5, 5, width_5, 5)
            tree_sum = np.where(tree_mask_5, raw_5, 0).sum(axis=(1, 3), dtype='float32')
            tree_count = tree_mask_5.sum(axis=(1, 3))
            with np.errstate(invalid='ignore', divide='ignore'):
                height_chunk = tree_sum / tree_count
            height_chunk[tree_count == 0] = np.nan
            height_out = np.where(np.isnan(height_chunk), NODATA, height_chunk).astype('float32')

            pct_chunk_30 = pct_chunk.reshape(n_rows_30, 6, width_30, 6).mean(axis=(1, 3)).astype('uint8')

            pct5_dst.write(pct_chunk, 1, window=Window(0, row0_5, width_5, n_rows_5))
            height5_dst.write(height_out, 1, window=Window(0, row0_5, width_5, n_rows_5))
            pct30_dst.write(pct_chunk_30, 1, window=Window(0, row0_30, width_30, n_rows_30))

    return pct5_path, height5_path, pct30_path

def save_preview(pct30_path, out_path):
    import matplotlib.pyplot as plt
    with rasterio.open(pct30_path) as src:
        pct = src.read(1)
    fig, ax = plt.subplots(figsize=(8, 8))
    cmap = plt.get_cmap('Greens').copy()
    cmap.set_bad('#f4ede0')
    im = ax.imshow(pct, cmap=cmap, vmin=0, vmax=60)
    ax.set_title('abq tree canopy percent (30m)')
    ax.axis('off')
    fig.colorbar(im, ax=ax, label='% canopy cover')
    fig.savefig(out_path, dpi=100, bbox_inches='tight')
    plt.close(fig)

def sample_point(path, lat, lng):
    with rasterio.open(path) as src:
        xs, ys = transform('EPSG:4326', src.crs, [lng], [lat])
        row, col = rowcol(src.transform, xs[0], ys[0])
        return src.read(1)[row, col]


if __name__ == '__main__':
    os.makedirs(OUT_DIR, exist_ok=True)
    pct5_path, height5_path, pct30_path = process()
    save_preview(pct30_path, f'{OUT_DIR}/abq_canopy_preview.png')

    with rasterio.open(pct30_path) as src:
        pct30 = src.read(1).astype('float32')

    print()
    print(f'citywide canopy cover: {pct30.mean():.1f}%')
    print('spot checks:')
    for label, (lat, lng) in SPOTS.items():
        val = sample_point(pct5_path, lat, lng)
        print(f'  {label}: {val}%')

    with rasterio.open('data/processed/abq_lst_anom.tif') as src:
        anom = src.read(1)
        anom_nodata = src.nodata

    valid = (anom != anom_nodata) if anom_nodata is not None else np.ones_like(anom, dtype=bool)
    corr = np.corrcoef(pct30[valid], anom[valid])[0, 1]
    print(f'correlation between canopy % and lst anomaly: {corr:+.2f}')
    if corr >= -0.15:
        print('something is off: expected a clearly negative correlation (more trees = cooler)')
