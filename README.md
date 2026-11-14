# solodeck

A [Decky Loader](https://decky.xyz/) plugin that runs [Spotify Soloist](https://github.com/spotify/soloist) — the official Spotify Connect CLI/daemon for headless or custom applications that use Spotify Connect — on your Steam Deck.

The plugin appears as its own icon in the Steam Quick Access Menu tab strip (next to Steam's tabs and Decky's own), so it is one button away without going through Decky's plugin list. The Quick Access page itself is intentionally just a title; configuration lives in the plugin's page in Decky.

## Spotify Soloist (downloaded at runtime)

**soloist is NOT bundled with this plugin.** Spotify does not allow redistributing the soloist binary, so the plugin downloads it on demand from Spotify's official builds:

1. Open the plugin's page in Decky.
2. Click **Download Soloist** — this fetches the official `soloist_release_x86_64.tar.gz` from `soloist-builds.spotifycdn.com` and installs it into Decky's runtime data dir (`~/homebrew/data/solodeck/soloist/soloist`), where it persists across plugin updates.
3. Once downloaded, you can pair and start the daemon.

Soloist builds expire after 90 days. When your downloaded build expires, click **Download Soloist** again to fetch a newer build.

## Configuration

Open the plugin in Decky's Quick Access tab to:

- enter the **Spotify Soloist API key** (generated from Spotify for Developers; the account must have Premium),
- **start pairing**: soloist advertises itself as the "Steam Deck" Spotify Connect device, and once it is selected in the Spotify app it stores the session and exits.

The API key is stored in Decky's plugin settings directory
(`~/homebrew/settings/solodeck/settings.json`, mode `0600`). soloist has no
config file or environment variable for the key, so it is passed on the command
line and is therefore visible to `ps` while pairing or the daemon runs.

### Optional Spotify Web API

The QAM uses Soloist's WebSocket data first. If a current or queued track is
missing a useful title, solodeck can use the Spotify Web API to fill in the
track name, artist, and album artwork. This feature is optional and does not
control playback.

To enable it, create a Spotify app in the
[Spotify Developer Dashboard](https://developer.spotify.com/dashboard), copy
its **Client ID** (not a client secret or the Soloist API key), and enter it in
the Web API section of the plugin configuration. Add
`http://127.0.0.1:48256/callback` as an allowed Redirect URI, then select
**Set up Spotify Web API** and finish authorization in the Steam Deck's
browser. Authorization uses PKCE and a temporary callback server bound only to
the Deck's loopback interface on port 48256. Spotify allows HTTP for explicit
loopback IP redirect URIs, so this local callback does not need TLS and does not
use ports 80 or 443.
After starting authorization, choose **Open in default browser** or **Open in
Deck browser**. Spotify redirects to the Deck's local callback after approval.

OAuth tokens are stored in the private settings file. Track metadata is cached
locally for up to 30 days, with a maximum of 500 entries. Configuration shows
whether Web API authorization is connected. The QAM explorer uses this
authorization to browse playlists and followed artists, search Spotify, and
start a selected track in its playlist or album context. Reconnect Spotify Web
API in configuration if access is denied after an authorization-scope update.
Leaving the Client ID empty keeps this integration disabled.

## The daemon

Once the device is paired, the plugin keeps **soloist** running as a daemon for
as long as the plugin is loaded, so the Steam Deck stays available as a Spotify
Connect device. It starts automatically after pairing and whenever the plugin
loads (including after a plugin update or reload).

The same page shows the daemon state and has **Start Soloist daemon**, **Stop
Soloist daemon** and **Restart Soloist daemon** controls. Stopping is remembered:
the daemon stays stopped across plugin reloads until it is started again.
Changing the API key requires a restart to take effect.

The daemon is supervised: if it exits unexpectedly after running normally it is
restarted automatically. A process that fails immediately (invalid API key,
another soloist instance holding the data directory, an expired soloist build)
is not restarted in a loop; the reason is shown on the plugin page and in the
log at `~/homebrew/logs/solodeck/`.

Starting a new pairing stops the daemon first, because pairing clears the
stored session and soloist does not allow two instances to share its data
directory.

The daemon enables soloist's WebSocket API on an OS-assigned loopback port
(`--ws 127.0.0.1:35797`); it is not reachable from the network. The QAM panel
connects directly to this WebSocket for playback updates, without polling the
Python backend. On Linux, Soloist uses the system's default PipeWire output
(and falls back to PulseAudio if PipeWire is unavailable); no output device is
forced by the plugin. The plugin automatically supplies the user's runtime
directory to Soloist when needed so it can find the audio session; no manual
PipeWire environment setup is required.

## Requirements

- Decky Loader 3.x
- Network access to download soloist (or set `SOLOIST_RELEASE_URL` to a local
  mirror before downloading)

## Building

```bash
python3 build.py
```

`build.py` compiles the frontend and packages the plugin into
`solodeck-v<version>.zip`. The plugin version is just the package version
(e.g. `1.0`) — it is **not** tied to a soloist build, because soloist is
downloaded separately at runtime. The archive does not contain a soloist
binary.

Every push to `main` triggers a GitHub Actions build and creates a GitHub
Release with the packaged plugin ZIP attached. Each release has a unique
`main-<run>-<commit>` tag; the plugin version inside the ZIP remains the
version from `package.json`.

## Deploying

This is a local-only deploy tool (the Steam Deck is not reachable over SSH
from this machine):

```bash
python3 deploy.py            # build + install into local Decky
python3 deploy.py --local    # same as above (explicit)
python3 deploy.py --no-build # install the newest existing zip
```

It installs into the Decky Loader on this machine (`~/homebrew`) using Decky's
own install API (no sudo required), then uses Steam's local CEF debug port to
reload the frontend.
