#!/usr/bin/env python3
"""Install the solodeck plugin into the Decky instance on this machine.

Installation goes through Decky Loader's websocket API (the same API the
Decky frontend uses), so no sudo password is required. The loader runs as
root and writes the plugin into ~/homebrew/plugins itself, then hot-loads
it immediately. Steam's CEF debug port is used afterwards to make Decky's
frontend load the new plugin bundle (and its Quick Access Menu tab).

This is a local-only deploy tool (the Steam Deck is not reachable over SSH
from here):

    python3 deploy.py            # build + install locally
    python3 deploy.py --local    # same as above (explicit)
    python3 deploy.py --no-build # install the newest existing zip

Configuration (environment variables):
    DECKY_PORT   Decky Loader HTTP/WS port on this machine (default: 1337)
    CEF_PORT     Steam's CEF debugging port              (default: 8080)
"""
import argparse
import asyncio
import glob
import json
import os
import socket
import subprocess
import time
import urllib.request
import zipfile

import websockets

DECKY_PORT = int(os.environ.get("DECKY_PORT", "1337"))  # Decky Loader HTTP/WS port (localhost only)
CEF_PORT = int(os.environ.get("DECK_CEF_PORT", "8080"))  # Steam CEF debug port
LOCAL_HOMEBREW = os.path.expanduser("~/homebrew")

# Message types of Decky's websocket protocol (see decky-loader wsrouter.py)
CALL, REPLY, DISCARD, RECEIVED_RESPONSE, FULL_SYNC, EVENT, ERROR = 0, 1, 2, 3, 4, 5, -1


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}


def plugin_meta():
    name = read_json("plugin.json").get("name", "solodeck")
    version = read_json("package.json").get("version", "0.0.0")
    return name, version


def latest_zip(plugin_name):
    """Return the most recently built plugin zip."""
    zips = glob.glob(f"{plugin_name}-v*.zip")
    if not zips:
        raise SystemExit(f"no {plugin_name}-v*.zip found - run build.py first")
    return max(zips, key=os.path.getmtime)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class DeckyClient:
    """Minimal client for Decky Loader's websocket router."""

    def __init__(self, ws):
        self.ws = ws
        self._id = 0
        self._pending = {}
        self._event_waiters = {}
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
                for queue in self._event_waiters.get(data.get("event"), []):
                    queue.put_nowait(data)

    async def call(self, route, *args, timeout=120):
        self._id += 1
        call_id = self._id
        future = asyncio.get_event_loop().create_future()
        self._pending[call_id] = future
        await self.ws.send(json.dumps(
            {"type": CALL, "id": call_id, "route": route, "args": list(args)}))
        reply = await asyncio.wait_for(future, timeout)
        if reply["type"] == ERROR:
            raise RuntimeError(f"{route} failed: {reply.get('error')}")
        return reply.get("result")

    async def wait_event(self, event, timeout=30):
        for saved in self.events:
            if saved.get("event") == event:
                return saved
        queue = asyncio.Queue()
        self._event_waiters.setdefault(event, []).append(queue)
        try:
            return await asyncio.wait_for(queue.get(), timeout)
        finally:
            self._event_waiters[event].remove(queue)


async def install_local(plugin_name, zip_filename):
    """Install the zip into the Decky instance running on this machine."""
    base = f"http://127.0.0.1:{DECKY_PORT}"
    try:
        with urllib.request.urlopen(base + "/auth/token", timeout=10) as res:
            token = res.read().decode().strip()
    except OSError:
        raise SystemExit(f"! no Decky Loader listening on {base}")

    artifact = "file://" + os.path.abspath(zip_filename)

    async with websockets.connect(f"ws://127.0.0.1:{DECKY_PORT}/ws?auth={token}") as ws:
        client = DeckyClient(ws)

        print(f"* requesting install of {artifact}")
        await client.call("utilities/install_plugin", artifact, plugin_name, "dev", "", 0)

        prompt = await client.wait_event("loader/add_plugin_install_prompt")
        request_id = prompt["args"][2]
        print(f"* confirming install request {request_id}")

        try:
            await client.call("utilities/confirm_plugin_install", request_id, timeout=20)
        except asyncio.TimeoutError:
            print("* Decky's frontend took the websocket back; "
                  "waiting for the install to finish")

    return wait_for_install(plugin_name, zip_filename, local=True)


