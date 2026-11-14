import asyncio
import base64
import hashlib
import json
import os
import secrets
import shutil
import signal
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque

# The decky plugin module is located at decky-loader/plugin
# For easy intellisense checkout the decky-loader code repo
# and add the `decky-loader/plugin/imports` path to `python.analysis.extraPaths` in `.vscode/settings.json`
import decky

# Spotify Soloist is the official Spotify Connect CLI/daemon for headless or
# custom applications. It is NOT bundled with this plugin and NOT downloaded
# automatically: the user fetches it once from the plugin's config page
# ("Download Soloist") into Decky's runtime data dir, where it persists across
# plugin updates. After downloading it, soloist runs as the Spotify Connect
# receiver that this plugin configures and supervises.
# Spotify Soloist download archive. Override with SOLOIST_RELEASE_URL for
# local/offline testing (e.g. a file:// URL to a local tarball).
SOLOIST_RELEASE_URL = os.environ.get(
    "SOLOIST_RELEASE_URL",
    "https://soloist-builds.spotifycdn.com/soloist_release_x86_64.tar.gz",
)

# The plugin's own configuration lives under the settings dir Decky manages.
SETTINGS_FILE = os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")
WEB_API_CACHE_FILE = os.path.join(
    decky.DECKY_PLUGIN_SETTINGS_DIR, "spotify_web_api_cache.json"
)
DEFAULT_DEVICE_NAME = "solodeck"
WEB_API_CACHE_TTL = 30 * 24 * 60 * 60
WEB_API_CACHE_MAX_ENTRIES = 500
WEB_API_CALLBACK_PORT = 48256

# How much process output to keep for the UI. Soloist prints progress lines
# while it waits for the device to be picked in the Spotify app and while the
# daemon is running.
OUTPUT_LINES = 200

# The daemon is supervised: an unexpected exit is restarted after a short
# delay. A process that dies almost immediately (bad key, another instance
# holding the data directory, expired build) is not restarted, because that
# would just loop and spam the log.
DAEMON_RESTART_DELAY = 3.0
DAEMON_MIN_UPTIME = 10.0
SOLOIST_WS_PORT = 35797

# Download status phases.
DL_IDLE = "idle"
DL_DOWNLOADING = "downloading"
DL_EXTRACTING = "extracting"
DL_DONE = "done"
DL_FAILED = "failed"


class SpotifyRateLimitError(RuntimeError):
    def __init__(
        self, message: str, retry_after: int, reason: str | None = None
    ) -> None:
        super().__init__(message)
        self.retry_after = retry_after
        self.reason = reason


def _soloist_root() -> str:
    # Persistent runtime data dir, outside the plugin folder so a downloaded
    # soloist survives plugin updates/reinstalls.
    root = decky.DECKY_PLUGIN_RUNTIME_DIR or os.path.join(
        os.path.expanduser("~"), ".local", "share", "solodeck")
    return os.path.join(root, "soloist")


def _soloist_bin() -> str:
    return os.path.join(_soloist_root(), "soloist")


