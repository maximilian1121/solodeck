"""Temporary HTTP server for trusted-network Spotify cookie transfer."""
from __future__ import annotations

import asyncio
import fcntl
import html
import ipaddress
import secrets
import socket
import struct
import time
from urllib.parse import parse_qs, urlsplit


class SpotifyPasteServerMixin:
    """Serve a short-lived, one-time Spotify session paste page."""

    def _init_spotify_paste_server(self) -> None:
        self._spotify_paste_server: asyncio.Server | None = None
        self._spotify_paste_token: str | None = None
        self._spotify_paste_expiry_task: asyncio.Task | None = None
        self._spotify_paste_expires_at: float | None = None
        self._spotify_paste_attempts = 0
        self._spotify_paste_lock = asyncio.Lock()
        self._spotify_paste_requests: set[asyncio.Task] = set()

    def _spotify_paste_lan_ipv4s(self) -> list[tuple[str, str]]:
        """List non-loopback IPv4 addresses from Linux interfaces."""
        addresses = []
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            for _index, interface in socket.if_nameindex():
                try:
                    request = struct.pack("256s", interface.encode("ascii")[:15])
                    response = fcntl.ioctl(probe.fileno(), 0x8915, request)  # SIOCGIFADDR
                    address = socket.inet_ntoa(response[20:24])
                    parsed = ipaddress.ip_address(address)
                    if parsed.is_loopback or parsed.is_unspecified:
                        continue
                    addresses.append((interface, address))
                except (OSError, UnicodeEncodeError):
                    continue
        finally:
            probe.close()

        if addresses:
            return addresses

        # Some stripped down systems hide interface ioctls. UDP connect only
        # selects a route and does not send a packet to the documentation IP.
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("192.0.2.1", 9))
            address = probe.getsockname()[0]
            if not ipaddress.ip_address(address).is_loopback:
                return [("network", address)]
        except OSError:
            pass
        finally:
            probe.close()
        return []

    @staticmethod
    def _spotify_paste_interface_label(interface: str) -> str:
        if interface.startswith("tailscale") or interface.startswith("tun"):
            return f"Tailscale ({interface})"
        if interface.startswith(("wlan", "wlp", "wifi")):
            return f"Wi-Fi ({interface})"
        if interface.startswith(("eth", "en", "eno", "enp")):
            return f"Wired ({interface})"
        return interface

    async def get_spotify_paste_status(self) -> dict:
        server = self._spotify_paste_server
        token = self._spotify_paste_token
        expires_at = self._spotify_paste_expires_at
        if server is None or token is None or expires_at is None:
            return {"running": False}
        sockets = server.sockets or []
        port = sockets[0].getsockname()[1] if sockets else None
        addresses = self._spotify_paste_lan_ipv4s()
        if not addresses or not port:
            return {"running": False}
        urls = [
            {
                "label": self._spotify_paste_interface_label(interface),
                "url": f"http://{address}:{port}/paste/{token}",
            }
            for interface, address in addresses
        ]
        return {
            "running": True,
            "url": urls[0]["url"],
            "urls": urls,
            "expires_in": max(0, int(expires_at - time.monotonic())),
        }

    async def start_spotify_paste_server(self) -> dict:
        existing = await self.get_spotify_paste_status()
        if existing.get("running"):
            return {"ok": True, **existing}
        await self._stop_spotify_paste_server()

        token = secrets.token_urlsafe(32)
        self._spotify_paste_token = token
        self._spotify_paste_attempts = 0
        try:
            server = await asyncio.start_server(
                self._handle_spotify_paste_request,
                host="0.0.0.0",
                port=0,
                limit=16384,
            )
        except OSError:
            self._spotify_paste_token = None
            return {"ok": False, "error": "Could not start the temporary local web server."}

        self._spotify_paste_server = server
        self._spotify_paste_expires_at = time.monotonic() + 300
        status = await self.get_spotify_paste_status()
        if not status.get("running"):
            await self._stop_spotify_paste_server()
            return {
                "ok": False,
                "error": "Could not find this Steam Deck's network address. Connect it to Wi-Fi and try again.",
            }
        self._spotify_paste_expiry_task = asyncio.create_task(
            self._expire_spotify_paste_server()
        )
        return {"ok": True, **status}

    async def _expire_spotify_paste_server(self) -> None:
        try:
            while self._spotify_paste_expires_at is not None:
                remaining = self._spotify_paste_expires_at - time.monotonic()
                if remaining <= 0:
                    break
                await asyncio.sleep(remaining)
            await self._stop_spotify_paste_server()
        except asyncio.CancelledError:
            raise

    async def stop_spotify_paste_server(self) -> dict:
        await self._stop_spotify_paste_server()
        return {"ok": True}

    async def _stop_spotify_paste_server(self) -> None:
        server = self._spotify_paste_server
        self._spotify_paste_server = None
        self._spotify_paste_token = None
        self._spotify_paste_expires_at = None
        expiry_task = self._spotify_paste_expiry_task
        self._spotify_paste_expiry_task = None
        if (
            expiry_task is not None
            and expiry_task is not asyncio.current_task()
            and not expiry_task.done()
        ):
            expiry_task.cancel()
            await asyncio.gather(expiry_task, return_exceptions=True)
        if server is not None:
            server.close()
            await server.wait_closed()
        current_task = asyncio.current_task()
        requests = [
            task for task in self._spotify_paste_requests
            if task is not current_task and not task.done()
        ]
        for task in requests:
            task.cancel()
        if requests:
            await asyncio.gather(*requests, return_exceptions=True)

    async def _spotify_paste_response(
        self, writer: asyncio.StreamWriter, status: str, body: str
    ) -> None:
        payload = body.encode("utf-8")
        headers = (
            f"HTTP/1.1 {status}\r\n"
            "Content-Type: text/html; charset=utf-8\r\n"
            f"Content-Length: {len(payload)}\r\n"
            "Cache-Control: no-store, max-age=0\r\n"
            "Pragma: no-cache\r\n"
            "Referrer-Policy: no-referrer\r\n"
            "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'\r\n"
            "X-Content-Type-Options: nosniff\r\n"
            "X-Frame-Options: DENY\r\n"
            "Connection: close\r\n\r\n"
        ).encode("ascii")
        writer.write(headers + payload)
        await writer.drain()

    @staticmethod
    def _spotify_paste_page(message: str = "") -> str:
        escaped_message = html.escape(message)
        result = f'<p role="status">{escaped_message}</p>' if message else ""
        return (
            "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            "<title>SoloDeck Spotify sign-in</title>"
            "<body style=\"font:18px system-ui;max-width:680px;margin:2rem auto;padding:0 1rem;background:#111;color:#fff\">"
            "<h1>Connect Spotify to SoloDeck</h1>"
            "<div role=\"alert\" style=\"border:4px solid #ff3737;background:#300;padding:1rem;font-weight:800;font-size:1.2rem\">"
            "DO NOT USE THIS ON A NETWORK YOU DO NOT FULLY TRUST. THIS IS PURE HTTP. "
            "Your Spotify session cookie is sent unencrypted and may be captured by anyone on this network."
            "</div>"
            f"{result}"
            "<p>Only continue if this is your own trusted home network. In a desktop browser where you are signed in to Spotify, open developer tools and find the <code>sp_dc</code> cookie under Application or Storage → Cookies → <code>open.spotify.com</code>. Paste that value below, then clear your clipboard.</p>"
            "<form method=\"post\" autocomplete=\"off\">"
            "<label for=\"sp_dc\">Spotify sp_dc cookie</label><br>"
            "<input id=\"sp_dc\" name=\"sp_dc\" type=\"password\" required autocomplete=\"off\" "
            "autocapitalize=\"none\" spellcheck=\"false\" style=\"box-sizing:border-box;width:100%;font-size:1rem;padding:.8rem;margin:.7rem 0\">"
            "<button style=\"font-size:1rem;padding:.8rem 1.2rem\">Send to Steam Deck</button></form>"
            "<p>This temporary page stops after a successful sign-in or five failed attempts, and expires after five minutes.</p>"
            "</body></html>"
        )

    async def _handle_spotify_paste_request(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        request_task = asyncio.current_task()
        if request_task is not None:
            self._spotify_paste_requests.add(request_task)
        try:
            status = "400 Bad Request"
            page = self._spotify_paste_page("Invalid request.")
            try:
                request_line = await asyncio.wait_for(reader.readline(), timeout=10)
                parts = request_line.decode("ascii", "replace").strip().split()
                if len(parts) != 3:
                    raise ValueError("Invalid request")
                method, target, _version = parts
                headers = {}
                header_bytes = len(request_line)
                while True:
                    line = await asyncio.wait_for(reader.readline(), timeout=10)
                    header_bytes += len(line)
                    if header_bytes > 16384:
                        status = "431 Request Header Fields Too Large"
                        page = self._spotify_paste_page("Request headers are too large.")
                        break
                    if line in (b"\r\n", b"\n", b""):
                        break
                    if b":" not in line:
                        raise ValueError("Invalid request")
                    key, value = line.decode("latin-1").split(":", 1)
                    headers[key.strip().lower()] = value.strip()

                if status.startswith("431"):
                    pass
                elif (
                    self._spotify_paste_token is None
                    or urlsplit(target).path != f"/paste/{self._spotify_paste_token}"
                ):
                    status = "404 Not Found"
                    page = self._spotify_paste_page("This temporary sign-in link is no longer valid.")
                elif method == "GET":
                    status, page = "200 OK", self._spotify_paste_page()
                elif method == "POST":
                    try:
                        content_length = int(headers.get("content-length", "-1"))
                    except ValueError:
                        content_length = -1
                    if content_length < 0:
                        status = "411 Length Required"
                        page = self._spotify_paste_page("A content length is required.")
                    elif content_length > 8192:
                        status = "413 Content Too Large"
                        page = self._spotify_paste_page("The submitted value is too large.")
                    else:
                        body = await asyncio.wait_for(reader.readexactly(content_length), timeout=10)
                        values = parse_qs(body.decode("utf-8", "replace"), keep_blank_values=True)
                        cookie = values.get("sp_dc", [""])[0]
                        async with self._spotify_paste_lock:
                            submitted_token = self._spotify_paste_token
                            submitted_expiry = self._spotify_paste_expires_at
                            if submitted_token is None or submitted_expiry is None:
                                status = "410 Gone"
                                page = self._spotify_paste_page("This temporary sign-in link has expired.")
                            elif time.monotonic() >= submitted_expiry:
                                await self._stop_spotify_paste_server()
                                status = "410 Gone"
                                page = self._spotify_paste_page("This temporary sign-in link has expired.")
                            elif not cookie.strip():
                                self._spotify_paste_attempts += 1
                                if self._spotify_paste_attempts >= 5:
                                    await self._stop_spotify_paste_server()
                                    status = "410 Gone"
                                    page = self._spotify_paste_page(
                                        "This temporary sign-in link reached its attempt limit. Start a new one."
                                    )
                                else:
                                    status = "400 Bad Request"
                                    page = self._spotify_paste_page("Paste the Spotify sp_dc cookie value.")
                            else:
                                result = await self._validate_spotify_cookie(cookie)
                                still_valid = (
                                    self._spotify_paste_token == submitted_token
                                    and self._spotify_paste_expires_at == submitted_expiry
                                    and time.monotonic() < submitted_expiry
                                )
                                if not still_valid:
                                    status = "410 Gone"
                                    page = self._spotify_paste_page(
                                        "This temporary sign-in link was stopped or expired. Start a new one."
                                    )
                                elif result.get("ok"):
                                    await self._reset_spotify_client()
                                    await self._reset_player()
                                    still_valid = (
                                        self._spotify_paste_token == submitted_token
                                        and self._spotify_paste_expires_at == submitted_expiry
                                        and time.monotonic() < submitted_expiry
                                    )
                                    if still_valid:
                                        # Commit atomically after all awaited work and revalidation.
                                        self._spotify_session_cookie = result["cookie"]
                                        await self._stop_spotify_paste_server()
                                        status = "200 OK"
                                        page = (
                                            "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                                            "<title>Spotify connected</title><body style=\"font:18px system-ui;background:#111;color:#fff;padding:2rem\">"
                                            "<h1>Spotify connected</h1><p>SoloDeck accepted the session. You can close this page.</p></body>"
                                        )
                                    else:
                                        status = "410 Gone"
                                        page = self._spotify_paste_page(
                                            "This temporary sign-in link was stopped or expired. Start a new one."
                                        )
                                else:
                                    self._spotify_paste_attempts += 1
                                    if self._spotify_paste_attempts >= 5:
                                        await self._stop_spotify_paste_server()
                                        status = "410 Gone"
                                        page = self._spotify_paste_page(
                                            "This temporary sign-in link reached its attempt limit. Start a new one."
                                        )
                                    else:
                                        status = "400 Bad Request"
                                        page = self._spotify_paste_page(
                                            result.get("error", "Spotify sign-in failed.")
                                        )
                else:
                    status = "405 Method Not Allowed"
                    page = self._spotify_paste_page("Use the sign-in form on this page.")
            except (asyncio.TimeoutError, asyncio.IncompleteReadError):
                status = "408 Request Timeout"
                page = self._spotify_paste_page("Request timed out. Reload the temporary link.")
            except asyncio.CancelledError:
                raise
            except Exception:
                # Never include request data or exception detail; it may contain the cookie.
                status = "400 Bad Request"
                page = self._spotify_paste_page(
                    "Could not process the request. Reload the temporary link and try again."
                )
            try:
                await self._spotify_paste_response(writer, status, page)
            except (ConnectionError, OSError):
                pass
        finally:
            if request_task is not None:
                self._spotify_paste_requests.discard(request_task)
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass

