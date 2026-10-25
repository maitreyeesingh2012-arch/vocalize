"""
Staged Vocalize scorer: three separate small heads on the frozen MERT embeddings.

  1. detection   probability the clip contains human singing (not speech, noise or screaming)
  2. usability   probability the singing is clean enough to score (not buried in noise)
  3. skill       how good the singing is, 0–100; only computed when 1 and 2 both pass

Each head is trained, validated and tested on its own dataset (scripts/staged_build.py,
scripts/staged_train.py). The skill output is mapped onto the experts' own rating distribution,
so scores spread out the way expert ratings do instead of bunching together.
"""
import os

import numpy as np

from .model import DIM, ENCODER_DIR, N_LAYERS, ROOT, Encoder

STAGED_PATH = os.environ.get('VOCALIZE_STAGED', os.path.join(ROOT, 'data', 'models', 'vocalize_staged.pt'))
TASKS = ('detection', 'usability', 'skill')


def build_task_head():
    import torch
    from torch import nn

    class TaskHead(nn.Module):
        def __init__(self):
            super().__init__()
            self.layer_logits = nn.Parameter(torch.zeros(N_LAYERS))      # learned mix of encoder layers
            self.net = nn.Sequential(nn.LayerNorm(DIM), nn.Dropout(0.2), nn.Linear(DIM, 128), nn.GELU(),
                                     nn.Dropout(0.2), nn.Linear(128, 1))

        def forward(self, x):                      # x: [B, 13, 768] → [B] (logit, or raw skill)
            h = (torch.softmax(self.layer_logits, 0)[None, :, None] * x).sum(1)
            return self.net(h).squeeze(-1)

    return TaskHead()


def skill_to_score(raw, knots):
    """Raw skill → 0–100 by matching the experts' rating distribution (quantile mapping)."""
    return float(np.interp(raw, knots['raw'], knots['score']))


class StagedScorer:
    """Loads the encoder and the three heads once; score(y, sr) → dict for the app."""

    def __init__(self, path=STAGED_PATH, encoder_dir=ENCODER_DIR):
        import torch
        self.torch = torch
        self.encoder = Encoder(encoder_dir)
        ckpt = torch.load(path, map_location='cpu', weights_only=False)
        self.heads, self.thresholds = {}, {}
        for task in TASKS:
            head = build_task_head()
            head.load_state_dict(ckpt[task]['state_dict'])
            self.heads[task] = head.eval()
            self.thresholds[task] = ckpt[task].get('threshold')
        self.knots = ckpt['skill']['knots']

    def _run(self, task, emb):
        with self.torch.no_grad():
            return self.heads[task](emb).mean().item()

    def score(self, y, sr):
        emb = self.torch.tensor(self.encoder.embed(y, sr), dtype=self.torch.float32)
        p_sing = 1 / (1 + np.exp(-self._run('detection', emb)))
        p_use = 1 / (1 + np.exp(-self._run('usability', emb)))
        out = {'singing_probability': round(float(p_sing), 3), 'usable_probability': round(float(p_use), 3),
               'stage_failed': None, 'skill_score': None}
        if p_sing < self.thresholds['detection']:
            out['stage_failed'] = 'detection'
        elif p_use < self.thresholds['usability']:
            out['stage_failed'] = 'usability'
        else:
            out['skill_score'] = round(skill_to_score(self._run('skill', emb), self.knots), 1)
        return out
