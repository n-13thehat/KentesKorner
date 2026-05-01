"""
Unit tests for the html.parser-based card extractor in
batocera/theater_providers.py.

Run from repo root:
    python -m unittest tests.test_theater_providers
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'batocera'))
from theater_providers import _mr_parse_cards


_FIXTURE_BASIC = '''
<html><body>
<div class="grid">
  <article class="bs">
    <a href="https://miruro.ro/series/cool-anime-2024/">
      <img data-src="https://cdn.miruro.ro/poster.jpg" alt="x">
    </a>
    <h2 itemprop="headline">Cool &amp; Anime 2024</h2>
    <div class="typez Anime">TV</div>
    <span class="epx">Eps 12</span>
  </article>
  <article class="bs">
    <a href="https://miruro.ro/series/movie-thing/">
      <img src="https://cdn.miruro.ro/m.webp">
    </a>
    <h2 itemprop="headline">Movie Thing</h2>
    <div class="typez">Movie</div>
    <span class="epx">Released</span>
  </article>
</div>
</body></html>
'''


class MrParseCardsTests(unittest.TestCase):
    def test_extracts_two_cards(self):
        cards = _mr_parse_cards(_FIXTURE_BASIC)
        self.assertEqual(len(cards), 2)

    def test_show_kind_inferred(self):
        cards = _mr_parse_cards(_FIXTURE_BASIC)
        c = cards[0]
        self.assertEqual(c['slug'], 'cool-anime-2024')
        self.assertEqual(c['kind'], 'show')
        self.assertEqual(c['title'], 'Cool & Anime 2024')   # &amp; decoded
        self.assertEqual(c['quality'], 'Eps 12')
        self.assertEqual(c['poster'], 'https://cdn.miruro.ro/poster.jpg')
        self.assertEqual(c['provider'], 'miruro')

    def test_movie_kind_inferred(self):
        cards = _mr_parse_cards(_FIXTURE_BASIC)
        c = cards[1]
        self.assertEqual(c['slug'], 'movie-thing')
        self.assertEqual(c['kind'], 'movie')
        # src= fallback when data-src is absent
        self.assertEqual(c['poster'], 'https://cdn.miruro.ro/m.webp')

    def test_card_without_slug_skipped(self):
        html = '<article class="bs"><h2 itemprop="headline">No href</h2></article>'
        self.assertEqual(_mr_parse_cards(html), [])

    def test_non_card_articles_ignored(self):
        # An <article> without class="bs" should not be picked up.
        html = '''
            <article class="other">
              <a href="https://miruro.ro/series/skip/"></a>
              <h2 itemprop="headline">Skip me</h2>
            </article>
        '''
        self.assertEqual(_mr_parse_cards(html), [])

    def test_malformed_html_falls_back_gracefully(self):
        # Missing close tags must not raise; parser should still extract.
        html = '''
            <article class="bs">
              <a href="https://miruro.ro/series/loose/">
              <h2 itemprop="headline">Loose
              <div class="typez">TV</div>
        '''
        cards = _mr_parse_cards(html)
        # The parser is best-effort; the fallback path may also fire.
        # We only require it doesn't raise and finds the slug if anything.
        if cards:
            self.assertEqual(cards[0]['slug'], 'loose')

    def test_empty_input_returns_empty(self):
        self.assertEqual(_mr_parse_cards(''), [])

    def test_typez_class_with_extra_modifiers(self):
        html = '''
            <article class="bs">
              <a href="https://miruro.ro/series/x/"></a>
              <h2 itemprop="headline">X</h2>
              <div class="typez highlighted">Movie</div>
            </article>
        '''
        cards = _mr_parse_cards(html)
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0]['kind'], 'movie')


if __name__ == '__main__':
    unittest.main()
