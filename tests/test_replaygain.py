import unittest
from pathlib import Path

from replaygain import extract_replaygain_from_file


class ReplayGainExtractionTest(unittest.TestCase):
    def test_extracts_tags_from_fixture(self):
        path = Path(__file__).parent / 'fixtures' / 'replaygain-loud.flac'
        tags = extract_replaygain_from_file(path)
        self.assertAlmostEqual(tags['replaygain_track_db'], -6.5, places=1)
        self.assertIn('replaygain_album_db', tags)


if __name__ == '__main__':
    unittest.main()
