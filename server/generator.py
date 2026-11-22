"""Making puzzles: every puzzle the Mac makes comes from one pipeline of three steps, and each
step can be swapped:

  wording   what to paint: the player's idea as typed, the artist's rewrite of it, or a random
            word soup the artist blends into one subject (agents/artist.md, through orchestra)
  picture   Z-Image paints the subject with the style line (STYLE)
  puzzle    the picture becomes puzzle art: convert.js, the game's own converter, run here in
            Node (convert_worker.mjs) exactly as the browser used to run it; or painter v3

A pipeline names one choice per step (PIPELINES). Create puzzle asks for four candidates and
the gauntlet for five puzzles; an experiment only decides which pipeline makes which candidate
(create_plan). The server always hands back finished puzzle art, never pictures.

Create puzzle can come with a photo: the artist looks at it (with the player's words, if any)
and writes the subject; the rest is the same. The photo is only ever held in memory, for that
one call, and is never stored or shown to anyone (orchestra's call record leaves images out).
"""

import atexit
import base64
import io
import json
import os
import random
import re
import shutil
import subprocess
import threading
import time
import traceback
from dataclasses import dataclass
from pathlib import Path

import painting

ROOT = Path(__file__).resolve().parent
USE_AGENT = os.environ.get("USE_AGENT", "1") != "0"
ARTIST = ROOT / "agents" / "artist.md"
ARTIST_MAX_TOKENS = 2048  # the reply is one short line; the rest is for the model's thinking
PHOTO_SIDE = 768  # a photo's longer side as the artist sees it
MAX_PHOTO_BYTES = 2 * 1024 * 1024

CANDIDATES = 4
GAUNTLET_SIZE = 5
# Bold, flat, outlined icons on a plain background survive the trip down to 32x32.
STYLE = ("flat vector icon style, bold simple shapes, thick dark outlines, at most 8 flat colors, "
         "no gradients, no text, plain solid light background")
WORDS = json.loads((ROOT / "words.json").read_text())

# The painter test (PAINTER_TEST=1): two of Create puzzle's four candidates come from the
# "painter" pipeline, shown in a random order, and each job is kept in data/painter-test/.
PAINTER_TEST = os.environ.get("PAINTER_TEST", "0") == "1"
PAINTER_DIR = Path(os.environ.get("PAINTER_DIR", ROOT / "painter")).expanduser()
PAINTER_STYLE = "idylwild"
PAINTER_COLORS = 10
PAINTER_TEST_DIR = ROOT / "data" / "painter-test"


@dataclass(frozen=True)
class Pipeline:
    name: str
    wording: str  # "typed", "artist" or "soup"
    puzzle: str   # "convert" or "painter"


PIPELINES = {p.name: p for p in (
    Pipeline("current", wording="artist", puzzle="convert"),   # Create puzzle, as it has been
    Pipeline("painter", wording="typed", puzzle="painter"),    # the painter test's challenger
    Pipeline("soup", wording="soup", puzzle="convert"),        # the gauntlet
)}


