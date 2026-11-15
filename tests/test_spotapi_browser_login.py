"""Contract tests for the optional isolated browser-login wrapper."""
import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'py_modules'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import spotapi_browser_login as login


class BrowserLoginTests(unittest.IsolatedAsyncioTestCase):
    async def test_fresh_session_and_client_cleanup(self):
        client = SimpleNamespace(close=AsyncMock())
        async def fake_login(*, saved, timeout):
            self.assertFalse(saved.info().present)
            self.assertEqual(timeout, 42)
            saved.save('example')
            return client
        with patch.object(login, 'browser_login', fake_login):
            cookie = await login.browser_login_cookie(timeout=42)
        self.assertEqual(cookie, 'sp_dc=example')
        client.close.assert_awaited_once()

    async def test_missing_cookie_closes_client(self):
        client = SimpleNamespace(close=AsyncMock())
        with patch.object(login, 'browser_login', AsyncMock(return_value=client)):
            with self.assertRaisesRegex(RuntimeError, 'did not return'):
                await login.browser_login_cookie()
        client.close.assert_awaited_once()

    async def test_cancellation_propagates(self):
        with patch.object(login, 'browser_login', AsyncMock(side_effect=asyncio.CancelledError)):
            with self.assertRaises(asyncio.CancelledError):
                await login.browser_login_cookie()

    def test_invalid_cookie_rejected(self):
        with self.assertRaises(ValueError):
            login._CapturedSession().save('bad;cookie')


if __name__ == '__main__':
    unittest.main()
