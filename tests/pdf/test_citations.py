import tempfile
import unittest
from pathlib import Path

from pypdf import PdfWriter
from pypdf.generic import (ArrayObject, DecodedStreamObject, DictionaryObject, FloatObject, NameObject,
                           TextStringObject)
from pypdf.generic import Fit

from easyread.library.store import Workspace, write_json_atomic
from easyread.pdf import citations

# Courier 12pt: every character is 7.2pt wide, so link rectangles can be placed on exact words.
W = 7.2
CITING = "as shown (Harding and Kloster, 2025) before"


def make_pdf(path: Path) -> None:
    writer = PdfWriter()
    font = writer._add_object(DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"),
                                                NameObject("/BaseFont"): NameObject("/Courier")}))
    for text in (b"BT /F1 12 Tf 40 150 Td (" + CITING.encode() + b") Tj ET",
                 # Two-column reference list: the cited entry starts in the right column, beside another entry.
                 b"BT /F1 12 Tf 40 700 Td (Ann Other. 2019. Left column entry.) Tj ET "
                 b"BT /F1 12 Tf 320 700 Td (Paul Harding and Kai Kloster. 2025.) Tj ET "
                 b"BT /F1 12 Tf 320 686 Td (Copilot study.) Tj ET"):
        page = writer.add_blank_page(width=600, height=800)
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
        content = DecodedStreamObject()
        content.set_data(text)
        page[NameObject("/Contents")] = writer._add_object(content)
    writer.add_named_destination("cite.harding2025copilot", 1, Fit.xyz(left=318, top=712))

    def link(start, length):  # hyperref splits "Harding and Kloster," and "2025)" into two links
        x0 = 40 + start * W
        return writer._add_object(DictionaryObject({
            NameObject("/Type"): NameObject("/Annot"), NameObject("/Subtype"): NameObject("/Link"),
            NameObject("/Rect"): ArrayObject([FloatObject(x0), FloatObject(147), FloatObject(x0 + length * W), FloatObject(161)]),
            NameObject("/Dest"): TextStringObject("cite.harding2025copilot")}))
    writer.pages[0][NameObject("/Annots")] = ArrayObject([link(CITING.index("Harding"), 20), link(CITING.index("2025"), 5)])
    with path.open("wb") as out:
        writer.write(out)


class CitationsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.ws = Workspace(self.root)
        make_pdf(self.root / "source.pdf")
        self.refs = [{"id": "1", "text": "Ann Other. 2019. Left column entry."},
                     {"id": "2", "text": "Paul Harding and Kai Kloster. 2025. Copilot study."}]
        write_json_atomic(self.root / "paper.json", {"blocks": [], "references": self.refs})

    def test_cite_links_attach_their_labels_to_the_entry_they_land_on(self):
        self.assertTrue(citations.refresh(self.ws))
        refs = self.ws.load("paper")["references"]
        self.assertNotIn("cites", refs[0])  # the left column entry beside the destination
        self.assertEqual(refs[1]["cites"], [["Harding and Kloster", "2025"]])
        # Unchanged: paper.json is not rewritten, so an open reader does not reload.
        stamp = (self.root / "paper.json").stat().st_mtime_ns
        self.assertFalse(citations.refresh(self.ws))
        self.assertEqual((self.root / "paper.json").stat().st_mtime_ns, stamp)

    def test_entries_that_cannot_be_addressed_by_id_are_skipped(self):
        dup = {"id": "2", "text": "Someone Else. 2020. Different."}
        write_json_atomic(self.root / "paper.json", {"blocks": [], "references": [*self.refs, dup]})
        self.assertFalse(citations.refresh(self.ws))
        # The same entry listed twice under different ids still matches once.
        write_json_atomic(self.root / "paper.json", {"blocks": [], "references": [*self.refs, {**self.refs[1], "id": "2b"}]})
        self.assertTrue(citations.refresh(self.ws))
        self.assertEqual(self.ws.load("paper")["references"][1]["cites"], [["Harding and Kloster", "2025"]])

    def test_labels_join_split_and_hyphenated_pieces_and_drop_bare_years(self):
        links = [[1, "cite.a", "(Khand\x02"], [1, "cite.a", "pur,"], [1, "cite.a", "2025)"],
                 [1, "cite.b", "(2026)"],
                 [1, "cite.a", "(Khandpur,"], [1, "cite.a", "2025)"], [2, "cite.a", "Khandpur"], [2, "cite.a", "Khandpur"]]
        self.assertEqual(citations.labels(links), {"cite.a": [["Khandpur", "2025"], ["Khandpur"]]})


if __name__ == "__main__":
    unittest.main()
