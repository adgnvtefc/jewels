# Painter v3

The picture-to-puzzle model used by the painter test (`server/painting.py`). It turns a painted
picture into a 32×32 sprite from a fixed 255-colour palette. This is a copy of better-pixels'
saved painter v3 (`~/projects/better-pixels/models/painterv3`, saved 2026-11-14), so this project
doesn't depend on that one's folder.

| File | What it is |
| --- | --- |
| `painter.py` | The model and how to run it; self-contained (MLX, numpy, Pillow). Unchanged copy. |
| `painter-v3.json` | Size settings (14.4M parameters). |
| `palette.json` | The 255 colours its tokens refer to. |
| `painter-v3.safetensors` | The weights, 57.8 MB. **Not in git** (see `.gitignore`); copy it here from better-pixels. sha256 `93f6fd2e56aca0cb20dcc5ad7af206de7020a5259de55763dbbcbd2abdb57a9f` |

It was trained on 4,009 hand-drawn CC0 sprites (Dungeon Crawl, Idylwild, Buch), each paired with
Z-Image repaintings of it. How it was trained and how it compares with `convert.js`: better-pixels'
`models/painterv3/README.md` and `TRAINING.md`.

To restore the weights on a new checkout:

```bash
cp ~/projects/better-pixels/models/painterv3/painter-v3.safetensors server/painter/
shasum -a 256 server/painter/painter-v3.safetensors
```
