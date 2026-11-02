import os
import logging
from collections import deque
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import onnxruntime as ort

from audioAnalysis.distortion.distortion_detector import DistortionDetector

BASE_DIR = Path(__file__).resolve().parent
# Input must already be 16 kHz; the plugin resamples (anti-aliased).
SAMPLE_RATE = 16000
WINDOW_SEC = 0.96
TARGET_RATE = 16000
YAMNET_MODEL_PATH = Path(os.environ.get("YAMNET_MODEL_PATH", BASE_DIR / "yamnet_model.onnx"))
CONTENT_MODEL_PATH = Path(os.environ.get("CONTENT_MODEL_PATH", BASE_DIR / "content_mlp.onnx"))
# Replace as a whole: the config's thresholds belong to that model.
DISTORTION_BUNDLE_DIR = Path(os.environ.get("DISTORTION_BUNDLE_DIR", BASE_DIR / "distortion"))

logger = logging.getLogger("audio_classifiers")


def _require_models() -> None:
    """Fail with something actionable when a model file is not on disk.

    yamnet_model.onnx is third-party and not kept in the repository (see this
    folder's README.md). Without this check onnxruntime raises a bare "No such
    file or directory" naming a path, which tells a first-time user nothing
    about how to get it.
    """
    missing = [
        path
        for path in (
            YAMNET_MODEL_PATH,
            CONTENT_MODEL_PATH,
            DISTORTION_BUNDLE_DIR / "distortion_detector.onnx",
            DISTORTION_BUNDLE_DIR / "detector_config.json",
        )
        # os.path.isfile, not Path.is_file: the latter propagates OSError
        # (e.g. EACCES on an untraversable parent) instead of answering False.
        if not os.path.isfile(path)
    ]
    if not missing:
        return
    raise FileNotFoundError(
        "Audio analysis models missing: "
        + ", ".join(p.name for p in missing)
        + ". YAMNet is fetched, not versioned — run ./scripts/fetch-models.sh from "
        "the repository root, or point YAMNET_MODEL_PATH / CONTENT_MODEL_PATH / "
        "DISTORTION_BUNDLE_DIR at an existing store."
    )

ENABLE_ANALYZER_DEBUG = os.environ.get("ENABLE_ANALYZER_DEBUG", "false").lower() in {"1", "true", "yes", "on"}
ANALYZER_DEBUG_EVERY_N_WINDOWS = max(1, int(os.environ.get("ANALYZER_DEBUG_EVERY_N_WINDOWS", "10")))

# τ override (1 − P(clean) needed to count as distorted); unset = the bundle's value.
DISTORTION_THRESHOLD = os.environ.get("DISTORTION_THRESHOLD")

# Windows quieter than this are not classified at all.
#
# The models have no "nothing here" output: the content classifier must spread
# probability across singing/speech/instrumental/other on every window it is
# given, so silence gets assigned a class with real confidence — which is why
# an empty room was being reported as music.
#
# Skipping outright rather than reporting "silent" is deliberate: silence is
# the absence of a measurement, not a measurement, and downstream holds and
# episode clocks should not see it at all. It also skips three ONNX runs.
SILENCE_RMS_DBFS = float(os.environ.get("ANALYZER_SILENCE_RMS_DBFS", "-55"))

# The distortion detector is speech-only, so it runs only on windows the
# content classifier calls speech. After this many windows without speech its
# smoothing and bandwidth history are cleared.
DISTORTION_RESET_AFTER_WINDOWS = max(1, int(os.environ.get("ANALYZER_DISTORTION_RESET_AFTER_WINDOWS", "3")))

# content_mlp.onnx output order.
CONTENT_CLASSES = ["singing", "speech", "instrumental", "other"]

# distortion_detector.onnx output order (softmax).
DISTORTION_CLASSES = ["clean", "clipping", "bass_boost", "low_fidelity"]