class Plugin:
    def __init__(self):
        self._pairing_task: asyncio.Task | None = None
        self._pairing_proc: asyncio.subprocess.Process | None = None
        self._pairing_output: deque[str] = deque(maxlen=OUTPUT_LINES)
        self._pairing_exit_code: int | None = None
        self._pairing_error: str | None = None
        self._pairing_cancelled = False

        self._daemon_task: asyncio.Task | None = None
        self._daemon_proc: asyncio.subprocess.Process | None = None
        self._daemon_output: deque[str] = deque(maxlen=OUTPUT_LINES)
        self._daemon_exit_code: int | None = None
        self._daemon_error: str | None = None
        self._daemon_stopping = False
        self._daemon_started_at: float | None = None
        self._daemon_restarts = 0

        self._download_task: asyncio.Task | None = None
        self._download_progress = {
            "status": DL_IDLE,
            "downloaded": 0,
            "total": 0,
            "percent": 0,
            "error": None,
        }
        self._web_api_auth_server: asyncio.Server | None = None
        self._web_api_auth_state: str | None = None
        self._web_api_code_verifier: str | None = None
        self._web_api_redirect_uri: str | None = None
        self._web_api_auth_status = "idle"
        self._web_api_auth_error: str | None = None
        self._web_api_auth_url: str | None = None
        self._web_api_cache: dict[str, dict] | None = None
        self._web_api_market: str | None = None
        self._web_api_market_lock = asyncio.Lock()
        self._web_api_rate_limit_until = 0.0
        self._web_api_rate_limit_message: str | None = None
        self._web_api_token_lock = asyncio.Lock()

    # Where soloist is expected to live after the user downloads it.
    async def get_soloist_status(self) -> dict:
        path = _soloist_bin()
        installed = os.path.isfile(path)
        version = None
        if installed:
            try:
                version = await asyncio.to_thread(self._read_soloist_version)
            except Exception:
                version = None
        return {
            "installed": installed,
            "version": version,
            "path": path,
        }

    # Returns the version string of the downloaded soloist binary,
    # e.g. "soloist 1.3.10.51 build 1793988108 (...)"
    async def get_soloist_version(self) -> str:
        path = _soloist_bin()
        if not os.path.isfile(path):
            raise RuntimeError(f"soloist is not downloaded yet (expected at {path})")
        return await asyncio.to_thread(self._read_soloist_version)

    def _read_soloist_version(self) -> str:
        path = _soloist_bin()
        result = subprocess.run(
            [path, "--version"], capture_output=True, text=True, timeout=10
        )
        return result.stdout.strip()

    # Build metadata baked in by build.py.
    async def get_build_info(self) -> dict:
        package_json = os.path.join(decky.DECKY_PLUGIN_DIR, "package.json")
        with open(package_json, "r", encoding="utf-8") as f:
            metadata = json.load(f)

        build_time = metadata.get("build_time")
        age_days = (time.time() - build_time) / 86400 if build_time else None

        return {
            "version": metadata.get("version"),
            "build_time": build_time,
            "age_days": age_days,
        }

    # The config centre reads this on mount so the API key field is prefilled.
    async def get_config(self) -> dict:
        settings = self._load_settings()
        return {
            "api_key": settings["api_key"],
            "device_name": settings["device_name"],
            "paired": self._is_paired(),
            "web_api_client_id": settings["web_api_client_id"],
            "web_api_connected": bool(settings["web_api_refresh_token"]),
        }

    async def save_api_key(self, api_key: str) -> dict:
        key = (api_key or "").strip()
        if not key:
            return {"ok": False, "error": "Enter your Spotify Soloist API key first."}

        settings = self._load_settings()
        settings["api_key"] = key
        self._save_settings(settings)
        decky.logger.info("Saved Spotify Soloist API key")
        return {"ok": True}

    async def save_device_name(self, device_name: str) -> dict:
        name = (device_name or "").strip()
        if not name:
            return {"ok": False, "error": "Enter a device name first."}

        settings = self._load_settings()
        settings["device_name"] = name
        self._save_settings(settings)
        decky.logger.info(f"Saved Soloist device name: {name}")
        return {"ok": True}

    async def start_web_api_auth(self, client_id: str) -> dict:
        normalized_client_id = (client_id or "").strip()
        if not normalized_client_id:
            return {"ok": False, "error": "Enter a Spotify Web API Client ID first."}
        if self._web_api_auth_server is not None:
            return {"ok": False, "error": "Spotify authorization is already in progress."}

        settings = self._load_settings()
        if settings["web_api_client_id"] != normalized_client_id:
            settings["web_api_client_id"] = normalized_client_id
            settings["web_api_access_token"] = ""
            settings["web_api_refresh_token"] = ""
            settings["web_api_token_expires_at"] = 0
            self._save_settings(settings)

        self._web_api_auth_state = secrets.token_urlsafe(32)
        self._web_api_code_verifier = secrets.token_urlsafe(64)
        challenge = base64.urlsafe_b64encode(
            hashlib.sha256(self._web_api_code_verifier.encode("ascii")).digest()
        ).decode("ascii").rstrip("=")

        try:
            self._web_api_auth_server = await asyncio.start_server(
                self._handle_web_api_callback,
                "127.0.0.1",
                WEB_API_CALLBACK_PORT,
            )
        except OSError as error:
            self._web_api_auth_state = None
            self._web_api_code_verifier = None
            return {
                "ok": False,
                "error": f"Could not start the local Spotify callback: {error}",
            }

        self._web_api_redirect_uri = (
            f"http://127.0.0.1:{WEB_API_CALLBACK_PORT}/callback"
        )
        query = urllib.parse.urlencode(
            {
                "client_id": normalized_client_id,
                "response_type": "code",
                "redirect_uri": self._web_api_redirect_uri,
                "scope": "user-read-private user-read-playback-state user-library-read user-follow-read playlist-read-private playlist-read-collaborative user-modify-playback-state",
                "code_challenge_method": "S256",
                "code_challenge": challenge,
                "state": self._web_api_auth_state,
            }
        )
        self._web_api_auth_status = "pending"
        self._web_api_auth_error = None
        self._web_api_auth_url = f"https://accounts.spotify.com/authorize?{query}"
        decky.logger.info("Started Spotify Web API authorization")
        return {
            "ok": True,
            "authorization_url": self._web_api_auth_url,
            "redirect_uri": self._web_api_redirect_uri,
        }

    async def get_web_api_auth_status(self) -> dict:
        settings = self._load_settings()
        status = self._web_api_auth_status
        if status == "idle" and settings["web_api_refresh_token"]:
            status = "connected"
        return {
            "status": status,
            "error": self._web_api_auth_error,
            "authorization_url": (
                self._web_api_auth_url
                if status in ("pending", "exchanging")
                else None
            ),
            "client_id": settings["web_api_client_id"],
            "configured": bool(settings["web_api_client_id"]),
        }

    async def cancel_web_api_auth(self) -> dict:
        server = self._web_api_auth_server
        if server is not None:
            server.close()
            await server.wait_closed()
        self._web_api_auth_server = None
        self._web_api_auth_state = None
        self._web_api_code_verifier = None
        self._web_api_redirect_uri = None
        self._web_api_auth_url = None
        self._web_api_auth_status = (
            "connected"
            if self._load_settings()["web_api_refresh_token"]
            else "idle"
        )
        self._web_api_auth_error = None
        return {"ok": True}

    async def _handle_web_api_callback(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        response_body = "Spotify authorization finished. You may close this page."
        response_status = "200 OK"
        try:
            request_line = await asyncio.wait_for(reader.readline(), timeout=5)
            method, target, _version = request_line.decode("ascii").strip().split(" ", 2)
            if method != "GET":
                response_status = "405 Method Not Allowed"
                response_body = "Only GET is supported."
            else:
                parsed = urllib.parse.urlsplit(target)
                if parsed.path != "/callback":
                    response_status = "404 Not Found"
                    response_body = "Not found."
                else:
                    params = urllib.parse.parse_qs(parsed.query)
                    returned_state = params.get("state", [""])[0]
                    if not self._web_api_auth_state or not secrets.compare_digest(
                        returned_state, self._web_api_auth_state
                    ):
                        self._web_api_auth_status = "error"
                        self._web_api_auth_error = "Spotify returned an invalid authorization state."
                        self._web_api_auth_url = None
                        response_status = "400 Bad Request"
                        response_body = self._web_api_auth_error
                    elif params.get("error"):
                        self._web_api_auth_status = "error"
                        self._web_api_auth_error = (
                            "Spotify authorization was denied: "
                            + params["error"][0]
                        )
                        self._web_api_auth_url = None
                        response_status = "400 Bad Request"
                        response_body = self._web_api_auth_error
                    else:
                        callback_state = self._web_api_auth_state
                        code = params.get("code", [""])[0]
                        if not code:
                            raise ValueError("Spotify did not return an authorization code.")
                        self._web_api_auth_status = "exchanging"
                        settings = self._load_settings()
                        token = await asyncio.to_thread(
                            self._exchange_web_api_code,
                            code,
                            settings["web_api_client_id"],
                            self._web_api_redirect_uri,
                            self._web_api_code_verifier,
                        )
                        if callback_state != self._web_api_auth_state:
                            response_status = "400 Bad Request"
                            response_body = "Spotify authorization was cancelled."
                            return
                        settings["web_api_access_token"] = token["access_token"]
                        settings["web_api_refresh_token"] = token["refresh_token"]
                        settings["web_api_token_expires_at"] = (
                            time.time() + int(token["expires_in"])
                        )
                        self._save_settings(settings)
                        self._web_api_market = None
                        self._web_api_auth_status = "connected"
                        self._web_api_auth_error = None
                        self._web_api_auth_url = None
                        decky.logger.info("Spotify Web API authorization completed")
        except (ValueError, KeyError, urllib.error.URLError, TimeoutError) as error:
            self._web_api_auth_status = "error"
            self._web_api_auth_error = str(error)
            self._web_api_auth_url = None
            response_status = "400 Bad Request"
            response_body = "Spotify authorization failed. Return to Solodeck for details."
            decky.logger.error(f"Spotify Web API authorization failed: {error}")
        except Exception as error:
            self._web_api_auth_status = "error"
            self._web_api_auth_error = str(error)
            self._web_api_auth_url = None
            response_status = "500 Internal Server Error"
            response_body = "Spotify authorization failed. Return to Solodeck for details."
            decky.logger.error(f"Spotify Web API callback failed: {error}")
        finally:
            body = response_body.encode("utf-8")
            writer.write(
                (
                    f"HTTP/1.1 {response_status}\r\n"
                    "Content-Type: text/plain; charset=utf-8\r\n"
                    "Connection: close\r\n"
                    f"Content-Length: {len(body)}\r\n\r\n"
                ).encode("ascii")
                + body
            )
            try:
                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()
            server = self._web_api_auth_server
            if server is not None and self._web_api_auth_status != "pending":
                server.close()
                await server.wait_closed()
                self._web_api_auth_server = None
                self._web_api_auth_state = None
                self._web_api_code_verifier = None
                self._web_api_redirect_uri = None

    def _exchange_web_api_code(
        self,
        code: str,
        client_id: str,
        redirect_uri: str | None,
        code_verifier: str | None,
    ) -> dict:
        if not redirect_uri or not code_verifier:
            raise RuntimeError("The Spotify authorization session expired.")
        return self._web_api_token_request(
            {
                "client_id": client_id,
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": code_verifier,
            }
        )

    def _web_api_token_request(self, values: dict[str, str]) -> dict:
        request = urllib.request.Request(
            "https://accounts.spotify.com/api/token",
            data=urllib.parse.urlencode(values).encode("ascii"),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            details = error.read().decode("utf-8", "replace")
            raise RuntimeError(f"Spotify token request failed ({error.code}): {details}") from error
        if not isinstance(result, dict) or not result.get("access_token"):
            raise RuntimeError("Spotify returned an invalid token response.")
        return result

    async def get_track_metadata(self, uri: str) -> dict | None:
        track_id = self._spotify_track_id(uri)
        if not track_id:
            return None

        cached = self._get_cached_track(uri)
        if cached is not None:
            return cached

        token = await self._get_web_api_token()
        if not token:
            return None

        try:
            result = await asyncio.to_thread(
                self._request_web_api_track, track_id, token
            )
            item = self._format_web_api_track(result)
            if item is not None:
                self._cache_track(uri, item)
            return item
        except (urllib.error.URLError, RuntimeError, ValueError, KeyError) as error:
            decky.logger.warning(f"Spotify Web API track lookup failed: {error}")
            return None

    async def get_web_api_library(self) -> dict:
        try:
            playlists = await self._get_all_web_api_items(
                "https://api.spotify.com/v1/me/playlists?limit=50"
            )
            saved_albums = await self._get_all_web_api_items(
                "https://api.spotify.com/v1/me/albums?limit=50"
            )
            followed = await self._get_all_web_api_items(
                "https://api.spotify.com/v1/me/following?type=artist&limit=50"
            )
            album_items = [
                entry.get("album", entry)
                for entry in saved_albums.get("items", [])
                if isinstance(entry, dict)
            ]
            artists = followed.get("artists", {})
            artist_items = (
                artists.get("items", []) if isinstance(artists, dict) else []
            )
            return {
                "ok": True,
                "playlists": [
                    item
                    for item in (
                        self._format_web_api_browse_item(value, "playlist")
                        for value in playlists.get("items", [])
                    )
                    if item is not None
                ],
                "albums": [
                    item
                    for item in (
                        self._format_web_api_browse_item(value, "album")
                        for value in album_items
                    )
                    if item is not None
                ],
                "artists": [
                    item
                    for item in (
                        self._format_web_api_browse_item(value, "artist")
                        for value in artist_items
                    )
                    if item is not None
                ],
            }
        except (urllib.error.URLError, RuntimeError, ValueError, KeyError) as error:
            decky.logger.warning(f"Spotify library request failed: {error}")
            return {"ok": False, "error": str(error)}

    async def get_web_api_playlist_tracks(self, uri: str) -> dict:
        playlist_id = self._spotify_uri_id(uri, "playlist")
        if not playlist_id:
            return {"ok": False, "error": "Invalid Spotify playlist."}
        try:
            playlist = await self._get_all_web_api_items(
                f"https://api.spotify.com/v1/playlists/{urllib.parse.quote(playlist_id)}/items?limit=50"
            )
            items = []
            for position, entry in enumerate(playlist.get("items", [])):
                if not isinstance(entry, dict):
                    continue
                track = entry.get("item") or entry.get("track")
                if not isinstance(track, dict):
                    continue
                formatted = self._format_web_api_track(track)
                if formatted is not None:
                    items.append({"position": position, "item": formatted})
            return {"ok": True, "items": items}
        except (urllib.error.URLError, RuntimeError, ValueError, KeyError) as error:
            decky.logger.warning(f"Spotify playlist request failed: {error}")
            return {"ok": False, "error": str(error)}

    async def get_web_api_artist_albums(self, uri: str, offset: int = 0) -> dict:
        artist_id = self._spotify_uri_id(uri, "artist")
        if not artist_id or not isinstance(offset, int) or offset < 0:
            return {"ok": False, "error": "Invalid Spotify artist."}
        try:
            market = await self._get_web_api_market()
            params: dict[str, str] = {"include_groups": "album,single"}
            if offset:
                params["offset"] = str(offset)
            if market is not None:
                params["market"] = market
            endpoint = (
                "https://api.spotify.com/v1/artists/"
                f"{urllib.parse.quote(artist_id)}/albums?"
                + urllib.parse.urlencode(params)
            )
            result = await self._web_api_json(endpoint)
            values = result.get("items", [])
            if not isinstance(values, list):
                raise RuntimeError("Spotify returned an invalid artist albums response.")
            next_offset = None
            next_url = result.get("next")
            if isinstance(next_url, str):
                next_query = urllib.parse.parse_qs(
                    urllib.parse.urlsplit(next_url).query
                )
                try:
                    candidate = int(next_query["offset"][0])
                except (KeyError, IndexError, ValueError):
                    candidate = None
                if candidate is not None and candidate > offset:
                    next_offset = candidate
            return {
                "ok": True,
                "items": [
                    item
                    for item in (
                        self._format_web_api_browse_item(value, "album")
                        for value in values
                    )
                    if item is not None
                ],
                "next_offset": next_offset,
            }
        except (urllib.error.URLError, RuntimeError, ValueError, KeyError) as error:
            decky.logger.warning(f"Spotify artist request failed: {error}")
            return {"ok": False, "error": str(error)}

    async def get_web_api_album_tracks(self, uri: str) -> dict:
        album_id = self._spotify_uri_id(uri, "album")
        if not album_id:
            return {"ok": False, "error": "Invalid Spotify album."}
        try:
            market = await self._get_web_api_market()
            params = {"limit": 50}
            if market is not None:
                params["market"] = market
            result = await self._get_all_web_api_items(
                "https://api.spotify.com/v1/albums/"
                f"{urllib.parse.quote(album_id)}/tracks?"
                + urllib.parse.urlencode(params)
            )
            items = []
            for position, track in enumerate(result.get("items", [])):
                if not isinstance(track, dict):
                    continue
                formatted = self._format_web_api_track(track)
                if formatted is not None:
                    items.append({"position": position, "item": formatted})
            return {"ok": True, "items": items}
        except (urllib.error.URLError, RuntimeError, ValueError, KeyError) as error:
            decky.logger.warning(f"Spotify album request failed: {error}")
            return {"ok": False, "error": str(error)}

    async def search_web_api(self, query: str) -> dict:
        normalized_query = (query or "").strip()
        if not normalized_query:
            return {"ok": True, "tracks": [], "playlists": [], "artists": [], "albums": []}
        try:
            market = await self._get_web_api_market()
        except (urllib.error.URLError, RuntimeError, ValueError, KeyError) as error:
            decky.logger.warning(f"Spotify search market lookup failed: {error}")
            market = None
        params = {
            "q": normalized_query,
            "type": "track,playlist,artist,album",
            "limit": 10,
        }
        if market is not None:
            params["market"] = market
        endpoint = "https://api.spotify.com/v1/search?" + urllib.parse.urlencode(
            params
        )
        try:
            result = await self._web_api_json(endpoint)
            response = {"ok": True, "tracks": [], "playlists": [], "artists": [], "albums": []}
            for entity_type in ("track", "playlist", "artist", "album"):
                page = result.get(f"{entity_type}s", {})
                values = page.get("items", []) if isinstance(page, dict) else []
                if entity_type == "track":
                    response["tracks"] = [
                        item
                        for item in (
                            self._format_web_api_track(value)
                            for value in values
                            if isinstance(value, dict)
                        )
                        if item is not None
                    ]
                else:
                    response[f"{entity_type}s"] = [
                        item
                        for item in (
                            self._format_web_api_browse_item(value, entity_type)
                            for value in values
                        )
                        if item is not None
                    ]
            return response
        except (urllib.error.URLError, RuntimeError, ValueError, KeyError) as error:
            decky.logger.warning(f"Spotify search request failed: {error}")
            return {"ok": False, "error": str(error)}

    async def play_web_api_track_in_context(
        self, context_uri: str, track_uri: str, position: int
    ) -> dict:
        context_type = (context_uri or "").split(":")[1:2]
        if (
            not context_type
            or context_type[0] not in ("playlist", "album")
            or not self._spotify_uri_id(context_uri, context_type[0])
            or not self._spotify_uri_id(track_uri, "track")
            or not isinstance(position, int)
            or position < 0
        ):
            return {"ok": False, "error": "Invalid playlist track selection."}
        try:
            settings = self._load_settings()
            device_name = settings["device_name"].casefold()
            devices_result = await self._web_api_json(
                "https://api.spotify.com/v1/me/player/devices"
            )
            devices = devices_result.get("devices", [])
            device = next(
                (
                    value
                    for value in devices
                    if isinstance(value, dict)
                    and isinstance(value.get("name"), str)
                    and value["name"].casefold() == device_name
                    and isinstance(value.get("id"), str)
                ),
                None,
            )
            if device is None:
                return {
                    "ok": False,
                    "error": (
                        "Could not find the Soloist Spotify Connect device. "
                        "Make sure Soloist is connected, then try again."
                    ),
                }
            endpoint = "https://api.spotify.com/v1/me/player/play?" + urllib.parse.urlencode(
                {"device_id": device["id"]}
            )
            await self._web_api_json(
                endpoint,
                method="PUT",
                payload={
                    "context_uri": context_uri,
                    "offset": {"position": position},
                    "position_ms": 0,
                },
            )
            return {"ok": True}
        except (urllib.error.URLError, RuntimeError, ValueError, KeyError) as error:
            decky.logger.warning(f"Spotify contextual playback failed: {error}")
            return {"ok": False, "error": str(error)}

    async def _get_all_web_api_items(self, endpoint: str) -> dict:
        result: dict = {}
        items: list = []
        nested_collection: str | None = None
        nested_page: dict = {}
        next_endpoint: str | None = endpoint
        for _ in range(200):
            if not next_endpoint:
                break
            page = await self._web_api_json(next_endpoint)
            values = page.get("items", [])
            page_next = page.get("next")
            if not isinstance(values, list):
                values = []
            if not values:
                for key, value in page.items():
                    if isinstance(value, dict) and isinstance(
                        value.get("items"), list
                    ):
                        nested_collection = key
                        nested_page = value
                        values = value["items"]
                        page_next = value.get("next")
                        break
            if isinstance(values, list):
                items.extend(values)
            result.update(page)
            next_endpoint = page_next
            if next_endpoint is not None and not isinstance(next_endpoint, str):
                raise RuntimeError("Spotify returned an invalid pagination link.")
        else:
            raise RuntimeError("Spotify library is too large to load completely.")
        result["items"] = items
        if nested_collection:
            result[nested_collection] = {**nested_page, "items": items}
        return result

    async def _web_api_json(
        self,
        endpoint: str,
        method: str = "GET",
        payload: dict | None = None,
    ) -> dict:
        remaining = self._web_api_rate_limit_until - time.monotonic()
        if remaining > 0:
            retry_seconds = max(1, int(remaining + 0.999))
            message = self._web_api_rate_limit_message
            if message and "quota exceeded" in message.lower():
                raise RuntimeError(
                    f"{message} Try again in about {retry_seconds} seconds."
                )
            raise RuntimeError(
                f"Spotify rate limit cooldown is active. Try again in "
                f"{retry_seconds} seconds."
            )
        token = await self._get_web_api_token()
        if not token:
            raise RuntimeError(
                "Connect Spotify Web API in configuration to browse your library."
            )
        try:
            return await asyncio.to_thread(
                self._request_web_api_json, endpoint, token, method, payload
            )
        except SpotifyRateLimitError as error:
            self._web_api_rate_limit_until = max(
                self._web_api_rate_limit_until,
                time.monotonic() + error.retry_after,
            )
            self._web_api_rate_limit_message = str(error)
            decky.logger.warning(
                "Spotify Web API rate limit reached "
                f"(reason={error.reason or 'unspecified'}, "
                f"retry_after={error.retry_after}s)"
            )
            raise

    async def _get_web_api_market(self) -> str | None:
        async with self._web_api_market_lock:
            if self._web_api_market is not None:
                return self._web_api_market or None
            profile = await self._web_api_json("https://api.spotify.com/v1/me")
            country = profile.get("country")
            if (
                not isinstance(country, str)
                or len(country) != 2
                or not country.isalpha()
            ):
                self._web_api_market = ""
                decky.logger.info(
                    "Spotify account country is unavailable; using the access token's market."
                )
                return None
            self._web_api_market = country.upper()
            return self._web_api_market

    @staticmethod
    def _request_web_api_json(
        endpoint: str,
        access_token: str,
        method: str = "GET",
        payload: dict | None = None,
    ) -> dict:
        parsed = urllib.parse.urlsplit(endpoint)
        if parsed.scheme != "https" or parsed.netloc != "api.spotify.com":
            raise ValueError("Invalid Spotify API URL.")
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Authorization": f"Bearer {access_token}"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            endpoint,
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                if response.status == 204:
                    return {}
                result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            response_body = error.read().decode("utf-8", "replace")
            error_details: dict = {}
            api_message = None
            try:
                error_data = json.loads(response_body)
                parsed_details = error_data.get("error", {})
                if isinstance(parsed_details, dict):
                    error_details = parsed_details
                api_message = (
                    error_details.get("message")
                    if isinstance(error_details.get("message"), str)
                    else None
                )
            except json.JSONDecodeError:
                pass
            endpoint_path = urllib.parse.urlsplit(endpoint).path
            detail = f": {api_message}" if isinstance(api_message, str) else ""
            if error.code == 429:
                reason = (
                    error_details.get("reason")
                    if isinstance(error_details, dict)
                    and isinstance(error_details.get("reason"), str)
                    else None
                )
                retry_header = error.headers.get("Retry-After")
                try:
                    retry_after = max(1, int(float(retry_header)))
                except (TypeError, ValueError):
                    retry_after = 15 * 60 if reason == "QUOTA_EXCEEDED" else 30
                if reason == "QUOTA_EXCEEDED":
                    message = (
                        "Spotify app quota exceeded (QUOTA_EXCEEDED). Check the "
                        "app's quota mode and request usage in the Spotify "
                        f"Developer Dashboard. Retry after {retry_after} seconds."
                    )
                else:
                    message = (
                        f"Spotify rate limited this app{detail}. Retry after "
                        f"{retry_after} seconds."
                    )
                raise SpotifyRateLimitError(message, retry_after, reason) from error
            if error.code == 403:
                raise RuntimeError(
                    "Spotify denied access. Reconnect Web API in configuration and "
                    f"grant the required permissions{detail} ({endpoint_path})."
                ) from error
            if error.code == 401:
                raise RuntimeError(
                    "Spotify authorization expired. Reconnect Web API in configuration"
                    f"{detail} ({endpoint_path})."
                ) from error
            raise RuntimeError(
                f"Spotify API request failed ({error.code}){detail} ({endpoint_path})."
            ) from error
        if not isinstance(result, dict):
            raise RuntimeError("Spotify returned an invalid API response.")
        return result

    @staticmethod
    def _spotify_uri_id(uri: str, entity_type: str) -> str | None:
        parts = (uri or "").split(":")
        if (
            len(parts) == 3
            and parts[0] == "spotify"
            and parts[1] == entity_type
            and parts[2]
        ):
            return parts[2]
        return None

    @staticmethod
    def _format_web_api_browse_item(
        value: dict, entity_type: str
    ) -> dict | None:
        name = value.get("name")
        uri = value.get("uri")
        if not isinstance(name, str) or not isinstance(uri, str):
            return None
        images = value.get("images", [])
        image_url = None
        if isinstance(images, list):
            image_url = next(
                (
                    image["url"]
                    for image in images
                    if isinstance(image, dict) and isinstance(image.get("url"), str)
                ),
                None,
            )
        return {
            "uri": uri,
            "name": name,
            "entity_type": entity_type,
            "image_url": image_url,
        }

    @staticmethod
    def _spotify_track_id(uri: str) -> str | None:
        parts = (uri or "").split(":")
        if len(parts) == 3 and parts[0] == "spotify" and parts[1] == "track":
            return parts[2]
        return None

    def _get_cached_track(self, uri: str) -> dict | None:
        now = time.time()
        if self._web_api_cache is None:
            try:
                with open(WEB_API_CACHE_FILE, "r", encoding="utf-8") as file:
                    cache = json.load(file)
                self._web_api_cache = cache if isinstance(cache, dict) else {}
            except (FileNotFoundError, json.JSONDecodeError):
                self._web_api_cache = {}

        entry = self._web_api_cache.get(uri)
        if not isinstance(entry, dict):
            return None
        cached_at = entry.get("cached_at")
        if not isinstance(cached_at, (int, float)) or now - cached_at > WEB_API_CACHE_TTL:
            self._web_api_cache.pop(uri, None)
            self._save_web_api_cache()
            return None
        item = entry.get("item")
        return item if isinstance(item, dict) else None

    def _cache_track(self, uri: str, item: dict) -> None:
        cache = self._web_api_cache
        if cache is None:
            cache = {}
            self._web_api_cache = cache
        cache[uri] = {"cached_at": time.time(), "item": item}
        if len(cache) > WEB_API_CACHE_MAX_ENTRIES:
            oldest = sorted(
                cache,
                key=lambda key: cache[key].get("cached_at", 0),
            )
            for key in oldest[: len(cache) - WEB_API_CACHE_MAX_ENTRIES]:
                cache.pop(key, None)
        self._save_web_api_cache()

    def _save_web_api_cache(self) -> None:
        os.makedirs(decky.DECKY_PLUGIN_SETTINGS_DIR, exist_ok=True)
        tmp = WEB_API_CACHE_FILE + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            json.dump(self._web_api_cache or {}, file)
        os.replace(tmp, WEB_API_CACHE_FILE)

    def _request_web_api_track(self, track_id: str, access_token: str) -> dict:
        request = urllib.request.Request(
            f"https://api.spotify.com/v1/tracks/{urllib.parse.quote(track_id)}",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            if error.code == 401:
                raise RuntimeError("Spotify authorization expired. Reconnect Web API in configuration.") from error
            raise RuntimeError(f"Spotify track request failed ({error.code}).") from error
        if not isinstance(result, dict):
            raise RuntimeError("Spotify returned an invalid track response.")
        return result

    @staticmethod
    def _format_web_api_track(track: dict) -> dict | None:
        name = track.get("name")
        uri = track.get("uri")
        if not isinstance(name, str) or not isinstance(uri, str):
            return None
        artists = track.get("artists")
        creators = []
        if isinstance(artists, list):
            creators = [
                {
                    "entity": {
                        "uri": artist.get("uri"),
                        "decorations": {
                            "identity": {
                                "name": artist["name"],
                                "uri": artist.get("uri"),
                            }
                        },
                    }
                }
                for artist in artists
                if isinstance(artist, dict) and isinstance(artist.get("name"), str)
            ]
        album = track.get("album")
        album_name = album.get("name") if isinstance(album, dict) else None
        album_uri = album.get("uri") if isinstance(album, dict) else None
        images = album.get("images", []) if isinstance(album, dict) else []
        covers = [
            {"url": image["url"], "size": str(image.get("width", "default"))}
            for image in images
            if isinstance(image, dict) and isinstance(image.get("url"), str)
        ]
        decorations: dict = {
            "identity": {"name": name},
            "creators": creators,
            "visual_identity": {"cover": covers},
            "playback": {"duration_ms": track.get("duration_ms", 0)},
        }
        if isinstance(album_name, str):
            decorations["parent"] = {
                "entity": {
                    "uri": album_uri,
                    "decorations": {
                        "identity": {"name": album_name, "uri": album_uri}
                    },
                }
            }
        return {
            "uri": uri,
            "name": name,
            "entity_type": "track",
            "decorations": decorations,
        }

    async def _get_web_api_token(self) -> str | None:
        async with self._web_api_token_lock:
            settings = self._load_settings()
            access_token = settings["web_api_access_token"]
            if access_token and settings["web_api_token_expires_at"] > time.time() + 60:
                return access_token
            refresh_token = settings["web_api_refresh_token"]
            client_id = settings["web_api_client_id"]
            if not refresh_token or not client_id:
                return None
            try:
                token = await asyncio.to_thread(
                    self._web_api_token_request,
                    {
                        "client_id": client_id,
                        "grant_type": "refresh_token",
                        "refresh_token": refresh_token,
                    },
                )
                settings["web_api_access_token"] = token["access_token"]
                settings["web_api_refresh_token"] = token.get(
                    "refresh_token", refresh_token
                )
                settings["web_api_token_expires_at"] = time.time() + int(
                    token.get("expires_in", 3600)
                )
                self._save_settings(settings)
                return settings["web_api_access_token"]
            except (urllib.error.URLError, RuntimeError, ValueError, KeyError) as error:
                decky.logger.warning(f"Spotify Web API token refresh failed: {error}")
                return None

    def _soloist_environment(self) -> dict[str, str]:
        env = os.environ.copy()
        if not env.get("XDG_RUNTIME_DIR"):
            runtime_dir = f"/run/user/{os.getuid()}"
            if os.path.isdir(runtime_dir):
                env["XDG_RUNTIME_DIR"] = runtime_dir
                decky.logger.info(
                    f"Using user runtime directory for Soloist audio: {runtime_dir}"
                )
            else:
                decky.logger.warning(
                    "XDG_RUNTIME_DIR is unset and the user runtime directory "
                    f"{runtime_dir} does not exist; Soloist may not reach PipeWire"
                )
        return env

    # Starts `soloist --pair` and returns immediately. The Spotify app has to
    # select the advertised device; the process then stores the session and
    # exits. Progress is polled with get_pairing_status().
    async def start_pairing(self, api_key: str | None = None) -> dict:
        if self._pairing_running():
            return {"ok": False, "error": "Pairing is already in progress."}

        status = await self.get_soloist_status()
        if not status["installed"]:
            return {"ok": False, "error": "Soloist is not downloaded yet. Click \"Download Soloist\" first."}

        if api_key is not None:
            saved = await self.save_api_key(api_key)
            if not saved["ok"]:
                return saved

        settings = self._load_settings()
        if not settings["api_key"]:
            return {"ok": False, "error": "Enter your Spotify Soloist API key first."}

        # Pairing clears the stored session, and soloist refuses to share its
        # data directory with a running daemon, so stop it first.
        await self._shutdown_daemon()

        # The API key is passed on the command line because soloist has no
        # config file or environment variable for it. That makes it visible to
        # `ps` for other local users, so it is deliberately never logged.
        args = [
            status["path"],
            "--device-name",
            settings["device_name"],
            "--api-key",
            settings["api_key"],
            "--pair",
        ]

        self._pairing_output.clear()
        self._pairing_exit_code = None
        self._pairing_error = None
        self._pairing_cancelled = False

        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                start_new_session=True,
                env=self._soloist_environment(),
            )
        except Exception as e:
            decky.logger.error(f"Failed to start soloist pairing: {e}")
            return {"ok": False, "error": str(e)}

        self._pairing_proc = proc
        self._pairing_task = asyncio.create_task(self._run_pairing(proc))
        decky.logger.info(f"Started Spotify pairing as '{settings['device_name']}'")
        return {"ok": True}

    async def get_pairing_status(self) -> dict:
        return {
            "running": self._pairing_running(),
            "cancelled": self._pairing_cancelled,
            "exit_code": self._pairing_exit_code,
            "output": list(self._pairing_output),
            "error": self._pairing_error,
        }

    async def cancel_pairing(self) -> dict:
        proc = self._pairing_proc
        if proc is None or proc.returncode is not None:
            return {"ok": True}

        decky.logger.info("Cancelling Spotify pairing")
        # soloist shuts down cleanly on SIGTERM (exit code 0), so remember that
        # this run was cancelled instead of treating the exit code as success.
        self._pairing_cancelled = True
        await self._stop_process(proc)
        return {"ok": True}

    async def get_daemon_status(self) -> dict:
        proc = self._daemon_proc
        running = proc is not None and proc.returncode is None
        settings = self._load_settings()
        return {
            "running": running,
            "enabled": settings["daemon_enabled"],
            "paired": self._is_paired(),
            "pid": proc.pid if running else None,
            "exit_code": self._daemon_exit_code,
            "error": self._daemon_error,
            "output": list(self._daemon_output),
            "restarts": self._daemon_restarts,
            "uptime": (time.time() - self._daemon_started_at)
            if running and self._daemon_started_at
            else None,
        }

    async def start_daemon(self) -> dict:
        status = await self.get_soloist_status()
        if not status["installed"]:
            return {"ok": False, "error": "Soloist is not downloaded yet. Click \"Download Soloist\" first."}
        if self._daemon_active():
            return {"ok": True}
        if not self._is_paired():
            return {"ok": False, "error": "Pair this device with Spotify first."}

        self._set_daemon_enabled(True)
        self._daemon_output.clear()
        self._daemon_exit_code = None
        self._daemon_error = None
        self._daemon_restarts = 0
        self._daemon_stopping = False
        self._daemon_task = asyncio.create_task(self._daemon_supervisor())
        decky.logger.info("Starting Soloist daemon")
        return {"ok": True}

    async def stop_daemon(self) -> dict:
        self._set_daemon_enabled(False)
        await self._shutdown_daemon()
        self._daemon_exit_code = None
        self._daemon_error = None
        decky.logger.info("Stopped Soloist daemon")
        return {"ok": True}

    async def restart_daemon(self) -> dict:
        status = await self.get_soloist_status()
        if not status["installed"]:
            return {"ok": False, "error": "Soloist is not downloaded yet. Click \"Download Soloist\" first."}
        if not self._is_paired():
            return {"ok": False, "error": "Pair this device with Spotify first."}

        self._set_daemon_enabled(True)
        await self._shutdown_daemon()
        return await self.start_daemon()

    def _data_dir(self) -> str:
        # soloist's default Linux data directory (see its storage options).
        xdg = os.environ.get("XDG_DATA_HOME")
        if xdg:
            return os.path.join(xdg, "soloist")
        return os.path.join(os.path.expanduser("~"), ".local", "share", "soloist")

    def _is_paired(self) -> bool:
        # A successful pairing stores the Spotify user's data below
        # settings/Users; before pairing that directory does not exist.
        users = os.path.join(self._data_dir(), "settings", "Users")
        try:
            return any(os.scandir(users))
        except OSError:
            return False

    def _load_settings(self) -> dict:
        settings = {
            "api_key": "",
            "device_name": DEFAULT_DEVICE_NAME,
            "daemon_enabled": True,
            "web_api_client_id": "",
            "web_api_access_token": "",
            "web_api_refresh_token": "",
            "web_api_token_expires_at": 0,
        }
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return settings

        if isinstance(data, dict):
            if isinstance(data.get("api_key"), str):
                settings["api_key"] = data["api_key"]
            if isinstance(data.get("device_name"), str) and data["device_name"].strip():
                settings["device_name"] = data["device_name"].strip()
            if isinstance(data.get("daemon_enabled"), bool):
                settings["daemon_enabled"] = data["daemon_enabled"]
            for key in (
                "web_api_client_id",
                "web_api_access_token",
                "web_api_refresh_token",
            ):
                if isinstance(data.get(key), str):
                    settings[key] = data[key]
            if isinstance(data.get("web_api_token_expires_at"), (int, float)):
                settings["web_api_token_expires_at"] = data[
                    "web_api_token_expires_at"
                ]
        return settings

    def _save_settings(self, settings: dict) -> None:
        os.makedirs(decky.DECKY_PLUGIN_SETTINGS_DIR, exist_ok=True)
        tmp = SETTINGS_FILE + ".tmp"
        # The file holds the API key, so keep it private to the deck user.
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(settings, f, indent=2)
            f.write("\n")
        os.replace(tmp, SETTINGS_FILE)

    def _set_daemon_enabled(self, enabled: bool) -> None:
        settings = self._load_settings()
        if settings["daemon_enabled"] != enabled:
            settings["daemon_enabled"] = enabled
            self._save_settings(settings)

    def _pairing_running(self) -> bool:
        return self._pairing_task is not None and not self._pairing_task.done()

    def _daemon_active(self) -> bool:
        proc = self._daemon_proc
        if proc is not None and proc.returncode is None:
            return True
        return self._daemon_task is not None and not self._daemon_task.done()

    async def _run_pairing(self, proc: asyncio.subprocess.Process) -> None:
        try:
            assert proc.stdout is not None
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                text = line.decode("utf-8", "replace").rstrip()
                if text:
                    self._pairing_output.append(text)
                    decky.logger.info(f"[pairing] {text}")

            self._pairing_exit_code = await proc.wait()
            if self._pairing_cancelled:
                decky.logger.info("Spotify pairing cancelled")
            elif self._pairing_exit_code == 0:
                decky.logger.info("Spotify pairing finished successfully")
                # The device is paired now, so keep it available in Spotify.
                self._set_daemon_enabled(True)
                await self.start_daemon()
            else:
                decky.logger.warning(f"Spotify pairing exited with {self._pairing_exit_code}")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self._pairing_error = str(e)
            decky.logger.error(f"Spotify pairing failed: {e}")
        finally:
            if self._pairing_proc is proc:
                self._pairing_proc = None

    async def _daemon_supervisor(self) -> None:
        settings = self._load_settings()
        while not self._daemon_stopping:
            proc = await self._spawn_daemon(settings)
            if proc is None:
                return

            self._daemon_proc = proc
            self._daemon_started_at = time.time()
            started = time.monotonic()
            try:
                await self._read_daemon_output(proc)
                code = await proc.wait()
            except asyncio.CancelledError:
                raise
            finally:
                self._daemon_proc = None
                self._daemon_started_at = None
            self._daemon_exit_code = code
            if self._daemon_stopping:
                return

            uptime = time.monotonic() - started
            if code == 10:
                self._daemon_error = "This soloist build has expired. Download a newer Soloist build."
                decky.logger.error("Soloist daemon stopped: build expired")
                return
            if uptime < DAEMON_MIN_UPTIME:
                self._daemon_error = f"Soloist exited with code {code}."
                decky.logger.error(
                    f"Soloist daemon exited after {uptime:.1f}s with code {code}"
                )
                return

            self._daemon_restarts += 1
            decky.logger.warning(
                f"Soloist daemon exited with {code}; "
                f"restarting in {DAEMON_RESTART_DELAY:.0f}s"
            )
            await asyncio.sleep(DAEMON_RESTART_DELAY)
            settings = self._load_settings()

    async def _spawn_daemon(self, settings: dict) -> asyncio.subprocess.Process | None:
        if not settings["api_key"]:
            self._daemon_error = "No Spotify Soloist API key saved."
            return None

        args = [
            _soloist_bin(),
            "--device-name",
            settings["device_name"],
            "--api-key",
            settings["api_key"],
            "--ws",
            f"127.0.0.1:{SOLOIST_WS_PORT}",
        ]
        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                start_new_session=True,
                env=self._soloist_environment(),
            )
        except Exception as e:
            self._daemon_error = str(e)
            decky.logger.error(f"Failed to start Soloist daemon: {e}")
            return None

        decky.logger.info(
            f"Started Soloist daemon as '{settings['device_name']}' (pid {proc.pid})"
        )
        return proc

    async def _read_daemon_output(self, proc: asyncio.subprocess.Process) -> None:
        assert proc.stdout is not None
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            text = line.decode("utf-8", "replace").rstrip()
            if text:
                self._daemon_output.append(text)
                decky.logger.info(f"[daemon] {text}")

    async def _shutdown_daemon(self) -> None:
        self._daemon_stopping = True
        proc = self._daemon_proc
        if proc is not None and proc.returncode is None:
            await self._stop_process(proc)

        task = self._daemon_task
        if task is not None and task is not asyncio.current_task() and not task.done():
            try:
                await asyncio.wait_for(task, timeout=10)
            except asyncio.TimeoutError:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
            except Exception as e:
                decky.logger.error(f"Soloist daemon task failed: {e}")

        self._daemon_task = None
        self._daemon_stopping = False

    async def _stop_process(self, proc: asyncio.subprocess.Process) -> None:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except ProcessLookupError:
            return

        try:
            await asyncio.wait_for(proc.wait(), timeout=5)
        except asyncio.TimeoutError:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass

    # --- soloist download -------------------------------------------------

    async def get_download_status(self) -> dict:
        return dict(self._download_progress)

    async def download_soloist(self) -> dict:
        if self._download_task is not None and not self._download_task.done():
            return {"ok": False, "error": "Soloist download already in progress."}

        self._download_progress = {
            "status": DL_DOWNLOADING,
            "downloaded": 0,
            "total": 0,
            "percent": 0,
            "error": None,
        }
        self._download_task = asyncio.create_task(self._download_soloist())
        decky.logger.info("Downloading Spotify Soloist")
        return {"ok": True}

    async def _download_soloist(self) -> None:
        root = _soloist_root()
        os.makedirs(root, exist_ok=True)
        progress = self._download_progress

        try:
            with tempfile.TemporaryDirectory(prefix="solodeck-soloist-") as tmpdir:
                tarball = os.path.join(tmpdir, "soloist.tar.gz")

                # Download.
                progress["status"] = DL_DOWNLOADING
                decky.logger.info(f"Downloading soloist from {SOLOIST_RELEASE_URL}")
                with urllib.request.urlopen(SOLOIST_RELEASE_URL, timeout=30) as resp:
                    total = resp.headers.get("content-length")
                    progress["total"] = int(total) if total else 0
                    with open(tarball, "wb") as out:
                        while True:
                            chunk = resp.read(65536)
                            if not chunk:
                                break
                            out.write(chunk)
                            progress["downloaded"] += len(chunk)
                            if progress["total"]:
                                progress["percent"] = int(
                                    progress["downloaded"] * 100 / progress["total"]
                                )

                # Extract.
                progress["status"] = DL_EXTRACTING
                progress["percent"] = 0
                extract_dir = os.path.join(tmpdir, "extract")
                os.makedirs(extract_dir, exist_ok=True)
                with tarfile.open(tarball, "r:gz") as tar:
                    tar.extractall(extract_dir)

                # The tarball contains a top-level `soloist` executable (and
                # possibly other files). Find it and install it.
                found = None
                for dirpath, _dirnames, filenames in os.walk(extract_dir):
                    for name in filenames:
                        candidate = os.path.join(dirpath, name)
                        if os.access(candidate, os.X_OK) and name != "soloist.tar.gz":
                            found = candidate
                            break
                    if found:
                        break
                if not found:
                    raise RuntimeError("soloist executable not found in download archive")

                final_bin = _soloist_bin()
                shutil.move(found, final_bin)
                os.chmod(final_bin, 0o755)

            progress["status"] = DL_DONE
            progress["percent"] = 100
            decky.logger.info(f"Soloist downloaded and installed to {final_bin}")
        except Exception as e:
            progress["status"] = DL_FAILED
            progress["error"] = str(e)
            decky.logger.error(f"Soloist download failed: {e}")

    # Asyncio-compatible long-running code, executed in a task when the plugin is loaded
    async def _main(self):
        decky.logger.info("Starting solodeck")

        status = await self.get_soloist_status()
        if status["installed"]:
            os.chmod(_soloist_bin(), 0o755)
            try:
                decky.logger.info(f"Using {status['version']}")
            except Exception as e:
                decky.logger.error(f"Failed to run soloist: {e}")
        else:
            decky.logger.info(
                "Soloist is not downloaded yet. Open the plugin page and click "
                "\"Download Soloist\"."
            )

        # Keep the Spotify Connect device online for as long as the plugin is
        # loaded, unless the user stopped it from the config page.
        if self._is_paired():
            if self._load_settings()["daemon_enabled"]:
                await self.start_daemon()
            else:
                decky.logger.info("Soloist daemon is disabled in settings")
        else:
            decky.logger.info("Spotify is not paired yet")

    # Function called first during the unload process
    async def _unload(self):
        decky.logger.info("Stopping solodeck")
        await self.cancel_pairing()
        await self.cancel_web_api_auth()
        # Stop the process, but do not persist "daemon disabled": this also
        # runs on plugin reloads, after which the daemon should come back.
        await self._shutdown_daemon()
        if self._download_task is not None and not self._download_task.done():
            self._download_task.cancel()

    # Function called after `_unload` during uninstall
    async def _uninstall(self):
        decky.logger.info("Uninstalling solodeck")
