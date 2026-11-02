"""Author-year citations that are links in the PDF (hyperref `cite.*` annotations), attached to reference entries.

Each reference entry gets `cites`: the label pieces its links show, e.g. [["Harding and Kloster", "2025"]].
The reader links those labels wherever they appear in the original or the translation, exactly like [n].
Raw annotations are cached per source PDF (pdf-citations.json); matching to entries reruns each refresh,
since the references list changes when a paper is re-translated.
"""
from __future__ import annotations

import json
import re
from collections import Counter
from contextlib import closing
from pathlib import Path

from ..library.store import write_json_atomic

_VERSION = 1
_EDGE = re.compile(r"^[\s(\[;,]+|[\s)\];,]+$")
_PREFIX = 25  # alphanumerics from the start of an entry that identify it


def _norm(text: str) -> str:
    return "".join(c for c in text.casefold() if c.isalnum())


def extract(pdf: Path) -> dict:
    """{"links": [[page, dest, text under the link]…] in page order, "dests": {dest: text where it lands}}."""
    from pypdf import PdfReader
    from pypdf.generic import ArrayObject
    from .pdfwork import open_pdf

    reader = PdfReader(str(pdf))
    named = reader.named_destinations
    links, dests = [], {}
    with open_pdf(pdf) as doc:
        for n, page in enumerate(reader.pages):
            found = []
            for ref in page.get("/Annots") or []:
                a = ref.get_object()
                if a.get("/Subtype") != "/Link":
                    continue
                dest = a.get("/Dest")
                action = a.get("/A")
                if action is not None:
                    action = action.get_object()
                    dest = action.get("/D") if action.get("/S") == "/GoTo" else None
                if dest is None or isinstance(dest, ArrayObject) or not str(dest).startswith("cite."):
                    continue
                found.append((str(dest), [float(v) for v in a["/Rect"]]))
            if not found:
                continue
            with closing(doc[n]) as pdf_page, closing(pdf_page.get_textpage()) as textpage:
                for dest, (x0, y0, x1, y1) in found:
                    links.append([n + 1, dest, textpage.get_text_bounded(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))])
        for dest in {d for _, d, _ in links}:
            target = named.get(dest)
            if target is None:
                continue
            index = reader.get_destination_page_number(target)
            with closing(doc[index]) as pdf_page, closing(pdf_page.get_textpage()) as textpage:
                width, height = pdf_page.get_size()
                top = float(target.top) if target.top is not None else height
                # From the destination's own x: in a two-column reference list the left column must not lead.
                left = max(0.0, float(target.left) - 2) if target.left is not None else 0.0
                dests[dest] = textpage.get_text_bounded(left, top - 22, width, top + 2)
    return {"links": links, "dests": dests}


def _raw(ws) -> dict:
    source = ws.source_pdf
    if not source or not source.is_file():
        return {}
    stat = source.stat()
    identity = [str(source.resolve()), stat.st_size, stat.st_mtime_ns, _VERSION]
    cache = ws.root / "extract" / "pdf-citations.json"
    try:
        saved = json.loads(cache.read_text(encoding="utf-8"))
        if saved.get("source") == identity:
            return saved.get("data", {})
    except (OSError, ValueError):
        pass
    try:
        data = extract(source)
    except Exception:  # Citation links are a reading aid; an odd PDF must not block opening it.
        from ..app.log import log
        log.exception("Could not read PDF citation links: %s", source.name)
        return {}
    cache.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(cache, {"source": identity, "data": data})
    return data


def labels(links: list) -> dict[str, list[list[str]]]:
    """Consecutive links to one destination form one citation: (OpenAI, + 2026a) -> ["OpenAI", "2026a"]."""
    out: dict[str, list[list[str]]] = {}
    group, last = [], None

    def close():
        if group and any(re.search(r"[^\W\d_]", p) for p in group):  # a bare year would link every "2026"
            out.setdefault(last[1], [])
            if group not in out[last[1]]:
                out[last[1]].append(list(group))

    for page, dest, text in links:
        piece = _EDGE.sub("", " ".join(str(text).split()))
        if not piece:
            continue
        same = last and (last[0], last[1]) == (page, dest)
        if same and group and group[-1].endswith("\x02"):  # "Khand-" + "pur": a name hyphenated across lines
            group[-1] = group[-1][:-1] + piece
        elif same and piece not in group and len(group) < 3:
            group.append(piece)
        else:
            close()
            group = [piece]
        last = (page, dest)
    close()
    return out


def _entry(dest: str, landing: str, refs: list[dict]) -> dict | None:
    """The reference entry a citation lands on: by the entry's opening words, else by the bib key."""
    lines = [line for line in re.split(r"[\r\n]+", landing) if line.strip()]
    # The first line only: the band can reach into the next entry ("OpenAI. Gpt 5." is a whole entry).
    head = _norm(lines[0] if lines else "")[:_PREFIX]
    if len(head) >= 6:
        hits = [r for r in refs if _norm(r.get("text", "")).startswith(head)] or \
               [r for r in refs if head in _norm(r.get("text", ""))]
        # The same entry listed twice (parallel batches each wrote the list) is still one entry.
        if hits and len({_norm(r.get("text", "")) for r in hits}) == 1:
            return hits[0]
    m = re.match(r"cite\.([a-z]+)\D*?(\d{4})", dest, re.I)
    if m:
        surname, year = m.group(1).casefold(), m.group(2)
        hits = [r for r in refs if surname in _norm(r.get("text", ""))[:80] and year in r.get("text", "")]
        if len(hits) == 1:
            return hits[0]
    return None


def refresh(ws) -> bool:
    """Write `cites` onto the paper's reference entries; returns whether paper.json changed."""
    data = _raw(ws)
    if not data.get("links"):
        return False
    found = labels(data["links"])
    dests = data.get("dests", {})

    def apply(paper):
        refs = [r for r in paper.get("references") or [] if isinstance(r, dict)]
        # Links address entries by id ([n] and the popover too): an id shared by several entries is unusable.
        ids = Counter(str(r.get("id")) for r in refs)
        usable = [r for r in refs if ids[str(r.get("id"))] == 1]
        cites: dict[int, list[list[str]]] = {}
        for dest, groups in found.items():
            entry = _entry(dest, dests.get(dest, ""), usable)
            if entry is not None:
                bucket = cites.setdefault(id(entry), [])
                bucket.extend(g for g in groups if g not in bucket)
        changed = False
        for r in refs:
            want = cites.get(id(r))
            if (r.get("cites") or None) != want:
                if want:
                    r["cites"] = want
                else:
                    r.pop("cites", None)
                changed = True
        return changed

    # Check on a plain read first: paper.json is rewritten (and the open page reloads) only when cites change.
    if not apply(ws.load("paper") or {}):
        return False
    ws.update("paper", apply)
    return True
