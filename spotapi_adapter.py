"""Translate SpotAPI's Pathfinder models to the Decky library UI contract."""
import asyncio
from contextlib import asynccontextmanager, aclosing
from itertools import chain

from spotapi import AsyncClient, Catalogue, Library
from spotapi.types import HTTPError
from spotapi.models.library import LibraryItem


def _sources(obj):
    return getattr(obj, "sources", None) or []


def _image(value):
    """Get the largest available image from Spotify's various model shapes."""
    if value is None:
        return None
    visuals = getattr(value, "visuals", None)
    images = getattr(value, "images", None)
    items = getattr(images, "items", None) or []
    artwork_options = [
        getattr(value, "cover_art", None),
        getattr(value, "avatar_image", None),
        getattr(visuals, "avatar_image", None),
        *items,
    ]
    artwork_options = [artwork for artwork in artwork_options if artwork is not None]
    if not artwork_options:
        return None
    # Pathfinder commonly returns the thumbnail first. Prefer explicit pixel
    # dimensions, using source order as a fallback when dimensions are absent.
    sources = [
        source
        for artwork in artwork_options
        for source in _sources(artwork)
    ]
    if not sources:
        return None
    return max(
        enumerate(sources),
        key=lambda entry: (
            (getattr(entry[1], "width", None) or 0)
            * (getattr(entry[1], "height", None) or 0),
            entry[0],
        ),
    )[1].url


def _raw_library_image(value):
    """Extract artwork from the Pathfinder library row before typed decoding.

    SpotAPI's LibraryItem intentionally retains only summary fields, discarding
    the image payload. Limit traversal to artwork containers so an owner's
    avatar or an unrelated link cannot be mistaken for the item cover.
    """
    if isinstance(value, str):
        if value.startswith("https://") or value.startswith("http://"):
            return value
        if value.startswith("spotify:image:"):
            return "https://i.scdn.co/image/" + value.removeprefix("spotify:image:")
        return None
    if isinstance(value, list):
        return next((image for item in value if (image := _raw_library_image(item))), None)
    if not isinstance(value, dict):
        return None
    for key in ("url", "uri", "sources", "items", "data"):
        if key in value and (image := _raw_library_image(value[key])):
            return image
    return None


def _library_artwork(row):
    wrapper = row.get("item", {}) if isinstance(row, dict) else {}
    data = wrapper.get("data", {}) if isinstance(wrapper, dict) else {}
    if not isinstance(data, dict):
        return None
    visuals = data.get("visuals") or {}
    candidates = [data.get("images"), data.get("coverArt"), data.get("image"),
                  data.get("avatarImage"),
                  visuals.get("avatarImage") if isinstance(visuals, dict) else None]
    return next((image for value in candidates if (image := _raw_library_image(value))), None)


def _library_creators(row, kind):
    wrapper = row.get("item", {}) if isinstance(row, dict) else {}
    data = wrapper.get("data", {}) if isinstance(wrapper, dict) else {}
    if not isinstance(data, dict):
        return []
    creators = []
    if kind == "playlist":
        owner = data.get("ownerV2") or data.get("owner_v2") or {}
        owner_data = owner.get("data", owner) if isinstance(owner, dict) else {}
        name = owner_data.get("name") if isinstance(owner_data, dict) else None
        uri = owner_data.get("uri") if isinstance(owner_data, dict) else None
        if isinstance(name, str) and name.strip():
            creators.append({"name": name.strip(), "uri": uri})
    elif kind == "album":
        artists = data.get("artists") or []
        if isinstance(artists, dict):
            artists = artists.get("items", [])
        for artist in artists if isinstance(artists, list) else []:
            profile = artist.get("profile", {}) if isinstance(artist, dict) else {}
            name = profile.get("name") if isinstance(profile, dict) else None
            uri = artist.get("uri") if isinstance(artist, dict) else None
            if isinstance(name, str) and name.strip():
                creators.append({"name": name.strip(), "uri": uri})
    return creators


