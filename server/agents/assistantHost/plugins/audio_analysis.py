"""
audio_analysis — plugin that subscribes to participant audio tracks,
runs a YAMNet embedding + content classifier (speech/singing/music/other)
on 960ms windows with 50% overlap, and publishes results as data events.

Ported from the standalone AudioAnalysisAgent in dataCollection/.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import importlib
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from typing import Any

import numpy as np
from livekit import rtc

from creativestudio_assistant import AssistantPlugin, PluginContext

logger = logging.getLogger("assistant_host:audio_analysis")

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))        # plugins/
HOST_DIR = os.path.dirname(PLUGIN_DIR)                         # assistantHost/
AGENTS_DIR = os.path.dirname(HOST_DIR)                         # agents/
if AGENTS_DIR not in sys.path:
    sys.path.insert(0, AGENTS_DIR)

ENABLE_ONNX_AUDIO_ANALYSIS = os.getenv("ENABLE_ONNX_AUDIO_ANALYSIS", "true").lower() in {"1", "true", "yes", "on"}
ENABLE_AUDIO_DEBUG = os.getenv("ENABLE_AUDIO_DEBUG", "false").lower() in {"1", "true", "yes", "on"}
ENABLE_AUDIO_EVENT_LOG = os.getenv("ENABLE_AUDIO_EVENT_LOG", "false").lower() in {"1", "true", "yes", "on"}

# Whether a detected mic problem interrupts its owner with a suggestion.
#
# Off for now: the detection is still being calibrated, and an unreliable
# personal alert is worse than none. Detection keeps running either way — the
# issues are published on every audio/analysis event and shown in the host's
# panel, which is observation without interruption. Flip this back on once the
# thresholds have been proven against real lessons.
ENABLE_DISTORTION_SUGGESTIONS = os.getenv(
    "ENABLE_DISTORTION_SUGGESTIONS", "false"
).lower() in {"1", "true", "yes", "on"}
AUDIO_DEBUG_INTERVAL_SEC = float(os.getenv("AUDIO_DEBUG_INTERVAL_SEC", "5"))
ONNX_ERROR_LOG_EVERY_N = max(1, int(os.getenv("ONNX_ERROR_LOG_EVERY_N", "50")))

# Which capture mode each content class argues for. "other" is the
# classifier's fallback bucket and says nothing about what the room is doing,
# so it deliberately maps to nothing and never drives a mode suggestion.
CONTENT_TO_MODE = {
    "singing": "music",
    "instrumental": "music",
    "speech": "speech",
}

# How long the room must keep arguing for one capture mode before it's worth
# asking the host to switch to it.
#
# This is a confidence threshold, not a safety one: the suggestion is a
# dismissable toast that the host must accept, so a false positive costs an
# ignored toast, not a wrong mode switch. It was 12s, which put the suggestion
# ~20s behind the music actually starting — long enough that the moment had
# passed. CONTENT_HOLD_WINDOWS already spends ~3s confirming the class before
# the episode even opens, so most of what 12s was guarding against was already
# guarded.
MODE_SUGGEST_MIN_SEC = float(os.getenv("AUDIO_MODE_SUGGEST_MIN_SEC", "5"))

# A gap of this long between analysed windows ends the current content episode.
#
# Silent windows are dropped outright now, so a pause leaves a hole in the
# result stream rather than a run of some other class. Without this, an episode
# survives any amount of silence and the mode suggestion never re-arms:
# music detected once, then a pause, then music again is one unbroken episode
# and the second stretch is never suggested. Observed in the field.
#
# Deliberately NOT applied to the mic issues below. The asymmetry is the point:
# a badly set input gain is still badly set after a pause, whereas "what is the
# room doing" genuinely stops being known once the room goes quiet.
MODE_EPISODE_GAP_SEC = float(os.getenv("AUDIO_MODE_EPISODE_GAP_SEC", "3"))

# How long before the mode suggestion is offered again within the same episode.
#
# It used to be offered exactly once per episode, which conflated *ignored*
# with *refused*. An episode lasts as long as the class holds, so a continuous
# hour of music was one episode and one single chance: ignore the toast — which
# is what happens if you are playing, or looking elsewhere, or had the
# calibration panel open — and the offer never came back, while the server went
# on detecting instrumental the whole time.
#
# Refusing is the case that deserves to stick, and it already does: dismissing
# a toast puts its dedup key in a client-side cooldown. This only re-offers what
# nobody ever answered.
MODE_RESUGGEST_SEC = float(os.getenv("AUDIO_MODE_RESUGGEST_SEC", "60"))

# How long a confirmed distortion must persist before telling the owner of the
# mic. _ConfirmedHold already damps single-window flicker, so this is only about
# not interrupting someone over one loud note.
CLIP_SUGGEST_MIN_SEC = float(os.getenv("AUDIO_CLIP_SUGGEST_MIN_SEC", "8"))

# The distortion classes worth interrupting a user over, and the copy for each.
#
# The distortion model is multi-label: an independent sigmoid per class, so
# several can be true at once. Each entry here is therefore gated on its OWN
# probability, deliberately not on the argmax `distortion_type` reported below.
# That distinction matters: `bw_limit` and `codec` sit near 1.0 in every WebRTC
# room by construction — the transport really is band-limited and Opus-coded —
# so an argmax gate lets a structural, unactionable label mask a real clipping
# detection sitting just behind it. Measured: clipping 0.92 losing to bw_limit
# 0.99 on audio that was audibly clipped.
#
# The other three classes are excluded on purpose, not by omission — and they
# are filtered out of the published event entirely (see MEANINGFUL_DISTORTIONS),
# not just left un-suggested, because none of them describes this microphone:
#
#   bw_limit    The analyser resamples 48k -> 16k (audio_classifiers.py:10-12,
#               np.interp with no anti-alias filter), so it never sees above
#               8 kHz. Every window is band-limited before the mic is involved:
#               the model is detecting its own pipeline. Pins near 1.0 always.
#   codec       Every track in the room is Opus. Always true, says nothing.
#   packet_loss Contradicted in the field on 2026-07-20: the label fired while
#               WebRTC stats reported no loss at all. Untrusted until that
#               disagreement is explained.
#
# Leaving these in meant `distortion` was permanently True and therefore carried
# no information at all.
ACTIONABLE_DISTORTIONS: dict[str, dict[str, str]] = {
    "clipping": {
        "title": "Your microphone is clipping",
        "description": (
            "Your input level is too high, so the loudest parts are distorting. "
            "Open the calibration panel to set it."
        ),
    },
    "bass_boost": {
        "title": "Your microphone sounds boomy",
        "description": (
            "The low end is overpowering, usually from being very close to the mic. "
            "Move back a little, or angle the mic slightly off to one side."
        ),
    },
}

# A mic that is audible but arriving too quietly. Deliberately not a member of
# ACTIONABLE_DISTORTIONS: it is not one of the model's classes and never can be
# — the classifiers describe *what* the audio is, never *how loud*, so this is
# read off the window's own RMS instead. It is gated on the content class being
# a real one (singing/speech/instrumental, i.e. present in CONTENT_TO_MODE) so
# it only fires when we can hear the person and they are simply too quiet,
# rather than nagging someone who has stopped playing.
LOW_LEVEL_DBFS = float(os.getenv("AUDIO_LOW_LEVEL_DBFS", "-42"))

# Every issue that can produce a suggestion, whatever detected it. The two
# sources share the hold + episode-clock machinery below.
SUGGESTABLE_ISSUES: dict[str, dict[str, str]] = {
    **ACTIONABLE_DISTORTIONS,
    "low_level": {
        "title": "Your microphone is very quiet",
        "description": (
            "We can hear you, but your level is low enough that you'll be buried in "
            "the mix. Raise your input gain, or move closer to the mic."
        ),
    },
}

# What `distortion` / `distortion_type` in the published event are computed
# over. Identical to the actionable set today; kept as its own name because
# "worth reporting" and "worth interrupting someone about" are different
# questions, and a future label could be the first to answer them differently.
# The raw, unfiltered labels are still logged for diagnosis.
MEANINGFUL_DISTORTIONS = frozenset(ACTIONABLE_DISTORTIONS)

# Hold values damp single-window classifier flicker: a new value only replaces
# the currently reported one once it has been seen this many consecutive
# windows in a row.
CONTENT_HOLD_WINDOWS = max(1, int(os.getenv("AUDIO_CONTENT_HOLD_WINDOWS", "3")))
DISTORTION_HOLD_WINDOWS = max(1, int(os.getenv("AUDIO_DISTORTION_HOLD_WINDOWS", "5")))
DISTORTION_TYPE_HOLD_WINDOWS = max(1, int(os.getenv("AUDIO_DISTORTION_TYPE_HOLD_WINDOWS", "5")))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class _StickyHold:
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


class _ConfirmedHold:
    """Only reports a candidate (including "no candidate") once it has held
    for `hold` consecutive updates. Unlike _StickyHold, "nothing detected" is
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


