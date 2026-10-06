# Audio analysis models

Four ONNX models. Two live in this repository, two do not, and the split is
deliberate.

| File | Size | Origin | Licence | In git? |
|---|---|---|---|---|
| `content_mlp.onnx` | 2.6 MB | Trained for this project (PyTorch 2.12.1) | GPLv3, with this repo | **yes** |
| `distortion_mlp.onnx` | 1.2 MB | Trained for this project (PyTorch 2.4.0) | GPLv3, with this repo | **yes** |
| `yamnet_model.onnx` | 16 MB | Google YAMNet, converted with `tf2onnx` 1.16.1 | Apache-2.0 | no — fetched |
| `dac_encoder.onnx` | 86 MB | Encoder half of the Descript Audio Codec, exported from PyTorch | MIT | no — fetched |

Get the two that are missing with:

```bash
./scripts/fetch-models.sh
```

## Why the third-party two are not in the repository

They are 97 MB of someone else's weights. Shipping them inside a GPLv3 source
tree muddles the licensing, and `dac_encoder.onnx` on its own is past GitHub's
50 MB file warning — every clone and every fork would carry it.

## Why the other two are

Nothing public can reproduce them. `content_mlp` maps YAMNet embeddings to
`["singing", "speech", "instrumental", "other"]`, and `distortion_mlp` maps a
DAC embedding plus 9 DSP features to five independent distortion labels. They
are the project's own work, they are small, and without them the analyser has
no outputs at all.

## Do not re-export the third-party two yourself

It is tempting — both upstreams are public. But `content_mlp` and
`distortion_mlp` were trained against the embeddings that *these exact export
artifacts* produce. A re-export from a different `torch` or `tf2onnx` version
can shift those embeddings slightly, and nothing will raise an error: the
classifiers simply get quieter and wronger. `fetch-models.sh` verifies SHA-256
for that reason. If you must rebuild them, retrain the two MLPs against your
new exports.

## Overriding the paths

`audio_classifiers.py` reads each path from the environment, so a shared or
read-only model store works without touching code:
`YAMNET_MODEL_PATH`, `CONTENT_MODEL_PATH`, `DAC_ENCODER_MODEL_PATH`,
`DISTORTION_MODEL_PATH`.
