#!/usr/bin/env python3
"""Measure, without a musician in the loop, how late the click and the reference
actually reach the room.

Run BOTH rounds monitored on SPEAKERS so the mic records what the player would
have heard. Then:

  click_lag = when the metronome grid actually lands in the sync take
  ref_lag   = when the reference actually lands in a normal take

Both include the same speaker->air->mic path and the same input latency, so
their DIFFERENCE is the systematic bias between the two monitoring paths — the
quantity a sync round measures on one and the mixer then applies to the other.
Do not move the laptop or change the volume between the two rounds, or that
cancellation is lost.

  python3 scripts/p2g_monitor_latency.py <sessionDir> <syncFile> <takeFile>

e.g.  python3 scripts/p2g_monitor_latency.py /tmp/play2gether/<id> \
            sync_<id>.wav <participantId>.ogg

Requires numpy and ffmpeg. Reads nothing but the audio; changes nothing.

NOTE ON CROSS-CORRELATION. Doc 11 rejects it for ALIGNING MUSICIANS, and that
rejection stands: correlating different instruments playing expressively gives a
broad peak whose maximum is the average of a distribution. This is the opposite
problem — the same signal recorded back through a speaker and a mic — which is
what correlation is actually for. Do not read this script as reopening that.
"""
import subprocess, sys, os, json
import numpy as np

SR = 8000                      # 0.125 ms per sample; the mixer's finest step is 5 ms
SYNC_BPM = 80
SYNC_TOTAL_BEATS = 16
SYNC_WARMUP_BEATS = 4          # SYNC_WARMUP_BARS * 4, discarded like the detector does


def decode(path):
    p = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-acodec", "pcm_f32le",
         "-ac", "1", "-ar", str(SR), "-"],
        capture_output=True)
    if p.returncode != 0:
        sys.exit(f"ffmpeg failed on {path}:\n{p.stderr.decode()[:400]}")
    return np.frombuffer(p.stdout, dtype=np.float32).astype(np.float64)


def envelope(x, smooth_ms=5):
    n = max(1, int(SR * smooth_ms / 1000))
    e = np.convolve(np.abs(x), np.ones(n) / n, mode="same")
    return e


def click_lag_ms(sync_path):
    """Median offset of the recorded clicks from the ideal grid.

    The clicks are machine-perfect, so unlike a player there is no scatter to be
    robust against — but the median is kept anyway so one spurious peak (a chair,
    a cough) cannot move the answer.
    """
    x = decode(sync_path)
    e = envelope(x, smooth_ms=3)
    flux = np.maximum(0, np.diff(e))
    beat_ms = 60000.0 / SYNC_BPM

    # Search each beat's neighbourhood for its own strongest rise. +-half a beat
    # around the ideal position, which cannot alias because there is exactly one
    # click per beat and we already know the grid.
    half = int(SR * (beat_ms / 2) / 1000)
    devs = []
    for k in range(SYNC_WARMUP_BEATS, SYNC_TOTAL_BEATS):
        centre = int(SR * (k * beat_ms) / 1000)
        lo, hi = max(0, centre - half), min(len(flux), centre + half)
        if hi - lo < 10:
            continue
        peak = lo + int(np.argmax(flux[lo:hi]))
        devs.append((peak - centre) * 1000.0 / SR)
    if not devs:
        return None, None
    devs = np.array(devs)
    med = float(np.median(devs))
    mad = float(np.median(np.abs(devs - med)))
    return med, mad


def ref_lag_ms(take_path, ref_path, max_lag_ms=1500):
    """Lag of the recorded reference against the reference file, by NORMALISED
    envelope cross-correlation.

    Envelopes rather than waveforms because the room and the speaker wreck phase
    but leave the amplitude shape intact.

    Normalised because it must not be: a plain `valid` correlation is maximised
    wherever the take happens to be loudest, not where it matches, so on music
    with a big dynamic range it reports the chorus instead of the lag. Dividing
    by the sliding norm of the take removes that.

    The reference window is deliberately shortened by the search range so the
    correlation has somewhere to slide — with two equal-length signals `valid`
    returns exactly one value, which is silently always "lag 0".
    """
    a = envelope(decode(take_path))     # what the mic heard
    b = envelope(decode(ref_path))      # what was played
    L = int(SR * max_lag_ms / 1000)
    if len(a) < L + SR or len(b) < SR:
        return None, None

    m = min(len(b), len(a) - L)         # reference window that can slide over `a`
    if m < SR:
        return None, None
    b = b[:m]
    b = b - b.mean()
    bn = float(np.sqrt(np.dot(b, b)))
    if bn == 0:
        return None, None

    a = a[:m + L]
    corr = np.correlate(a, b, mode="valid")          # length L + 1

    # Sliding norm of `a` over each window of length m, via a cumulative sum.
    a2 = np.concatenate(([0.0], np.cumsum(a * a)))
    asum = np.concatenate(([0.0], np.cumsum(a)))
    n = np.arange(len(corr))
    win_sq = a2[n + m] - a2[n]
    win_sum = asum[n + m] - asum[n]
    var = np.maximum(win_sq - win_sum * win_sum / m, 1e-12)
    ncc = corr / (np.sqrt(var) * bn)

    best = int(np.argmax(ncc))
    peak = ncc[best]
    half = np.where(ncc >= peak * 0.9)[0]
    width_ms = (half[-1] - half[0]) * 1000.0 / SR if len(half) else float("nan")
    return best * 1000.0 / SR, width_ms


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    d, sync_file, take_file = sys.argv[1], sys.argv[2], sys.argv[3]
    meta = json.load(open(os.path.join(d, "session.json")))
    ref = meta.get("referenceFile")
    if not ref:
        sys.exit("session.json has no referenceFile")

    c, c_mad = click_lag_ms(os.path.join(d, sync_file))
    r, r_width = ref_lag_ms(os.path.join(d, take_file), os.path.join(d, ref))

    print(f"reference file        : {ref}")
    if c is None:
        print("click lag             : could not find the clicks")
    else:
        print(f"click lag             : {c:+.1f} ms   (scatter ±{c_mad:.1f} — should be ~0, it is a machine)")
    if r is None:
        print("reference lag         : correlation failed")
    else:
        print(f"reference lag         : {r:+.1f} ms   (peak width {r_width:.0f} ms at 90%)")
    if c is not None and r is not None:
        print()
        print(f"SYSTEMATIC BIAS       : {r - c:+.1f} ms")
        print("  = how much later the reference reaches the ears than the click.")
        print("  A sync round measures the player against the click; the mixer then")
        print("  applies that number to a take monitored on the reference. This is")
        print("  the amount by which that transfer is wrong, before any musician.")
        print("  Both paths share the speaker->air->mic delay, so it cancels here —")
        print("  provided the laptop and the volume did not move between rounds.")


if __name__ == "__main__":
    main()
