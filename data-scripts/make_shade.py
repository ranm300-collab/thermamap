# hourly shade maps for abq from the combined building+tree height grid, july 15

import os
import math
import contextlib
from datetime import datetime
import numpy as np
import rasterio
from rasterio.windows import Window
from rasterio.transform import rowcol
from rasterio.warp import transform as transform_coords

HEIGHTS_PATH = 'data/processed/abq_heights_5m.tif'
CANOPY_PCT_PATH = 'data/processed/abq_canopy_pct_5m.tif'
OUT_DIR = 'data/processed/shade'
PREVIEW_PATH = 'data/processed/shade_preview.png'

LAT, LNG = 35.0844, -106.6504
TZ_OFFSET = -6  # mdt
DATE = (2026, 7, 15)
HOURS = list(range(7, 20))  # 7am to 7pm

PIXEL_SIZE = 5.0
MAX_SHADOW_DIST = 300.0  # past this a low sun angle throws shadows further than matters for a walk
MIN_SUN_ELEVATION = 5.0  # basically sunrise/sunset, ray tracing gets silly and pointless below this
ROOFTOP_HEIGHT = 2.5
ROOFTOP_CANOPY_PCT = 50  # tall + mostly not tree canopy = probably a roof, not a tree
CORE_TILE = 400

DOWNTOWN = (35.084, -106.650)
WEST_SIDE = (35.150, -106.720)
PREVIEW_KM = 1.5

def to_julian_day(dt_utc):
    y, m = dt_utc.year, dt_utc.month
    d = dt_utc.day + (dt_utc.hour + dt_utc.minute / 60 + dt_utc.second / 3600) / 24
    if m <= 2:
        y -= 1
        m += 12
    a = y // 100
    b = 2 - a + a // 4
    return int(365.25 * (y + 4716)) + int(30.6001 * (m + 1)) + d + b - 1524.5

def solar_position(dt_local):
    # standard noaa solar calculator formulas, dt_local is naive local (mdt) time
    from datetime import timedelta
    dt_utc = dt_local - timedelta(hours=TZ_OFFSET)
    jd = to_julian_day(dt_utc)
    jc = (jd - 2451545.0) / 36525.0

    gml = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360
    gma = 357.52911 + jc * (35999.05029 - 0.0001537 * jc)
    eeo = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc)
    seqc = (math.sin(math.radians(gma)) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
            + math.sin(math.radians(2 * gma)) * (0.019993 - 0.000101 * jc)
            + math.sin(math.radians(3 * gma)) * 0.000289)
    stl = gml + seqc
    sal = stl - 0.00569 - 0.00478 * math.sin(math.radians(125.04 - 1934.136 * jc))
    moe = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60
    oc = moe + 0.00256 * math.cos(math.radians(125.04 - 1934.136 * jc))
    decl = math.degrees(math.asin(math.sin(math.radians(oc)) * math.sin(math.radians(sal))))

    vary = math.tan(math.radians(oc / 2)) ** 2
    eot = 4 * math.degrees(vary * math.sin(2 * math.radians(gml))
                            - 2 * eeo * math.sin(math.radians(gma))
                            + 4 * eeo * vary * math.sin(math.radians(gma)) * math.cos(2 * math.radians(gml))
                            - 0.5 * vary * vary * math.sin(4 * math.radians(gml))
                            - 1.25 * eeo * eeo * math.sin(2 * math.radians(gma)))

    time_offset = eot + 4 * LNG - 60 * TZ_OFFSET
    tst = (dt_local.hour * 60 + dt_local.minute + dt_local.second / 60 + time_offset) % 1440
    ha = tst / 4 + 180 if tst / 4 < 0 else tst / 4 - 180

    zenith = math.degrees(math.acos(
        math.sin(math.radians(LAT)) * math.sin(math.radians(decl))
        + math.cos(math.radians(LAT)) * math.cos(math.radians(decl)) * math.cos(math.radians(ha))
    ))
    elevation = 90 - zenith

    cos_az_arg = (math.sin(math.radians(LAT)) * math.cos(math.radians(zenith)) - math.sin(math.radians(decl))) / (
        math.cos(math.radians(LAT)) * math.sin(math.radians(zenith)))
    cos_az_arg = max(-1, min(1, cos_az_arg))
    if ha > 0:
        azimuth = (math.degrees(math.acos(cos_az_arg)) + 180) % 360
    else:
        azimuth = (540 - math.degrees(math.acos(cos_az_arg))) % 360

    return elevation, azimuth

