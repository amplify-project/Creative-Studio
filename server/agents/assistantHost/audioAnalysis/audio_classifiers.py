import os
import logging
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import onnxruntime as ort

BASE_DIR = Path(__file__).resolve().parent
SAMPLE_RATE = 48000
WINDOW_SEC = 0.96
TARGET_RATE = 16000
YAMNET_MODEL_PATH = Path(os.environ.get("YAMNET_MODEL_PATH", BASE_DIR / "yamnet_model.onnx"))
CONTENT_MODEL_PATH = Path(os.environ.get("CONTENT_MODEL_PATH", BASE_DIR / "content_mlp.onnx"))
DAC_ENCODER_MODEL_PATH = Path(os.environ.get("DAC_ENCODER_MODEL_PATH", BASE_DIR / "dac_encoder.onnx"))
DISTORTION_MODEL_PATH = Path(os.environ.get("DISTORTION_MODEL_PATH", BASE_DIR / "distortion_mlp.onnx"))

logger = logging.getLogger("audio_classifiers")


def _require_models() -> None:
    """Fail with something actionable when a model file is not on disk.

    yamnet_model.onnx and dac_encoder.onnx are third-party weights and are not
    kept in the repository (see this folder's README.md). Without this check
    onnxruntime raises a bare "No such file or directory" naming a path, which
    tells a first-time user nothing about how to get it.
    """
    missing = [
        path
        for path in (
            YAMNET_MODEL_PATH,
            CONTENT_MODEL_PATH,
            DAC_ENCODER_MODEL_PATH,
            DISTORTION_MODEL_PATH,
        )
        # os.path.isfile, not Path.is_file: the latter propagates OSError
        # (e.g. EACCES on an untraversable parent) instead of answering False,
        # which would replace this message with a raw traceback. A model we
        # cannot read is missing for our purposes either way.
        if not os.path.isfile(path)
    ]
    if not missing:
        return
    raise FileNotFoundError(
        "Audio analysis models missing: "
        + ", ".join(p.name for p in missing)
        + ". The third-party ones are fetched, not versioned — run "
        "./scripts/fetch-models.sh from the repository root, or point "
        "YAMNET_MODEL_PATH / CONTENT_MODEL_PATH / DAC_ENCODER_MODEL_PATH / "
        "DISTORTION_MODEL_PATH at an existing store."
    )

ENABLE_ANALYZER_DEBUG = os.environ.get("ENABLE_ANALYZER_DEBUG", "false").lower() in {"1", "true", "yes", "on"}
ANALYZER_DEBUG_EVERY_N_WINDOWS = max(1, int(os.environ.get("ANALYZER_DEBUG_EVERY_N_WINDOWS", "10")))
DISTORTION_THRESHOLD = float(os.environ.get("DISTORTION_THRESHOLD", "0.7"))

# Windows quieter than this are not classified at all.
#
# The models have no "nothing here" output: the content classifier must spread
# probability across singing/speech/instrumental/other on every window it is
# given, so silence gets assigned a class with real confidence — which is why
# an empty room was being reported as music. The distortion side is worse: the
# little that is present during silence is room rumble and mains hum, i.e. low
# frequency, so lf_energy_ratio dominates and near-silence carries the exact
# feature signature of bass_boost.
#
# Skipping outright rather than reporting "silent" is deliberate: silence is
# the absence of a measurement, not a measurement, and downstream holds and
# episode clocks should not see it at all. It also skips three ONNX runs.
SILENCE_RMS_DBFS = float(os.environ.get("ANALYZER_SILENCE_RMS_DBFS", "-55"))

# content_mlp.onnx output order.
CONTENT_CLASSES = ["singing", "speech", "instrumental", "other"]

# distortion_mlp.onnx output order (multi-label, independent sigmoid per class).
DISTORTION_CLASSES = ["clipping", "bw_limit", "bass_boost", "codec"]

# Bumped when extract_dsp_features()'s output layout changes; must match the
# DSP feature version the loaded distortion_mlp.onnx was trained against.
DSP_FEATURE_VERSION = 3


@dataclass
class AudioAnalysisResult:
    content_class: str
    content_class_index: int
    probabilities: list[float]
    distortion_probabilities: list[float]
    distortion_labels: list[str]
    # Level of the window at the capture rate, before any resampling. Carried
    # on the result because the caller only ever sees results, never the
    # samples that produced them, and level is not something the models report:
    # their classes describe *what* the audio is, never *how loud*.
    rms_dbfs: float = -120.0


def resample_to_target(audio_float, src_rate, target_rate, target_len):
    # Simple linear interpolation resample using numpy.interp
    if src_rate == target_rate:
        if len(audio_float) == target_len:
            return audio_float
        # Pad or trim if needed
        if len(audio_float) > target_len:
            return audio_float[:target_len]
        else:
            return np.pad(audio_float, (0, target_len - len(audio_float)))

    # original sample indices
    old_indices = np.linspace(0, len(audio_float) - 1, num=len(audio_float))
    new_indices = np.linspace(0, len(audio_float) - 1, num=target_len)
    resampled = np.interp(new_indices, old_indices, audio_float).astype(np.float32)
    return resampled


