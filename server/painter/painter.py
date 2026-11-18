"""Painter v3: turns a picture into a 32x32 pixel-art sprite.

Self-contained: needs only mlx, numpy and pillow, and the files next to this one
(painter-v3.safetensors, painter-v3.json, palette.json). Apple Silicon only (MLX).

From Python:
    from painter import PainterV3
    painter = PainterV3()
    sprite = painter.draw(Image.open("picture.png"), style="idylwild")   # a 32x32 RGBA PIL image
    sprite.resize((256, 256), Image.NEAREST).save("sprite.png")

From the command line:
    python painter.py picture.png sprite.png [style]

Styles (the hand-drawn style to draw like): idylwild, buch, dcss-monster, dcss-item, dcss-other.
Pictures work best with one subject on a plain light background, like the ones Z-Image paints.
"""
import json
import sys
from pathlib import Path
import mlx.core as mx
import mlx.nn as nn
import numpy as np
from PIL import Image

HERE = Path(__file__).parent
STYLES = ["idylwild", "buch", "dcss-monster", "dcss-item", "dcss-other"]   # the order it was trained with
SIDE, COLOURS, PATCH = 32, 256, 4      # 32x32 sprite; token 0 empty, 1-255 palette colours; 4x4 picture pixels per sprite pixel
MASK = COLOURS                          # the token for "not decided yet"


class Block(nn.Module):
    """One transformer layer: every position looks at every other, then works on its own."""

    def __init__(self, dim, heads):
        super().__init__()
        self.heads = heads
        self.norm1, self.norm2 = nn.LayerNorm(dim), nn.LayerNorm(dim)
        self.qkv, self.join = nn.Linear(dim, dim * 3), nn.Linear(dim, dim)
        self.widen, self.narrow = nn.Linear(dim, dim * 4), nn.Linear(dim * 4, dim)

    def __call__(self, x):
        batch, places, dim = x.shape
        q, k, v = (part.reshape(batch, places, self.heads, -1).transpose(0, 2, 1, 3)
                   for part in mx.split(self.qkv(self.norm1(x)), 3, axis=-1))
        seen = mx.fast.scaled_dot_product_attention(q, k, v, scale=(dim // self.heads) ** -0.5)
        x = x + self.join(seen.transpose(0, 2, 1, 3).reshape(batch, places, dim))
        return x + self.narrow(nn.gelu(self.widen(self.norm2(x))))


class Painter(nn.Module):
    """At each of the 1,024 pixels: the colour chosen so far (or MASK), the 4x4 patch of the
    picture under it, its row and column, and the style. Scores every palette colour per pixel."""

    def __init__(self, dim=384, layers=8, heads=6, styles=5):
        super().__init__()
        self.colour = nn.Embedding(COLOURS + 1, dim)
        self.look = nn.Linear(PATCH * PATCH * 3, dim)
        self.row, self.column = nn.Embedding(SIDE, dim), nn.Embedding(SIDE, dim)
        self.style = nn.Embedding(styles, dim)
        self.blocks = [Block(dim, heads) for _ in range(layers)]
        self.norm, self.choose = nn.LayerNorm(dim), nn.Linear(dim, COLOURS)

    def __call__(self, tokens, patches, style):
        place = mx.arange(SIDE * SIDE)
        x = (self.colour(tokens) + self.look(patches) + self.row(place // SIDE) + self.column(place % SIDE)
             + self.style(style)[:, None])
        for block in self.blocks:
            x = block(x)
        return self.choose(self.norm(x))


def framed(picture, margin=1 / 16):
    """The picture cropped to a square around its subject, with a small margin. The
    background is taken to be whatever colour the top-left corner is."""
    rgb = np.asarray(picture.convert("RGB"), int)
    rows, columns = np.nonzero(np.abs(rgb - rgb[0, 0]).sum(axis=2) > 40)
    if len(rows) == 0:
        return picture.convert("RGB")
    side = int(max(rows.max() - rows.min(), columns.max() - columns.min()) * (1 + 2 * margin)) + 1
    top, left = (rows.min() + rows.max() - side) // 2, (columns.min() + columns.max() - side) // 2
    canvas = Image.new("RGB", (side, side), tuple(int(v) for v in rgb[0, 0]))
    canvas.paste(picture.convert("RGB"), (-int(left), -int(top)))
    return canvas


class PainterV3:
    def __init__(self, folder=HERE):
        folder = Path(folder)
        settings = json.loads((folder / "painter-v3.json").read_text())
        self.model = Painter(**settings["model"])
        self.model.load_weights(str(folder / "painter-v3.safetensors"))
        self.palette = np.array(json.loads((folder / "palette.json").read_text()), np.uint8)

    def tokens(self, pictures, style="idylwild"):
        """Sprites as token grids (count, 32, 32): 0 is empty, k is palette colour k-1.
        Every pixel is drawn in one pass, which tested as well as drawing in many steps."""
        refs = np.stack([np.asarray(framed(p).resize((SIDE * PATCH,) * 2, Image.LANCZOS)) for p in pictures])
        cut = refs.reshape(len(refs), SIDE, PATCH, SIDE, PATCH, 3).transpose(0, 1, 3, 2, 4, 5)
        patches = mx.array(cut.reshape(len(refs), SIDE * SIDE, -1).astype(np.float32) / 127.5 - 1)
        hidden = mx.full((len(refs), SIDE * SIDE), MASK, dtype=mx.int32)
        scores = self.model(hidden, patches, mx.array([STYLES.index(style)] * len(refs)))
        return np.array(mx.argmax(scores, axis=-1)).reshape(-1, SIDE, SIDE)

    def draw(self, picture, style="idylwild"):
        """One picture as a 32x32 RGBA sprite; empty pixels are transparent."""
        grid = self.tokens([picture], style)[0]
        rgba = np.zeros((SIDE, SIDE, 4), np.uint8)
        filled = grid > 0
        rgba[filled, :3] = self.palette[grid[filled] - 1]
        rgba[filled, 3] = 255
        return Image.fromarray(rgba)


if __name__ == "__main__":
    PainterV3().draw(Image.open(sys.argv[1]), sys.argv[3] if len(sys.argv) > 3 else "idylwild").save(sys.argv[2])
