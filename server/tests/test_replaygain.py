import unittest
from pathlib import Path
from unittest.mock import patch

import replaygain
from replaygain import extract_replaygain_from_file


class ReplayGainExtractionTest(unittest.TestCase):
    def test_extracts_tags_from_fixture(self):
        if replaygain.MutagenFile is None:
            self.skipTest('mutagen is not installed')
        path = Path(__file__).resolve().parents[2] / 'tests' / 'fixtures' / 'replaygain-loud.flac'
        tags = extract_replaygain_from_file(path, allowed_root=path.parent)
        self.assertAlmostEqual(tags['replaygain_track_db'], -6.5, places=1)
        self.assertIn('replaygain_album_db', tags)

    def test_ignores_files_outside_allowed_root(self):
        path = Path(__file__).resolve().parents[2] / 'tests' / 'fixtures' / 'replaygain-loud.flac'
        with patch('replaygain.MutagenFile') as mutagen_file:
            tags = extract_replaygain_from_file(path, allowed_root=path.parent / 'other')
        self.assertEqual(tags, {})
        mutagen_file.assert_not_called()


if __name__ == '__main__':
    unittest.main()
