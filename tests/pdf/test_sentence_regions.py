import tempfile
import unittest
from itertools import product
from pathlib import Path

from easyread.library.store import write_json_atomic
from easyread.pdf import pdfwork
from easyread.pdf.text_regions import locate_prose, utf16_to_index
from easyread.translate import sentences


def glyphs(text, x, y, per_line=40, advance=.01):
    """Printed glyphs wrapped every `per_line` characters, each one `advance` wide."""
    return [[ch, round(x + i % per_line * advance, 4), round(y + i // per_line * .02, 4),
             round(x + (i % per_line + .9) * advance, 4), round(y + i // per_line * .02 + .014, 4)]
            for i, ch in enumerate(text)]


def stream(chars):
    """The page stream locate_prose reads: only letters and digits are searchable text."""
    text, idx = [], []
    for i, glyph in enumerate(chars):
        if glyph[0].isascii() and glyph[0].isalnum():
            text.append(glyph[0].lower())
            idx.append(i)
    return "".join(text), idx, chars


def words(n, start=0):
    unique = ("".join(w) + "q" for w in product("abcdefghij", repeat=3))
    return [w for i, w in enumerate(unique) if start <= i < start + n]


def sents_of(english, *pieces):
    ends, at = [], 0
    for piece in pieces:
        at = english.index(piece, at) + len(piece)
        ends.append(at)
    return [("p", 0, ends)]


class SentenceRegionsTest(unittest.TestCase):
    def test_sentences_are_outlined_line_by_line(self):
        first = "The first sentence is short and ends early."
        second = "The second sentence runs on for much longer than the first one does, so it wraps."
        third = "A third sentence closes the paragraph neatly."
        english = f"{first} {second} {third}"
        loc = locate_prose(english, 1, {1: stream(glyphs(english, .08, .10))}.get,
                           sents_of(english, first, second, third))
        rows = loc["sents"]["p"]
        self.assertEqual(len(rows), 3)
        # The first sentence fills line one and spills a few glyphs onto line two.
        self.assertEqual([round(r["box"][1], 2) for r in rows[0]], [.10, .12])
        # The second starts mid-line, so it cannot merge with the full line below it.
        self.assertEqual([round(r["box"][1], 2) for r in rows[1]], [.12, .14, .16])
        self.assertGreater(rows[1][0]["box"][0], .08)
        self.assertEqual(rows[1][1]["box"][0], .08)
        self.assertTrue(all(r["page"] == 1 for row in rows for r in row))
        # Sentences never overlap their neighbours' text.
        self.assertLessEqual(rows[0][-1]["box"][2], rows[1][0]["box"][2])

    def test_full_measure_lines_of_one_sentence_merge(self):
        english = " ".join(words(32)) + "."
        loc = locate_prose(english, 1, {1: stream(glyphs(english, .10, .10))}.get, sents_of(english, english))
        (row,) = loc["sents"]["p"]
        self.assertEqual(len(row), 1)
        self.assertAlmostEqual(row[0]["box"][1], .10)
        self.assertAlmostEqual(row[0]["box"][3], .174)

    def test_inline_math_stays_inside_its_sentence_but_a_footnote_does_not(self):
        english = "Let the value of the loop counter be $x_i$ whenever we reach the end of the whole process."
        before, after = "Let the value of the loop counter be ", " whenever we reach the end of the whole process."
        for hole, boxes in (("ABCDEFGHIJ", 1), ("ABCDEFGHIJ" * 4, 2)):
            with self.subTest(hole=len(hole)):
                page = stream(glyphs(before + hole + after, .02, .30, per_line=200))
                loc = locate_prose(english, 1, {1: page}.get, sents_of(english, english))
                self.assertEqual(len(loc["sents"]["p"][0]), boxes)

    def test_formula_that_ends_a_sentence_belongs_to_it(self):
        english = ("This first sentence has quite a few words and ends with a formula $y$. "
                   "The second sentence follows right after that one.")
        printed = ("This first sentence has quite a few words and ends with a formula " + "YY"
                   + ". The second sentence follows right after that one.")
        chars = glyphs(printed, .02, .30, per_line=200)
        formula_right = max(g[3] for g in chars if g[0] == "Y")
        first, second = locate_prose(english, 1, {1: stream(chars)}.get,
                                     sents_of(english, "formula $y$.", "that one."))["sents"]["p"]
        self.assertGreaterEqual(first[-1]["box"][2], formula_right)
        self.assertGreater(second[0]["box"][0], formula_right)

    def test_unmatched_sentence_is_none_instead_of_a_guess(self):
        printed = "A paragraph whose first sentence is long enough to be matched against the printed page text."
        english = printed + " This one is absent."
        rows = locate_prose(english, 1, {1: stream(glyphs(printed, .08, .10))}.get,
                            sents_of(english, printed, "is absent."))["sents"]["p"]
        self.assertTrue(rows[0])
        self.assertIsNone(rows[1])

    def test_without_sentences_the_location_is_unchanged(self):
        english = "A paragraph that has no sentence alignment still gets its ordinary box."
        loc = locate_prose(english, 1, {1: stream(glyphs(english, .08, .10))}.get)
        self.assertNotIn("sents", loc)
        self.assertEqual(loc["src"], "text")

    def test_utf16_offsets_become_python_indices(self):
        text = "a𝑥b"  # 𝑥 is one Python character but two UTF-16 units
        self.assertEqual(utf16_to_index(text, [1, 3, 4]), [1, 2, 3])
        self.assertIsNone(utf16_to_index(text, [2]))
        self.assertEqual(utf16_to_index("", [0]), [0])


class SentenceSpansTest(unittest.TestCase):
    def test_paragraph_and_list_items_use_the_readers_keys(self):
        para = {"id": "p1", "type": "para", "en": "Value 𝑥 holds.‖ Next one follows.", "zh": "值成立。‖ 下一个。"}
        lst = {"id": "l1", "type": "list", "items": [
            {"en": "Plain item.", "zh": "普通条目。"},
            {"en": "First half.‖ Second half.", "zh": "前半。‖ 后半。"}]}
        sentences.attach([para, lst])
        (key, start, ends), = pdfwork.sentence_spans(para)
        self.assertEqual((key, start), ("p1", 0))
        self.assertEqual(ends, [len("Value 𝑥 holds."), len(para["en"])])  # Python indices, not UTF-16 units
        (key, start, ends), = pdfwork.sentence_spans(lst)
        self.assertEqual(key, "l1#1")
        self.assertEqual(start, len("Plain item.") + 1)  # block_english joins the items with a space
        self.assertEqual(ends, [start + len("First half."), start + len(lst["items"][1]["en"])])

    def test_alignment_the_reader_would_not_use_is_skipped(self):
        para = {"id": "p1", "type": "para", "en": "One sentence.‖ Another.", "zh": "一句。‖ 另一句。"}
        sentences.attach([para])
        para["zh"] += "（已改）"  # an edited translation drops the alignment, as in the reader
        self.assertEqual(pdfwork.sentence_spans(para), [])
        self.assertEqual(pdfwork.sentence_spans({"id": "h", "type": "heading", "en": "Intro", "zh": "引言"}), [])


class LocateSentencesTest(unittest.TestCase):
    def test_layout_carries_sentence_regions_next_to_the_paragraph(self):
        first, second = "The opening sentence is printed first.", "The closing sentence is printed after it."
        block = {"id": "p1", "page": 1, "type": "para", "en": f"{first}‖ {second}", "zh": "开头句。‖ 结尾句。"}
        plain = {"id": "p2", "page": 1, "type": "para",
                 "en": "A separate paragraph without any sentence alignment on the page."}
        sentences.attach([block])
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "extract").mkdir()
            write_json_atomic(root / "paper.json", {"blocks": [block, plain]})
            write_json_atomic(root / "extract/page-001.chars.json",
                              glyphs(block["en"], .08, .10) + glyphs(plain["en"], .08, .50))
            layout = pdfwork.locate(root)
        rows = layout["p1"]["sents"]["p1"]
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(rows))
        self.assertNotIn("sents", layout["p2"])


if __name__ == "__main__":
    unittest.main()