def preprocess_for_model(audio_data, src_rate=SAMPLE_RATE):
    """
    Convert int16 audio_data (mono) sampled at src_rate into the model input:
    - normalize to float32 in [-1, 1]
    - resample to TARGET_RATE
    - ensure length matches TARGET_RATE * WINDOW_SEC (rounded)
    - return 1D float32 array as expected by YAMNet ONNX
    """
    audio_float = audio_data.astype(np.float32) / 32768.0

    target_len = int(TARGET_RATE * WINDOW_SEC)
    resampled = resample_to_target(audio_float, src_rate, TARGET_RATE, target_len)

    return resampled.astype(np.float32)


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


def extract_dsp_features(audio_16k: np.ndarray) -> np.ndarray:
    """
    Hand-crafted DSP features appended after the DAC embedding for distortion_mlp,
    in the exact order the model was trained on: crest_factor_norm, clip_ratio,
    spectral_flatness, hf_energy_ratio, lf_energy_ratio, mid_band_ratio,
    spectral_centroid, rms_level_norm.
    """
    eps = 1e-10
    audio_16k = audio_16k.astype(np.float64)

    peak = np.max(np.abs(audio_16k)) + eps
    rms = np.sqrt(np.mean(np.square(audio_16k))) + eps

    crest_factor_db = 20.0 * np.log10(peak / rms)
    crest_factor_norm = np.clip(crest_factor_db / 40.0, 0.0, 1.0)

    clip_ratio = float(np.mean(np.abs(audio_16k) >= 0.95 * peak))

    window = audio_16k * np.hanning(len(audio_16k))
    spectrum = np.fft.rfft(window)
    power = np.square(np.abs(spectrum))
    freqs = np.fft.rfftfreq(len(audio_16k), d=1.0 / TARGET_RATE)
    power_safe = power + eps
    total_energy = np.sum(power) + eps

    spectral_flatness = np.exp(np.mean(np.log(power_safe))) / np.mean(power_safe)
    spectral_flatness = float(np.clip(spectral_flatness, 0.0, 1.0))

    hf_energy_ratio = float(np.sum(power[(freqs >= 4000) & (freqs <= 8000)]) / total_energy)
    lf_energy_ratio = float(np.sum(power[(freqs >= 0) & (freqs <= 400)]) / total_energy)
    mid_band_ratio = float(np.sum(power[(freqs >= 300) & (freqs <= 3500)]) / total_energy)

    nyquist = TARGET_RATE / 2.0
    spectral_centroid = float((np.sum(freqs * power) / total_energy) / nyquist)

    rms_dbfs = 20.0 * np.log10(rms)
    rms_level_norm = float(np.clip((rms_dbfs - (-60.0)) / 60.0, 0.0, 1.0))

    return np.array(
        [
            crest_factor_norm,
            clip_ratio,
            spectral_flatness,
            hf_energy_ratio,
            lf_energy_ratio,
            mid_band_ratio,
            spectral_centroid,
            rms_level_norm,
        ],
        dtype=np.float32,
    )


def run_dac_encoder(audio_16k, session):
    """Run the DAC 16kHz encoder on a fixed-length (15360-sample) 960ms window, mean-pooled over time."""
    input_data = audio_16k.reshape(1, 1, -1).astype(np.float32)
    outputs = session.run(None, {session.get_inputs()[0].name: input_data})
    embedding = np.asarray(outputs[0] if isinstance(outputs, (list, tuple)) else outputs)
    return embedding.reshape(-1).astype(np.float32)


def run_distortion_classifier(dac_embedding, dsp_features, session):
    """
    Run the multi-label distortion classifier on concat(dac_embedding, dsp_features).
    Returns independent per-class sigmoid probabilities (not softmax).
    """
    features = np.concatenate([dac_embedding.reshape(-1), dsp_features.reshape(-1)]).astype(np.float32)
    features = features.reshape(1, -1)
    outputs = session.run(None, {session.get_inputs()[0].name: features})
    logits = np.asarray(outputs[0] if isinstance(outputs, (list, tuple)) else outputs).reshape(-1).astype(np.float32)
    probabilities = 1.0 / (1.0 + np.exp(-logits))
    return probabilities


