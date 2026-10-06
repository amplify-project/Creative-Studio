"""The audio analyser's DSP features, and the contract between this code and the
two classifier models trained for this project (both in git, no download).

The contract tests exist because the models are retrained outside this code:
on 2026-07-22 the distortion model went from 5 classes to 4 and from 9 DSP
features to 8. If the code and a model disagree, the analyser either crashes on
the first window or silently reads the wrong class.
"""
from pathlib import Path

import numpy as np
import onnxruntime as ort
import pytest

from audioAnalysis import audio_classifiers as ac

MODELS = Path(ac.__file__).parent
SR = ac.TARGET_RATE
N = int(SR * ac.WINDOW_SEC)
t = np.arange(N) / SR


def features(x):
    return dict(zip(
        ["crest", "clip_ratio", "flatness", "hf", "lf", "mid", "centroid", "level"],
        ac.extract_dsp_features(x.astype(np.float32)),
    ))


# ── contract with the models ─────────────────────────────────────────────────

def test_distortion_model_takes_the_dac_embedding_plus_our_dsp_features():
    inp = ort.InferenceSession(str(MODELS / "distortion_mlp.onnx")).get_inputs()[0].shape[1]
    dsp = len(ac.extract_dsp_features(np.zeros(N, dtype=np.float32)))
    assert inp == 1024 + dsp


def test_distortion_model_outputs_one_score_per_class_we_name():
    out = ort.InferenceSession(str(MODELS / "distortion_mlp.onnx")).get_outputs()[0].shape[1]
    assert out == len(ac.DISTORTION_CLASSES)


def test_content_model_outputs_one_score_per_class_we_name():
    out = ort.InferenceSession(str(MODELS / "content_mlp.onnx")).get_outputs()[0].shape[1]
    assert out == len(ac.CONTENT_CLASSES)


# ── the features ─────────────────────────────────────────────────────────────

def test_clipping_shows_in_clip_ratio_and_crest_factor():
    clean = 0.3 * np.sin(2 * np.pi * 440 * t)
    clipped = np.clip(6 * clean, -1, 1)
    c, k = features(clean), features(clipped)
    assert k["clip_ratio"] > 3 * c["clip_ratio"]
    assert k["crest"] < c["crest"]


def test_low_hum_is_low_frequency_energy():
    # Mains hum is what made a silent room read as bass_boost.
    assert features(0.1 * np.sin(2 * np.pi * 60 * t))["lf"] > 0.9


def test_a_high_tone_is_high_frequency_energy():
    assert features(0.1 * np.sin(2 * np.pi * 6000 * t))["hf"] > 0.9


def test_level_spans_minus_60_to_0_dbfs():
    quiet = 10 ** (-70 / 20) * np.sqrt(2) * np.sin(2 * np.pi * 440 * t)
    loud = np.sin(2 * np.pi * 440 * t)
    assert features(quiet)["level"] == pytest.approx(0.0)
    assert features(loud)["level"] > 0.9


def test_digital_silence_gives_finite_features():
    assert np.all(np.isfinite(ac.extract_dsp_features(np.zeros(N, dtype=np.float32))))
