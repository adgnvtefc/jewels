"""Painter v3: turns a painted picture into puzzle art on the Mac, for the Create puzzle test.

The model lives in better-pixels' saved copy (`models/painterv3`, set by PAINTER_DIR); it is
loaded from there by file path, so nothing else in that project is imported. Its output is
calmed into the game's range by the cleanup below, a copy of better-pixels' `puzzle.calm`
(2026-11-14), kept here so later work in that project can't change live puzzles:
  merged      colours too alike to tell apart are folded together, down to a colour budget
  despeckled  a pixel with no same-coloured neighbour takes the commonest colour around it
"""

import importlib.util
import threading
from pathlib import Path

import numpy as np

NEIGHBOURS = [(dy, dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx]
WHITE = [255, 255, 255]  # the painter's empty token becomes a white background

_painter = None
_loading = threading.Lock()


def load(folder: Path):
    """The model, loaded once (near-instant; 58 MB of weights)."""
    global _painter
    with _loading:
        if _painter is None:
            spec = importlib.util.spec_from_file_location("painter_v3", Path(folder) / "painter.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            _painter = module.PainterV3(folder)
    return _painter


def oklab(rgb):
    """sRGB (0-255) to OKLab, where distance tracks how different two colours look."""
    c = np.asarray(rgb, float) / 255
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    lms = np.cbrt(c @ np.array([[0.4122214708, 0.2119034982, 0.0883024619],
                                [0.5363325363, 0.6806995451, 0.2817188376],
                                [0.0514459929, 0.1073969566, 0.6299787005]]))
    return lms @ np.array([[0.2104542553, 1.9779984951, 0.0259040371],
                           [0.7936177850, -2.4285922050, 0.7827717662],
                           [-0.0040720468, 0.4505937099, -0.8086757660]])


def merged(grid, lab, most=10, closer=0.045, empty=0):
    """Fold the two most alike colours together, the rarer into the commoner, until at most
    `most` remain and no two are closer than `closer` in OKLab (the game's own threshold).
    The empty background is left alone."""
    grid = grid.copy()
    while True:
        used, counts = np.unique(grid[grid != empty], return_counts=True)
        if len(used) < 2:
            return grid
        gaps = np.linalg.norm(lab[used][:, None] - lab[used][None], axis=2)
        np.fill_diagonal(gaps, np.inf)
        a, b = np.unravel_index(gaps.argmin(), gaps.shape)
        if len(used) <= most and gaps[a, b] >= closer:
            return grid
        rarer, commoner = (a, b) if counts[a] < counts[b] else (b, a)
        grid[grid == used[rarer]] = used[commoner]


def despeckled(grid):
    """Each pixel with no same-coloured neighbour (diagonals count, as in play) takes the
    commonest colour around it."""
    h, w = grid.shape
    out = grid.copy()
    for y in range(h):
        for x in range(w):
            around = [grid[y + dy, x + dx] for dy, dx in NEIGHBOURS if 0 <= y + dy < h and 0 <= x + dx < w]
            if grid[y, x] not in around:
                colours, counts = np.unique(around, return_counts=True)
                out[y, x] = colours[counts.argmax()]
    return out


def calm(grid, palette, most=10):
    """Merge colours, then clear lone pixels, twice over (clearing specks can leave new ones,
    and can free a colour to merge)."""
    lab = oklab(palette)
    for _ in range(2):
        grid = despeckled(merged(grid, lab, most))
    return grid


def art_from_grid(grid, palette, title: str, most: int = 10) -> dict | None:
    """Puzzle art (no id yet) from a token grid, or None if too plain to be a puzzle."""
    grid = calm(np.asarray(grid), palette, most)
    used, pixels = np.unique(grid, return_inverse=True)
    if len(used) < 2:
        return None
    return {"title": title, "width": 32, "height": 32,
            "colors": ["#%02x%02x%02x" % tuple(int(v) for v in palette[u]) for u in used],
            "pixels": pixels.ravel().tolist()}


def painted_puzzle(picture, title: str, folder: Path, style: str = "idylwild", most: int = 10) -> dict | None:
    """The full painted picture (PIL, 512 px) -> puzzle art without an id, or None."""
    painter = load(folder)
    grid = painter.tokens([picture], style)[0]  # crops to the subject itself
    palette = np.vstack([[WHITE], painter.palette]).astype(int)
    return art_from_grid(grid, palette, title, most)
