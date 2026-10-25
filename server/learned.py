"""
Learned singing score (vocal_scorer): is this clean singing, and how good is it?

Optional: needs torch/transformers and the trained files in data/models. If they are missing,
or VOCALIZE_LEARNED_SCORER=0, sessions are saved without a learned score.
"""
import logging
import os
import threading

log = logging.getLogger(__name__)
_lock = threading.Lock()       # the encoder collects hidden states on itself, so one clip at a time
_scorer = None
_unavailable = False


def _load():
    """Load the scorer once (caller holds _lock). Takes ~35 s or more, mostly importing torch/transformers."""
    global _scorer, _unavailable
    if _scorer is None and not _unavailable:
        from vocal_scorer.model import ENCODER_DIR
        from vocal_scorer.staged import STAGED_PATH, StagedScorer
        if not (os.path.exists(STAGED_PATH) and os.path.isdir(ENCODER_DIR)):
            log.info('Staged scorer files not found; skipping learned scores')
            _unavailable = True
            return
        _scorer = StagedScorer()


def warm_up():
    """Load the scorer in the background at server start, so the first recording doesn't wait for it."""
    if os.environ.get('VOCALIZE_LEARNED_SCORER') == '0':
        return

    def run():
        import time
        t = time.time()
        with _lock:
            try:
                _load()
                log.warning('Learned scorer ready after %.0f s', time.time() - t)
            except Exception:  # noqa: BLE001
                log.exception('Learned scorer failed to load')
    threading.Thread(target=run, name='scorer-warm-up', daemon=True).start()


def learned_score(y, sr):
    """{'singing_probability', 'usable_probability', 'stage_failed', 'learned_score'} or None if unavailable."""
    if _unavailable or os.environ.get('VOCALIZE_LEARNED_SCORER') == '0':
        return None
    with _lock:
        try:
            _load()
            if _scorer is None:
                return None
            out = _scorer.score(y, sr)
            # skill is only scored when the clip passed singing detection and usability
            return {**out, 'learned_score': out['skill_score']}
        except Exception:  # noqa: BLE001 - the rule-based report still works without it
            log.exception('Learned scorer failed')
            return None
