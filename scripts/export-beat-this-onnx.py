#!/usr/bin/env python3
"""
Re-create scripts/models/beat_this_small0.onnx from the upstream checkpoint.

NOT needed to run the app: scripts/fetch-models.sh downloads the exported file.
This is the provenance — how that file was made, so it can be checked or
redone. Needs torch, onnx, onnxscript and beat_this
(pip install "git+https://github.com/CPJKU/beat_this.git" onnx onnxscript).

Two things that cost time on 2026-10-08:
  * The legacy exporter (dynamo=False) produced WRONG logits (max diff 5-8)
    with no error. Use dynamo=True; the parity check below must pass.
  * The model returns a dict; it is wrapped to return (beat, downbeat).
"""
import sys
import numpy as np
import torch
from beat_this.inference import load_model

OUT = sys.argv[1] if len(sys.argv) > 1 else "scripts/models/beat_this_small0.onnx"


class Wrapped(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):
        o = self.m(x)
        return o["beat"], o["downbeat"]


model = Wrapped(load_model("small0", "cpu")).eval()
example = torch.rand(1, 1500, 128) * 3
T = torch.export.Dim("T", min=16, max=1500)
torch.onnx.export(model, (example,), OUT, input_names=["spect"], output_names=["beat", "downbeat"],
                  dynamic_shapes={"x": {1: T}}, dynamo=True, opset_version=18, external_data=False)

import onnxruntime as ort
sess = ort.InferenceSession(OUT, providers=["CPUExecutionProvider"])
for n in (1500, 500, 77):
    x = torch.rand(1, n, 128) * 3
    with torch.inference_mode():
        ref = model(x)
    got = sess.run(None, {"spect": x.numpy()})
    diff = max(float(np.abs(got[i] - ref[i].numpy()).max()) for i in (0, 1))
    print(f"T={n}: max |onnx - torch| = {diff:.2e}")
    assert diff < 1e-3, "export does not match the torch model"
print(f"wrote {OUT}")
