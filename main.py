import os
import sys

plugin_dir = os.path.dirname(os.path.realpath(__file__))
sys.path.append(os.path.join(plugin_dir, "py_modules"))

import asyncio
import json
import shutil
import signal
import socket
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from aiohttp import web
from collections import deque


from spotapi import AsyncClient

import decky

# Spotify API (spotapi) QR authentication
SPOTIFY_AUTH_PORT = 8765
SPOTIFY_COOKIE_SETTING_KEY = "spotify_cookie"

# Spotify Soloist download archive. Override with SOLOIST_RELEASE_URL for
# local/offline testing (e.g. a file:// URL to a local tarball).
SOLOIST_RELEASE_URL = os.environ.get(
    "SOLOIST_RELEASE_URL",
    "https://soloist-builds.spotifycdn.com/soloist_release_x86_64.tar.gz",
)

# The plugin's own configuration lives under the settings dir Decky manages.
SETTINGS_FILE = os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")
DEFAULT_DEVICE_NAME = "solodeck"

# Download status phases.
DL_IDLE = "idle"
DL_DOWNLOADING = "downloading"
DL_EXTRACTING = "extracting"
DL_DONE = "done"
DL_FAILED = "failed"

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


def _soloist_root() -> str:
    # Persistent runtime data dir, outside the plugin folder so a downloaded
    # soloist survives plugin updates/reinstalls.
    root = decky.DECKY_PLUGIN_RUNTIME_DIR or os.path.join(
        os.path.expanduser("~"), ".local", "share", "solodeck"
    )
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

        # Spotify API (spotapi) QR auth server
        self._auth_runner: web.AppRunner | None = None
        self._auth_server_task: asyncio.Task | None = None

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
            return {"ok": False, "error": "Enter your Spotify Soloist API key first."}

        settings = self._load_settings()
        settings["device_name"] = name
        self._save_settings(settings)
        decky.logger.info(f"Saved Soloist device name: {name}")
        return {"ok": True}

    # --- Spotify API (spotapi) QR authentication ---------------------------

    async def start_qr_auth(self) -> str:
        """Start a local HTTP server for Spotify QR-code authentication.

        Returns the HTTP URL the user should open on their phone.
        """
        await self.stop_qr_auth()

        # Pick a port: try 8765 first, then fall back to a free port.
        port = SPOTIFY_AUTH_PORT
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.bind(("0.0.0.0", port))
        except OSError:
            sock.bind(("0.0.0.0", 0))
            port = sock.getsockname()[1]
        finally:
            sock.close()

        # Determine the local LAN IP address.
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("8.8.8.8", 80))
            local_ip = probe.getsockname()[0]
        except Exception:
            local_ip = "127.0.0.1"
        finally:
            probe.close()

        app = web.Application()
        app.router.add_get("/", self._handle_auth_get)
        app.router.add_post("/submit", self._handle_auth_submit)

        self._auth_runner = web.AppRunner(app)
        await self._auth_runner.setup()
        site = web.TCPSite(self._auth_runner, "0.0.0.0", port)
        await site.start()

        url = f"http://{local_ip}:{port}"
        decky.logger.info(f"Spotify QR auth server started at {url}")
        return url

    async def stop_qr_auth(self) -> None:
        """Stop the local HTTP auth server if running."""
        if self._auth_runner is not None:
            try:
                await self._auth_runner.cleanup()
            except Exception as error:
                decky.logger.warning(
                    f"Error stopping auth server: {error}"
                )
            self._auth_runner = None
        self._auth_server_task = None

    async def get_auth_status(self) -> bool:
        """Return True if a Spotify cookie is saved in settings."""
        settings = self._load_settings()
        return bool(settings.get(SPOTIFY_COOKIE_SETTING_KEY))

    async def logout_spotify(self) -> dict:
        """Remove the saved Spotify cookie."""
        settings = self._load_settings()
        if SPOTIFY_COOKIE_SETTING_KEY in settings:
            del settings[SPOTIFY_COOKIE_SETTING_KEY]
            self._save_settings(settings)
        await self.stop_qr_auth()
        return {"ok": True}

    async def _handle_auth_get(self, request: web.Request) -> web.Response:
        """Serve the QR-code login form."""
        html = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Spotify Login</title>
