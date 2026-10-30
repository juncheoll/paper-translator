"""Download the pinned layout model for a Docling API server (no Chrome registration)."""
import argparse
import sys
import threading
from pathlib import Path
from docling_native_host import DoclingHelper, MODEL


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifacts', type=Path, required=True, help='Model directory passed to docling_service.py')
    args = parser.parse_args()
    helper = DoclingHelper(Path(__file__).resolve().parent.parent,
                          {'allowedOrigins': [], 'python': sys.executable})
    helper.models = args.artifacts.expanduser().resolve()
    helper.model_directory = helper.models / MODEL.replace('/', '--')
    helper.download_models(threading.Event(), lambda event: print(
        event.get('message', ''), event.get('loaded', 0), '/', event.get('total', '?'), flush=True))
    if not helper.model_ready():
        raise SystemExit('Model preparation was incomplete.')
    print('Prepared:', helper.models)


if __name__ == '__main__':
    main()
