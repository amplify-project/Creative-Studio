"""Hysteresis on the per-window classifier output: one odd window must not flip
what the panel and the suggestions report."""
from audioAnalysis.holds import ConfirmedHold, StickyHold


def test_sticky_adopts_the_first_value_at_once():
    h = StickyHold(3)
    assert h.update("speech") == "speech"


def test_sticky_ignores_a_single_odd_window():
    h = StickyHold(3)
    for c in ["speech", "speech", "music", "speech"]:
        value = h.update(c)
    assert value == "speech"


def test_sticky_switches_after_hold_consecutive_windows():
    h = StickyHold(3)
    h.update("speech")
    assert [h.update("music") for _ in range(3)] == ["speech", "speech", "music"]


def test_sticky_with_an_initial_value_needs_the_full_hold_to_leave_it():
    h = StickyHold(3, initial=False)
    assert [h.update(True) for _ in range(3)] == [False, False, True]


def test_confirmed_reports_nothing_until_held():
    h = ConfirmedHold(3)
    assert [h.update("clipping", 0.9) for _ in range(2)] == [None, None]
    assert h.update("clipping", 0.6) == {"type": "clipping", "confidence": 0.8}


def test_confirmed_a_broken_streak_starts_over():
    h = ConfirmedHold(3)
    for c in ["clipping", "clipping", None, "clipping", "clipping"]:
        result = h.update(c, 1.0)
    assert result is None


def test_confirmed_clears_only_once_nothing_has_held():
    h = ConfirmedHold(2)
    h.update("clipping", 1.0)
    h.update("clipping", 1.0)
    assert h.update(None) == {"type": "clipping", "confidence": 0.0}  # one clean window is not enough
    assert h.update(None) is None
