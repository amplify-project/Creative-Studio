"""
Hysteresis for per-window classifier output.

The analyser emits one reading per ~960 ms window and single windows flicker.
These decide when a new reading is believed. Kept out of plugins/ (where every
*.py is loaded as a plugin) and away from the LiveKit imports, so they can be
tested on their own.
"""


class StickyHold:
    """Adopts the first candidate immediately; after that, a different
    candidate only becomes the reported value once it has appeared for
    `hold` consecutive updates in a row. Used for fields that always need a
    defined value (content type, distortion on/off)."""

    def __init__(self, hold: int, initial=None):
        self.hold = hold
        self.value = initial
        self._candidate = initial
        self._streak = 0

    def update(self, candidate):
        if candidate == self._candidate:
            self._streak += 1
        else:
            self._candidate = candidate
            self._streak = 1
        if self.value is None or self._streak >= self.hold:
            self.value = self._candidate
        return self.value


class ConfirmedHold:
    """Only reports a candidate (including "no candidate") once it has held
    for `hold` consecutive updates. Unlike StickyHold, "nothing detected" is
    a normal steady state here rather than a placeholder to escape on the
    first observation - used for the distortion-type suggestion, which
    should stay empty until the same type has actually been consistent."""

    def __init__(self, hold: int):
        self.hold = hold
        self.value = None
        self._candidate = None
        self._streak = 0
        self._confidences: list[float] = []

    def update(self, candidate, confidence: float = 0.0):
        if candidate == self._candidate:
            self._streak += 1
            self._confidences.append(confidence)
        else:
            self._candidate = candidate
            self._streak = 1
            self._confidences = [confidence]
        if self._streak >= self.hold:
            self.value = candidate
        return self.as_dict()

    def as_dict(self):
        if self.value is None:
            return None
        avg_confidence = sum(self._confidences) / len(self._confidences)
        return {"type": self.value, "confidence": round(avg_confidence, 4)}
