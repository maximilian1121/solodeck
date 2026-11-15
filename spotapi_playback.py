"""SpotAPI playback and track metadata for the Decky UI."""

import asyncio
import traceback

from spotapi import AsyncClient, Catalogue, Player
from spotapi.lyrics import LyricsClient

import decky


def _spotify_uri_id(uri: str, kind: str) -> str | None:
    parts = uri.split(":") if isinstance(uri, str) else []
    if len(parts) == 3 and parts[0] == "spotify" and parts[1] == kind and parts[2]:
        return parts[2]
    return None


def _log_spotapi_failure(operation: str, error: Exception) -> None:
    # Upstream exception text can contain account or request details.
    try:
        decky.logger.warning(f"Spotify {operation} failed ({type(error).__name__})")
    except Exception:
        pass


class SpotAPIPlaybackMixin:
    def _spotapi_log_failure(self, operation: str, error: Exception) -> None:
        _log_spotapi_failure(operation, error)

    def _player_lock(self) -> asyncio.Lock:
        lock = getattr(self, "_spotify_player_lock", None)
        if lock is None:
            lock = self._spotify_player_lock = asyncio.Lock()
        return lock

    async def _warm_player_loop(self) -> None:
        """Keep a ready player around so the first click is not a cold start.

        This loop never holds a player reference and never tears anything down.
        _get_or_create_player already rebuilds a dead connection, so calling it
        on a timer is all the health checking we need.
        """
        delay = 5
        while True:
            try:
                cookie = await self._spotify_cookie()
                if cookie:
                    await self._get_or_create_player(cookie)
                    delay = 5
                    await asyncio.sleep(10)
                    continue
            except asyncio.CancelledError:
                raise
            except Exception as error:
                self._spotapi_log_failure("player warmup", error)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60)

    async def _get_or_create_player(self, cookie: str) -> tuple[Player, AsyncClient]:
        """Return a ready, persistent Player for the given cookie.

        Re-creates the player only when the cookie changes or the existing
        connection has dropped. The caller must NOT close the client, because
        it is owned by this entry.

        The device name is deliberately not part of the cache key. Player never
        uses it, and including it made every click rebuild the warmed player.
        """
        async with self._player_lock():
            entry = getattr(self, "_spotify_player_entry", None)

            if entry is not None and (
                entry["cookie"] != cookie or not entry["player"].is_ready
            ):
                await self._teardown_player_entry(entry)
                entry = None
                self._spotify_player_entry = None

            if entry is None:
                client = await AsyncClient.from_cookies(cookie)
                player = Player(client)
                # Send commands from our own controller. If the target device is
                # also the active device, the default route would mail Soloist
                # a command from Soloist, and Soloist ignores its own mail.
                player.source_device_id = player.controller_id
                # Managed background task that keeps the WebSocket alive.
                task = asyncio.create_task(
                    player.start(), name="spotapi-player-keepalive"
                )
                try:
                    await asyncio.wait_for(player.wait_until_ready(), timeout=15)
                except (asyncio.TimeoutError, TimeoutError):
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                    await client.close()
                    raise TimeoutError("Spotify Connect handshake timed out.")
                entry = {
                    "cookie": cookie,
                    "client": client,
                    "player": player,
                    "task": task,
                }
                self._spotify_player_entry = entry
                decky.logger.info("Persistent SpotAPI player connected")

            return entry["player"], entry["client"]

    @staticmethod
    async def _teardown_player_entry(entry: dict) -> None:
        """Cancel the keepalive task and close the client for a stale entry."""
        try:
            task: asyncio.Task = entry["task"]
            player: Player = entry["player"]
            await player.close()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        except Exception:
            pass
        try:
            await entry["client"].close()
        except Exception:
            pass

    async def _reset_player(self) -> None:
        """Tear down any persistent player (call on logout or cookie rotation)."""
        async with self._player_lock():
            entry = getattr(self, "_spotify_player_entry", None)
            self._spotify_player_entry = None
        if entry is not None:
            await self._teardown_player_entry(entry)
            decky.logger.info("Persistent SpotAPI player torn down")

    async def play_spotify_track(self, track_uri: str) -> dict:
        """Play a standalone track on the configured Soloist device."""
        if not _spotify_uri_id(track_uri, "track"):
            return {"ok": False, "error": "Invalid Spotify track."}

        try:
            settings = self._load_settings()
            device_name = settings.get("device_name", "").strip().casefold()
            if not device_name:
                return {"ok": False, "error": "Set a Soloist device name first."}
            cookie = await self._spotify_cookie()
            if not cookie:
                return {"ok": False, "error": "Connect your Spotify account first."}
            player, _client = await self._get_or_create_player(cookie)
            matching_devices = [
                device
                for device in player.devices
                if isinstance(getattr(device, "name", None), str)
                and device.name.strip().casefold() == device_name
            ]
            if not matching_devices:
                return {
                    "ok": False,
                    "error": "Could not find the Soloist Spotify device. Make sure it is running and connected.",
                }
            if len(matching_devices) > 1:
                return {
                    "ok": False,
                    "error": "More than one Spotify device has the Soloist name. Give Soloist a unique name and try again.",
                }

            player.select(matching_devices[0])
            await player.command(
                "play",
                wait=False,
                context={
                    "uri": track_uri,
                    "url": "context://" + track_uri,
                    "metadata": {},
                },
                play_origin={
                    "feature_identifier": "spotapi",
                    "referrer_identifier": "spotapi",
                },
                options={"initially_paused": False, "seek_to": 0},
            )
            return {"ok": True}
        except Exception as error:
            self._spotapi_log_failure("track playback", error)
            if isinstance(error, (RuntimeError, TimeoutError)):
                try:
                    await self._reset_player()
                except Exception:
                    pass
            return {
                "ok": False,
                "error": "Could not start this track. Check that Spotify is connected and try again.",
            }

    async def play_web_api_track_in_context(
        self, context_uri: str, track_uri: str, position: int
    ) -> dict:
        """Play the selected item at its occurrence inside a playlist or album."""
        context_type = (context_uri or "").split(":")[1:2]
        if (
            not context_type
            or context_type[0] not in ("playlist", "album")
            or not _spotify_uri_id(context_uri, context_type[0])
            or not _spotify_uri_id(track_uri, "track")
            or type(position) is not int
            or position < 0
        ):
            return {"ok": False, "error": "Invalid playlist track selection."}

        try:
            settings = self._load_settings()
            device_name = settings.get("device_name", "").strip().casefold()
            if not device_name:
                return {"ok": False, "error": "Set a Soloist device name first."}

            cookie = await self._spotify_cookie()
            if not cookie:
                return {"ok": False, "error": "Connect your Spotify account first."}

            player, _client = await self._get_or_create_player(cookie)

            matching_devices = [
                device
                for device in player.devices
                if isinstance(getattr(device, "name", None), str)
                and device.name.strip().casefold() == device_name
            ]
            if not matching_devices:
                return {
                    "ok": False,
                    "error": (
                        "Could not find the Soloist Spotify device. "
                        "Make sure it is running and connected."
                    ),
                }
            if len(matching_devices) > 1:
                return {
                    "ok": False,
                    "error": (
                        "More than one Spotify device has the Soloist name. "
                        "Give Soloist a unique name and try again."
                    ),
                }

            player.select(matching_devices[0])
            await player.command(
                "play",
                wait=False,
                context={
                    "uri": context_uri,
                    "url": "context://" + context_uri,
                    "metadata": {},
                },
                play_origin={
                    "feature_identifier": "spotapi",
                    "referrer_identifier": "spotapi",
                },
                options={
                    "initially_paused": False,
                    "seek_to": 0,
                    "skip_to": {"track_uri": track_uri, "track_index": position},
                },
            )
            return {"ok": True}
        except Exception as error:
            # Do not log request bodies, cookies, or upstream response details.
            self._spotapi_log_failure("context playback", error)
            # Log the traceback location (not values) so we can diagnose.
            try:
                decky.logger.warning(
                    "context playback traceback:\n"
                    + "".join(traceback.format_tb(error.__traceback__))
                )
            except Exception:
                pass
            # Only rebuild on connection style errors. A bad request should not
            # cost the user a fresh handshake.
            if isinstance(error, (RuntimeError, TimeoutError)):
                try:
                    await self._reset_player()
                except Exception:
                    pass
            return {
                "ok": False,
                "error": "Could not start playback in this playlist. Check that Spotify is connected and try again.",
            }

    async def get_track_metadata(self, uri: str) -> dict | None:
        # Catalogue lookups do not need a user account. Borrow the authenticated
        # session when available so Spotify can apply the account's market.
        from spotapi_adapter import format_track

        client = None
        try:
            cookie = await self._spotify_cookie()
            if cookie:
                client = await AsyncClient.from_cookies(cookie)
            async with Catalogue(client) as catalogue:
                return format_track(await catalogue.get_track(uri))
        except Exception as error:
            # Metadata is a best-effort enrichment for Soloist's current track.
            # Avoid logging exception text, which can contain request credentials.
            self._spotapi_log_failure("track metadata", error)
            return None
        finally:
            if client is not None:
                await client.close()

    async def get_spotify_lyrics(self, uri: str) -> dict:
        """Return Spotify's available timed lyrics for the active track."""
        if not _spotify_uri_id(uri, "track"):
            return {"ok": False, "error": "Lyrics are only available for tracks."}
        try:
            async with self._spotapi_catalogue() as (client, _):
                lyrics = await LyricsClient(client).get(uri)
            return {
                "ok": True,
                "sync_type": lyrics.sync_type,
                "language": lyrics.language,
                "is_rtl": lyrics.is_rtl,
                "lines": [
                    {
                        "start_time_ms": line.start_time_ms,
                        "end_time_ms": line.end_time_ms,
                        "words": line.words,
                    }
                    for line in lyrics.lines
                ],
            }
        except Exception as error:
            self._spotapi_log_failure("lyrics", error)
            return {"ok": False, "error": "Lyrics are unavailable for this track."}
