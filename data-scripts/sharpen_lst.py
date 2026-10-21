# Sharpens landsat thermal (really ~100m even though the file is 30m) using the true
# 30m optical bands, tsharp style (kustas 2003) but w/ albedo added in since abq has so
# much bare ground and pavement that greenness alone doesn't explain the heat pattern

import os
import glob
import numpy as np
import rasterio
from rasterio.transform import Affine, rowcol
from rasterio.warp import reproject, transform as transform_coords, Resampling
import matplotlib.pyplot as plt
from common import LANDSAT_PIXEL_SIZE

LANDSAT_DIR = 'data/landsat'
OUT_DIR = 'data/landsat/sharp'
PREVIEW_PATH = 'data/processed/sharpen_preview.png'

ST_SCALE = 0.00341802
ST_OFFSET = 149.0
SR_SCALE = 0.0000275
SR_OFFSET = -0.2
BAD_QA_BITS = 0b11011  # fill + dilated cloud + cloud + cloud shadow, same as process_lst

# liang 2001 broadband albedo, oli-adapted coefficients (blue, red, nir, swir1, swir2)
ALBEDO_WEIGHTS = {'blue': 0.356, 'red': 0.130, 'nir': 0.373, 'swir1': 0.085, 'swir2': 0.072}
ALBEDO_CONST = -0.0018

COARSE_BLOCK = 3  # 3x3 of 30m pixels = ~90m, close to the real thermal resolution
MIN_COARSE_PIXELS = 20  # not enough points to trust a regression below this
MIN_R2 = 0.3  # below this ndvi/albedo barely explain the temp pattern, sharpening's just noise

DOWNTOWN = (35.084, -106.650)
PREVIEW_KM = 1.5
PIXEL_SIZE = LANDSAT_PIXEL_SIZE


def find_scenes():
    scenes = []
    for st_path in sorted(glob.glob(f'{LANDSAT_DIR}/*_st.tif')):
        name = os.path.basename(st_path).replace('_st.tif', '')
        bands = {
            'st': st_path,
            'qa': f'{LANDSAT_DIR}/{name}_qa.tif',
            'blue': f'{LANDSAT_DIR}/{name}_sr_b2.tif',
            'red': f'{LANDSAT_DIR}/{name}_sr_b4.tif',
            'nir': f'{LANDSAT_DIR}/{name}_sr_b5.tif',
            'swir1': f'{LANDSAT_DIR}/{name}_sr_b6.tif',
            'swir2': f'{LANDSAT_DIR}/{name}_sr_b7.tif',
        }
        if all(os.path.exists(p) for p in bands.values()):
            scenes.append((name, bands))
    return scenes

def read_band(path):
    with rasterio.open(path) as src:
        return src.read(1), src.profile

def load_scene(bands):
    st_raw, profile = read_band(bands['st'])
    qa, _ = read_band(bands['qa'])

    lst_k = st_raw * ST_SCALE + ST_OFFSET
    lst_f = (lst_k - 273.15) * 9 / 5 + 32
    cloud_bad = (st_raw == 0) | ((qa & BAD_QA_BITS) != 0)
    lst_f[cloud_bad] = np.nan
    lst_f[(lst_f < 40) | (lst_f > 180)] = np.nan

    sr = {}
    for key in ['blue', 'red', 'nir', 'swir1', 'swir2']:
        raw, _ = read_band(bands[key])
        refl = raw * SR_SCALE + SR_OFFSET
        refl[cloud_bad | (raw == 0)] = np.nan
        sr[key] = refl

    ndvi = (sr['nir'] - sr['red']) / (sr['nir'] + sr['red'])
    albedo = sum(ALBEDO_WEIGHTS[k] * sr[k] for k in ALBEDO_WEIGHTS) + ALBEDO_CONST

    return lst_f, ndvi, albedo, profile