<style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #121212; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    h1 { color: #1ed760; font-size: 28px; margin-bottom: 8px; }
    p { color: #a9a9a9; font-size: 16px; text-align: center; max-width: 400px; margin-bottom: 24px; }
    form { display: flex; flex-direction: column; align-items: center; gap: 16px; width: 100%; max-width: 400px; }
    input { width: 100%; padding: 14px; border-radius: 4px; border: none; background: #1a1a1a; color: #fff; font-size: 16px; box-sizing: border-box; }
    button { width: 100%; padding: 14px; border-radius: 4px; border: none; background: #1ed760; color: #000; font-size: 16px; font-weight: 700; cursor: pointer; }
    button:hover { background: #1ed15c; }
    .hint { font-size: 13px; color: #666; margin-top: 16px; text-align: center; }
    .hint a { color: #1ed760; text-decoration: none; }
    .hint a:hover { text-decoration: underline; }
</style>
</head>
<body>
<h1>Spotify</h1>
<p>Paste your Spotify <code>sp_dc</code> cookie below to log in.</p>
<p class="hint">Get it from <a href="https://open.spotify.com" target="_blank">open.spotify.com</a> in your browser's DevTools (Application → Cookies → sp_dc).</p>
<form id="form" method="post" action="/submit">
    <input type="text" name="sp_dc" placeholder="sp_dc=..." required autocomplete="off" autocorrect="off" spellcheck="false">
    <button type="submit">Sign In</button>
</form>
<script>
document.getElementById('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const sp_dc = formData.get('sp_dc');
    const cookie = sp_dc.startsWith('sp_dc=') ? sp_dc : 'sp_dc=' + sp_dc;
    formData.set('sp_dc', cookie);
    const res = await fetch('/submit', { method: 'POST', body: formData });
    if (res.ok) {
        document.body.innerHTML = '<div style="text-align:center; color:#1ed760; font-size:20px;"><h1 style="color:#1ed760;">Signed in!</h1><p>You can close this page and return to the Deck.</p></div>';
    } else {
        const text = await res.text();
        alert('Login failed: ' + text);
    }
});
</script>
</body>
</html>"""
        return web.Response(text=html, content_type="text/html")

    async def _handle_auth_submit(self, request: web.Request) -> web.Response:
        """Handle the submitted sp_dc cookie and validate it."""
        try:
            form = await request.post()
        except Exception:
            return web.Response(
                text="Invalid form data.", status=400, content_type="text/html"
            )

        cookie = form.get("sp_dc", "")
        if not isinstance(cookie, str) or not cookie.strip():
            return web.Response(
                text="Missing sp_dc cookie.", status=400, content_type="text/html"
            )

        cookie = cookie.strip()
        if not cookie.startswith("sp_dc="):
            cookie = "sp_dc=" + cookie

        # Validate by creating a spotapi client (this validates the cookie).
        try:
            client = await AsyncClient.from_cookies(cookie)
            await client.close()
        except Exception as error:
            decky.logger.warning(f"Spotify cookie validation failed: {error}")
            return web.Response(
                text="Invalid Spotify cookie. Please check and try again.",
                status=400,
                content_type="text/html",
            )

        # Save the cookie persistently.
        settings = self._load_settings()
        settings[SPOTIFY_COOKIE_SETTING_KEY] = cookie
        self._save_settings(settings)

        # Notify the frontend that auth succeeded.
        try:
            decky.emit("spotify_auth_success", True)
        except Exception:
            pass

        # Stop the auth server after a short delay so the response can be sent.
        asyncio.create_task(self._stop_after_delay())

        html = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Signed In</title>
<style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #121212; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    h1 { color: #1ed760; font-size: 28px; margin-bottom: 8px; }
    p { color: #a9a9a9; font-size: 16px; text-align: center; max-width: 400px; }
</style>
</head>
<body>
<h1 style="color:#1ed760;">Signed In!</h1>
<p>You can close this page and return to the Deck.</p>
</body>
</html>"""
        return web.Response(text=html, content_type="text/html")

    async def _stop_after_delay(self) -> None:
        """Stop the auth server after a short delay so the response can be sent."""
        await asyncio.sleep(1)
        await self.stop_qr_auth()

    # --- End of Spotify API (spotapi) QR authentication --------------------

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

    # --- soloist pairing ---------------------------------------------------

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
        self._pairing_cancelled = True
        await self._stop_process(proc)
        return {"ok": True}

    # --- soloist daemon ----------------------------------------------------

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

    # --- internal helpers --------------------------------------------------

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
        return settings

    def _save_settings(self, settings: dict) -> None:
        os.makedirs(decky.DECKY_PLUGIN_SETTINGS_DIR, exist_ok=True)
        tmp = SETTINGS_FILE + ".tmp"
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