class AudioContentAnalyzer:
    def __init__(self, src_rate: int = SAMPLE_RATE):
        self.src_rate = src_rate
        self.samples_per_window = int(src_rate * WINDOW_SEC)
        
        # --- NUEVO: ELIMINADO EL SOLAPAMIENTO (OVERLAP 0%) ---
        # Antes: self.hop_samples = max(1, self.samples_per_window // 2)
        self.hop_samples = self.samples_per_window
        # -----------------------------------------------------
        
        self.window_duration_ms = (self.samples_per_window / self.src_rate) * 1000.0 if self.src_rate else 0.0
        self.model_input_samples = int(TARGET_RATE * WINDOW_SEC)
        self.model_input_duration_ms = (self.model_input_samples / TARGET_RATE) * 1000.0 if TARGET_RATE else 0.0
        self.audio_buffer = np.array([], dtype=np.int16)
        
        # --- NUEVO: RESTRICCIÓN DE HILOS PARA ONNX ---
        sess_options = ort.SessionOptions()
        sess_options.intra_op_num_threads = 1
        sess_options.inter_op_num_threads = 1
        # ---------------------------------------------
        
        _require_models()

        self.yamnet_session = ort.InferenceSession(str(YAMNET_MODEL_PATH), sess_options)
        self.content_session = ort.InferenceSession(str(CONTENT_MODEL_PATH), sess_options)
        self.dac_session = ort.InferenceSession(str(DAC_ENCODER_MODEL_PATH), sess_options)
        self.distortion_session = ort.InferenceSession(str(DISTORTION_MODEL_PATH), sess_options)
        self.window_counter = 0

        logger.info(
            "AudioContentAnalyzer configured src_rate=%s source_window_samples=%s source_hop_samples=%s "
            "source_window_ms=%.1f target_rate=%s model_window_samples=%s model_window_ms=%.1f "
            "silence_gate=%.1fdBFS distortion_threshold=%.2f debug=%s",
            self.src_rate,
            self.samples_per_window,
            self.hop_samples,
            self.window_duration_ms,
            TARGET_RATE,
            self.model_input_samples,
            self.model_input_duration_ms,
            SILENCE_RMS_DBFS,
            DISTORTION_THRESHOLD,
            ENABLE_ANALYZER_DEBUG,
        )
        if abs(self.window_duration_ms - 960.0) > 1.0:
            logger.warning(
                "Expected roughly 960 ms analysis windows but effective window is %.1f ms at src_rate=%s",
                self.window_duration_ms,
                self.src_rate,
            )
        if abs(self.model_input_duration_ms - 960.0) > 1.0:
            logger.warning(
                "Expected roughly 960 ms model input windows but effective resampled window is %.1f ms at target_rate=%s",
                self.model_input_duration_ms,
                TARGET_RATE,
            )

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

        # Measured on the raw capture-rate window: the model input has been
        # resampled and normalised, so it is no longer a faithful level.
        window_float = np.asarray(window, dtype=np.float32) / 32768.0
        rms = float(np.sqrt(np.mean(np.square(window_float)))) if window_float.size else 0.0
        rms_dbfs = 20.0 * np.log10(rms) if rms > 0 else -120.0

        if rms_dbfs < SILENCE_RMS_DBFS:
            if should_log:
                logger.info(
                    "Window %s skipped as silence rms_dbfs=%.1f threshold=%.1f",
                    self.window_counter,
                    rms_dbfs,
                    SILENCE_RMS_DBFS,
                )
            return None

        input_data = preprocess_for_model(window, src_rate=self.src_rate)
        if len(input_data) != self.model_input_samples:
            logger.warning(
                "Unexpected resampled input size samples=%s expected=%s window_index=%s",
                len(input_data),
                self.model_input_samples,
                self.window_counter,
            )

        yamnet_outputs = self.yamnet_session.run(None, {self.yamnet_session.get_inputs()[0].name: input_data})
        embeddings = extract_yamnet_embeddings(yamnet_outputs)

        probabilities, class_index = run_content_classifier(embeddings, self.content_session)
        content_class = CONTENT_CLASSES[class_index] if class_index < len(CONTENT_CLASSES) else f"unknown({class_index})"

        dac_embedding = run_dac_encoder(input_data, self.dac_session)
        dsp_features = extract_dsp_features(input_data)
        distortion_probabilities = run_distortion_classifier(dac_embedding, dsp_features, self.distortion_session)
        distortion_labels = [
            DISTORTION_CLASSES[i]
            for i, p in enumerate(distortion_probabilities)
            if p >= DISTORTION_THRESHOLD and i < len(DISTORTION_CLASSES)
        ]

        if should_log:
            logger.info(
                "Window %s embeddings_shape=%s content_class=%s probabilities=%s distortion_labels=%s "
                "distortion_probabilities=%s",
                self.window_counter,
                tuple(embeddings.shape),
                content_class,
                np.round(probabilities, 4).tolist(),
                distortion_labels,
                np.round(distortion_probabilities, 4).tolist(),
            )

        return AudioAnalysisResult(
            content_class=content_class,
            content_class_index=class_index,
            probabilities=probabilities.tolist(),
            distortion_probabilities=distortion_probabilities.tolist(),
            distortion_labels=distortion_labels,
            rms_dbfs=rms_dbfs,
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
