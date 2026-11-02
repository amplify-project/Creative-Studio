"""Reference runtime for the distortion detector bundle — the complete algorithm.

Standalone: needs only numpy and onnxruntime (no training code). It is the
specification the C++ port (distortion_decision.hpp) must match; the bundle's
test_vectors/ were produced by this file.

    from distortion_detector import DistortionDetector
    det = DistortionDetector("path/to/bundle")          # hop from detector_config.json
    for d in det.process(audio_16k_mono_float32):      # call repeatedly as audio arrives
        if d.alarm:
            print(d.time_s, d.alarm_label)

Per window (960 ms of 16 kHz mono, every hop):
  1. distortion_detector.onnx: audio (1, 15360) → probs (clean, clipping,
     bass_boost, low_fidelity), clip_tail, bandwidth_hz, rms_dbfs
  2. narrowband tracker: widest bandwidth over the last bw_history_s of
     windows with signal (rms_dbfs > active_dbfs: loud enough to measure, not
     a speech detector); narrowband if that is <= bw_narrow_hz and
     >= bw_min_active of those windows had signal

Feed it speech only: the level gate can't tell speech from an instrument, so
the app gates on its content classifier before calling process().
  3. window class: distorted if 1 − P(clean) >= tau (top distorted class);
     a clipping call is vetoed if clip_tail < clip_tail_min; a clean window
     becomes low_fidelity if narrowband
  4. alarm: >= k of the last n windows distorted; reported class = the most
     frequent distorted class among them (ties → the most recent)
"""

import json
import os
from collections import Counter, deque
from dataclasses import dataclass

import numpy as np
import onnxruntime as ort


@dataclass
class Decision:
    time_s: float              # window start, seconds since the first sample
    probs: np.ndarray          # (4,) softmax: clean, clipping, bass_boost, low_fidelity
    clip_tail: float
    bandwidth_hz: float
    rms_dbfs: float
    narrowband: bool
    window_class: int          # 0 clean, 1 clipping, 2 bass_boost, 3 low_fidelity (this window alone)
    alarm: bool                # after k-of-n smoothing
    alarm_class: int           # 0 when no alarm
    alarm_label: str           # user-facing label, "" when no alarm


class DecisionLayer:
    """Steps 2–4: stateful, one call per window, in order."""

    def __init__(self, cfg: dict, hop_s: float):
        self.cfg = cfg
        self.tau = cfg["tau"][f"{hop_s:.2f}"]
        self.bw_hist = deque(maxlen=max(1, round(cfg["bw_history_s"] / hop_s)))
        self.cls_hist = deque(maxlen=cfg["smooth_n"])

    def reset(self):
        self.bw_hist.clear()
        self.cls_hist.clear()

    def update(self, probs, clip_tail, bandwidth_hz, rms_dbfs):
        c = self.cfg
        active = rms_dbfs > c["active_dbfs"]
        self.bw_hist.append(bandwidth_hz if active else None)
        seen = [b for b in self.bw_hist if b is not None]
        narrow = (active and len(seen) >= c["bw_min_active"] * self.bw_hist.maxlen
                  and max(seen) <= c["bw_narrow_hz"])

        cls = int(np.argmax(probs[1:])) + 1 if 1 - probs[0] >= self.tau else 0
        if cls == 1 and clip_tail < c["clip_tail_min"]:
            cls = 0
        if cls == 0 and narrow:
            cls = 3

        self.cls_hist.append(cls)
        hits = [x for x in self.cls_hist if x > 0]
        alarm = len(hits) >= c["smooth_k"]
        alarm_cls = 0
        if alarm:
            counts = Counter(hits)
            best = max(counts.values())
            alarm_cls = next(x for x in reversed(self.cls_hist) if x > 0 and counts[x] == best)
        return narrow, cls, alarm, alarm_cls


class DistortionDetector:
    def __init__(self, bundle_dir: str, hop_s: float | None = None, threads: int = 1):
        with open(os.path.join(bundle_dir, "detector_config.json")) as f:
            self.cfg = json.load(f)
        self.hop_s = hop_s or self.cfg["default_hop_s"]
        self.win = self.cfg["window_samples"]
        self.hop = int(round(self.hop_s * self.cfg["sample_rate"]))
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        self.sess = ort.InferenceSession(os.path.join(bundle_dir, self.cfg["model"]), so,
                                         providers=["CPUExecutionProvider"])
        self.decide = DecisionLayer(self.cfg, self.hop_s)
        self.reset()

    def reset(self):
        self.buf = np.zeros(0, np.float32)
        self.next_start = 0          # absolute sample index of the next window
        self.buf_start = 0           # absolute sample index of buf[0]
        self.decide.reset()

    def run_model(self, windows: np.ndarray) -> dict:
        """Step 1 for a batch of windows (N, 15360) → dict of arrays."""
        out = self.sess.run(None, {"audio": windows.astype(np.float32)})
        return dict(zip([o.name for o in self.sess.get_outputs()], out))

    def process(self, audio: np.ndarray) -> list[Decision]:
        """Feed 16 kHz mono float audio (any length); returns a Decision per completed window."""
        self.buf = np.concatenate([self.buf, np.asarray(audio, np.float32)])
        starts = []
        while self.next_start + self.win <= self.buf_start + len(self.buf):
            starts.append(self.next_start)
            self.next_start += self.hop
        decisions = []
        if starts:
            w = np.stack([self.buf[s - self.buf_start:s - self.buf_start + self.win] for s in starts])
            o = self.run_model(w)
            for i, s in enumerate(starts):
                p = o["probs"][i]
                narrow, cls, alarm, acls = self.decide.update(p, float(o["clip_tail"][i]),
                                                              float(o["bandwidth_hz"][i]), float(o["rms_dbfs"][i]))
                decisions.append(Decision(s / self.cfg["sample_rate"], p, float(o["clip_tail"][i]),
                                          float(o["bandwidth_hz"][i]), float(o["rms_dbfs"][i]), narrow, cls,
                                          alarm, acls, self.cfg["user_labels"][acls] if alarm else ""))
        drop = self.next_start - self.buf_start           # samples no future window needs
        if drop > 0:
            self.buf = self.buf[drop:]
            self.buf_start += drop
        return decisions