def packaged_metadata(zip_filename, plugin_name):
    """Read the package.json that build.py baked into the plugin zip."""
    with zipfile.ZipFile(zip_filename) as z:
        return json.loads(z.read(f"{plugin_name}/package.json"))


def local_metadata(plugin_name):
    path = os.path.join(LOCAL_HOMEBREW, "plugins", plugin_name, "package.json")
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def wait_for_install(plugin_name, zip_filename, timeout=120, local=False):
    """Poll the installed package.json until it matches the built zip.

    Decky unpacks the zip before it loads the new backend, so a matching
    build_time means this deploy's files are on disk. A build that is already
    installed (same build_time) passes immediately, which is correct.
    """
    expected = packaged_metadata(zip_filename, plugin_name)
    print(f"* waiting for {plugin_name} {expected['version']} "
          f"(build {expected.get('build_time')}) to be installed")
    read_metadata = local_metadata if local else local_metadata
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        installed = read_metadata(plugin_name)
        if installed and installed.get("build_time") == expected.get("build_time"):
            print(f"* installed {plugin_name} {installed['version']}")
            return True
        time.sleep(2)
    print(f"! {plugin_name} was not installed within {timeout}s")
    return False


async def _cef_evaluate(ws_url, expression, timeout=60):
    async with websockets.connect(ws_url, max_size=50_000_000) as ws:
        await ws.send(json.dumps({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {"expression": expression, "returnByValue": True, "awaitPromise": True},
        }))
        while True:
            message = json.loads(await asyncio.wait_for(ws.recv(), timeout))
            if message.get("id") == 1:
                return message


async def reload_frontend_plugin(plugin_name):
    """Ask Decky's frontend to re-import the plugin.

    Installing over our own websocket connection takes over the loader's
    single socket, so the backend's `loader/import_plugin` event (which makes
    the frontend load the new bundle) is lost. Once the frontend has
    reconnected, Steam's CEF debug port lets us have the frontend itself call
    `utilities/enable_plugin`, which re-imports the plugin and its QAM tab.
    """
    cef_base = f"http://127.0.0.1:{CEF_PORT}"

    try:
        with urllib.request.urlopen(cef_base + "/json/list", timeout=10) as res:
            targets = json.load(res)
    except OSError:
        print("! Steam's CEF debug port is not reachable; open the Quick Access Menu "
              "or restart Steam to pick up the new frontend")
        return False

    target = next((t for t in targets if t.get("title") == "SharedJSContext"), None)
    if target is None:
        print("! SharedJSContext not found; restart Steam to pick up the new frontend")
        return False

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
    result = await _cef_evaluate(target["webSocketDebuggerUrl"], expression)
    details = result.get("result", {})
    if details.get("exceptionDetails"):
        print(f"! frontend reload failed: {details['exceptionDetails'].get('text')}")
        return False
    value = details.get("result", {}).get("value")
    if value != "ok":
        print(f"! frontend reload returned {value!r}")
        return False
    print("* frontend reloaded the plugin")
    return True


async def async_main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--no-build", action="store_true", help="skip rebuilding the plugin")
    parser.add_argument("--local", action="store_true",
                        help="install into the Decky instance on this machine (default)")
    args = parser.parse_args()

    plugin_name, _version = plugin_meta()

    if not args.no_build:
        print("* building plugin zip")
        subprocess.run(["python3", "build.py"], check=True)

    zip_filename = latest_zip(plugin_name)
    print(f"* using {zip_filename}")

    ok = await install_local(plugin_name, zip_filename)

    if not ok:
        raise SystemExit("! plugin was not loaded - check the Decky loader logs")
    await reload_frontend_plugin(plugin_name)
    print(f"* {plugin_name} installed and loaded")


def main():
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