def create_plan() -> list[str]:
    """Which pipeline makes each of Create puzzle's candidates, in the order shown."""
    if not PAINTER_TEST:
        return ["current"] * CANDIDATES
    plan = ["current"] * (CANDIDATES // 2) + ["painter"] * (CANDIDATES - CANDIDATES // 2)
    return random.sample(plan, len(plan))  # shuffled, so no pipeline always shows first


def title_for(text: str, limit: int = 60) -> str:
    return text[:1].upper() + text[1:limit]  # as the game titles a new puzzle


# ---- wording ----

def read_artist() -> tuple[dict, str]:
    """agents/artist.md: `key: value` settings between '---' lines, then the system prompt."""
    _, settings, prompt = ARTIST.read_text().split("---\n", 2)
    pairs = (line.split(":", 1) for line in settings.splitlines() if ":" in line)
    return {key.strip(): value.strip() for key, value in pairs}, prompt.strip()


def clean_photo(data) -> str | None:
    """A player's photo as the artist will see it: a data: URL of a JPEG at most PHOTO_SIDE px
    on a side, re-encoded here so nothing else in the file (its location, the camera) comes
    along. None if it isn't a picture."""
    from PIL import Image, ImageOps

    match = re.fullmatch(r"data:image/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})", data) if isinstance(data, str) else None
    if not match:
        return None
    try:
        raw = base64.b64decode(match[1], validate=True)
        if len(raw) > MAX_PHOTO_BYTES:
            return None
        image = Image.open(io.BytesIO(raw))
        if image.width * image.height > 50_000_000:
            return None
        image = ImageOps.exif_transpose(image).convert("RGB")
        image.thumbnail((PHOTO_SIDE, PHOTO_SIDE))
        out = io.BytesIO()
        image.save(out, "JPEG", quality=85)
    except Exception:
        return None
    return "data:image/jpeg;base64," + base64.b64encode(out.getvalue()).decode()


def photo_title(subject: str) -> str:
    """A puzzle made from a photo is titled from the artist's subject, cut short:
    "A round red apple with a green stem" becomes "A round red apple"."""
    short = re.split(r",| with | holding | wearing | in front of ", subject, maxsplit=1)[0].strip()
    return title_for(short or subject)


def artist(idea: str, tag: str, account: str, photo: str | None = None) -> tuple[str, bool]:
    """Ask the artist for one drawable subject, from the idea, a photo, or both; fall back to
    the idea itself."""
    if not USE_AGENT:
        return idea, False
    try:
        from orchestra import chat as model_chat

        settings, prompt = read_artist()
        content = idea
        if photo:
            content = [{"type": "text", "text": f"Their photo, and their words: {idea}" if idea else "Their photo."},
                       {"type": "image_url", "image_url": {"url": photo}}]
        reply = model_chat(app="jewels", model=settings["model"],
                           temperature=float(settings["temperature"]) if "temperature" in settings else None,
                           max_tokens=ARTIST_MAX_TOKENS, metadata={"job": tag, "account": account, "photo": bool(photo)},
                           messages=[{"role": "system", "content": prompt}, {"role": "user", "content": content}])
        if reply.finish_reason == "length":  # cut off: whatever came back isn't a finished subject
            print(f"{tag}: the artist ran out of tokens; using the idea as written", flush=True)
            return idea, False
        answer = re.sub(r"<think>.*?</think>", "", reply.content or "", flags=re.S).strip()
        line = next((l.strip(" \"'`*") for l in answer.splitlines() if l.strip()), "").rstrip(".")
        if line:
            return line[:160], True
    except Exception:
        traceback.print_exc()
    return idea, False


def soup(rng=random) -> list[str]:
    """3 to 5 different words: one describer, one creature or thing, then any mix, shuffled."""
    words = [rng.choice(WORDS["describers"]), rng.choice(WORDS["creatures"] + WORDS["things"])]
    groups = [WORDS["describers"], WORDS["creatures"], WORDS["things"], WORDS["doings"]]
    size = rng.choice([3, 4, 5])
    while len(words) < size:
        word = rng.choice(rng.choice(groups))
        if word not in words:
            words.append(word)
    rng.shuffle(words)
    return words


def wording(pipeline: str, idea: str, account: str, tag: str, photo: str | None = None) -> dict:
    """{subject, agent, words?, title}: what to paint, and the puzzle's title."""
    how = PIPELINES[pipeline].wording
    if photo and how == "typed":
        how = "artist"  # a photo has no words to paint as typed: the artist describes it
    if how == "typed":
        return {"subject": idea, "agent": False, "title": title_for(idea)}
    if how == "artist":
        subject, agent = artist(idea, tag, account, photo)
        if photo and not idea and not agent:
            raise RuntimeError("Couldn’t make out the photo. Try again, or describe it in words.")
        # with a photo, the title comes from what the artist saw: words that go with a photo
        # ("with a birthday candle") make a poor title
        return {"subject": subject, "agent": agent, "title": photo_title(subject) if photo else title_for(idea)}
    words = soup()
    subject, agent = artist(" ".join(words), tag, account)
    return {"subject": subject, "agent": agent, "words": words, "title": title_for(", ".join(words), 80)}


# ---- puzzle ----

def picture_png(image) -> bytes:
    """The picture at 256 px, as the browser used to receive it: the converter works from a
    128x128 grid, so this is plenty."""
    from PIL import Image

    buffer = io.BytesIO()
    image.convert("RGB").resize((256, 256), Image.LANCZOS).save(buffer, "PNG")
    return buffer.getvalue()


def find_node() -> str:
    """The server runs under launchd, whose PATH has no Homebrew: look where Node usually is."""
    for candidate in (os.environ.get("NODE"), shutil.which("node"), "/opt/homebrew/bin/node", "/usr/local/bin/node"):
        if candidate and Path(candidate).exists():
            return candidate
    raise RuntimeError("Node isn't installed; it runs convert.js for the server")


class Converter:
    """convert.js in one long-lived Node process (convert_worker.mjs), shared by all threads."""

    def __init__(self):
        self.lock, self.process, self.count = threading.Lock(), None, 0

    def _stop(self):
        if self.process:
            self.process.kill()
            self.process.wait()
            for pipe in (self.process.stdin, self.process.stdout):
                pipe.close()
        self.process = None

    def _start(self):
        self._stop()
        self.process = subprocess.Popen([find_node(), str(ROOT / "convert_worker.mjs")], cwd=ROOT, text=True,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=1)

    def convert(self, png: bytes, title: str) -> dict:
        """Puzzle art (no id) from a picture's PNG bytes, exactly as the browser made it."""
        from PIL import Image

        image = Image.open(io.BytesIO(png)).convert("RGBA")
        request = {"width": image.width, "height": image.height, "options": {"title": title},
                   "rgba": base64.b64encode(image.tobytes()).decode()}
        with self.lock:
            for attempt in (1, 2):  # once more on a fresh process, if the old one died
                try:
                    if self.process is None or self.process.poll() is not None:
                        self._start()
                    self.count += 1
                    self.process.stdin.write(json.dumps({**request, "id": self.count}) + "\n")
                    self.process.stdin.flush()
                    reply = json.loads(self.process.stdout.readline())
                    break
                except (OSError, ValueError):
                    self._stop()
                    if attempt == 2:
                        raise
        if "error" in reply:
            raise RuntimeError(f"convert.js: {reply['error']}")
        return reply["art"]

    def close(self):
        with self.lock:
            self._stop()


converter = Converter()
atexit.register(converter.close)


def puzzle(pipeline: str, picture, title: str) -> tuple[str, dict]:
    """(variant, art). If painter v3 can't make a puzzle of a picture, convert.js does, marked
    "painter-failed" so the pick counts for neither pipeline."""
    variant = pipeline
    if PIPELINES[pipeline].puzzle == "painter":
        try:
            art = painting.painted_puzzle(picture, title, PAINTER_DIR, PAINTER_STYLE, PAINTER_COLORS)
            if art:
                return variant, art
        except Exception:
            traceback.print_exc()
        variant = "painter-failed"
    return variant, converter.convert(picture_png(picture), title)


# ---- a whole candidate ----

class Generator:
    """Makes candidates with one Z-Image model. Lives on the picture worker's thread (MLX runs
    there); wording can be done ahead on any thread and passed in."""

    def __init__(self, model):
        self.model = model

    def paint(self, subject: str) -> dict:
        seed, prompt = random.randrange(2**31), f"{subject}, one subject centered, {STYLE}"
        image = self.model.generate_image(seed=seed, prompt=prompt, num_inference_steps=8, width=512, height=512).image
        return {"picture": image, "prompt": prompt, "seed": seed}

    def make(self, pipeline: str, words: dict) -> dict:
        """One candidate: {variant, art, subject, prompt, seed, picture (PIL), words?}."""
        painted = self.paint(words["subject"])
        variant, art = puzzle(pipeline, painted["picture"], words["title"])
        return {"variant": variant, "art": art, "subject": words["subject"], **painted,
                **({"words": words["words"]} if "words" in words else {})}


def start_painter_test() -> None:
    """Load painter v3 (on the picture worker's thread, where MLX runs). If it won't load,
    Create puzzle carries on without the test."""
    global PAINTER_TEST
    if not PAINTER_TEST:
        return
    try:
        painting.load(PAINTER_DIR)
        print(f"painter test: on (2 current + 2 painter v3, {PAINTER_STYLE}, up to {PAINTER_COLORS} colors)", flush=True)
    except Exception as error:
        PAINTER_TEST = False
        print(f"painter test: off, painter v3 didn't load from {PAINTER_DIR}: {error}", flush=True)


def save_test_job(job_id: str, job: dict, subject: str, made: list[dict]) -> None:
    """Keep a painter-test job: each full picture, and what made it and where it was shown."""
    folder = PAINTER_TEST_DIR / job_id
    folder.mkdir(parents=True, exist_ok=True)
    shown = []
    for position, item in enumerate(made, 1):
        file = f"{position}-{item['variant']}.png"
        item["picture"].save(folder / file)
        shown.append({"position": position, "file": file, **{k: v for k, v in item.items() if k != "picture"}})
    (folder / "job.json").write_text(json.dumps({
        "idea": job["prompt"], "subject": subject, "account": job["account"], "at": int(time.time()),
        "style": PAINTER_STYLE, "most_colors": PAINTER_COLORS, "shown": shown,
    }, indent=1))


def shown(item: dict) -> dict:
    """What the browser gets for a candidate."""
    return {"variant": item["variant"], "art": item["art"]}
