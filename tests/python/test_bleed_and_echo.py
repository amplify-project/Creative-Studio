"""scripts/p2g_bleed.py and the echo test in scripts/p2g_dtw_align.py.

Synthetic signals only, so it runs without the benchmark data. The numbers the
thresholds were set from are in docs/llm/12-dtw-alignment.md ("The echo test")
and come from scripts/p2g_real_bench.py on real recordings."""
import importlib.util
import json
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]


def _load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


pb = _load("p2g_bleed")
SR = pb.SR
rng = np.random.default_rng(7)


def _notes(seconds, seed, timbre=None):
    """A sparse train of decaying noise bursts — onsets, no fixed pitch. The
    TIMING comes from `seed`; the waveform of each burst from `timbre`, so two
    calls with the same seed and different timbres are two instruments playing
    the same rhythm — related, but never a copy of each other."""
    r = np.random.default_rng(seed)
    w = np.random.default_rng(seed if timbre is None else 1000 + timbre)
    y = np.zeros(int(seconds * SR))
    t = 0.2
    while t < seconds - 0.5:
        n = int(0.25 * SR)
        i = int(t * SR)
        y[i:i + n] += w.standard_normal(n) * np.exp(-np.arange(n) / (0.05 * SR))
        t += r.uniform(0.2, 0.6)
    return y


def _delay(y, ms):
    d = int(round(ms * SR / 1000))
    return np.concatenate([np.zeros(d), y])[:len(y)]


def _detect(ref, take):
    lags, cc = pb.gcc_phat(ref, take, *pb.SEARCH_MS)
    lag, psr = pb.peak(lags, cc)
    return lag, psr, pb.uniqueness(lags, cc)


def test_bleed_is_found_to_the_millisecond():
    ref = _notes(40, 1)
    player = _notes(40, 2)                      # an unrelated part
    take = _delay(player, 130) + 0.3 * _delay(ref, 60)
    lag, psr, uniq = _detect(ref, take)
    assert abs(lag - 60) < 0.2
    assert psr >= pb.PSR_MIN and uniq >= pb.UNIQ_MIN


def test_no_bleed_is_not_reported():
    ref, take = _notes(40, 3), _delay(_notes(40, 4), 130)
    _, psr, uniq = _detect(ref, take)
    assert not (psr >= pb.PSR_MIN and uniq >= pb.UNIQ_MIN)


def test_mains_hum_is_a_comb_not_a_needle():
    # The same stationary hum in both files gives equal peaks every period —
    # the "bleed at 0 ms" seen on clean choir takes. Uniqueness rejects it.
    t = np.arange(40 * SR) / SR
    hum = sum(np.sin(2 * np.pi * 100 * k * t) / k for k in range(2, 12))
    ref = hum + 0.05 * rng.standard_normal(len(t))
    take = hum + 0.05 * rng.standard_normal(len(t))
    _, _, uniq = _detect(ref, take)
    assert uniq < pb.UNIQ_MIN


def test_subtraction_removes_a_pure_bleed():
    ref = _notes(40, 5)
    take = 0.5 * _delay(ref, 60)
    clean, _ = pb.fit_and_subtract(ref, take, 60.0)
    assert pb.db(take) - pb.db(clean) > 25


def test_subtraction_leaves_the_player():
    ref, player = _notes(40, 6), _delay(_notes(40, 8), 130)
    take = player + 0.5 * _delay(ref, 60)
    clean, _ = pb.fit_and_subtract(ref, take, 60.0)
    resid = clean - player
    assert pb.db(player) - pb.db(resid) > 20      # bleed gone, player intact


def _write(path, y):
    y = y / max(1.0, float(np.max(np.abs(y))) / 0.9)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((y * 32767).astype(np.int16).tobytes())


@pytest.mark.skipif(subprocess.run(["which", "ffmpeg"], capture_output=True).returncode != 0,
                    reason="no ffmpeg")
# Bleed where a real one lands — a few ms from the player, both at the device
# round trip — and one far from it. The first version of the aligner refused
# answers near the bleed; on the first real session that refused right answers.
@pytest.mark.parametrize("bleed", [None, 125.0, 60.0])
def test_aligner_measures_and_says_so(tmp_path, bleed):
    ref = _notes(30, 9)
    # Same rhythm, another instrument, 130 ms late. NOT a copy of the reference:
    # an exact copy is indistinguishable from bleed and is removed as such —
    # which is also what would happen to a ?p2gtest track that is literally a
    # part of the reference file.
    take = _delay(_notes(30, 9, timbre=1), 130)
    if bleed is not None:
        take = take + 0.5 * _delay(ref, bleed)
    _write(tmp_path / "ref.wav", ref)
    _write(tmp_path / "take.wav", take)
    out = subprocess.run([sys.executable, str(ROOT / "scripts" / "p2g_dtw_align.py"),
                          str(tmp_path / "ref.wav"), str(tmp_path / "take.wav"),
                          "--expect", "120", "--band", "0.25"],
                         capture_output=True, text=True).stdout
    r = json.loads(out)
    assert r["ok"], r
    assert r["verdict"] == "measured", r
    assert abs(r["lagMs"] - 130) <= 12
    assert abs(r["echo"]) <= 0.2
    assert (r["bleed"] is not None) == (bleed is not None)
    if bleed is not None:
        assert abs(r["bleed"]["lagMs"] - bleed) < 0.5
        assert r["centreFrom"] == "bleed"
