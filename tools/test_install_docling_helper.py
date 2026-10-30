import base64
import json
import os
from pathlib import Path
import shlex
import stat
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import install_docling_helper as setup


class InstallerTests(unittest.TestCase):
    def fixture(self, directory):
        root = Path(directory).resolve() / 'beta files'
        (root / 'tools').mkdir(parents=True)
        for name in setup.SOURCE_FILES:
            (root / 'tools' / name).write_text('fixture' if not name.endswith('.txt') else 'docling==2.144.0\n')
        (root / 'extension').mkdir()
        (root / 'extension/manifest.json').write_text(json.dumps({'key': base64.b64encode(b'fixture public key').decode()}))
        home = Path(directory).resolve() / "user's helper with spaces"
        manifests = Path(directory).resolve() / 'chrome data/NativeMessagingHosts'
        return root, home, manifests

    @patch.object(setup, 'run')
    def test_installs_own_files_and_atomic_origin_registration_without_source_path_dependency(self, command):
        with tempfile.TemporaryDirectory() as directory:
            root, home, manifests = self.fixture(directory)
            result = setup.install(root, home, python=sys.executable, skip_dependencies=True,
                                   manifest_dir=manifests, platform_name='darwin')
            identity = setup.extension_id(root)
            manifest = json.loads(Path(result['manifest']).read_text())
            config = json.loads((home / 'config.json').read_text())
            self.assertEqual(manifest['allowed_origins'], [f'chrome-extension://{identity}/'])
            self.assertEqual(config['allowedOrigins'], [f'chrome-extension://{identity}'])
            self.assertEqual(manifest['path'], str(home / 'native-host'))
            self.assertEqual(stat.S_IMODE((home / 'native-host').stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(Path(result['manifest']).stat().st_mode), 0o600)
            launcher = (home / 'native-host').read_text()
            parsed = shlex.split(launcher.split('exec ', 1)[1])
            self.assertEqual(parsed[1], str(home / 'tools/docling_native_host.py'))
            self.assertNotIn(str(root), launcher)
            self.assertFalse((home / 'venv').exists())
            self.assertTrue((home / 'models').is_dir())
            self.assertEqual(len(command.call_args_list), 2)

    @patch.object(setup, 'run')
    def test_existing_venv_python_path_is_not_resolved_away(self, command):
        with tempfile.TemporaryDirectory() as directory:
            root, home, manifests = self.fixture(directory)
            prepared = Path(directory) / 'prepared/bin/python'
            prepared.parent.mkdir(parents=True)
            prepared.symlink_to(sys.executable)
            setup.install(root, home, python=prepared, skip_dependencies=True, manifest_dir=manifests)
            self.assertEqual(command.call_args_list[0].args[0][0], prepared)
            self.assertEqual(json.loads((home / 'config.json').read_text())['python'], str(prepared))

    def test_extension_id_derives_from_manifest_and_rejects_invalid_explicit_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            root, _, _ = self.fixture(directory)
            actual = setup.extension_id(root)
            self.assertEqual(len(actual), 32)
            self.assertRegex(actual, '^[a-p]{32}$')
            self.assertEqual(setup.extension_id(root, 'a' * 32), 'a' * 32)
            for bad in ('', 'a' * 31, 'z' * 32, 'a' * 32 + '/../../run'):
                with self.assertRaises(ValueError):
                    setup.extension_id(root, bad)

    @patch.object(setup, 'run')
    def test_refuses_to_replace_foreign_registration_or_helper_directory(self, command):
        with tempfile.TemporaryDirectory() as directory:
            root, home, manifests = self.fixture(directory)
            manifests.mkdir(parents=True)
            target = manifests / f'{setup.HOST}.json'
            target.write_text(json.dumps({'name': setup.HOST, 'path': '/someone/else'}))
            with self.assertRaisesRegex(ValueError, 'different native host'):
                setup.install(root, home, python=sys.executable, skip_dependencies=True, manifest_dir=manifests)
            self.assertFalse(home.exists())
            target.unlink()
            (home / 'tools').mkdir(parents=True)
            with self.assertRaisesRegex(ValueError, 'unknown helper files'):
                setup.install(root, home, python=sys.executable, skip_dependencies=True, manifest_dir=manifests)
            self.assertFalse(command.called)

    @patch.object(setup, 'run')
    def test_uninstall_removes_registration_and_only_owned_files_preserving_models_by_default(self, command):
        with tempfile.TemporaryDirectory() as directory:
            root, home, manifests = self.fixture(directory)
            result = setup.install(root, home, python=sys.executable, skip_dependencies=True,
                                   manifest_dir=manifests, platform_name='darwin')
            (home / 'models/preserved').write_text('cached weights')
            (home / 'unrelated.txt').write_text('keep')
            state = setup.uninstall(home, platform_name='darwin')
            self.assertTrue(state['unregistered'])
            self.assertFalse(Path(result['manifest']).exists())
            self.assertFalse((home / 'tools').exists())
            self.assertTrue((home / 'models/preserved').exists())
            self.assertTrue((home / 'unrelated.txt').exists())

    @patch.object(setup, 'run')
    def test_uninstall_does_not_remove_registration_changed_by_another_application(self, command):
        with tempfile.TemporaryDirectory() as directory:
            root, home, manifests = self.fixture(directory)
            result = setup.install(root, home, python=sys.executable, skip_dependencies=True, manifest_dir=manifests)
            target = Path(result['manifest'])
            target.write_text(json.dumps({'name': setup.HOST, 'path': '/someone/else'}))
            with self.assertRaisesRegex(ValueError, 'another native host'):
                setup.uninstall(home)
            self.assertTrue((home / 'tools').exists())
            self.assertTrue(target.exists())

    @patch.object(setup, 'windows_register')
    @patch.object(setup, 'run')
    def test_windows_manifest_and_batch_quoting(self, command, register):
        with tempfile.TemporaryDirectory() as directory:
            root, home, manifests = self.fixture(directory)
            result = setup.install(root, home, selected_id='b' * 32, python=sys.executable, skip_dependencies=True,
                                   manifest_dir=manifests, platform_name='win32')
            self.assertEqual(register.call_args.args[0], Path(result['manifest']))
            launcher = (home / 'native-host.cmd').read_text()
            self.assertIn('DisableDelayedExpansion', launcher)
            self.assertIn('" --home "', launcher)
            self.assertTrue(launcher.rstrip().endswith('%*'))
            escaped = setup.launcher_text('C:\\User%PATH%\\python.exe', 'C:\\Helper', 'win32')
            self.assertIn('User%%PATH%%', escaped)

    def test_windows_registry_refuses_foreign_registration_without_writing(self):
        registry = MagicMock()
        registry.QueryValueEx.return_value = ('C:\\AnotherApp\\host.json', 1)
        with patch.dict(sys.modules, {'winreg': registry}):
            with self.assertRaisesRegex(ValueError, 'different native host'):
                setup.windows_register(Path('C:/Expected/host.json'))
            with self.assertRaisesRegex(ValueError, 'another native host'):
                setup.windows_register(Path('C:/Expected/host.json'), remove=True)
        registry.CreateKey.assert_not_called()
        registry.DeleteKey.assert_not_called()

    def test_default_homes_and_linux_native_manifest_follow_per_user_locations(self):
        self.assertEqual(setup.default_home('darwin', {}, '/users/test'), Path('/users/test/Library/Application Support/PaperTranslator/Docling'))
        self.assertEqual(setup.default_home('linux', {'XDG_DATA_HOME': '/data'}, '/users/test'), Path('/data/paper-translator/docling'))
        self.assertEqual(setup.default_home('win32', {'LOCALAPPDATA': '/local'}, '/users/test'), Path('/local/PaperTranslator/Docling'))
        self.assertEqual(setup.registration_path('/helper', 'darwin', user_home='/users/test'), Path('/users/test/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.papertranslator.docling.json'))


if __name__ == '__main__':
    unittest.main()
