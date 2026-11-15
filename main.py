import os
import sys

plugin_dir = os.path.dirname(os.path.realpath(__file__))
# Decky loads main.py via importlib without putting its directory on sys.path.
# Add it explicitly so the plugin's sibling modules are importable.
if plugin_dir not in sys.path:
    sys.path.insert(0, plugin_dir)
sys.path.insert(0, os.path.join(plugin_dir, "py_modules"))

# Decky's frozen Python may include html but omit html.parser. Supply the
# parser without replacing an already-loaded standard-library package.
stdlib_fallback = os.path.join(plugin_dir, "vendor", "python-stdlib")
sys.path.append(stdlib_fallback)
import html
html_fallback = os.path.join(stdlib_fallback, "html")
if html_fallback not in html.__path__:
    html.__path__.append(html_fallback)

import asyncio
import json
import shutil
import signal
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from collections import deque


from spotapi import AsyncClient
from spotapi_adapter import SpotAPIAdapterMixin
from spotapi_playback import SpotAPIPlaybackMixin
from spotapi_browser_login import browser_login_cookie

import decky

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

# After soloist exits with code 0 from --pair, it may need a moment to flush
# the session to disk before _is_paired() reports true. Poll briefly.
PAIRED_POLL_INTERVAL = 0.5
PAIRED_POLL_TIMEOUT = 5.0


def _soloist_root() -> str:
    # Persistent runtime data dir, outside the plugin folder so a downloaded
    # soloist survives plugin updates/reinstalls.
    root = decky.DECKY_PLUGIN_RUNTIME_DIR or os.path.join(
        os.path.expanduser("~"), ".local", "share", "solodeck"
    )
    return os.path.join(root, "soloist")


def _soloist_bin() -> str:
    return os.path.join(_soloist_root(), "soloist")


