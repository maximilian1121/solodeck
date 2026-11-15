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

### Spotify account and library

The Quick Access panel can browse your Spotify library, search, and start a
track on the paired Soloist device using [SpotAPI](https://github.com/Aran404/SpotAPI).
This is a separate connection from Soloist and does not require a Spotify Web API
client ID. SpotAPI uses unofficial Spotify interfaces, which can change or rate
limit requests.

Select **Sign in to Spotify** in the plugin settings and complete Spotify's
login in the isolated browser window. The plugin includes the browser and its
libraries; you do not need to install them. If the window cannot open in Gaming
Mode, try Desktop Mode. This browser flow still needs verification on a Steam
Deck; **Manual connection** is available if it does not work.

For manual connection, sign in at `open.spotify.com` in a desktop browser. In
developer tools, open Application (or Storage) → Cookies → `open.spotify.com`,
copy the value of `sp_dc`, and paste it into the plugin. This cookie grants
access to your account; treat it like a password. By default the session is kept
only in memory. After signing in, you can optionally save an encrypted session
protected by a password you choose. Enter that password after a plugin or Steam
restart to unlock it; the password is not stored. If you forget it, sign in and
save a new session. This login does not change the Soloist pairing flow.

Spotify catalogue and library data are cached by the panel for convenience.
Disconnect the account in settings to clear its current session. The bundled
SpotAPI dependency is GPL-3.0; its license is included with the dependency in
the plugin package.

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
