# draws the app icon by hand (sun over a curving path) and a splash source with it
# centered on the sandy bg. same shapes/colors as the web app palette

import math
from PIL import Image, ImageDraw

BG = (244, 237, 224)  # --bg
MARK = (181, 85, 56)  # --accent

OUT_ICON = 'resources/icon.png'
OUT_SPLASH = 'resources/splash.png'
OUT_SPLASH_DARK = 'resources/splash-dark.png'
ICON_SIZE = 1024
SPLASH_SIZE = 2732

SUN_RADIUS = 150
RAY_COUNT = 8
RAY_INNER = 175
RAY_OUTER = 250
RAY_WIDTH = 34

PATH_WIDTH = 80


def draw_mark(draw, cx, cy_sun, cy_path, scale):
    r = SUN_RADIUS * scale
    draw.ellipse([cx - r, cy_sun - r, cx + r, cy_sun + r], fill=MARK)

    for i in range(RAY_COUNT):
        angle = (2 * math.pi / RAY_COUNT) * i - math.pi / 2
        x1 = cx + math.cos(angle) * RAY_INNER * scale
        y1 = cy_sun + math.sin(angle) * RAY_INNER * scale
        x2 = cx + math.cos(angle) * RAY_OUTER * scale
        y2 = cy_sun + math.sin(angle) * RAY_OUTER * scale
        w = RAY_WIDTH * scale
        draw.line([x1, y1, x2, y2], fill=MARK, width=round(w))
        draw.ellipse([x2 - w / 2, y2 - w / 2, x2 + w / 2, y2 + w / 2], fill=MARK)

    span = 360 * scale
    amp = 55 * scale
    w = PATH_WIDTH * scale
    # stamping circles along the curve instead of a polyline, line(joint='curve') was
    # leaving thin gaps at the sharper bends
    steps = 200
    for i in range(steps + 1):
        t = i / steps
        x = cx - span / 2 + span * t
        y = cy_path + amp * math.sin(t * math.pi * 1.4)
        draw.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=MARK)


def make_icon():
    img = Image.new('RGB', (ICON_SIZE, ICON_SIZE), BG)
    draw = ImageDraw.Draw(img)
    draw_mark(draw, ICON_SIZE / 2, ICON_SIZE * 0.38, ICON_SIZE * 0.73, scale=1.0)
    img.save(OUT_ICON)
    print(f'wrote {OUT_ICON}')


def make_splash():
    img = Image.new('RGB', (SPLASH_SIZE, SPLASH_SIZE), BG)
    draw = ImageDraw.Draw(img)
    scale = 0.62  # icon reads smaller, centered, lots of sandy space around it like a real splash
    draw_mark(draw, SPLASH_SIZE / 2, SPLASH_SIZE * 0.44, SPLASH_SIZE * 0.58, scale=scale)
    img.save(OUT_SPLASH)
    print(f'wrote {OUT_SPLASH}')
    # app has one palette, no dark theme - without this capacitor-assets makes its own dark
    # splash (shrinks the sandy square onto a plain black bg), looked broken on a real phone
    img.save(OUT_SPLASH_DARK)
    print(f'wrote {OUT_SPLASH_DARK}')


if __name__ == '__main__':
    make_icon()
    make_splash()
