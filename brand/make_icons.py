"""Builds every app icon from the logo the owner designed: brand/source/logo-original.png.

    python3 brand/make_icons.py        (needs Pillow, numpy and scipy)

The logo is a navy rounded square on a dark backdrop. Store and home-screen icons must be full-bleed
squares (the phone rounds them itself), so the dark corners are replaced by a smooth extension of the
square's own navy background. The logo itself is never altered, only resized.

LIMIT: the source is 462 x 485 px, so nothing larger than about 512 px is sharp. The App Store needs a
1024 px icon: ask for the original high-resolution file (or a vector) before submitting to the stores.
"""
import numpy as np
from PIL import Image
from scipy import ndimage

SRC = "brand/source/logo-original.png"
OUT = "web/public/icons"

# Where the navy rounded square sits inside the source image (measured from the pixels).
L, R, T, B = 23, 430, 21, 427
PAD = 420          # the source is placed on a larger canvas so the background can be extended past its edges
INNER_SHRINK = 24  # drop the square's own bevel and shadow edge before extending

src = np.asarray(Image.open(SRC).convert("RGB"), dtype=np.float32)
h, w, _ = src.shape

# Padded canvas so the background can be extended past the source's edges.
H, W = h + 2 * PAD, w + 2 * PAD
canvas = np.zeros((H, W, 3), np.float32)
canvas[PAD:PAD + h, PAD:PAD + w] = src
lum = canvas @ np.array([0.299, 0.587, 0.114], np.float32)
cx, cy = PAD + (L + R) / 2, PAD + (T + B) / 2
yy, xx = np.mgrid[0:H, 0:W]

def squircle(shrink):
    """Superellipse (iOS-style rounded square) mask, `shrink` pixels inside the measured edge."""
    a, b = (R - L) / 2 - shrink, (B - T) / 2 - shrink
    return np.abs((xx - cx) / a) ** 5 + np.abs((yy - cy) / b) ** 5 <= 1.0

# The logo = the light blue strokes. Keep every one of its pixels, with a small halo.
logo = ndimage.binary_dilation(lum > 95, iterations=6)

# Background samples: deep inside the square, away from its bevel/shadow edge and from the logo.
good_bg = squircle(INNER_SHRINK) & ~ndimage.binary_dilation(lum > 95, iterations=10)
_, (iy, ix) = ndimage.distance_transform_edt(~good_bg, return_indices=True)
extended = canvas[iy, ix]                                  # nearest good background colour everywhere
extended = np.stack([ndimage.gaussian_filter(extended[..., c], 16) for c in range(3)], axis=-1)

# Original pixels where they are clean (deep inside) or part of the logo; the smooth extension elsewhere.
keep = (squircle(INNER_SHRINK) | logo).astype(np.float32)
keep = ndimage.gaussian_filter(keep, 3)[..., None]
full = canvas * keep + extended * (1 - keep)
full_img = Image.fromarray(np.clip(full, 0, 255).astype(np.uint8))

def square(side, center_x, center_y):
    box = (round(center_x - side / 2), round(center_y - side / 2), round(center_x + side / 2), round(center_y + side / 2))
    return full_img.crop(box)

# The logo's visual centre is a little left of and below the square's centre; frame it a bit lower and left.
cxl, cyl = PAD + 220, PAD + 244
standard = square(440, cxl, cyl)          # logo fills the icon, like the original design
maskable = square(440 / 0.74, cxl, cyl)   # logo inside the central 74%, safe for circular masks

def save(img, name, size):
    img.resize((size, size), Image.LANCZOS).save(f"{OUT}/{name}", optimize=True)

save(standard, "icon-512.png", 512)
save(standard, "icon-192.png", 192)
save(standard, "apple-touch-icon.png", 180)
save(standard, "favicon-32.png", 32)
save(maskable, "icon-maskable-512.png", 512)

# A sheet to look at: the sizes an icon really lives at, plus the maskable one cropped to a circle.
sheet = Image.new("RGB", (900, 370), (243, 239, 230))
x = 20
for size in (180, 120, 80, 48, 32):
    sheet.paste(standard.resize((size, size), Image.LANCZOS), (x, 20)); x += size + 16
circle = Image.new("L", (200, 200), 0)
from PIL import ImageDraw
ImageDraw.Draw(circle).ellipse((0, 0, 199, 199), fill=255)
sheet.paste(maskable.resize((200, 200), Image.LANCZOS), (x + 20, 20), circle)
dark = Image.new("RGB", (900, 130), (20, 24, 29))
x = 20
for size in (80, 48, 32):
    dark.paste(standard.resize((size, size), Image.LANCZOS), (x, 24)); x += size + 16
sheet.paste(dark, (0, 240))
import os
os.makedirs("brand/out", exist_ok=True)
sheet.save("brand/out/icon-preview.png")
print("wrote", OUT, "(192, 512, maskable 512, 180 touch, 32 favicon) and brand/out/icon-preview.png")
