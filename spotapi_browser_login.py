"""User-initiated, isolated Spotify browser login using SpotAPI's helper.

Playwright and its Chromium runtime are optional dependencies. SpotAPI creates
and closes a fresh browser context for the login; this module never reads the
user's existing browser profile or persists the resulting session itself.
"""
from spotapi import SavedSession, browser_login
from spotapi.models.sessions import SessionInfo


class _CapturedSession(SavedSession):
    """Receive the validated cookie without writing to a credential store."""

    __slots__ = ("cookie",)

    def __init__(self):
        super().__init__("solodeck-browser-login")
        self.cookie: str | None = None

    def info(self) -> SessionInfo:
        # Always open a fresh browser, rather than loading an existing session.
        return SessionInfo(self.name, False)

    def save(self, cookie: str) -> None:
        if not isinstance(cookie, str) or not cookie or any(c in cookie for c in "\r\n;"):
            raise ValueError("Spotify returned an invalid session.")
        self.cookie = cookie


async def browser_login_cookie(*, timeout: float = 180) -> str:
    """Return a newly authorized cookie after the user signs in to Spotify.

    The caller owns secure persistence and must never log the returned value.
    Missing browser dependencies and browser launch failures propagate; the UI
    should offer its manual connection option when this feature is unavailable.
    Cancellation propagates through SpotAPI, which closes the temporary browser.
    """
    captured = _CapturedSession()
    client = await browser_login(saved=captured, timeout=timeout)
    try:
        if not captured.cookie:
            raise RuntimeError("Spotify did not return a session.")
        return "sp_dc=" + captured.cookie
    finally:
        await client.close()