class AudioAnalysis(AssistantPlugin):
    name = "audio-analysis"
    description = "Real-time ONNX content classification (speech/singing/music/other) on participant audio tracks."
    max_per_minute = 4
    dedup_cooldown_sec = 30.0

    def __init__(self, ctx: PluginContext):
        super().__init__(ctx)
        self.active_tasks: dict[str, asyncio.Task] = {}
        # track sid -> publisher identity. on_track_subscribed is the only place
        # that sees the participant; _process_audio downstream only has the sid,
        # and a personal suggestion needs someone to send it to.
        self.track_owner: dict[str, str] = {}
        self.audio_analyzer_cls = None
        self.distortion_classes: list[str] = []

        if ENABLE_ONNX_AUDIO_ANALYSIS:
            try:
                if ENABLE_AUDIO_DEBUG and "ENABLE_ANALYZER_DEBUG" not in os.environ:
                    os.environ["ENABLE_ANALYZER_DEBUG"] = "true"
                analyzer_module = importlib.import_module("audioAnalysis.audio_classifiers")
                self.audio_analyzer_cls = analyzer_module.AudioContentAnalyzer
                self.distortion_classes = list(getattr(analyzer_module, "DISTORTION_CLASSES", []))
                logger.info(
                    "ONNX audio analysis enabled (analyzer_debug=%s)",
                    os.environ.get("ENABLE_ANALYZER_DEBUG", "false"),
                )
                # Every value that decides *when* something is suggested, logged
                # once at startup. The container mounts this directory live but
                # Python only reloads on restart, so "which code is actually
                # running" is otherwise unanswerable from the outside — and it
                # is the first question whenever a measured delay disagrees with
                # the configured one.
                logger.info(
                    "audio tuning: mode_suggest_min=%.1fs mode_resuggest=%.1fs "
                    "mode_episode_gap=%.1fs content_hold=%d windows "
                    "clip_suggest_min=%.1fs low_level=%.1fdBFS "
                    "distortion_suggestions=%s",
                    MODE_SUGGEST_MIN_SEC,
                    MODE_RESUGGEST_SEC,
                    MODE_EPISODE_GAP_SEC,
                    CONTENT_HOLD_WINDOWS,
                    CLIP_SUGGEST_MIN_SEC,
                    LOW_LEVEL_DBFS,
                    ENABLE_DISTORTION_SUGGESTIONS,
                )
            except Exception as e:
                logger.exception("Failed to import ONNX analyzer module: %s", e)
        else:
            logger.info("ONNX audio analysis disabled by ENABLE_ONNX_AUDIO_ANALYSIS")

    async def on_track_subscribed(self, track: Any, publication: Any, participant: Any) -> None:
        if not isinstance(track, rtc.Track):
            return
        if track.kind != rtc.TrackKind.KIND_AUDIO:
            return

        track_key = publication.sid
        if track_key in self.active_tasks:
            return

        identity = getattr(participant, "identity", None)
        if identity:
            self.track_owner[track_key] = identity

        task = asyncio.create_task(self._process_audio(track, track_key))
        self.active_tasks[track_key] = task
        logger.info("[%s] Started audio processing task (owner=%s)", track_key, identity or "<unknown>")

    async def on_track_unsubscribed(self, track: Any, publication: Any, participant: Any) -> None:
        self.track_owner.pop(publication.sid, None)
        task = self.active_tasks.pop(publication.sid, None)
        if task:
            task.cancel()
            logger.info("[%s] Cancelled audio processing task", publication.sid)

    async def _publish_audio_event(
        self,
        track_id: str,
        content_type: str,
        distortion: bool,
        distortion_type: dict[str, Any] | None,
        duration_sec: float,
        rms_dbfs: float,
        issues: list[str],
    ) -> None:
        evt = {
            "type": "event",
            "name": "audio/analysis",
            "args": {
                "track_id": track_id,
                "content_type": content_type,
                "distortion": distortion,
                "distortion_type": distortion_type,
                "duration": duration_sec,
                # Level of the window, and every issue currently detected on it.
                # The host panel shows these directly, so it sees what the
                # analyser sees rather than only the suggestions it chose to
                # raise — and they are what the silence / low-level thresholds
                # get calibrated against.
                "rms_dbfs": round(rms_dbfs, 1),
                "issues": issues,
                "ts": _now_iso(),
            },
        }

        payload = json.dumps(evt)
        if ENABLE_AUDIO_EVENT_LOG:
            logger.info("audio_event_out topic=cmd payload=%s", payload)

        await self.ctx.publish_data(payload.encode(), topic="cmd", reliable=False)

    def _room_audio_mode(self) -> str:
        """Capture mode currently set on shared state. Absent means speech —
        the clients resolve it the same way (`?? "speech"`)."""
        ui = self.ctx.state.get("ui") or {}
        mode = ui.get("audioMode")
        return mode if mode in ("speech", "music") else "speech"

    async def _maybe_suggest_mode(self, target: str | None, duration_sec: float) -> bool:
        """Ask the host to switch capture mode when the room has been arguing for
        one mode long enough and the mode disagrees. True iff one went out."""
        if target is None:
            return False
        if duration_sec < MODE_SUGGEST_MIN_SEC:
            return False
        if self._room_audio_mode() == target:
            return False

        if target == "music":
            title = "Music detected in the room"
            description = (
                "Switch to music-optimised mode to disable echo cancellation and "
                "capture raw stereo."
            )
        else:
            title = "Speech detected in the room"
            description = (
                "Switch back to speech-optimised mode to re-enable echo cancellation "
                "and noise suppression."
            )

        # Keyed per direction: a switch back to speech must not be swallowed by
        # the cooldown left over from the music suggestion.
        return await self.ctx.suggest(
            title=title,
            description=description,
            skill="audio.setMode",
            args={"mode": target},
            dedup_key=f"audio-switch-{target}",
            ttl_ms=15000,
            severity="suggestion",
        )

    async def _maybe_suggest_distortion(self, track_id: str, issue: str) -> bool:
        """Tell the owner of a distorting mic, and only them. True iff it went out."""
        identity = self.track_owner.get(track_id)
        if not identity:
            # Deliberately no fallback: `to=[]` broadcasts, which would put
            # "your mic is clipping" on every screen in the room.
            logger.info("[%s] %s held but no owner resolved — not suggesting", track_id, issue)
            return False

        copy = SUGGESTABLE_ISSUES[issue]
        return await self.ctx.suggest(
            title=copy["title"],
            description=copy["description"],
            skill="audio.calibrateMic",
            args={"participantId": identity, "issue": issue},
            # Keyed per issue: a clipping alert must not swallow a later
            # bass_boost one on the same mic, and vice versa.
            dedup_key=f"audio-cal:{issue}:{identity}",
            ttl_ms=30000,
            severity="alert",
            to=[identity],
        )

    async def _process_audio(self, track: rtc.Track, track_id: str) -> None:
        audio_stream = rtc.AudioStream(track)

        audio_analyzer = None
        loop = asyncio.get_running_loop()
        analysis_executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=1, thread_name_prefix=f"audio-analysis-{track_id}"
        )
        logger.info("[%s] Audio processing started", track_id)

        next_debug_log_at = time.monotonic() + AUDIO_DEBUG_INTERVAL_SEC
        debug_frames = 0
        debug_samples = 0
        debug_rms_sum = 0.0
        debug_errors = 0
        onnx_error_count = 0
        content_type_hold = _StickyHold(CONTENT_HOLD_WINDOWS)
        distortion_hold = _StickyHold(DISTORTION_HOLD_WINDOWS, initial=False)
        distortion_type_hold = _ConfirmedHold(DISTORTION_TYPE_HOLD_WINDOWS)
        # One independent hold + episode clock per actionable label, because the
        # labels themselves are independent — see ACTIONABLE_DISTORTIONS.
        issue_holds = {
            issue: _ConfirmedHold(DISTORTION_TYPE_HOLD_WINDOWS)
            for issue in SUGGESTABLE_ISSUES
        }
        issue_since: dict[str, float | None] = {issue: None for issue in SUGGESTABLE_ISSUES}
        issue_suggested: dict[str, bool] = {issue: False for issue in SUGGESTABLE_ISSUES}
        current_target = None
        current_mode_started_at = None
        mode_suggested_at = None
        last_analysis_ts = None

        try:
            async for event in audio_stream:
                now_ts = time.monotonic()
                frame = event.frame

                samples = np.frombuffer(frame.data, dtype=np.int16)
                if samples.size == 0:
                    continue

                if audio_analyzer is None and self.audio_analyzer_cls is not None:
                    try:
                        audio_analyzer = self.audio_analyzer_cls(src_rate=frame.sample_rate)
                        logger.info(
                            "[%s] ONNX analyzer initialized (sample_rate=%s, channels=%s)",
                            track_id,
                            frame.sample_rate,
                            frame.num_channels,
                        )
                    except Exception as e:
                        logger.exception("[%s] ONNX analyzer initialization failed: %s", track_id, e)
                        self.audio_analyzer_cls = None

                if frame.num_channels > 1:
                    samples = samples.reshape(-1, frame.num_channels).mean(axis=1)
                samples = samples.astype(np.int16)

                if ENABLE_AUDIO_DEBUG:
                    pcm = samples.astype(np.float32) / 32768.0
                    debug_frames += 1
                    debug_samples += int(samples.size)
                    debug_rms_sum += float(np.sqrt(np.mean(np.square(pcm))))

                if audio_analyzer is not None:
                    try:
                        results = await loop.run_in_executor(
                            analysis_executor, audio_analyzer.process_samples, samples
                        )
                        if results:
                            for result in results:
                                analysis_ts = time.monotonic()
                                window_duration_sec = (
                                    audio_analyzer.window_duration_ms / 1000.0
                                    if audio_analyzer is not None
                                    else 0.0
                                )

                                content_type = content_type_hold.update(result.content_class)

                                # Everything the event reports is computed over
                                # the meaningful subset; the raw labels survive
                                # only in the debug log below.
                                meaningful_labels = [
                                    label
                                    for label in result.distortion_labels
                                    if label in MEANINGFUL_DISTORTIONS
                                ]
                                distortion = distortion_hold.update(bool(meaningful_labels))

                                label_probs = (
                                    dict(zip(self.distortion_classes, result.distortion_probabilities))
                                    if self.distortion_classes
                                    else {}
                                )

                                # Reported for telemetry only. Keep it argmax —
                                # it answers "what is this mic's dominant
                                # problem", which is a fair thing to log — but
                                # never gate a suggestion on it.
                                distortion_type_candidate = None
                                distortion_type_confidence = 0.0
                                if meaningful_labels and label_probs:
                                    distortion_type_candidate = max(
                                        meaningful_labels, key=lambda label: label_probs.get(label, 0.0)
                                    )
                                    distortion_type_confidence = label_probs.get(distortion_type_candidate, 0.0)
                                distortion_type = distortion_type_hold.update(
                                    distortion_type_candidate, distortion_type_confidence
                                )

                                # A hole in the result stream means the analyser
                                # dropped windows as silence.
                                if (
                                    last_analysis_ts is not None
                                    and analysis_ts - last_analysis_ts > MODE_EPISODE_GAP_SEC
                                ):
                                    current_target = None
                                    current_mode_started_at = None
                                    mode_suggested_at = None
                                last_analysis_ts = analysis_ts

                                # Episodes are keyed on the mode the room is
                                # arguing for, NOT on the content class. singing
                                # and instrumental are different classes that
                                # want the same mode, so keying on the class made
                                # every alternation between them restart the
                                # clock — and someone singing over their own
                                # playing alternates constantly, which is the
                                # normal case here, not an edge one. The episode
                                # never reached the threshold and no suggestion
                                # ever fired.
                                target_mode = CONTENT_TO_MODE.get(content_type)
                                if current_target != target_mode or current_mode_started_at is None:
                                    current_target = target_mode
                                    # Backdate by the whole confirmation, not by
                                    # one window. _StickyHold only reports a new
                                    # class after CONTENT_HOLD_WINDOWS of it in
                                    # a row, so by the time we get here the room
                                    # has genuinely been doing this for that
                                    # long. Crediting a single window threw away
                                    # ~2s of every episode.
                                    current_mode_started_at = analysis_ts - (
                                        CONTENT_HOLD_WINDOWS * window_duration_sec
                                    )
                                    mode_suggested_at = None

                                state_duration_sec = max(0.0, analysis_ts - current_mode_started_at)

                                # Once per episode, not once per window: the
                                # duration only grows while the class holds, so
                                # suggesting on every window past the threshold
                                # would re-nag every cooldown for as long as the
                                # music plays. A new episode re-arms it.
                                if (
                                    mode_suggested_at is None
                                    or analysis_ts - mode_suggested_at >= MODE_RESUGGEST_SEC
                                ):
                                    if await self._maybe_suggest_mode(
                                        target_mode, state_duration_sec
                                    ):
                                        mode_suggested_at = analysis_ts

                                # Two detection sources, one machinery: the model
                                # labels, plus the level read off the window's
                                # own RMS. Silence never reaches here at all —
                                # the analyser drops those windows — so a gap in
                                # results is a gap in every episode clock below.
                                detected_issues = set(meaningful_labels)
                                if (
                                    content_type in CONTENT_TO_MODE
                                    and result.rms_dbfs < LOW_LEVEL_DBFS
                                ):
                                    detected_issues.add("low_level")

                                # Each issue runs on its own episode clock: it's
                                # a property of one mic, not of what the room is
                                # doing, so it must not reset when the content
                                # class changes. Its own _ConfirmedHold damps the
                                # signal, so brief gaps between loud notes don't
                                # end the episode.
                                held_issues: list[str] = []
                                for issue in SUGGESTABLE_ISSUES:
                                    present = issue_holds[issue].update(
                                        issue if issue in detected_issues else None,
                                        label_probs.get(issue, 0.0),
                                    )
                                    if present is not None:
                                        held_issues.append(issue)
                                        if issue_since[issue] is None:
                                            issue_since[issue] = analysis_ts
                                        if (
                                            ENABLE_DISTORTION_SUGGESTIONS
                                            and not issue_suggested[issue]
                                            and analysis_ts - issue_since[issue] >= CLIP_SUGGEST_MIN_SEC
                                        ):
                                            issue_suggested[issue] = await self._maybe_suggest_distortion(
                                                track_id, issue
                                            )
                                    else:
                                        issue_since[issue] = None
                                        issue_suggested[issue] = False

                                await self._publish_audio_event(
                                    track_id=track_id,
                                    content_type=content_type,
                                    distortion=distortion,
                                    distortion_type=distortion_type,
                                    duration_sec=state_duration_sec,
                                    rms_dbfs=result.rms_dbfs,
                                    issues=held_issues,
                                )

                                logger.info(
                                    "[%s] content_type=%s duration=%.2fs distortion=%s distortion_type=%s "
                                    "raw_class=%s raw_distortion_labels=%s",
                                    track_id,
                                    content_type,
                                    state_duration_sec,
                                    distortion,
                                    distortion_type,
                                    result.content_class,
                                    result.distortion_labels,
                                )
                    except Exception as e:
                        debug_errors += 1
                        onnx_error_count += 1
                        if onnx_error_count == 1 or onnx_error_count % ONNX_ERROR_LOG_EVERY_N == 0:
                            logger.exception(
                                "[%s] ONNX analysis failed (count=%d): %s",
                                track_id,
                                onnx_error_count,
                                e,
                            )
                        else:
                            logger.error(
                                "[%s] ONNX analysis failed (count=%d): %s",
                                track_id,
                                onnx_error_count,
                                e,
                            )

                if ENABLE_AUDIO_DEBUG and now_ts >= next_debug_log_at:
                    avg_rms = (debug_rms_sum / debug_frames) if debug_frames > 0 else 0.0
                    buffered_samples = len(audio_analyzer.audio_buffer) if audio_analyzer is not None else 0
                    required_samples = audio_analyzer.samples_per_window if audio_analyzer is not None else 0

                    logger.info(
                        "[%s] audio_debug frames=%d samples=%d avg_rms=%.4f errors=%d buffer=%d/%d",
                        track_id,
                        debug_frames,
                        debug_samples,
                        avg_rms,
                        debug_errors,
                        buffered_samples,
                        required_samples,
                    )

                    next_debug_log_at = now_ts + AUDIO_DEBUG_INTERVAL_SEC
                    debug_frames = 0
                    debug_samples = 0
                    debug_rms_sum = 0.0
                    debug_errors = 0

        except asyncio.CancelledError:
            logger.info("[%s] Audio task cancelled", track_id)
        finally:
            if ENABLE_AUDIO_DEBUG and (debug_frames > 0 or debug_errors > 0):
                avg_rms = (debug_rms_sum / debug_frames) if debug_frames > 0 else 0.0
                buffered_samples = len(audio_analyzer.audio_buffer) if audio_analyzer is not None else 0
                required_samples = audio_analyzer.samples_per_window if audio_analyzer is not None else 0

                logger.info(
                    "[%s] audio_debug frames=%d samples=%d avg_rms=%.4f errors=%d buffer=%d/%d",
                    track_id,
                    debug_frames,
                    debug_samples,
                    avg_rms,
                    debug_errors,
                    buffered_samples,
                    required_samples,
                )
            await audio_stream.aclose()
            analysis_executor.shutdown(wait=False)
            logger.info("[%s] Audio processing finished", track_id)