def format_browse(value, kind=None):
    uri = getattr(value, "uri", "") or ""
    kind = kind or (uri.split(":")[1] if uri.startswith("spotify:") else "")
    if kind not in ("playlist", "album", "artist") or not uri:
        return None
    profile = getattr(value, "profile", None)
    name = getattr(value, "name", None) or getattr(profile, "name", "")
    creators = []
    if kind == "playlist":
        owner = getattr(getattr(value, "owner_v2", None), "data", None)
        owner_name = getattr(owner, "name", None)
        if isinstance(owner_name, str) and owner_name.strip():
            creators.append({
                "name": owner_name.strip(),
                "uri": getattr(owner, "uri", None),
            })
    elif kind == "album":
        artists = getattr(getattr(value, "artists", None), "items", None) or []
        for artist in artists:
            artist_profile = getattr(artist, "profile", None)
            artist_name = getattr(artist_profile, "name", None) or getattr(artist, "name", None)
            if isinstance(artist_name, str) and artist_name.strip():
                creators.append({
                    "name": artist_name.strip(),
                    "uri": getattr(artist, "uri", None),
                })
    result = {"uri": uri, "name": name, "entity_type": kind, "image_url": _image(value)}
    if creators:
        result["creators"] = creators
    return result


def format_track(value, album=None):
    """Produce the Soloist-style track decorations consumed by TrackDetailsFocusable."""
    uri = getattr(value, "uri", "") or ""
    name = getattr(value, "name", "") or ""
    album = getattr(value, "album_of_track", None) or album
    artists = getattr(getattr(value, "artists", None), "items", None)
    if artists is None:
        artists = list(chain(getattr(getattr(value, "first_artist", None), "items", None) or [],
                             getattr(getattr(value, "other_artists", None), "items", None) or []))
    creators = []
    for artist in artists:
        profile = getattr(artist, "profile", None)
        artist_name = getattr(profile, "name", None) or getattr(artist, "name", "")
        artist_uri = getattr(artist, "uri", "") or ""
        creators.append({"entity": {"uri": artist_uri, "decorations": {"identity": {"name": artist_name, "uri": artist_uri}}}})
    duration = getattr(getattr(value, "duration", None), "total_milliseconds", None)
    image = _image(album)
    album_uri = getattr(album, "uri", "") or ""
    album_name = getattr(album, "name", "") or ""
    decorations = {"identity": {"name": name, "uri": uri}, "creators": creators,
                   "visual_identity": {"cover": [{"url": image}] if image else []},
                   "parent": {"entity": {"uri": album_uri, "decorations": {"identity": {"name": album_name, "uri": album_uri}}}}}
    if duration is not None:
        decorations["playback"] = {"duration_ms": duration}
    return {"uri": uri, "name": name, "entity_type": "track", "decorations": decorations}


