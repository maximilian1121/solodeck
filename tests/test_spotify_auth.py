import asyncio
import importlib.util
import logging
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

# Decky is supplied by the host at runtime.
if "decky" not in sys.modules:
    sys.modules["decky"] = types.SimpleNamespace(
        DECKY_PLUGIN_SETTINGS_DIR="/tmp/solodeck-test-settings",
        DECKY_PLUGIN_RUNTIME_DIR="/tmp/solodeck-test-runtime",
        DECKY_PLUGIN_DIR=".", logger=logging.getLogger("solodeck-test"),
    )
spec = importlib.util.spec_from_file_location("solodeck_main_auth_test", Path(__file__).resolve().parents[1] / "main.py")
main = importlib.util.module_from_spec(spec)
spec.loader.exec_module(main)


class SpotifyAuthTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.plugin = main.Plugin()
        self.client = types.SimpleNamespace(close=AsyncMock())
        self.open_client = AsyncMock(return_value=self.client)
        self.client_patch = patch.object(main.AsyncClient, "from_cookies", self.open_client)
        self.client_patch.start()
        self.addCleanup(self.client_patch.stop)

    async def test_valid_cookie_is_validated_and_session_only(self):
        result = await self.plugin.connect_spotify("example")
        self.assertEqual(result, {"ok": True, "persistent": False})
        self.open_client.assert_awaited_once_with("sp_dc=example")
        self.client.close.assert_awaited_once()
        self.assertTrue(await self.plugin.get_auth_status())
        self.assertFalse(await main.Plugin().get_auth_status())

    async def test_rejects_invalid_and_failed_validation_without_saving(self):
        self.assertFalse((await self.plugin.connect_spotify("bad;value"))["ok"])
        self.open_client.assert_not_awaited()
        self.open_client.side_effect = ValueError("secret must not be exposed")
        result = await self.plugin.connect_spotify("bad")
        self.assertFalse(result["ok"])
        self.assertNotIn("secret", result["error"])
        self.assertIsNone(self.plugin._spotify_session_cookie)

    async def test_logout_clears_session(self):
        self.plugin._spotify_session_cookie = "sp_dc=example"
        self.assertEqual(await self.plugin.logout_spotify(), {"ok": True})
        self.assertIsNone(await self.plugin._spotify_cookie())

    async def test_protected_session_save_unlock_and_forget(self):
        class Store:
            def __init__(self): self.value = None
            def exists(self): return self.value is not None
            def save(self, cookie, password): self.value = (cookie, password)
            def unlock(self, password):
                if not self.value or password != self.value[1]:
                    raise ValueError("sensitive detail")
                return self.value[0]
            def clear(self): self.value = None
        store = Store()
        self.plugin._spotify_password_store = lambda: store
        self.assertFalse((await self.plugin.save_spotify_session("pass"))["ok"])
        self.plugin._spotify_session_cookie = "sp_dc=example"
        self.assertEqual(await self.plugin.save_spotify_session("pass"), {"ok": True})
        self.assertTrue((await self.plugin.get_spotify_saved_session_status())["saved"])
        await self.plugin.logout_spotify()
        self.assertTrue((await self.plugin.get_spotify_saved_session_status())["saved"])
        wrong = await self.plugin.unlock_spotify_session("wrong")
        self.assertFalse(wrong["ok"])
        self.assertNotIn("sensitive", wrong["error"])
        self.assertFalse(await self.plugin.get_auth_status())
        self.assertTrue((await self.plugin.unlock_spotify_session("pass"))["ok"])
        self.open_client.assert_awaited_once_with("sp_dc=example")
        self.assertEqual(await self.plugin.forget_spotify_session(), {"ok": True})
        self.assertFalse((await self.plugin.get_spotify_saved_session_status())["saved"])

    async def test_unlocked_but_expired_session_is_not_connected(self):
        store = types.SimpleNamespace(unlock=lambda _: "sp_dc=expired")
        self.plugin._spotify_password_store = lambda: store
        self.open_client.side_effect = ValueError("expired")
        self.assertFalse((await self.plugin.unlock_spotify_session("pass"))["ok"])
        self.assertFalse(await self.plugin.get_auth_status())

    async def test_browser_login_exposes_status_without_cookie(self):
        with patch.object(main, "browser_login_cookie", AsyncMock(return_value="sp_dc=example")):
            self.assertTrue((await self.plugin.start_spotify_browser_login())["ok"])
            await self.plugin._browser_login_task
        self.assertEqual(await self.plugin.get_spotify_browser_login_status(),
                         {"status": "connected", "persistent": False})
        self.assertNotIn("example", str(await self.plugin.get_spotify_browser_login_status()))

    async def test_browser_login_cancel_and_failure(self):
        entered = asyncio.Event()
        async def waiting():
            entered.set()
            await asyncio.Event().wait()
        with patch.object(main, "browser_login_cookie", waiting):
            await self.plugin.start_spotify_browser_login()
            await entered.wait()
            self.assertFalse((await self.plugin.start_spotify_browser_login())["ok"])
            await self.plugin.cancel_spotify_browser_login()
        self.assertEqual((await self.plugin.get_spotify_browser_login_status())["status"], "cancelled")
        with patch.object(main, "browser_login_cookie", AsyncMock(side_effect=RuntimeError("secret"))):
            await self.plugin.start_spotify_browser_login()
            await self.plugin._browser_login_task
        status = await self.plugin.get_spotify_browser_login_status()
        self.assertEqual(status["status"], "error")
        self.assertNotIn("secret", str(status))

    async def test_logout_resets_browser_status(self):
        self.plugin._browser_login_status = {"status": "connected"}
        await self.plugin.logout_spotify()
        self.assertEqual((await self.plugin.get_spotify_browser_login_status())["status"], "idle")


if __name__ == "__main__":
    unittest.main()
