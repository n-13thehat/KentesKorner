import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'batocera'))
import rom_providers as providers


class GameMatchingTests(unittest.TestCase):
    def test_sequel_numbers_are_required_and_accept_roman_numerals(self):
        for filename, title, expected in (
            ('Tony Hawk S Pro Skater 4.7z', "Tony Hawk's Pro Skater 2", False),
            ('Tony Hawk S Pro Skater 4 (Disc 2).7z', "Tony Hawk's Pro Skater 2", False),
            ('Tony Hawk S Pro Skater 2 (USA).zip', "Tony Hawk's Pro Skater 2", True),
            ('God of War III [SLUS-20002].iso', 'God of War II', False),
            ('God of War 2 (USA).iso', 'God of War II', True),
            ('Final Fantasy 7 (Disc 1).bin', 'Final Fantasy VII', True),
        ):
            with self.subTest(filename=filename):
                self.assertEqual(providers.title_matches(filename, title), expected)

    def test_archive_picker_rejects_other_sequels(self):
        wrong = {'name': 'Tony Hawk S Pro Skater 4.7z', 'size': 400000000}
        correct = {'name': 'Tony Hawk S Pro Skater 2.zip', 'size': 300000000}
        title = "Tony Hawk's Pro Skater 2"
        self.assertIsNone(providers._archive_pick_file([wrong], 'ps1', title))
        self.assertEqual(providers._archive_pick_file([wrong, correct], 'ps1', title)['name'], correct['name'])

    def test_provider_merge_cannot_return_the_wrong_sequel(self):
        candidates = [{'filename': f'Tony Hawk S Pro Skater {n}.zip', 'provider': 'fixture',
                       'url': f'https://example.org/{n}.zip'} for n in (2, 4)]
        with mock.patch.dict(providers.PROVIDERS, {'fixture': {'search': lambda *_: candidates}}, clear=True):
            result = providers.fan_out_search('ps1', "Tony Hawk's Pro Skater 2", providers=['fixture'])
        self.assertEqual([item['filename'] for item in result], ['Tony Hawk S Pro Skater 2.zip'])


if __name__ == '__main__':
    unittest.main()
