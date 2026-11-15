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
import sys
import tempfile
import time
import urllib.request
import zipfile

import websockets

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
            raise RuntimeError(f"{route} timed out")
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
