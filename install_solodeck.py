#!/usr/bin/env python3
"""Self-contained Solodeck installer / updater.

Downloads the latest pre-built plugin zip from GitHub Releases and installs it
into Decky Loader on this machine (~/homebrew/plugins/solodeck) using Decky's
own websocket API, then reloads the frontend so the Quick Access Menu picks up
the new tab.

No build happens at runtime (no pnpm, no pip) — just downloads the already-built
zip and deploys it, same as `deploy.py --no-build` but fetching the zip itself.

Usage:
    chmod +x install_solodeck.py
    python3 install_solodeck.py
"""
import asyncio
import json
import os
import base64
import hashlib
import struct
import sys
import tempfile
import time
import urllib.request
import zipfile
from urllib.parse import urlsplit


class _LocalWebSocket:
    """Small asyncio WebSocket client using only Python's standard library."""

    def __init__(self, url, max_size=50_000_000):
        self.url = urlsplit(url)
        self.max_size = max_size
        self.reader = None
        self.writer = None
        self._fragments = []

    async def __aenter__(self):
        if self.url.scheme != "ws" or not self.url.hostname:
            raise ValueError("Decky and Steam must expose a local ws:// endpoint")
        port = self.url.port or 80
        self.reader, self.writer = await asyncio.open_connection(self.url.hostname, port)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        path = self.url.path or "/"
        if self.url.query:
            path += "?" + self.url.query
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {self.url.netloc}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.writer.write(request.encode("ascii"))
        await self.writer.drain()
        response = await self.reader.readuntil(b"\r\n\r\n")
        lines = response.decode("latin-1").split("\r\n")
        if len(lines[0].split()) < 2 or lines[0].split()[1] != "101":
            raise ConnectionError(f"WebSocket handshake failed: {lines[0]}")
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                name, value = line.split(":", 1)
                headers[name.strip().lower()] = value.strip()
        accept = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
        ).decode("ascii")
        if headers.get("sec-websocket-accept") != accept:
            raise ConnectionError("WebSocket server returned an invalid accept key")
        return self

    async def __aexit__(self, *_exc):
        if self.writer is not None:
            try:
                await self._send_frame(8, b"")
            except (ConnectionError, OSError):
                pass
            self.writer.close()
            try:
                await self.writer.wait_closed()
            except OSError:
                pass

    async def _send_frame(self, opcode, payload):
        if self.writer is None:
            raise ConnectionError("WebSocket is closed")
        mask = os.urandom(4)
        length = len(payload)
        head = bytearray([0x80 | opcode])
        if length < 126:
            head.append(0x80 | length)
        elif length <= 0xFFFF:
            head.append(0x80 | 126)
            head.extend(struct.pack("!H", length))
        else:
            head.append(0x80 | 127)
            head.extend(struct.pack("!Q", length))
        masked = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        self.writer.write(bytes(head) + mask + masked)
        await self.writer.drain()

    async def send(self, message):
        if isinstance(message, str):
            payload = message.encode("utf-8")
        else:
            payload = bytes(message)
        await self._send_frame(1, payload)

    async def recv(self):
        while True:
            first, second = await self.reader.readexactly(2)
            fin, opcode = bool(first & 0x80), first & 0x0F
            masked, length = bool(second & 0x80), second & 0x7F
            if length == 126:
                length = struct.unpack("!H", await self.reader.readexactly(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", await self.reader.readexactly(8))[0]
            if length > self.max_size:
                raise ValueError("WebSocket message exceeds the installer limit")
            mask = await self.reader.readexactly(4) if masked else None
            payload = await self.reader.readexactly(length)
            if mask:
                payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
            if opcode == 8:
                raise ConnectionError("WebSocket connection closed")
            if opcode == 9:
                await self._send_frame(10, payload)
                continue
            if opcode == 10:
                continue
            if opcode in (1, 2):
                self._fragments = [payload]
                self._fragment_opcode = opcode
            elif opcode == 0 and self._fragments:
                self._fragments.append(payload)
            else:
                continue
            if fin:
                result = b"".join(self._fragments)
                opcode = self._fragment_opcode
                self._fragments = []
                return result.decode("utf-8") if opcode == 1 else result

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return await self.recv()
        except (ConnectionError, asyncio.IncompleteReadError):
            raise StopAsyncIteration


class _WebSocketsCompat:
    @staticmethod
    def connect(url, max_size=50_000_000):
        return _LocalWebSocket(url, max_size=max_size)


websockets = _WebSocketsCompat()

DECKY_PORT = int(os.environ.get("DECKY_PORT", "1337"))   # Decky Loader HTTP/WS
CEF_PORT = int(os.environ.get("CEF_PORT", "8080"))       # Steam CEF debug port
REPO = "maximilian1121/solodeck"

# Decky websocket protocol message types (decky-loader wsrouter.py)
CALL, REPLY, DISCARD, RECEIVED_RESPONSE, FULL_SYNC, EVENT, ERROR = 0, 1, 2, 3, 4, 5, -1


def log(msg):
    print(msg, flush=True)


def fail(msg):
    print(f"! {msg}", file=sys.stderr, flush=True)
    if os.environ.get("SOLodeck_NO_PAUSE") != "1":
        try:
            input("Press Enter to close this window...")
        except EOFError:
            pass
    sys.exit(1)


class DeckyClient:
    """Minimal client for Decky Loader's websocket router."""

    def __init__(self, ws):
        self.ws = ws
        self._id = 0
        self._pending = {}
        self.events = []
        asyncio.get_event_loop().create_task(self._reader())

    async def _reader(self):
        async for message in self.ws:
            data = json.loads(message)
            msg_type = data.get("type")
            if msg_type in (REPLY, ERROR):
                fut = self._pending.pop(data.get("id"), None)
                if fut and not fut.done():
                    fut.set_result(data)
                await self.ws.send(json.dumps({"type": RECEIVED_RESPONSE, "id": data.get("id")}))
            elif msg_type == EVENT:
                self.events.append(data)

    async def call(self, route, *args, timeout=120):
        self._id += 1
        call_id = self._id
        future = asyncio.get_event_loop().create_future()
        self._pending[call_id] = future
        await self.ws.send(json.dumps(
            {"type": CALL, "id": call_id, "route": route, "args": list(args)}))
        try:
            reply = await asyncio.wait_for(future, timeout)
        except asyncio.TimeoutError:
            self._pending.pop(call_id, None)
            # Keep timeout type intact so install callers can distinguish a
            # slow Decky confirmation from an explicit route failure. Decky
            # may finish installing after the confirmation RPC times out.
            raise asyncio.TimeoutError(f"{route} timed out") from None
        if reply["type"] == ERROR:
            raise RuntimeError(f"{route} failed: {reply.get('error')}")
        return reply.get("result")

    async def wait_event(self, event, timeout=30):
        for saved in self.events:
            if saved.get("event") == event:
                return saved
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            for saved in self.events:
                if saved.get("event") == event:
                    return saved
            await asyncio.sleep(0.2)
        raise RuntimeError(f"timed out waiting for event {event}")


def latest_release_zip():
    """Return (zip_url, asset_name) for the latest GitHub Release zip asset."""
    api = f"https://api.github.com/repos/{REPO}/releases/latest"
    log(f"* querying {api}")
    with urllib.request.urlopen(api, timeout=30) as r:
        release = json.load(r)
    for asset in release.get("assets", []):
        name = asset.get("name", "")
        if name.endswith(".zip"):
            return asset["browser_download_url"], name
    # No zip asset: fall back to tag download of a conventional name
    tag = release.get("tag_name", "main")
    fallback = f"https://github.com/{REPO}/releases/download/{tag}/solodeck-v{tag.lstrip('v')}.zip"
    log(f"* no zip asset found; trying {fallback}")
    return fallback, f"solodeck-{tag}.zip"


def shutil_copyfileobj(src, dst, length=1024 * 1024):
    while True:
        buf = src.read(length)
        if not buf:
            break
        dst.write(buf)


def download_zip(url):
    log(f"* downloading {url}")
    fd, path = tempfile.mkstemp(prefix="solodeck-", suffix=".zip")
    os.close(fd)
    try:
        with urllib.request.urlopen(url, timeout=300) as r, open(path, "wb") as f:
            shutil_copyfileobj(r, f)
    except Exception as e:
        os.unlink(path)
        fail(f"could not download plugin zip: {e}")
    return path

async def install_into_decky(zip_path, plugin_name):
    """Push the zip into Decky Loader and wait for it to be installed."""
    base = f"http://127.0.0.1:{DECKY_PORT}"
    try:
        with urllib.request.urlopen(base + "/auth/token", timeout=10) as res:
            token = res.read().decode().strip()
    except OSError:
        fail(f"no Decky Loader listening on {base} — start Steam with Decky Loader first")

    artifact = "file://" + os.path.abspath(zip_path)

    async with websockets.connect(f"ws://127.0.0.1:{DECKY_PORT}/ws?auth={token}") as ws:
        client = DeckyClient(ws)

        log(f"* requesting install of {artifact}")
        await client.call("utilities/install_plugin", artifact, plugin_name, "dev", "", 0)

        try:
            prompt = await client.wait_event("loader/add_plugin_install_prompt", timeout=30)
        except RuntimeError:
            log("* no install prompt received; Decky may have auto-confirmed")
            prompt = None

        if prompt is not None:
            request_id = prompt["args"][2]
            log(f"* confirming install request {request_id}")
            try:
                await client.call("utilities/confirm_plugin_install", request_id, timeout=20)
            except asyncio.TimeoutError:
                log("* Decky frontend took the websocket back; waiting for install to finish")

    # Poll the installed package.json until build_time matches the zip.
    await wait_for_install(zip_path, plugin_name)


def zip_build_time(zip_path):
    with zipfile.ZipFile(zip_path) as z:
        meta = json.loads(z.read(f"solodeck/package.json"))
    return meta.get("build_time"), meta.get("version")


def local_package_meta(plugin_name):
    path = os.path.expanduser(f"~/homebrew/plugins/{plugin_name}/package.json")
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


async def wait_for_install(zip_path, plugin_name, timeout=120):
    expected_build, expected_version = zip_build_time(zip_path)
    log(f"* waiting for {plugin_name} {expected_version} (build {expected_build}) to be installed")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        installed = local_package_meta(plugin_name)
        if installed and installed.get("build_time") == expected_build:
            log(f"* installed {plugin_name} {installed.get('version')}")
            return True
        await asyncio.sleep(2)
    fail(f"{plugin_name} was not installed within {timeout}s — check Decky loader logs")
    return False


async def reload_frontend(plugin_name):
    """Use Steam's CEF debug port to tell Decky's frontend to re-import the plugin."""
    cef_base = f"http://127.0.0.1:{CEF_PORT}"
    try:
        with urllib.request.urlopen(cef_base + "/json/list", timeout=10) as res:
            targets = json.load(res)
    except OSError:
        log("! Steam's CEF debug port is not reachable; open the Quick Access Menu "
            "or restart Steam to pick up the new frontend")
        return

    target = next((t for t in targets if t.get("title") == "SharedJSContext"), None)
    if target is None:
        log("! SharedJSContext not found; restart Steam to pick up the new frontend")
        return

    expression = f"""(async () => {{
        const backend = window.DeckyBackend;
        if (!backend) return "DeckyBackend missing";
        for (let i = 0; i < 60; i++) {{
            if (backend.ws && backend.ws.readyState === 1) break;
            await new Promise((resolve) => setTimeout(resolve, 500));
        }}
        await backend.call("utilities/enable_plugin", {json.dumps(plugin_name)});
        return "ok";
    }})()"""

    async with websockets.connect(target["webSocketDebuggerUrl"], max_size=50_000_000) as ws:
        await ws.send(json.dumps({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {"expression": expression, "returnByValue": True, "awaitPromise": True},
        }))
        while True:
            message = json.loads(await asyncio.wait_for(ws.recv(), timeout=60))
            if message.get("id") == 1:
                break

    details = message.get("result", {})
    if details.get("exceptionDetails"):
        log(f"! frontend reload failed: {details['exceptionDetails'].get('text')}")
        return
    value = details.get("result", {}).get("value")
    if value != "ok":
        log(f"! frontend reload returned {value!r}")
        return
    log("* frontend reloaded the plugin")


async def async_main():
    plugin_name = "solodeck"

    url, asset_name = latest_release_zip()
    zip_path = download_zip(url)
    try:
        await install_into_decky(zip_path, plugin_name)
        await reload_frontend(plugin_name)
        log(f"* {plugin_name} installed and loaded")
    finally:
        try:
            os.unlink(zip_path)
        except OSError:
            pass


def main():
    try:
        asyncio.run(async_main())
    except SystemExit:
        raise
    except Exception as e:
        fail(f"install failed: {e}")


if __name__ == "__main__":
    main()