# Outside speech (singing, instruments) the detector is out of its training
# domain, so only clipping is trusted there, and only when clip_tail confirms
# the waveform really piles up at the ceiling. Measured 2026-11-02 on two solo
# singers, a folk tune set, drums and a mixed track, each hard-clipped at five
# drives and round-tripped through Opus 64k: zero clipping alarms on clean
# audio; fires once roughly 5%+ of samples are clipped; mild clipping and drums
# are missed. bass_boost and low_fidelity both false-alarmed on CLEAN music (a
# bass singer reads as boomy), which is why they stay speech-only.
MUSIC_CLIPPING_ONLY = os.environ.get("ANALYZER_MUSIC_CLIPPING", "true").lower() in {"1", "true", "yes", "on"}


class ClippingOnlyDecision:
    """The detector's decision rule restricted to clipping, for windows that
    are not speech. Same window rule as the bundle's DecisionLayer (distorted
    if 1 - P(clean) >= tau, clipping if it is the top distorted class, vetoed
    when clip_tail < clip_tail_min) and the same k-of-n smoothing — but every
    other class counts as clean, and there is no narrowband override."""

    def __init__(self, cfg: dict, tau: float):
        self.tau = tau
        self.clip_tail_min = cfg["clip_tail_min"]
        self.k = cfg["smooth_k"]
        self.hist: deque[bool] = deque(maxlen=cfg["smooth_n"])

    def reset(self):
        self.hist.clear()

    def update(self, probs, clip_tail: float) -> bool:
        distorted = 1.0 - float(probs[0]) >= self.tau
        is_clip = distorted and int(np.argmax(probs[1:])) == 0 and clip_tail >= self.clip_tail_min
        self.hist.append(bool(is_clip))
        return sum(self.hist) >= self.k


@dataclass
class AudioAnalysisResult:
    content_class: str
    content_class_index: int
    probabilities: list[float]
    # Empty when the detector didn't run (distortion_checked False).
    distortion_probabilities: list[float]
    # The detector's smoothed alarm: at most one class, empty = none. Outside
    # speech it can only ever be "clipping" (see ClippingOnlyDecision).
    distortion_labels: list[str]
    # Level of the window. Carried on the result because the caller only ever
    # sees results, never the samples that produced them, and level is not
    # something the models report: their classes describe *what* the audio is,
    # never *how loud*.
    rms_dbfs: float = -120.0
    distortion_checked: bool = False
    # "full" on speech, "clipping" on anything else, "" when not checked.
    distortion_scope: str = ""


def to_model_input(audio_data):
    """int16 mono at TARGET_RATE -> float32 in [-1, 1]."""
    return (np.asarray(audio_data).astype(np.float32) / 32768.0).astype(np.float32)


def extract_yamnet_embeddings(outputs):
    """
    Extract 1024-dimensional embeddings from YAMNet outputs.
    YAMNet typically outputs: [scores, embeddings, spectrogram]
    We want the embeddings (usually the second output).
    """
    if isinstance(outputs, (list, tuple)) and len(outputs) >= 2:
        embeddings = np.asarray(outputs[1])
    else:
        embeddings = np.asarray(outputs[0] if isinstance(outputs, (list, tuple)) else outputs)

    if embeddings.ndim == 2:
        # Average over time frames if needed: (T, 1024) -> (1024,)
        embeddings = embeddings.mean(axis=0)

    return embeddings.flatten().astype(np.float32)


def run_content_classifier(embeddings, session):
    """
    Run the content classifier on YAMNet embeddings.
    Returns the full probability distribution and the predicted class index.
    """
    if embeddings.ndim == 1:
        embeddings = embeddings.reshape(1, -1)

    outputs = session.run(None, {session.get_inputs()[0].name: embeddings})
    result = np.asarray(outputs[0] if isinstance(outputs, (list, tuple)) else outputs)
    logits = result.reshape(-1).astype(np.float32)
    if logits.size == 0:
        return np.zeros(len(CONTENT_CLASSES), dtype=np.float32), 0

    exp_logits = np.exp(logits - np.max(logits))
    probabilities = exp_logits / np.sum(exp_logits)

    class_prediction = int(np.argmax(probabilities))
    return probabilities, class_prediction


