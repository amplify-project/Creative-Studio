"""The contract between the analyser and its models, and the clipping-only
decision the analyser applies outside speech.

The distortion bundle (audioAnalysis/distortion/) is rebuilt in a separate
training repo and dropped in as a whole. If the code and a model disagree on
the class order, the analyser silently reads the wrong class, so that is
checked here. None of this needs YAMNet (fetched, not in git).
"""
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
import pytest

from audioAnalysis import audio_classifiers as ac
from audioAnalysis.distortion.distortion_detector import DistortionDetector

BUNDLE = Path(ac.DISTORTION_BUNDLE_DIR)
CFG = json.loads((BUNDLE / "detector_config.json").read_text())
SR = ac.TARGET_RATE
N = int(SR * ac.WINDOW_SEC)
t = np.arange(N) / SR


@pytest.fixture(scope="module")
def det():
    return DistortionDetector(str(BUNDLE), hop_s=ac.WINDOW_SEC)


def probs(clean, clip, bass=0.0, lofi=0.0):
    return np.array([clean, clip, bass, lofi], dtype=np.float32)


# ── contract with the models ────────────────────────────────────────────────

def test_content_model_outputs_one_score_per_class_we_name():
    out = ort.InferenceSession(str(ac.CONTENT_MODEL_PATH)).get_outputs()[0].shape[1]
    assert out == len(ac.CONTENT_CLASSES)


def test_bundle_classes_are_the_ones_the_analyser_names():
    assert CFG["classes"] == ac.DISTORTION_CLASSES


def test_bundle_has_a_threshold_for_the_analysers_hop():
    assert f"{ac.WINDOW_SEC:.2f}" in CFG["tau"]


def test_bundle_window_is_the_analysers_window():
    assert CFG["window_samples"] == N and CFG["sample_rate"] == SR


def test_model_returns_what_the_decision_layer_reads(det):
    out = det.run_model(np.zeros((1, N), dtype=np.float32))
    assert out["probs"].shape == (1, len(ac.DISTORTION_CLASSES))
    for key in ("clip_tail", "bandwidth_hz", "rms_dbfs"):
        assert out[key].shape == (1,)


# ── the model on a signal whose answer is not in doubt ──────────────────────

def chord(level):
    return sum(np.sin(2 * np.pi * f * t) for f in (220, 277, 329, 440)) * level / 4


def test_hard_clipping_raises_clip_tail(det):
    clean = det.run_model(chord(0.3)[None, :].astype(np.float32))
    clipped = det.run_model(np.clip(chord(0.3) * 8, -1, 1)[None, :].astype(np.float32))
    assert clipped["clip_tail"][0] > clean["clip_tail"][0]
    assert clipped["clip_tail"][0] >= CFG["clip_tail_min"]


# ── ClippingOnlyDecision ────────────────────────────────────────────────────

@pytest.fixture
def music():
    return ac.ClippingOnlyDecision(CFG, tau=0.7)


def feed(dec, p, tail, n):
    return [dec.update(p, tail) for _ in range(n)]


def test_needs_k_of_n_windows_before_alarming(music):
    alarms = feed(music, probs(0.1, 0.9), tail=0.5, n=CFG["smooth_k"])
    assert alarms == [False] * (CFG["smooth_k"] - 1) + [True]


def test_clip_tail_veto_holds_in_music(music):
    # Loud bright music fools the model; the waveform check does not.
    assert not any(feed(music, probs(0.1, 0.9), tail=CFG["clip_tail_min"] - 0.1, n=10))


def test_bass_and_low_fidelity_never_alarm_in_music(music):
    # Both false-alarmed on clean music in the 2026-11-02 measurement.
    assert not any(feed(music, probs(0.05, 0.05, bass=0.9), tail=0.5, n=10))
    assert not any(feed(music, probs(0.05, 0.05, lofi=0.9), tail=0.5, n=10))


def test_clipping_must_be_the_top_distorted_class(music):
    assert not any(feed(music, probs(0.1, 0.4, bass=0.5), tail=0.5, n=10))


def test_below_tau_is_clean(music):
    assert not any(feed(music, probs(0.4, 0.6), tail=0.5, n=10))


def test_reset_clears_the_history(music):
    feed(music, probs(0.1, 0.9), tail=0.5, n=CFG["smooth_k"] - 1)
    music.reset()
    assert not music.update(probs(0.1, 0.9), 0.5)
