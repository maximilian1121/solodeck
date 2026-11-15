"""Verify download progress remains observable while network I/O is blocked."""
import asyncio
import importlib.util
import io
import logging
import sys
import tarfile
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.modules.setdefault("decky", types.SimpleNamespace(
    DECKY_PLUGIN_SETTINGS_DIR="/tmp/solodeck-test-settings",
    DECKY_PLUGIN_RUNTIME_DIR="/tmp/solodeck-test-runtime",
    logger=logging.getLogger("solodeck-test"),
))
spec = importlib.util.spec_from_file_location("solodeck_download_test", Path(__file__).resolve().parents[1] / "main.py")
main = importlib.util.module_from_spec(spec)
spec.loader.exec_module(main)


class DownloadTests(unittest.IsolatedAsyncioTestCase):
    async def test_progress_is_available_during_a_blocking_download(self):
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w:gz") as tar:
            payload = b"#!/bin/sh\nexit 0\n"
            entry = tarfile.TarInfo("soloist")
            entry.size, entry.mode = len(payload), 0o755
            tar.addfile(entry, io.BytesIO(payload))
        data = archive.getvalue()
        blocked = threading.Event()
        release = threading.Event()

        class Response:
            headers = {"content-length": str(len(data))}
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def __init__(self): self.reads = 0
            def read(self, _size):
                self.reads += 1
                if self.reads == 1: return data[:10]
                if self.reads == 2:
                    blocked.set()
                    if not release.wait(3): raise TimeoutError("test timed out")
                    return data[10:]
                return b""

        with tempfile.TemporaryDirectory() as directory:
            with patch.object(main, "_soloist_root", return_value=directory), \
                 patch.object(main, "_soloist_bin", return_value=str(Path(directory) / "soloist")), \
                 patch.object(main.urllib.request, "urlopen", return_value=Response()):
                plugin = main.Plugin()
                try:
                    await plugin.download_soloist()
                    self.assertTrue(await asyncio.to_thread(blocked.wait, 2))
                    status = await asyncio.wait_for(plugin.get_download_status(), 1)
                    self.assertEqual(status["status"], main.DL_DOWNLOADING)
                    self.assertEqual(status["downloaded"], 10)
                    self.assertGreater(status["percent"], 0)
                finally:
                    release.set()
                await plugin._download_task
                self.assertEqual((await plugin.get_download_status())["status"], main.DL_DONE)
                self.assertTrue((Path(directory) / "soloist").is_file())


if __name__ == "__main__":
    unittest.main()
