# scripts/models

`beat_this_small0.onnx` — the beat tracker behind the P2G mixer's pulse grid
(`scripts/p2g_beat_grid.py`, `docs/llm/15-beat-grid.md`).

- **Model:** Beat This! "small0" checkpoint — F. Foscarin, J. Schlüter,
  G. Widmer, *Beat this! Accurate beat tracking without DBN postprocessing*,
  ISMIR 2024. https://github.com/CPJKU/beat_this
- **Licence:** MIT, © 2024 Institute of Computational Perception, JKU Linz.
- **Not in git** (like the assistant's third-party models): fetch it with
  `scripts/fetch-models.sh`, which checks its sha256.
- **How it was made:** `scripts/export-beat-this-onnx.py` (torch dynamo export,
  opset 18, dynamic time axis, parity-checked against torch to ~1e-5).
- **Input:** `spect` float32 `[1, T, 128]`, a log-mel spectrogram at 22.05 kHz,
  hop 441 (50 frames/s). **Output:** `beat`, `downbeat` logits `[1, T]`.