def coarsen(arr, block):
    h, w = arr.shape
    cropped = arr[:h - h % block, :w - w % block]
    reshaped = cropped.reshape(cropped.shape[0] // block, block, cropped.shape[1] // block, block)
    return np.nanmean(reshaped, axis=(1, 3))

def fit_regression(coarse_lst, coarse_ndvi, coarse_albedo):
    valid = ~(np.isnan(coarse_lst) | np.isnan(coarse_ndvi) | np.isnan(coarse_albedo))
    if valid.sum() < MIN_COARSE_PIXELS:
        return None

    y = coarse_lst[valid]
    design = np.column_stack([np.ones(y.size), coarse_ndvi[valid], coarse_albedo[valid]])
    coefs, _, _, _ = np.linalg.lstsq(design, y, rcond=None)

    pred = design @ coefs
    ss_res = np.sum((y - pred) ** 2)
    ss_tot = np.sum((y - np.mean(y)) ** 2)
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0
    return coefs, r2

def upsample_residual(coarse_residual, fine_transform, shape_30m, crs):
    coarse_transform = fine_transform * Affine.scale(COARSE_BLOCK)
    dest = np.full(shape_30m, np.nan, dtype='float32')
    reproject(
        source=coarse_residual.astype('float32'),
        destination=dest,
        src_transform=coarse_transform,
        src_crs=crs,
        dst_transform=fine_transform,
        dst_crs=crs,
        resampling=Resampling.bilinear
    )
    return dest

def sharpen_scene(lst, ndvi, albedo, profile):
    coarse_lst = coarsen(lst, COARSE_BLOCK)
    coarse_ndvi = coarsen(ndvi, COARSE_BLOCK)
    coarse_albedo = coarsen(albedo, COARSE_BLOCK)

    fit = fit_regression(coarse_lst, coarse_ndvi, coarse_albedo)
    if fit is None:
        return lst, None

    coefs, r2 = fit
    if r2 < MIN_R2:
        return lst, r2

    a, b, c = coefs
    pred_30m = a + b * ndvi + c * albedo
    coarse_pred = a + b * coarse_ndvi + c * coarse_albedo
    residual_30m = upsample_residual(coarse_lst - coarse_pred, profile['transform'], lst.shape, profile['crs'])

    sharpened = pred_30m + residual_30m
    sharpened[np.isnan(lst)] = np.nan  # sharpening cant invent pixels that were cloud/nodata
    return sharpened, r2

def write_sharp_tif(path, array, profile):
    out_profile = profile.copy()
    out_profile.update(dtype='float32', nodata=-9999.0, count=1)
    out = np.where(np.isnan(array), -9999.0, array).astype('float32')
    with rasterio.open(path, 'w', **out_profile) as dst:
        dst.write(out, 1)

def crop_downtown(array, transform, crs):
    xs, ys = transform_coords('EPSG:4326', crs, [DOWNTOWN[1]], [DOWNTOWN[0]])
    row, col = rowcol(transform, xs[0], ys[0])
    half_px = int((PREVIEW_KM * 1000 / 2) / PIXEL_SIZE)
    r0, r1 = max(0, row - half_px), row + half_px
    c0, c1 = max(0, col - half_px), col + half_px
    return array[r0:r1, c0:c1]

def save_preview(plain_crop, sharp_crop, path):
    vmin = min(np.nanmin(plain_crop), np.nanmin(sharp_crop))
    vmax = max(np.nanmax(plain_crop), np.nanmax(sharp_crop))
    fig, axes = plt.subplots(1, 2, figsize=(10, 5))
    for ax, arr, title in [(axes[0], plain_crop, 'plain'), (axes[1], sharp_crop, 'sharpened')]:
        im = ax.imshow(np.ma.masked_invalid(arr), cmap='inferno', vmin=vmin, vmax=vmax)
        ax.set_title(title)
        ax.axis('off')
    fig.colorbar(im, ax=axes, label='surface temp (f)', fraction=0.03)
    fig.suptitle('downtown lst, plain vs sharpened')
    fig.savefig(path, dpi=100, bbox_inches='tight')
    plt.close(fig)


if __name__ == '__main__':
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs('data/processed', exist_ok=True)

    scenes = find_scenes()
    print(f'found {len(scenes)} scenes with all 5 sr bands present')

    r2s = []
    sharpened_count = 0
    fallback_count = 0
    preview_saved = False

    for i, (name, bands) in enumerate(scenes):
        print(f'sharpening {name} ({i + 1}/{len(scenes)})...')
        lst, ndvi, albedo, profile = load_scene(bands)
        result, r2 = sharpen_scene(lst, ndvi, albedo, profile)

        if r2 is not None:
            r2s.append(r2)
        if r2 is not None and r2 >= MIN_R2:
            sharpened_count += 1
            print(f'  r2={r2:.2f}')
            if not preview_saved:
                plain_crop = crop_downtown(lst, profile['transform'], profile['crs'])
                sharp_crop = crop_downtown(result, profile['transform'], profile['crs'])
                if np.isfinite(plain_crop).sum() > plain_crop.size * 0.5:
                    save_preview(plain_crop, sharp_crop, PREVIEW_PATH)
                    preview_saved = True
                    print('  saved downtown before/after preview from this scene')
        else:
            fallback_count += 1
            reason = 'too few coarse pixels' if r2 is None else f'r2={r2:.2f} too low'
            print(f'  {reason}, using plain lst')

        write_sharp_tif(f'{OUT_DIR}/{name}_lst_sharp.tif', result, profile)

    print()
    print(f'{len(scenes)} scenes sharpened or fallen back')
    print(f'{sharpened_count} sharpened, {fallback_count} fell back to plain')
    if r2s:
        print(f'average r2 across attempts: {np.mean(r2s):.2f}')
    if not preview_saved:
        print('never got a clean downtown scene for the preview, skipping it')