class Plugin(SpotAPIAdapterMixin, SpotAPIPlaybackMixin):
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

        self._spotify_session_cookie: str | None = None
        self._spotify_restore_lock = asyncio.Lock()
        self._browser_login_task: asyncio.Task | None = None
        self._browser_login_status = {"status": "idle"}

    async def _main(self):
        self._warm_task = asyncio.create_task(self._warm_player_loop())

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

    # --- Spotify account authentication -----------------------------------

    async def _spotify_cookie(self) -> str | None:
        # Restore an opted-in plaintext session on demand, so QAM/library calls
        # work even when the user has not opened the config screen this launch.
        if self._spotify_session_cookie:
            return self._spotify_session_cookie
        async with self._spotify_restore_lock:
            if self._spotify_session_cookie:
                return self._spotify_session_cookie
            try:
                cookie = await asyncio.to_thread(
                    lambda: open(
                        self._spotify_plaintext_session_path(), encoding="utf-8"
                    ).read().strip()
                )
            except OSError:
                return None
            if not cookie:
                return None
            result = await self.connect_spotify(cookie)
            return self._spotify_session_cookie if result.get("ok") else None

    async def get_auth_status(self) -> bool:
        # Presence does not guarantee that Spotify still accepts the session.
        return bool(await self._spotify_cookie())

    async def connect_spotify(self, cookie: str) -> dict:
        if asyncio.current_task() is not self._browser_login_task:
            self._browser_login_status = {"status": "idle"}
        value = (cookie or "").strip()
        if value.startswith("sp_dc="):
            value = value[6:]
        if not value or any(c in value for c in "\r\n;"):
            return {"ok": False, "error": "Enter the sp_dc cookie value only."}
        value = "sp_dc=" + value
        try:
            client = await asyncio.wait_for(AsyncClient.from_cookies(value), timeout=30)
            await client.close()
        except asyncio.TimeoutError:
            return {"ok": False, "error": "Spotify took too long to respond. Check your connection and try again."}
        except Exception:
            # Upstream error details can contain credentials; do not log them.
            return {"ok": False, "error": "Could not connect to Spotify. Check the cookie and your internet connection, then try again."}
        self._spotify_session_cookie = value
        await self._reset_spotify_client()
        await self._reset_player()
        return {"ok": True, "persistent": False}

    def _spotify_password_store(self):
        # This file contains only password-encrypted data, separate from settings.
        from spotify_password_store import PasswordSessionStore
        return PasswordSessionStore(os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "spotify-session.enc"))

    async def get_spotify_saved_session_status(self) -> dict:
        try:
            encrypted = await asyncio.to_thread(self._spotify_password_store().exists)
            plaintext = await asyncio.to_thread(os.path.isfile, self._spotify_plaintext_session_path())
            return {"saved": encrypted or plaintext, "encrypted": encrypted, "unencrypted": plaintext}
        except Exception:
            return {"saved": False, "error": "Could not check the saved Spotify session."}

    def _spotify_plaintext_session_path(self) -> str:
        return os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "spotify-session.txt")

    async def save_spotify_session_unencrypted(self) -> dict:
        cookie = await self._spotify_cookie()
        if not cookie:
            return {"ok": False, "error": "Connect your Spotify account first."}
        path = self._spotify_plaintext_session_path()
        try:
            def write_session():
                os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
                temporary = path + ".tmp"
                fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                try:
                    with os.fdopen(fd, "w", encoding="utf-8") as output:
                        output.write(cookie)
                        output.flush()
                        os.fsync(output.fileno())
                    os.replace(temporary, path)
                finally:
                    if os.path.exists(temporary):
                        os.unlink(temporary)
            await asyncio.to_thread(write_session)
            return {"ok": True, "encrypted": False}
        except OSError:
            return {"ok": False, "error": "Could not save the Spotify session."}

    async def unlock_spotify_session_unencrypted(self) -> dict:
        path = self._spotify_plaintext_session_path()
        try:
            cookie = await asyncio.to_thread(lambda: open(path, encoding="utf-8").read().strip())
        except OSError:
            return {"ok": False, "error": "No readable saved Spotify session was found."}
        return await self.connect_spotify(cookie)

    async def save_spotify_session(self, password: str) -> dict:
        cookie = await self._spotify_cookie()
        if not cookie:
            return {"ok": False, "error": "Connect your Spotify account first."}
        if not isinstance(password, str) or not password:
            return {"ok": False, "error": "Enter a password to protect the saved session."}
        try:
            await asyncio.to_thread(self._spotify_password_store().save, cookie, password)
            return {"ok": True}
        except Exception:
            # Never expose password, cookie, or cryptographic exception details.
            return {"ok": False, "error": "Could not save the protected Spotify session."}

    async def unlock_spotify_session(self, password: str) -> dict:
        if not isinstance(password, str) or not password:
            return {"ok": False, "error": "Enter your session password."}
        try:
            cookie = await asyncio.to_thread(self._spotify_password_store().unlock, password)
        except Exception:
            return {"ok": False, "error": "Could not unlock the saved session. Check your password and try again."}
        # Validate with Spotify before presenting the restored account as connected.
        return await self.connect_spotify(cookie)

    async def forget_spotify_session(self) -> dict:
        try:
            await asyncio.to_thread(self._spotify_password_store().clear)
            try:
                os.unlink(self._spotify_plaintext_session_path())
            except FileNotFoundError:
                pass
            return {"ok": True}
        except Exception:
            return {"ok": False, "error": "Could not remove the saved Spotify session."}

    async def start_spotify_browser_login(self) -> dict:
        """Launch an isolated Spotify sign-in and return immediately for UI polling."""
        if self._browser_login_task and not self._browser_login_task.done():
            return {"ok": False, "error": "Spotify sign-in is already running."}
        browser_path = os.path.join(plugin_dir, "playwright-browsers")
        if os.path.isdir(browser_path):
            os.environ["PLAYWRIGHT_BROWSERS_PATH"] = browser_path
        self._browser_login_status = {"status": "pending"}
        self._browser_login_task = asyncio.create_task(self._run_spotify_browser_login())
        return {"ok": True}

    async def _run_spotify_browser_login(self) -> None:
        try:
            cookie = await browser_login_cookie()
            result = await self.connect_spotify(cookie)
            if result.get("ok"):
                self._browser_login_status = {
                    "status": "connected", "persistent": result.get("persistent", False)
                }
            else:
                self._browser_login_status = {"status": "error", "error": result.get("error")}
        except asyncio.CancelledError:
            self._browser_login_status = {"status": "cancelled"}
            raise
        except TimeoutError:
            self._browser_login_status = {"status": "error", "error": "Spotify sign-in timed out. Please try again."}
        except Exception:
            # Browser errors may include paths or credentials; never expose them.
            self._browser_login_status = {"status": "error", "error": (
                "Could not open Spotify sign-in. Try Desktop Mode and check that the "
                "plugin's bundled browser is available, or use manual connection below."
            )}

    async def get_spotify_browser_login_status(self) -> dict:
        return dict(self._browser_login_status)

    async def cancel_spotify_browser_login(self) -> dict:
        task = self._browser_login_task
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            self._browser_login_status = {"status": "cancelled"}
        return {"ok": True}

    async def logout_spotify(self) -> dict:
        await self.cancel_spotify_browser_login()
        self._browser_login_status = {"status": "idle"}
        self._spotify_session_cookie = None
        await self._reset_spotify_client()
        await self._reset_player()
        return {"ok": True}

    async def _unload(self) -> None:
        """Close an in-progress isolated sign-in when Decky unloads the plugin."""
        task = getattr(self, "_warm_task", None)
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await self.cancel_spotify_browser_login()
        self._spotify_session_cookie = None
        await self._reset_spotify_client()
        await self._reset_player()

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
        # Keep network reads and archive extraction off Decky's event loop so
        # get_download_status can report progress while this work is running.
        await asyncio.to_thread(self._download_soloist_sync, self._download_progress)

    def _download_soloist_sync(self, progress: dict) -> None:
        try:
            root = _soloist_root()
            os.makedirs(root, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="solodeck-soloist-") as tmpdir:
                tarball = os.path.join(tmpdir, "soloist.tar.gz")

                # Download.
                progress["status"] = DL_DOWNLOADING
                decky.logger.info(f"Downloading soloist from {SOLOIST_RELEASE_URL}")
                with urllib.request.urlopen(SOLOIST_RELEASE_URL, timeout=30) as resp:
                    total = resp.headers.get("content-length")
                    try:
                        progress["total"] = max(0, int(total)) if total else 0
                    except ValueError:
                        progress["total"] = 0
                    with open(tarball, "wb") as out:
                        while True:
                            chunk = resp.read(65536)
                            if not chunk:
                                break
                            out.write(chunk)
                            progress["downloaded"] += len(chunk)
                            if progress["total"]:
                                progress["percent"] = min(100, int(
                                    progress["downloaded"] * 100 / progress["total"]
                                ))

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

    async def get_daemon_status(self) -> dict:
        proc = self._daemon_proc
        pid = proc.pid if proc is not None else None
        uptime = None
        if self._daemon_started_at is not None:
            uptime = time.time() - self._daemon_started_at
        settings = self._load_settings()
        return {
            "running": self._daemon_active(),
            "enabled": settings.get("daemon_enabled", True),
            "paired": self._is_paired(),
            "pid": pid,
            "exit_code": self._daemon_exit_code,
            "error": self._daemon_error,
            "output": list(self._daemon_output),
            "restarts": self._daemon_restarts,
            "uptime": uptime,
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

    async def _wait_for_paired(self) -> bool:
        # soloist may need a moment to flush the session to disk after it
        # exits from --pair. Poll _is_paired() briefly instead of failing
        # on the first check.
        deadline = time.monotonic() + PAIRED_POLL_TIMEOUT
        while time.monotonic() < deadline:
            if self._is_paired():
                return True
            await asyncio.sleep(PAIRED_POLL_INTERVAL)
        return self._is_paired()

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
                # Give soloist a moment to flush the session to disk before
                # starting the daemon (which gates on _is_paired()).
                self._set_daemon_enabled(True)
                if not await self._wait_for_paired():
                    decky.logger.warning(
                        "Pairing exited cleanly but soloist did not register "
                        "as paired within timeout"
                    )
                result = await self.start_daemon()
                if not result["ok"]:
                    decky.logger.warning(
                        f"Could not start daemon after pairing: {result.get('error')}"
                    )
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