class AudioContentAnalyzer:
    def __init__(self, src_rate: int = SAMPLE_RATE):
        if src_rate != TARGET_RATE:
            raise ValueError(
                f"AudioContentAnalyzer needs {TARGET_RATE} Hz audio, got {src_rate} Hz: resample before it "
                "with a proper (anti-aliased) resampler"
            )
        self.src_rate = src_rate
        self.samples_per_window = int(src_rate * WINDOW_SEC)

        # No overlap; the detector's thresholds are calibrated for this 0.96 s hop.
        self.hop_samples = self.samples_per_window

        self.window_duration_ms = (self.samples_per_window / self.src_rate) * 1000.0
        self.model_input_samples = int(TARGET_RATE * WINDOW_SEC)
        self.model_input_duration_ms = (self.model_input_samples / TARGET_RATE) * 1000.0
        self.audio_buffer = np.array([], dtype=np.int16)

        sess_options = ort.SessionOptions()
        sess_options.intra_op_num_threads = 1
        sess_options.inter_op_num_threads = 1

        _require_models()
        self.yamnet_session = ort.InferenceSession(str(YAMNET_MODEL_PATH), sess_options)
        self.content_session = ort.InferenceSession(str(CONTENT_MODEL_PATH), sess_options)

        self.distortion = DistortionDetector(str(DISTORTION_BUNDLE_DIR), hop_s=WINDOW_SEC, threads=1)
        assert self.distortion.cfg["classes"] == DISTORTION_CLASSES, self.distortion.cfg["classes"]
        if DISTORTION_THRESHOLD is not None:
            self.distortion.decide.tau = float(DISTORTION_THRESHOLD)
        self.music_clipping = ClippingOnlyDecision(self.distortion.cfg, self.distortion.decide.tau)
        self.windows_without_speech = 0
        self.windows_without_music = 0
        self.window_counter = 0

        logger.info(
            "AudioContentAnalyzer configured rate=%s window_samples=%s hop_samples=%s window_ms=%.1f "
            "silence_gate=%.1fdBFS distortion_tau=%.2f distortion_reset_after=%d windows "
            "distortion_model=%s music_clipping=%s debug=%s",
            self.src_rate,
            self.samples_per_window,
            self.hop_samples,
            self.window_duration_ms,
            SILENCE_RMS_DBFS,
            self.distortion.decide.tau,
            DISTORTION_RESET_AFTER_WINDOWS,
            self.distortion.cfg.get("model_sha256", "?")[:12],
            MUSIC_CLIPPING_ONLY,
            ENABLE_ANALYZER_DEBUG,
        )

    def _no_speech(self):
        self.windows_without_speech += 1
        if self.windows_without_speech == DISTORTION_RESET_AFTER_WINDOWS:
            self.distortion.decide.reset()

    def _no_music(self):
        self.windows_without_music += 1
        if self.windows_without_music == DISTORTION_RESET_AFTER_WINDOWS:
            self.music_clipping.reset()

    def analyze_window(self, window):
        self.window_counter += 1
        should_log = ENABLE_ANALYZER_DEBUG and self.window_counter % ANALYZER_DEBUG_EVERY_N_WINDOWS == 0

        if len(window) != self.samples_per_window:
            logger.warning(
                "Unexpected window size samples=%s expected=%s window_index=%s",
                len(window),
                self.samples_per_window,
                self.window_counter,
            )

        input_data = to_model_input(window)
        rms = float(np.sqrt(np.mean(np.square(input_data)))) if input_data.size else 0.0
        rms_dbfs = 20.0 * np.log10(rms) if rms > 0 else -120.0

        if rms_dbfs < SILENCE_RMS_DBFS:
            self._no_speech()
            self._no_music()
            if should_log:
                logger.info(
                    "Window %s skipped as silence rms_dbfs=%.1f threshold=%.1f",
                    self.window_counter,
                    rms_dbfs,
                    SILENCE_RMS_DBFS,
                )
            return None

        yamnet_outputs = self.yamnet_session.run(None, {self.yamnet_session.get_inputs()[0].name: input_data})
        embeddings = extract_yamnet_embeddings(yamnet_outputs)

        probabilities, class_index = run_content_classifier(embeddings, self.content_session)
        content_class = CONTENT_CLASSES[class_index] if class_index < len(CONTENT_CLASSES) else f"unknown({class_index})"

        distortion_probabilities: list[float] = []
        distortion_labels: list[str] = []
        scope = ""
        out = None
        if content_class == "speech":
            scope = "full"
            self.windows_without_speech = 0
            self._no_music()
            out = self.distortion.run_model(input_data[None, :])
            narrowband, window_class, alarm, alarm_class = self.distortion.decide.update(
                out["probs"][0],
                float(out["clip_tail"][0]),
                float(out["bandwidth_hz"][0]),
                float(out["rms_dbfs"][0]),
            )
            if alarm:
                distortion_labels = [DISTORTION_CLASSES[alarm_class]]
        else:
            self._no_speech()
            if MUSIC_CLIPPING_ONLY:
                scope = "clipping"
                self.windows_without_music = 0
                out = self.distortion.run_model(input_data[None, :])
                if self.music_clipping.update(out["probs"][0], float(out["clip_tail"][0])):
                    distortion_labels = ["clipping"]
        checked = out is not None
        if checked:
            distortion_probabilities = out["probs"][0].tolist()

        if should_log:
            logger.info(
                "Window %s content_class=%s probabilities=%s distortion_scope=%s distortion_labels=%s "
                "distortion_probabilities=%s%s",
                self.window_counter,
                content_class,
                np.round(probabilities, 4).tolist(),
                scope or "-",
                distortion_labels,
                np.round(distortion_probabilities, 4).tolist(),
                (
                    (
                        f" window_class={DISTORTION_CLASSES[window_class]} narrowband={narrowband}"
                        if scope == "full"
                        else ""
                    )
                    + f" clip_tail={float(out['clip_tail'][0]):.2f} bandwidth_hz={float(out['bandwidth_hz'][0]):.0f}"
                    if checked
                    else ""
                ),
            )

        return AudioAnalysisResult(
            content_class=content_class,
            content_class_index=class_index,
            probabilities=probabilities.tolist(),
            distortion_probabilities=distortion_probabilities,
            distortion_labels=distortion_labels,
            rms_dbfs=rms_dbfs,
            distortion_checked=checked,
            distortion_scope=scope,
        )

    def process_samples(self, samples):
        if samples.dtype != np.int16:
            samples = samples.astype(np.int16)

        # Keep a rolling buffer and emit one result per complete 960ms window,
        # advancing by a full window (0% overlap) to save CPU.
        self.audio_buffer = np.concatenate((self.audio_buffer, samples))
        if ENABLE_ANALYZER_DEBUG and len(self.audio_buffer) < self.samples_per_window:
            logger.info(
                "Accumulating audio buffer buffered_samples=%s required_samples=%s buffered_ms=%.1f required_ms=%.1f",
                len(self.audio_buffer),
                self.samples_per_window,
                (len(self.audio_buffer) / self.src_rate) * 1000.0,
                self.window_duration_ms,
            )
        results = []
        while len(self.audio_buffer) >= self.samples_per_window:
            window = self.audio_buffer[:self.samples_per_window]
            result = self.analyze_window(window)
            # None means the window was below SILENCE_RMS_DBFS. It is dropped
            # rather than reported, so callers see a gap in the stream instead
            # of a confident classification of nothing.
            if result is not None:
                results.append(result)
            self.audio_buffer = self.audio_buffer[self.hop_samples:]
        return results


def test_model():
    """Test the model with dummy data to ensure it works correctly"""
    analyzer = AudioContentAnalyzer()
    dummy_audio = np.random.randint(-1000, 1000, size=analyzer.samples_per_window, dtype=np.int16)

    try:
        result = analyzer.analyze_window(dummy_audio)
        print(result)
        return True
    except Exception as e:
        print(f"Model test failed: {e}")
        return False


if __name__ == "__main__":
    test_model()
