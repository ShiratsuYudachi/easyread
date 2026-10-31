"""Locate prose as matched glyph regions, preserving column and page breaks."""
from __future__ import annotations

import re
import unicodedata
from bisect import bisect_left, bisect_right
from difflib import SequenceMatcher
from statistics import median


def _norm(text):
    return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKC", text).lower())


def _bounds(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes)]


def _lines(chars, positions):
    """Join neighboring glyphs into line fragments: (median glyph height, [[box, first offset], ...])."""
    glyphs = [(chars[i][1:5], pos) for i, pos in positions.items()
              if chars[i][3] > chars[i][1] and chars[i][4] > chars[i][2]]
    if not glyphs:
        return None
    height = median(b[3] - b[1] for b, _ in glyphs)
    rows = []
    for box, pos in sorted(glyphs, key=lambda g: ((g[0][1] + g[0][3]) / 2, g[0][0])):
        center = (box[1] + box[3]) / 2
        row = next((r for r in reversed(rows[-3:]) if abs(r[0] - center) < height * .6), None)
        if row is None:
            row = [center, []]
            rows.append(row)
        row[1].append((box, pos))
    lines = []
    for _, glyphs in rows:
        fragments = []
        for box, pos in sorted(glyphs, key=lambda g: g[0][0]):
            if not fragments or box[0] - fragments[-1][0][2] > .018:
                fragments.append([list(box), pos])
            else:
                fragments[-1][0] = _bounds([fragments[-1][0], box])
                fragments[-1][1] = min(fragments[-1][1], pos)
        lines.extend(fragments)
    return height, lines


def _regions(chars, positions):
    """Join neighboring glyphs into lines, then vertically adjacent line runs.

    A column gutter or a figure-sized vertical gap must remain outside the box.
    Matching offsets, rather than a page-wide y sort, preserve reading order.
    """
    found = _lines(chars, positions)
    if not found:
        return []
    height, lines = found
    runs = []
    for box, pos in sorted(lines, key=lambda g: g[0][1]):
        candidates = [r for r in runs if box[1] <= r[0][3] + height * 1.4
                      and box[3] >= r[0][1] - .002
                      and min(box[2], r[0][2]) - max(box[0], r[0][0])
                      > min(box[2] - box[0], r[0][2] - r[0][0]) * .45]
        if candidates:
            run = max(candidates, key=lambda r: r[0][3])
            run[0] = _bounds([run[0], box])
            run[1] = min(run[1], pos)
        else:
            runs.append([list(box), pos])
    runs = [r for r in runs if r[0][2] - r[0][0] >= .012]
    return [box for box, _ in sorted(runs, key=lambda r: r[1])]


# A gap of up to this many page characters inside one sentence (rendered inline math, a footnote mark) belongs to it;
# anything longer is another piece of the page, such as a footnote that interrupts the column.
_HOLE = 24
# Lines whose left and right edges agree this closely form one block, as in a text selection.
_FLUSH = .01
# Inline math that ends or starts a sentence ("... up to $13.1\%$.") has no text of its own to match against.
_ENDS_IN_MATH = re.compile(r"\$[^$]*\$[\s.,;:!?)\]}\"'”’]*$")
_STARTS_WITH_MATH = re.compile(r"^[\s\"'“‘(\[{]*\$[^$]*\$")


def utf16_to_index(text, offsets):
    """Turn JS string offsets (UTF-16 units, as `sents` stores them) into Python indices; None if one is not a boundary."""
    want, found, units = set(offsets), {}, 0
    for i, ch in enumerate(text):
        if units in want:
            found[units] = i
        units += 2 if ord(ch) > 0xFFFF else 1
    if units in want:
        found[units] = len(text)
    return [found[o] for o in offsets] if all(o in found for o in offsets) else None


def _punctuated(chars, positions):
    """Add the unmatched glyphs the text stream leaves out: punctuation and accented letters between matched
    glyphs, and the few marks that close a sentence (".", "%", ")")."""
    order = sorted(positions)
    extra = {}
    for a, b in zip(order, order[1:]):
        if 1 < b - a <= 8:
            extra.update({c: positions[a] for c in range(a + 1, b)})
    for c in range(order[-1] + 1, min(order[-1] + 4, len(chars))):
        if chars[c][0].isalnum() or chars[c][0].isspace():
            break
        extra[c] = positions[order[-1]]
    return {**extra, **positions}


def _sentence_boxes(chars, positions):
    """One box per line of a sentence, in reading order, so a sentence is outlined like a text selection.

    Neighbouring lines that run the full measure merge into one block; the partial first and last lines stay apart.
    """
    found = _lines(chars, positions)
    if not found:
        return []
    height, lines = found
    boxes = []
    for box, _ in sorted(lines, key=lambda line: line[1]):
        if box[2] - box[0] < .004:
            continue
        last = boxes[-1] if boxes else None
        if (last and abs(last[0] - box[0]) < _FLUSH and abs(last[2] - box[2]) < _FLUSH
                and last[1] <= box[1] <= last[3] + height * 1.4):
            last[:] = _bounds([last, box])
        else:
            boxes.append(list(box))
    return boxes


