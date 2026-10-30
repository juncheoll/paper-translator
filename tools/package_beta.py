"""Package an already-built Paper Translator beta without private data or model weights."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import zipfile

SUPPORT = (
    'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
    'doc/server.md', 'doc/privacy.md', 'doc/testing.md', 'doc/beta-smoke.pdf',
    'config/extension-id.txt',
    'tools/install-docling-macos.command', 'tools/install-docling-linux.sh',
    'tools/install-docling-windows.cmd', 'tools/install-docling-windows.ps1',
    'tools/install_docling_helper.py', 'tools/docling_native_host.py',
    'tools/docling_service.py', 'tools/requirements-docling.txt',
    'tools/prepare_docling_server.py', 'tools/docling-server.service',
    'tools/docling-server.env.example', 'tools/nginx-docling.conf.example',
)
REQUIRED = ('manifest.json', 'background.js', 'pdf_open.js', 'viewer.js', 'popup.js',
            'settings.js', 'offscreen.js', 'settings.html', 'popup.html', 'help.html',
            'pdfjs/web/viewer.html', 'pdfjs/build/pdf.mjs', 'pdfjs/build/pdf.worker.mjs',
            'browser-ai/wllama.wasm', 'browser-ai/llama-worker.js', 'browser-ai/opfs-worker.js',
            'LICENSE', 'THIRD_PARTY_NOTICES.md')
FORBIDDEN = ('.gguf', '.safetensors', '.pyc', '.pem', '.key')
PREFIX = 'paper-translator-beta'


def collect(root):
    root = root.resolve()
    build = root / 'build'
    for relative in REQUIRED:
        if not (build / relative).is_file():
            raise ValueError(f'Missing build file: {relative}; run npm run build')
    manifest = json.loads((build / 'manifest.json').read_text())
    if manifest.get('name') != 'Paper Translator' or manifest.get('manifest_version') != 3:
        raise ValueError('Unexpected extension manifest')
    if any(name in manifest.get('permissions', []) for name in ['tts', 'search', 'fontSettings']):
        raise ValueError('Legacy extension permissions found')
    files = [(file, f'{PREFIX}/extension/{file.relative_to(build).as_posix()}')
             for file in sorted(build.rglob('*')) if file.is_file()]
    for relative in SUPPORT:
        file = root / relative
        if not file.is_file():
            raise ValueError(f'Missing release support file: {relative}')
        files.append((file, f'{PREFIX}/{relative}'))
    for file, _ in files:
        if file.is_symlink() or not file.resolve().is_relative_to(root) or file.suffix.lower() in FORBIDDEN:
            raise ValueError(f'Unsafe release file: {file}')
    token_example = (root / 'tools/docling-server.env.example').read_text()
    if any(line.startswith('PAPER_DOCLING_TOKEN=') and line.split('=', 1)[1].strip() for line in token_example.splitlines()):
        raise ValueError('The token example must be empty')
    return manifest, files


def package(root, output):
    manifest, files = collect(root)
    checksum = output.with_name(output.name + '.sha256')
    if output.exists() or checksum.exists():
        raise FileExistsError('Release files already exist; choose a new output name')
    output.parent.mkdir(parents=True, exist_ok=True)
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9)))
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for file, name in files:
            archive.write(file, name)
        archive.writestr(f'{PREFIX}/BETA_BUILD.json', json.dumps({
            'name': manifest['name'], 'version': manifest['version'], 'builtAt': now.isoformat(),
            'freshPcValidation': 'pending', 'actualChromeWebGpuValidation': 'pending',
        }, indent=2) + '\n')
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    checksum.write_text(f'{digest}  {output.name}\n')
    return {'path': str(output), 'bytes': output.stat().st_size, 'files': len(files) + 1, 'sha256': digest}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    stamp = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).strftime('%Y%m%d-%H%M%S')
    output = args.output or root / 'release' / f'paper-translator-beta-{stamp}.zip'
    print(json.dumps(package(root, output.resolve()), indent=2))
