"""Install the per-user Docling native host; normally launched by the OS installer."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile

HOST = 'com.papertranslator.docling'
OWNER = 'paper-translator-docling-helper-v1'
SOURCE_FILES = ('docling_service.py', 'docling_native_host.py', 'requirements-docling.txt', 'install_docling_helper.py')


def default_home(platform_name=None, environ=None, user_home=None):
    platform_name = platform_name or sys.platform
    environ = os.environ if environ is None else environ
    user_home = Path.home() if user_home is None else Path(user_home)
    if environ.get('PAPER_DOCLING_HOME'):
        return Path(environ['PAPER_DOCLING_HOME']).expanduser()
    if platform_name == 'darwin':
        return user_home / 'Library/Application Support/PaperTranslator/Docling'
    if platform_name == 'win32':
        return Path(environ.get('LOCALAPPDATA', user_home / 'AppData/Local')) / 'PaperTranslator/Docling'
    return Path(environ.get('XDG_DATA_HOME', user_home / '.local/share')) / 'paper-translator/docling'


def extension_id(root, explicit=None):
    if explicit is not None:
        if not re.fullmatch('[a-p]{32}', explicit):
            raise ValueError('Extension ID must contain exactly 32 letters a-p')
        return explicit
    for relative in ('extension/manifest.json', 'public/manifest.json', 'build/manifest.json'):
        path = Path(root) / relative
        if path.is_file():
            value = json.loads(path.read_text(encoding='utf-8'))
            if value.get('key'):
                digest = hashlib.sha256(base64.b64decode(value['key'], validate=True)).hexdigest()[:32]
                return ''.join(chr(ord('a') + int(char, 16)) for char in digest)
    raise ValueError('No manifest key found; pass --extension-id from chrome://extensions')


def registration_path(home, platform_name=None, manifest_dir=None, user_home=None):
    platform_name = platform_name or sys.platform
    user_home = Path.home() if user_home is None else Path(user_home)
    if manifest_dir is not None:
        return Path(manifest_dir) / f'{HOST}.json'
    if platform_name == 'win32':
        return Path(home) / f'{HOST}.json'
    if platform_name == 'darwin':
        return user_home / f'Library/Application Support/Google/Chrome/NativeMessagingHosts/{HOST}.json'
    return Path(os.environ.get('XDG_CONFIG_HOME', user_home / '.config')) / f'google-chrome/NativeMessagingHosts/{HOST}.json'


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(value, stream, ensure_ascii=False, indent=2)
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def launcher_text(python, home, platform_name=None):
    platform_name = platform_name or sys.platform
    host = Path(home) / 'tools/docling_native_host.py'
    if platform_name == 'win32':
        values = [str(python), str(host), str(home)]
        if any('"' in value or '\n' in value or '\r' in value for value in values):
            raise ValueError('Invalid Windows installation path')
        python, host, home = (value.replace('%', '%%') for value in values)
        return ('@echo off\r\nsetlocal DisableDelayedExpansion\r\nset PYTHONUTF8=1\r\nset PYTHONUNBUFFERED=1\r\n'
                f'"{python}" "{host}" --home "{home}" %*\r\n')
    return '#!/bin/sh\nexec ' + ' '.join(shlex.quote(str(value)) for value in (python, host, '--home', home)) + ' "$@"\n'


def windows_register(manifest, remove=False):
    import winreg
    key_path = rf'Software\Google\Chrome\NativeMessagingHosts\{HOST}'
    if remove:
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
                current = winreg.QueryValueEx(key, '')[0]
            if os.path.normcase(current) != os.path.normcase(str(manifest)):
                raise ValueError('Refusing to remove another native host registration')
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
        except FileNotFoundError:
            pass
    else:
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
                current = winreg.QueryValueEx(key, '')[0]
            if os.path.normcase(current) != os.path.normcase(str(manifest)):
                raise ValueError('A different native host is already registered with this name')
        except FileNotFoundError:
            pass
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            winreg.SetValueEx(key, '', 0, winreg.REG_SZ, str(manifest))


def run(command):
    subprocess.run([str(value) for value in command], check=True)


def check_python(python):
    run([python, '-c', 'import sys; assert sys.version_info[:2] == (3, 12), "Python 3.12 is required"'])


def check_packages(python, requirements):
    expected = {}
    for line in requirements.read_text(encoding='utf-8').splitlines():
        if line.strip() and not line.lstrip().startswith('#'):
            name, version = line.strip().split('==')
            expected[name] = version
    script = ('import importlib.metadata as m; expected=' + repr(expected) + '; '
              'bad=[name for name,version in expected.items() if m.version(name).split("+")[0] != version]; '
              'assert not bad, "Unexpected package versions: " + ", ".join(bad)')
    run([python, '-c', script])


def install(root, home=None, selected_id=None, python=None, skip_dependencies=False,
            manifest_dir=None, platform_name=None):
    root = Path(root).resolve()
    if skip_dependencies and python is None:
        raise ValueError('--skip-dependencies requires --python pointing at an existing prepared environment')
    platform_name = platform_name or sys.platform
    home = (Path(home) if home is not None else default_home(platform_name)).expanduser().resolve()
    for name in SOURCE_FILES:
        if not (root / 'tools' / name).is_file():
            raise ValueError(f'Missing tools/{name}; extract the complete beta package first')
    origin = f'chrome-extension://{extension_id(root, selected_id)}'
    manifest = registration_path(home, platform_name, manifest_dir).resolve()
    launcher = home / ('native-host.cmd' if platform_name == 'win32' else 'native-host')
    marker = home / 'installation.json'
    if marker.exists():
        if json.loads(marker.read_text(encoding='utf-8')).get('owner') != OWNER:
            raise ValueError('This installation directory belongs to another program')
    elif any((home / relative).exists() for relative in ('tools', 'venv', 'config.json', launcher.name)):
        raise ValueError('The target contains unknown helper files; choose an empty installation directory')
    if manifest.exists():
        previous = json.loads(manifest.read_text(encoding='utf-8'))
        if previous.get('name') != HOST or previous.get('path') != str(launcher):
            raise ValueError('A different native host is already registered with this name')
    # Keep a venv executable's path: resolving its symlink discards that environment.
    base_python = Path(os.path.abspath(os.path.expanduser(str(python or sys.executable))))
    check_python(base_python)
    home.mkdir(parents=True, exist_ok=True)
    environment = home / 'venv'
    installed_python = base_python if skip_dependencies else environment / ('Scripts/python.exe' if platform_name == 'win32' else 'bin/python')
    # Claim this directory before dependency installation so an interrupted setup can be retried.
    atomic_json(marker, {'owner': OWNER, 'home': str(home), 'manifest': str(manifest), 'launcher': str(launcher),
                         'python': str(installed_python), 'managedEnvironment': not skip_dependencies})
    if not skip_dependencies:
        if not installed_python.is_file():
            run([base_python, '-m', 'venv', environment])
        run([installed_python, '-m', 'pip', 'install', '--upgrade', 'pip'])
        if platform_name in ('win32', 'linux'):
            run([installed_python, '-m', 'pip', 'install', 'torch==2.15.0', 'torchvision==0.29.2',
                 '--index-url', 'https://download.pytorch.org/whl/cpu'])
        run([installed_python, '-m', 'pip', 'install', '-r', root / 'tools/requirements-docling.txt'])
    check_packages(installed_python, root / 'tools/requirements-docling.txt')
    (home / 'tools').mkdir(exist_ok=True)
    for name in SOURCE_FILES:
        destination = home / 'tools' / name
        if (root / 'tools' / name).resolve() != destination.resolve():
            shutil.copyfile(root / 'tools' / name, destination)
    for name in ('models', 'cache', 'logs'):
        (home / name).mkdir(exist_ok=True)
    launcher.write_text(launcher_text(installed_python, home, platform_name), encoding='utf-8', newline='')
    if platform_name != 'win32':
        launcher.chmod(0o700)
    atomic_json(home / 'config.json', {'allowedOrigins': [origin], 'python': str(installed_python)})
    atomic_json(manifest, {'name': HOST, 'description': 'Paper Translator Docling CPU helper',
                          'path': str(launcher), 'type': 'stdio', 'allowed_origins': [origin + '/']})
    if platform_name == 'win32':
        windows_register(manifest)
    atomic_json(marker, {'owner': OWNER, 'home': str(home), 'manifest': str(manifest), 'launcher': str(launcher),
                         'python': str(installed_python), 'managedEnvironment': not skip_dependencies})
    return {'home': str(home), 'manifest': str(manifest), 'extensionId': origin.rsplit('/', 1)[-1]}


def uninstall(home=None, platform_name=None, remove_data=False):
    platform_name = platform_name or sys.platform
    home = (Path(home) if home is not None else default_home(platform_name)).expanduser().resolve()
    marker = home / 'installation.json'
    record = json.loads(marker.read_text(encoding='utf-8'))
    if record.get('owner') != OWNER or record.get('home') != str(home):
        raise ValueError('This is not an owned helper installation')
    manifest, launcher = Path(record['manifest']), Path(record['launcher'])
    expected = home / ('native-host.cmd' if platform_name == 'win32' else 'native-host')
    if launcher != expected:
        raise ValueError('Unexpected native host launcher path')
    if manifest.exists():
        value = json.loads(manifest.read_text(encoding='utf-8'))
        if value.get('name') != HOST or value.get('path') != str(launcher):
            raise ValueError('Refusing to remove another native host registration')
    if platform_name == 'win32':
        windows_register(manifest, remove=True)
    manifest.unlink(missing_ok=True)
    leftovers = []
    for relative in ('tools', 'native-host', 'native-host.cmd', 'config.json', 'venv', 'python', 'bootstrap', 'uv-cache'):
        target = home / relative
        if target.is_symlink():
            target.unlink()
        elif target.is_dir():
            try:
                shutil.rmtree(target)
            except OSError:
                leftovers.append(relative)
        else:
            target.unlink(missing_ok=True)
    if remove_data:
        for relative in ('models', 'cache', 'logs'):
            target = home / relative
            if target.is_symlink():
                target.unlink()
            elif target.is_dir():
                shutil.rmtree(target)
    if not leftovers:
        marker.unlink()
    return {'unregistered': True, 'dataRetained': not remove_data, 'leftovers': leftovers, 'home': str(home)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path)
    parser.add_argument('--extension-id')
    parser.add_argument('--python', type=Path, help='Existing Python 3.12; required with --skip-dependencies')
    parser.add_argument('--skip-dependencies', action='store_true', help='Developer check using a prepared environment')
    parser.add_argument('--chrome-manifest-dir', type=Path, help='Override registration directory for isolated tests')
    parser.add_argument('--uninstall', action='store_true')
    parser.add_argument('--remove-data', action='store_true', help='Also remove helper model/cache/log files during uninstall')
    args = parser.parse_args()
    try:
        result = uninstall(args.home, remove_data=args.remove_data) if args.uninstall else install(
            Path(__file__).resolve().parent.parent, args.home, args.extension_id, args.python,
            args.skip_dependencies, args.chrome_manifest_dir)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        print('Done. Reload the extension and open Settings > Docling helper.' if not args.uninstall else
              'Registration removed. Close Chrome before deleting any remaining runtime files.')
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f'Docling helper setup failed: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
