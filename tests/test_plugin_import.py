"""Exercise Decky's importlib loading without the plugin directory on sys.path."""
import subprocess
import sys
import unittest
from pathlib import Path


class PluginImportTests(unittest.TestCase):
    def test_import_from_outside_plugin_directory(self):
        main = Path(__file__).resolve().parents[1] / "main.py"
        script = """
import importlib.util, logging, sys, types
# Model a frozen loader that has already imported html but omitted its parser.
import html
html.__path__[:] = []
sys.modules.pop('html.parser', None)
sys.modules['decky'] = types.SimpleNamespace(
    DECKY_PLUGIN_SETTINGS_DIR='/tmp/solodeck-test-settings',
    DECKY_PLUGIN_RUNTIME_DIR='/tmp/solodeck-test-runtime',
    logger=logging.getLogger('solodeck-test'))
spec = importlib.util.spec_from_file_location('decky_plugin_test', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.Plugin
import html.parser
assert 'vendor/python-stdlib/html/parser.py' in html.parser.__file__
"""
        result = subprocess.run([sys.executable, "-I", "-c", script, str(main)],
                                cwd="/tmp", capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