class SpotAPIAdapterMixin:
    """Decky RPCs for the Spotify account's library and Pathfinder catalogue."""

    def _session_lock(self):
        lock = getattr(self, "_spotify_client_lock", None)
        if lock is None:
            lock = self._spotify_client_lock = asyncio.Lock()
        return lock

    async def _reset_spotify_client(self):
        """Retire the current session; in-flight requests release it on exit."""
        close = None
        async with self._session_lock():
            entry = getattr(self, "_spotify_client_entry", None)
            self._spotify_client_entry = None
            if entry is not None:
                entry["retired"] = True
                if entry["users"] == 0:
                    close = entry["client"]
        if close is not None:
            await close.close()

    @asynccontextmanager
    async def _spotapi_catalogue(self):
        # Keep the authenticated HTTP client alive between requests: opening a
        # new one requires Spotify token exchange and connection setup each time.
        cookie = await self._spotify_cookie()
        if not cookie:
            raise ValueError("Connect your Spotify account first.")
        close = None
        async with self._session_lock():
            entry = getattr(self, "_spotify_client_entry", None)
            if entry is not None and entry["cookie"] != cookie:
                self._spotify_client_entry = None
                entry["retired"] = True
                if entry["users"] == 0:
                    close = entry["client"]
                entry = None
            if close is not None:
                await close.close()
            if entry is None:
                client = await AsyncClient.from_cookies(cookie)
                entry = {"cookie": cookie, "client": client, "users": 0, "retired": False}
                self._spotify_client_entry = entry
            entry["users"] += 1
        try:
            async with Catalogue(entry["client"]) as catalogue:
                yield entry["client"], catalogue
        finally:
            close = None
            async with self._session_lock():
                entry["users"] -= 1
                if entry["retired"] and entry["users"] == 0:
                    close = entry["client"]
            if close is not None:
                await close.close()

    @staticmethod
    def _spotapi_error(error):
        # Do not expose transport details, URLs, or credentials to the UI.
        if isinstance(error, ValueError) and str(error) == "Connect your Spotify account first.":
            return str(error)
        if isinstance(error, HTTPError):
            if error.status_code == 401:
                return "Spotify rejected this session. Disconnect and connect your Spotify account again."
            if error.status_code == 403:
                return "Spotify denied access. Check that your account can access this content, or reconnect."
            if error.status_code == 429:
                return "Spotify is limiting requests right now. Wait a little, then try again."
        return "Spotify could not complete this request. Check your connection and reconnect if needed."

    async def get_web_api_library(self):
        try:
            async with self._spotapi_catalogue() as (client, _):
                library = Library(client)
                groups = {"playlist": [], "album": [], "artist": []}
                seen = set()
                folders = [None]
                seen_folders = set()
                while folders:
                    folder = folders.pop()
                    if folder in seen_folders:
                        continue
                    seen_folders.add(folder)
                    # Preserve the raw Pathfinder artwork: LibraryItem.from_dict
                    # drops it while decoding the rest of the library metadata.
                    variables = library._variables(100, 0, (), None, "", folder)
                    async with aclosing(library.queries.paginate_query(
                        variables, "libraryV3", extract_page=library._page
                    )) as pages:
                        async for page in pages:
                            for row in page.get("items", []):
                                if not isinstance(row, dict):
                                    continue
                                item = LibraryItem.from_dict(row)
                                if item.kind == "folder" and item.uri:
                                    folders.append(item.uri)
                                elif item.kind in groups and item.uri not in seen:
                                    seen.add(item.uri)
                                    formatted = format_browse(item, item.kind)
                                    if formatted:
                                        formatted["image_url"] = _library_artwork(row)
                                        creators = _library_creators(row, item.kind)
                                        if creators:
                                            formatted["creators"] = creators
                                        groups[item.kind].append(formatted)
                return {"ok": True, "playlists": groups["playlist"], "albums": groups["album"], "artists": groups["artist"]}
        except Exception as error:
            return {"ok": False, "error": self._spotapi_error(error)}

    async def precache_web_api_library(self):
        # The UI already caches successful library and context responses locally.
        return {"ok": True, "cached": False}

    async def search_web_api(self, query):
        if not isinstance(query, str) or not query.strip():
            return {"ok": True, "tracks": [], "playlists": [], "albums": [], "artists": []}
        try:
            async with self._spotapi_catalogue() as (_, catalogue):
                results = await catalogue.search(query, types=("track", "playlist", "album", "artist"), limit=20)
                return {"ok": True, "tracks": [format_track(item) for item in results.tracks],
                        **{kind + "s": [format_browse(item, kind) for item in getattr(results, kind + "s")]
                           for kind in ("playlist", "album", "artist")}}
        except Exception as error:
            return {"ok": False, "error": self._spotapi_error(error)}

    async def get_web_api_playlist_tracks(self, uri):
        try:
            async with self._spotapi_catalogue() as (_, catalogue):
                items = []
                position = 0
                async with aclosing(catalogue.get_playlist_items(uri)) as pages:
                    async for page in pages:
                        for entry in page:
                            item = entry.item
                            # Keep original positions for unavailable entries and duplicates.
                            if item is not None and (getattr(item, "uri", "") or "").startswith("spotify:track:"):
                                items.append({"position": position, "item": format_track(item)})
                            position += 1
                return {"ok": True, "items": items}
        except Exception as error:
            return {"ok": False, "error": self._spotapi_error(error)}

    async def get_web_api_album_tracks(self, uri):
        try:
            async with self._spotapi_catalogue() as (_, catalogue):
                async def get_tracks():
                    items = []
                    async with aclosing(catalogue.get_album_tracks(uri)) as pages:
                        async for page in pages:
                            items.extend(page)
                    return items
                album, tracks = await asyncio.gather(catalogue.get_album(uri), get_tracks())
                return {"ok": True, "items": [
                    {"position": position, "item": format_track(item, album)}
                    for position, item in enumerate(tracks)
                ]}
        except Exception as error:
            return {"ok": False, "error": self._spotapi_error(error)}

    async def get_web_api_artist_albums(self, uri, offset=0):
        try:
            if type(offset) is not int or offset < 0:
                raise ValueError("Invalid offset")
            async with self._spotapi_catalogue() as (_, catalogue):
                items = []
                index = 0
                has_more = False
                async with aclosing(catalogue.get_artist_releases(uri)) as pages:
                    async for page in pages:
                        for item in page:
                            if index >= offset:
                                if len(items) == 50:
                                    has_more = True
                                    break
                                items.append(format_browse(item, "album"))
                            index += 1
                        if has_more:
                            break
                return {"ok": True, "items": items, "next_offset": offset + len(items) if has_more else None}
        except Exception as error:
            return {"ok": False, "error": self._spotapi_error(error)}

    async def _spotapi_track_page(self, uri, offset, *, kind):
        from spotapi.catalogue import _page, _playlist_entry
        from spotapi.operations import Operations
        from spotapi.resources import parse_spotify_resource
        from spotapi._decoding import from_dict
        from spotapi.models.catalogue.album_details import AlbumTrack

        if type(offset) is not int or offset < 0:
            return {"ok": False, "error": "Invalid track offset."}
        try:
            resource = parse_spotify_resource(uri, kind)
            if resource.kind != kind:
                raise ValueError("Invalid context")
            async with self._spotapi_catalogue() as (_, catalogue):
                if kind == "playlist":
                    operation = Operations.FETCH_PLAYLIST_CONTENTS.value
                    variables = {"uri": resource.uri, "offset": offset, "limit": 30,
                                 "enableWatchFeedEntrypoint": False,
                                 "includeEpisodeContentRatingsV2": True}
                    path = ("playlistV2", "content")
                else:
                    operation = Operations.QUERY_ALBUM_TRACKS.value
                    variables = {"uri": resource.uri, "offset": offset, "limit": 30}
                    path = ("albumUnion", "tracksV2")

                async def fetch_page():
                    async with aclosing(catalogue.queries.paginate(
                        operation, variables, extract_page=lambda data: _page(data, *path)
                    )) as pages:
                        return await anext(pages, {"items": []})

                if kind == "album":
                    async def get_album_metadata():
                        try:
                            return await catalogue.get_album(resource.uri)
                        except Exception as error:
                            # Album identity is already available to the UI. A
                            # metadata enrichment failure must not hide tracks.
                            import decky

                            decky.logger.warning(
                                f"Spotify album metadata enrichment failed ({type(error).__name__})"
                            )
                            return None

                    page, album = await asyncio.gather(
                        fetch_page(), get_album_metadata()
                    )
                else:
                    page, album = await fetch_page(), None
                rows = page.get("items")
                if not isinstance(rows, list):
                    raise ValueError("Invalid Spotify page")
                items = []
                for index, row in enumerate(rows):
                    if kind == "playlist":
                        item = _playlist_entry(row).item
                    else:
                        payload = row.get("track") if isinstance(row, dict) else None
                        item = from_dict(AlbumTrack, payload) if payload else None
                    if item is not None and (getattr(item, "uri", "") or "").startswith("spotify:track:"):
                        items.append({"position": offset + index, "item": format_track(item, album)})
                # Use source rows, not the number of playable tracks, to preserve
                # positions when unavailable items and episodes are present.
                next_offset = offset + len(rows)
                total = page.get("totalCount")
                paging = page.get("pagingInfo")
                if isinstance(paging, dict) and "nextOffset" in paging:
                    candidate = paging["nextOffset"]
                    next_offset = candidate if type(candidate) is int and candidate > offset else None
                elif not rows or (type(total) is int and next_offset >= total) or (total is None and len(rows) < 30):
                    next_offset = None
                return {"ok": True, "items": items, "next_offset": next_offset}
        except Exception as error:
            import decky

            decky.logger.warning(
                f"Spotify {kind} track page failed at offset {offset} ({type(error).__name__})"
            )
            return {"ok": False, "error": self._spotapi_error(error)}

    async def get_spotify_playlist_page(self, uri, offset=0):
        return await self._spotapi_track_page(uri, offset, kind="playlist")

    async def get_spotify_album_page(self, uri, offset=0):
        return await self._spotapi_track_page(uri, offset, kind="album")
