import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('package_beta', Path(__file__).with_name('package_beta.py'))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class PackageTests(unittest.TestCase):
    def fixture(self, root):
        for relative in mod.REQUIRED:
            file = root / 'build' / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('fixture')
        (root / 'build/manifest.json').write_text(json.dumps({'name': 'Paper Translator', 'manifest_version': 3, 'version': '0.1.0'}))
        for relative in mod.SUPPORT:
            file = root / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('PAPER_DOCLING_TOKEN=\n' if relative.endswith('.env.example') else 'fixture')

    def test_package_and_checksum_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.fixture(root)
            (root / 'private-user-settings.json').write_text('secret')
            result = mod.package(root, root / 'out.zip')
            with zipfile.ZipFile(result['path']) as archive:
                self.assertIsNone(archive.testzip())
                self.assertNotIn('private-user-settings.json', '\n'.join(archive.namelist()))
                self.assertIn('paper-translator-beta/extension/viewer.js', archive.namelist())
            self.assertTrue((root / 'out.zip.sha256').read_text().startswith(result['sha256']))
            with self.assertRaises(FileExistsError):
                mod.package(root, root / 'out.zip')

    def test_model_weights_and_secrets_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.fixture(root)
            (root / 'build/private.gguf').write_bytes(b'model')
            with self.assertRaisesRegex(ValueError, 'Unsafe'):
                mod.collect(root)
            (root / 'build/private.gguf').unlink()
            (root / 'tools/docling-server.env.example').write_text('PAPER_DOCLING_TOKEN=secret\n')
            with self.assertRaisesRegex(ValueError, 'empty'):
                mod.collect(root)

    def test_symlinks_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.fixture(root)
            (root / 'build/link.js').symlink_to(root / 'README.md')
            with self.assertRaisesRegex(ValueError, 'Unsafe'):
                mod.collect(root)


if __name__ == '__main__':
    unittest.main()