def _locate_sentences(english, sentences, found):
    """{key: [regions or None per sentence]} from the glyphs the paragraph match already placed.

    Only glyphs that matched the sentence's own text count, plus short holes between them; a sentence the page
    never matched stays None, so the reader falls back to the whole paragraph rather than guess.
    """
    cache = {}

    def offset(end):
        if end not in cache:
            cache[end] = len(_norm(re.sub(r"\$[^$]*\$", " ", english[:end])))
        return cache[end]

    # SequenceMatcher blocks run in order on both sides, so on one page the matched text indices and their
    # offsets in the paragraph rise together: a sentence's glyphs are one slice, found by bisection.
    pages = []
    for page, idx, chars, hits in found:
        order = sorted(hits)
        pages.append((page, idx, chars, order, [hits[k] for k in order]))
    located = {}
    for key, start, ends in sentences:
        rows, previous, handed = [], start, False
        for end in ends:
            lo, hi = offset(previous), offset(end)
            text = english[previous:end]
            trailing, leading = bool(_ENDS_IN_MATH.search(text)), bool(_STARTS_WITH_MATH.match(text))
            previous = end
            regions = []
            for page, idx, chars, everything, offsets in pages:
                matched = everything[bisect_left(offsets, lo):bisect_left(offsets, hi)]
                chosen = set(matched)
                for a, b in zip(matched, matched[1:]):
                    if 1 < b - a <= _HOLE + 1:
                        chosen.update(range(a + 1, b))
                if matched and trailing:  # the formula sits between this sentence and the next matched word
                    after = bisect_right(everything, matched[-1])
                    gap = range(matched[-1] + 1, everything[after]) if after < len(everything) else ()
                    if 0 < len(gap) <= _HOLE:
                        chosen.update(gap)
                if matched and leading and not handed:  # ... unless the previous sentence already took it
                    before = bisect_left(everything, matched[0]) - 1
                    gap = range(everything[before] + 1, matched[0]) if before >= 0 else ()
                    if 0 < len(gap) <= _HOLE:
                        chosen.update(gap)
                regions.extend({"page": page, "box": [round(v, 4) for v in box]}
                               for box in _sentence_boxes(chars, _punctuated(chars, {idx[k]: k for k in chosen})
                                                          if chosen else {}))
            rows.append(regions or None)
            handed = trailing
        located[key] = rows
    return located


def locate_prose(english, page, stream, sentences=None):
    """Match actual text on successive pages; never estimate a missing tail.

    The primary page/box remains readable by older consumers. `regions` is the
    complete, ordered location, and can include multiple boxes on several pages.
    `sentences` is a list of (key, start, ends): the text starting at `start` in `english`
    splits into sentences that end at each index of `ends`. Their locations come back as `sents`.
    """
    target = _norm(re.sub(r"\$[^$]*\$", " ", english))
    if len(target) < 24:
        return None
    regions, covered, progress, placed = [], set(), 0, []
    for pn in range(page, page + 8):
        data = stream(pn)
        if not data:
            break
        text, idx, chars = data
        matches = [m for m in SequenceMatcher(None, target, text, autojunk=False).get_matching_blocks()
                   if m.size >= 24 and m.a + m.size > progress]
        if not matches or (sum(m.size for m in matches) < 48 and
                           not any(m.a == 0 or m.a + m.size >= len(target) - 4 for m in matches)):
            if pn == page:
                continue  # The model can assign the preceding page number.
            break
        positions, hits = {}, {}
        for match in matches:
            start = max(match.a, progress)
            for pos in range(start, match.a + match.size):
                k = match.b + pos - match.a
                char = idx[k]
                positions[char] = min(positions.get(char, pos), pos)
                hits[k] = pos
                covered.add(pos)
        placed.append((pn, idx, chars, hits))
        boxes = _regions(chars, positions)
        regions.extend({"page": pn, "box": box} for box in boxes)
        progress = max(m.a + m.size for m in matches)
        if progress >= len(target) - 4:
            break
    if not regions or len(covered) < len(target) * .65:
        return None
    first_page = regions[0]["page"]
    boxes = [r["box"] for r in regions if r["page"] == first_page]
    loc = {"page": first_page, "box": _bounds(boxes), "src": "text", "regions": regions}
    if len(boxes) > 1:
        loc["boxes"] = boxes
    if sentences:
        located = _locate_sentences(english, sentences, placed)
        located = {key: rows for key, rows in located.items() if any(rows)}
        if located:
            loc["sents"] = located
    return loc
