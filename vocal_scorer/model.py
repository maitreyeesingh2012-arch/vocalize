"""
Learned singing-quality scorer for Vocalize.

A frozen pretrained music encoder (MERT-v1-95M) turns audio into per-layer embeddings;
a small trained head turns those into
  - gate:     probability the clip is clean singing (not speech / noise / screaming / heavy noise)
  - quality:  how good the singing is (trained with margin ranking on expert ratings)
  - aspects:  predictions of the expert sub-ratings (pitch, rhythm, ..., breath, overall)
Final score (0–100) = 100 · gate · quality, so non-singing can't score well however
steady its pitch looks. Training: scripts/learned_build.py, scripts/learned_train.py.
"""
import os

import numpy as np

ENCODER_SR = 24000
WINDOW_S = 10.0
MAX_WINDOWS = 2          # ponytail: 2×10 s per clip keeps CPU encoding to a few hours; raise with a GPU
N_LAYERS, DIM = 13, 768
ASPECTS = ['pitch', 'rhythm', 'vocal_range', 'timbre', 'pronunciation', 'vibrato', 'dynamic',
           'breath_control', 'overall_performance']

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENCODER_DIR = os.environ.get('VOCALIZE_ENCODER', os.path.join(ROOT, 'data', 'models', 'MERT-v1-95M'))
HEAD_PATH = os.environ.get('VOCALIZE_SCORER', os.path.join(ROOT, 'data', 'models', 'vocalize_scorer.pt'))


def build_head():
    import torch
    from torch import nn

    class ScorerHead(nn.Module):
        def __init__(self):
            super().__init__()
            self.layer_logits = nn.Parameter(torch.zeros(N_LAYERS))      # learned mix of encoder layers
            self.body = nn.Sequential(nn.LayerNorm(DIM), nn.Dropout(0.2), nn.Linear(DIM, 256), nn.GELU(),
                                      nn.Dropout(0.2), nn.Linear(256, 128), nn.GELU())
            self.gate = nn.Linear(128, 1)
            self.quality = nn.Linear(128, 1)
            self.aspects = nn.Linear(128, len(ASPECTS))

        def forward(self, x):                      # x: [B, 13, 768] (one window, or windows averaged)
            h = (torch.softmax(self.layer_logits, 0)[None, :, None] * x).sum(1)
            h = self.body(h)
            return self.gate(h).squeeze(-1), self.quality(h).squeeze(-1), torch.sigmoid(self.aspects(h))

    return ScorerHead()


class Encoder:
    """Frozen MERT encoder: audio → [windows, 13, 768] (time-averaged hidden states per layer)."""

    def __init__(self, path=ENCODER_DIR):
        import torch
        from transformers import AutoModel, Wav2Vec2FeatureExtractor
        self.torch = torch
        self.model = AutoModel.from_pretrained(path, trust_remote_code=True).eval()
        self.proc = Wav2Vec2FeatureExtractor.from_pretrained(path, trust_remote_code=True)
        # Collect the input to the first transformer layer and every layer's output with hooks:
        # newer `transformers` versions no longer return hidden_states from MERT's custom code.
        self._states = []
        layers = self.model.encoder.layers
        layers[0].register_forward_pre_hook(lambda m, args: self._states.append(args[0]))
        for layer in layers:
            layer.register_forward_hook(lambda m, args, out: self._states.append(out[0] if isinstance(out, tuple) else out))

    def embed(self, y, sr):
        import librosa
        if sr != ENCODER_SR:
            y = librosa.resample(np.asarray(y, dtype=np.float32), orig_sr=sr, target_sr=ENCODER_SR)
        win = int(WINDOW_S * ENCODER_SR)
        starts = list(range(0, max(1, len(y) - win // 2), win))[:MAX_WINDOWS] or [0]
        out = []
        with self.torch.no_grad():
            for s in starts:
                seg = y[s:s + win]
                if len(seg) < ENCODER_SR * 1.0:          # ignore sub-second tails
                    continue
                inp = self.proc(seg, sampling_rate=ENCODER_SR, return_tensors='pt')
                self._states = []
                self.model(**inp)
                out.append(self.torch.stack(self._states[:N_LAYERS]).squeeze(1).mean(1).numpy())   # [13, 768]
        return np.stack(out) if out else np.zeros((1, N_LAYERS, DIM), dtype=np.float32)


class LearnedScorer:
    """Loads encoder + trained head once; score(y, sr) → dict for the app."""

    def __init__(self, head_path=HEAD_PATH, encoder_dir=ENCODER_DIR):
        import torch
        self.torch = torch
        self.encoder = Encoder(encoder_dir)
        ckpt = torch.load(head_path, map_location='cpu', weights_only=False)
        self.head = build_head()
        self.head.load_state_dict(ckpt['state_dict'])
        self.head.eval()
        self.q_lo, self.q_hi = ckpt['quality_range']      # calibration of the raw quality to 0..1
        self.q_knots = ckpt.get('quality_knots')           # everyday-singer rescaling (scripts/learned_rescale.py)
        self.q_floor = ckpt.get('quality_floor', 0.0)

    def score(self, y, sr):
        emb = self.torch.tensor(self.encoder.embed(y, sr), dtype=self.torch.float32)
        with self.torch.no_grad():
            g, q, a = self.head(emb)
        gate = float(self.torch.sigmoid(g).mean())
        if self.q_knots:
            pct = float(np.interp(q.mean().item(), self.q_knots, np.linspace(0, 1, len(self.q_knots))))
            quality = self.q_floor + (1 - self.q_floor) * pct
        else:
            quality = float(np.clip((q.mean().item() - self.q_lo) / (self.q_hi - self.q_lo), 0, 1))
        return {
            'singing_probability': round(gate, 3),
            'quality': round(quality, 3),
            'learned_score': round(100 * gate * quality, 1),
            'aspects': {k: round(float(v) * 10, 1) for k, v in zip(ASPECTS, a.mean(0).tolist())},   # 1–10 like the experts
        }