def find_solar_noon_elevation():
    # cheaper to just scan than to solve the hour angle=0 time analytically
    best = -999
    for minute in range(11 * 60, 15 * 60):
        dt = datetime(*DATE, minute // 60, minute % 60, 0)
        el, _ = solar_position(dt)
        best = max(best, el)
    return best

def shade_core(height_padded, elevation, azimuth, core_h, core_w, buffer_px):
    if elevation < MIN_SUN_ELEVATION:
        return np.ones((core_h, core_w), dtype=bool)

    az_rad = math.radians(azimuth)
    tan_el = math.tan(math.radians(elevation))
    shaded = np.zeros((core_h, core_w), dtype=bool)

    n_steps = int(MAX_SHADOW_DIST / PIXEL_SIZE)
    for step in range(1, n_steps + 1):
        d = step * PIXEL_SIZE
        ray_height = d * tan_el
        dr = int(round(-step * math.cos(az_rad)))
        dc = int(round(step * math.sin(az_rad)))
        window = height_padded[buffer_px + dr:buffer_px + dr + core_h, buffer_px + dc:buffer_px + dc + core_w]
        shaded |= window >= ray_height

    return shaded

def process():
    with rasterio.open(HEIGHTS_PATH) as h:
        grid_transform = h.transform
        width = h.width
        height = h.height
        crs = h.crs

    os.makedirs(OUT_DIR, exist_ok=True)
    profile = {
        'driver': 'GTiff', 'height': height, 'width': width, 'count': 1,
        'dtype': 'uint8', 'crs': crs, 'transform': grid_transform,
        'nodata': 255, 'compress': 'deflate'
    }

    buffer_px = int(math.ceil(MAX_SHADOW_DIST / PIXEL_SIZE))
    sun_positions = {}
    for hour in HOURS:
        sun_positions[hour] = solar_position(datetime(*DATE, hour, 0, 0))

    out_paths = {hour: f'{OUT_DIR}/shade_{hour:02d}00.tif' for hour in HOURS}

    with contextlib.ExitStack() as stack:
        height_src = stack.enter_context(rasterio.open(HEIGHTS_PATH))
        canopy_src = stack.enter_context(rasterio.open(CANOPY_PCT_PATH))
        dsts = {hour: stack.enter_context(rasterio.open(out_paths[hour], 'w', **profile)) for hour in HOURS}

        for row0 in range(0, height, CORE_TILE):
            row1 = min(row0 + CORE_TILE, height)
            core_h = row1 - row0
            for col0 in range(0, width, CORE_TILE):
                col1 = min(col0 + CORE_TILE, width)
                core_w = col1 - col0
                print(f'shade tile rows {row0}-{row1} cols {col0}-{col1} of {height}x{width}...')

                pad_window = Window(col0 - buffer_px, row0 - buffer_px, core_w + 2 * buffer_px, core_h + 2 * buffer_px)
                height_padded = height_src.read(1, window=pad_window, boundless=True, fill_value=0.0)
                canopy_pct = canopy_src.read(1, window=Window(col0, row0, core_w, core_h), boundless=True, fill_value=0)

                core_height = height_padded[buffer_px:buffer_px + core_h, buffer_px:buffer_px + core_w]
                rooftop = (core_height > ROOFTOP_HEIGHT) & (canopy_pct < ROOFTOP_CANOPY_PCT)

                for hour in HOURS:
                    elevation, azimuth = sun_positions[hour]
                    shaded = shade_core(height_padded, elevation, azimuth, core_h, core_w, buffer_px)
                    out = np.where(rooftop, 255, np.where(shaded, 1, 0)).astype('uint8')
                    dsts[hour].write(out, 1, window=Window(col0, row0, core_w, core_h))

def window_around(path, lat, lng, km, fill=255):
    with rasterio.open(path) as src:
        xs, ys = transform_coords('EPSG:4326', src.crs, [lng], [lat])
        row, col = rowcol(src.transform, xs[0], ys[0])
        half_px = int((km * 1000) / 2 / PIXEL_SIZE)
        window = Window(col - half_px, row - half_px, half_px * 2, half_px * 2)
        return src.read(1, window=window, boundless=True, fill_value=fill)

def save_preview():
    import matplotlib.pyplot as plt
    hours = [9, 12, 17]
    fig, axes = plt.subplots(1, 3, figsize=(15, 5))
    for ax, hour in zip(axes, hours):
        arr = window_around(f'{OUT_DIR}/shade_{hour:02d}00.tif', *DOWNTOWN, PREVIEW_KM)
        img = np.where(arr == 255, 0.9, np.where(arr == 1, 0.15, 0.97))
        ax.imshow(img, cmap='gray', vmin=0, vmax=1)
        ax.set_title(f'{hour}:00')
        ax.axis('off')
    fig.suptitle('downtown abq shade, july 15')
    fig.savefig(PREVIEW_PATH, dpi=110, bbox_inches='tight')
    plt.close(fig)

def percent_shaded(hour, lat, lng, km):
    arr = window_around(f'{OUT_DIR}/shade_{hour:02d}00.tif', lat, lng, km)
    walkable = arr != 255
    if walkable.sum() == 0:
        return None
    return 100 * (arr[walkable] == 1).sum() / walkable.sum()

if __name__ == '__main__':
    noon_elevation = find_solar_noon_elevation()
    print(f'solar noon elevation: {noon_elevation:.1f} degrees (expect around 76)')

    process()
    save_preview()

    total_bytes = sum(os.path.getsize(f'{OUT_DIR}/shade_{h:02d}00.tif') for h in HOURS)
    print(f'shade rasters total size: {total_bytes / (1024 * 1024):.1f} mb')

    print()
    print('percent of walkable area shaded:')
    print(f"{'hour':>6} {'downtown':>10} {'west side':>10}")
    for hour in HOURS:
        d = percent_shaded(hour, *DOWNTOWN, PREVIEW_KM)
        w = percent_shaded(hour, *WEST_SIDE, PREVIEW_KM)
        print(f'{hour:>6} {d:>9.1f}% {w:>9.1f}%')
