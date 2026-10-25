"""Download the evaluation datasets from Hugging Face into data/datasets/ (resumable)."""
import os

from huggingface_hub import snapshot_download

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPOS = {
    'ccmusic-database/acapella': 'acapella',   # CC BY-NC-ND 4.0: research use, do not redistribute
    'TangRain/SingMOS-Pro': 'singmos_pro',     # CC BY 4.0
    'TangRain/SingMOS': 'singmos',             # CC BY 4.0
}

for repo, folder in REPOS.items():
    path = snapshot_download(repo, repo_type='dataset', max_workers=8,
                             local_dir=os.path.join(ROOT, 'data', 'datasets', folder))
    print('done', repo, '->', path, flush=True)
