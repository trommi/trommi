"""test_rules.py: rules.py on fixed layouts, no phone, no Xcode (python3 dev/ios-audit/test_rules.py).

The last case, known_trommi(), is the iPhone app as it stood on 8 October 2026 (main, 7f1099c plus the open work in
the tree), its frames taken from the code's own numbers and from the phone (iPhone Air, 420x912 pt): it must keep
finding the two overlaps that are real bugs there, so a fix shows up as this case going quiet.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rules  # noqa: E402

SCREEN = {'w': 420, 'h': 912, 'scale': 3}
SAFE = {'top': 62, 'bottom': 34, 'left': 0, 'right': 0}


def dump(*elements, **kw):
    return {'name': 't', 'screen': SCREEN, 'safe': SAFE, 'elements': list(elements), **kw}


def el(label, rect, **kw):
    return {'label': label, 'rect': rect, **kw}


def kinds(problems, severity=None):
    return sorted(p['rule'] for p in problems if severity is None or p['severity'] == severity)


class Rules(unittest.TestCase):
    def test_overlapping_buttons(self):
        p = rules.check(dump(el('A', [10, 300, 100, 50], interactive=True), el('B', [60, 320, 100, 50], interactive=True)))
        self.assertEqual(kinds(p, 'error'), ['overlap'])

    def test_touching_buttons_are_fine(self):
        p = rules.check(dump(el('A', [10, 300, 100, 50], interactive=True), el('B', [110, 300, 100, 50], interactive=True)))
        self.assertEqual(kinds(p), [])

    def test_nested_controls_are_a_note(self):
        p = rules.check(dump(el('Row', [0, 300, 420, 100], interactive=True), el('Inner', [10, 310, 60, 60], interactive=True)))
        self.assertEqual(kinds(p), ['nested-controls'])

    def test_small_targets(self):
        p = rules.check(dump(el('tag', [370, 300, 19, 38], interactive=True), el('ok', [10, 300, 44, 44], interactive=True),
                             el('flat', [100, 300, 150, 34], interactive=True)))
        self.assertEqual([(x['rule'], x['severity']) for x in p], [('small-target', 'error'), ('small-target', 'warn')])

    def test_under_the_status_bar_and_home_indicator(self):
        p = rules.check(dump(el('Close', [350, 10, 44, 44], interactive=True), el('hint', [10, 885, 200, 20], text=True)))
        self.assertEqual(kinds(p), ['safe-area', 'safe-area'])
        self.assertEqual([x['severity'] for x in p], ['error', 'warn'])

    def test_chrome_may_sit_in_the_insets(self):
        p = rules.check(dump(el('Tab', [100, 860, 68, 50], interactive=True, chrome=True)))
        self.assertNotIn('safe-area', kinds(p))

    def test_under_the_floating_bar(self):
        bar = el('glass: capsule', [99, 816, 222, 60], chrome=True)
        rest = rules.check(dump(bar, el('Got it', [214, 800, 175, 62], interactive=True)))
        end = rules.check(dump(bar, el('Got it', [214, 800, 175, 62], interactive=True, state='end')))
        self.assertEqual([(x['rule'], x['severity']) for x in rest], [('under-chrome', 'info')])
        self.assertEqual([(x['rule'], x['severity']) for x in end], [('under-chrome', 'error')])

    def test_text_over_text(self):
        p = rules.check(dump(el('Some things here need a newer Trommi', [39, 120, 341, 36], text=True), el('Claude', [72, 112, 120, 24], text=True)))
        self.assertEqual(kinds(p), ['text-over-text'])

    def test_voiceover_caption_without_label(self):
        p = rules.check(dump(focus=['Chat, Button', 'Button', ', Button, Selected']))
        self.assertEqual(kinds(p), ['no-label', 'no-label'])

    def test_apple_findings_pass_through_once(self):
        a = {'type': 'testTypeHitRegion', 'rect': [370, 219, 19, 38], 'info': 'Current size is 19 x 38'}
        p = rules.check(dump(apple=[a, dict(a)]))
        self.assertEqual([(x['rule'], x['severity']) for x in p], [('apple:HitRegion', 'warn')])

    def test_known_trommi(self):
        p = rules.check(known_trommi())
        errs = [x['text'] for x in p if x['severity'] == 'error']
        self.assertTrue(any('Selection' in t and 'Desk' in t for t in errs), errs)
        self.assertTrue(any('Later' in t for t in errs), errs)
        self.assertTrue(any(x['rule'] == 'text-over-text' and 'newer Trommi' in x['text'] for x in p))


class Build15(unittest.TestCase):
    """Two screenshots from the owner (build 15, iPhone 402x874 pt; image 1105 px wide: 2.75 px per pt)."""

    def test_keyboard_button_over_send(self):
        # the composer's keyboard-hide bubble lay on the send arrow (removed: the keyboard goes by a drag or a tap)
        p = rules.check({'name': 'chat-keyboard', 'screen': {'w': 402, 'h': 874, 'scale': 3}, 'safe': {'top': 62, 'bottom': 34, 'left': 0, 'right': 0},
                         'elements': [el('Send', [356, 484, 30, 28], interactive=True), el('Hide Keyboard', [337, 495, 45, 45], interactive=True, chrome=True)]})
        self.assertIn('overlap', kinds(p, 'error'))

    def test_rows_under_the_pen_and_the_tab_bar(self):
        # the history: the minimized tab bar (left) and the pen (right) float over rows and their times; scrolled to the
        # end they must clear them (the composer bar is a safeAreaBar now): the probe's end state names any that stay
        p = rules.check({'name': 'chat-history', 'screen': {'w': 402, 'h': 874, 'scale': 3}, 'safe': {'top': 62, 'bottom': 34, 'left': 0, 'right': 0},
                         'elements': [el('Write', [337, 737, 49, 48], interactive=True, chrome=True), el('glass: Chat tab', [27, 800, 45, 45], chrome=True),
                                      el('10:44', [358, 750, 30, 16], text=True, state='end'), el('What?? und Uno bündig unten rechts', [38, 803, 300, 22], text=True, state='end')]})
        self.assertIn('under-chrome', kinds(p))


def known_trommi():
    """The Desk on an iPhone Air with two cards chosen, the update line showing.

    BottomBar (Shell.swift): 3 items 68x50, spacing 4, padding 5, 2 pt above the bottom inset -> 222x60 at y 816
    (the phone's VoiceOver frame of "Chat": 99,816 72x54). SelectionBar (DeskScreen.swift, .overlay(alignment: .bottom)
    of the Desk, .padding(.bottom, 10), items minHeight 44 + 2x6): 56 tall, bottom at 912-34-10 -> y 812, the same
    place. UpdateBanner (Shell.swift, .overlay(alignment: .top), .padding(.top, 50) below the top inset): measured on
    the phone at 39,120 341x36, over the first row of Chats and the Desk's greeting (screenshot 16:25: it covers
    "Claude" and its message). Later tag: 19x38 (Apple's hit region).
    """
    return dump(
        el('glass: BottomBar', [99, 816, 222, 60], chrome=True),
        el('Chat', [104, 821, 68, 50], interactive=True, chrome=True),
        el('Desk', [176, 821, 68, 50], interactive=True, chrome=True),
        el('Note', [248, 821, 68, 50], interactive=True, chrome=True),
        el('SelectionBar: Later', [70, 818, 54, 44], interactive=True),
        el('SelectionBar: Duck it', [130, 818, 54, 44], interactive=True),
        el('SelectionBar: Shred', [190, 818, 54, 44], interactive=True),
        el('SelectionBar: Clear Selection', [300, 822, 36, 36], interactive=True),
        el('Some things here need a newer Trommi', [39, 120, 341, 36], text=True),
        el('Claude', [72, 112, 140, 24], text=True),
        el('Later: put this question off', [370, 219, 19, 38], interactive=True),
    )


if __name__ == '__main__':
    unittest.main(verbosity=1)
