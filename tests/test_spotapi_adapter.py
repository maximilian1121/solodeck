import asyncio
import sys
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'py_modules'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from spotapi_adapter import SpotAPIAdapterMixin, format_browse, format_track
from spotapi.models.catalogue.track import Track, Artists, ArtistItem, ArtistProfile, Duration, AlbumOfTrack
from spotapi.models.catalogue.common import CoverArt, Sources
from spotapi.models.library import LibraryItem
from spotapi.types import HTTPError


def track(uri, name='Song'):
    return NS(uri=uri, name=name, artists=NS(items=[NS(uri='spotify:artist:a', profile=NS(name='Artist'))]),
              duration=NS(total_milliseconds=1234), album_of_track=NS(uri='spotify:album:b', name='Album', cover_art=NS(sources=[NS(url='https://image')])) )


class Adapter(SpotAPIAdapterMixin):
    def __init__(self, catalogue):
        self.catalogue = catalogue

    @asynccontextmanager
    async def _spotapi_catalogue(self):
        yield object(), self.catalogue


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    def test_format_track(self):
        result = format_track(track('spotify:track:1'))
        self.assertEqual(result['decorations']['playback']['duration_ms'], 1234)
        self.assertEqual(result['decorations']['creators'][0]['entity']['decorations']['identity']['name'], 'Artist')
        self.assertEqual(result['decorations']['visual_identity']['cover'][0]['url'], 'https://image')

    def test_real_spotapi_models(self):
        artist = ArtistItem(uri='spotify:artist:a', profile=ArtistProfile(name='Artist'))
        album = AlbumOfTrack(id='b', uri='spotify:album:b', name='Album',
                             cover_art=CoverArt(sources=[Sources(url='https://image')]))
        item = Track(id='1', uri='spotify:track:1', name='Song', album_of_track=album,
                     artists=Artists(items=[artist]), duration=Duration(total_milliseconds=1234))
        result = format_track(item)
        self.assertEqual(result['decorations']['parent']['entity']['uri'], 'spotify:album:b')
        self.assertEqual(result['decorations']['creators'][0]['entity']['uri'], 'spotify:artist:a')
        self.assertEqual(result['decorations']['visual_identity']['cover'][0]['url'], 'https://image')
        library_item = LibraryItem.from_dict({'item': {'_uri': 'spotify:playlist:p', 'data': {'name': 'Mine'}}})
        self.assertEqual(format_browse(library_item)['name'], 'Mine')

    async def test_playlist_preserves_positions_and_duplicates(self):
        async def pages(uri):
            yield [NS(item=track('spotify:track:1')), NS(item=None), NS(item=track('spotify:track:1'))]
        result = await Adapter(NS(get_playlist_items=pages)).get_web_api_playlist_tracks('spotify:playlist:p')
        self.assertTrue(result['ok'])
        self.assertEqual([v['position'] for v in result['items']], [0, 2])
        self.assertEqual([v['item']['uri'] for v in result['items']], ['spotify:track:1'] * 2)

    async def test_artist_pagination(self):
        async def pages(uri):
            yield [NS(uri=f'spotify:album:{i}', name=str(i)) for i in range(55)]
        adapter = Adapter(NS(get_artist_releases=pages))
        first = await adapter.get_web_api_artist_albums('spotify:artist:a', 0)
        second = await adapter.get_web_api_artist_albums('spotify:artist:a', first['next_offset'])
        self.assertEqual(len(first['items']), 50)
        self.assertEqual(len(second['items']), 5)
        self.assertIsNone(second['next_offset'])
        self.assertEqual(second['items'][0]['name'], '50')

    async def test_library_traverses_folders_and_preserves_artwork(self):
        def row(uri, name, **art):
            return {"item": {"_uri": uri, "data": {"name": name, **art}}}
        class FakeQueries:
            async def paginate_query(self, variables, operation, **kwargs):
                if variables["folderUri"] is None:
                    yield {"items": [
                        row("spotify:folder:f", "Folder"),
                        row("spotify:album:a", "Album", coverArt={"sources": [{"url": "https://img/album"}]}),
                        row("spotify:artist:a", "Artist", visuals={"avatarImage": {"sources": [{"url": "https://img/artist"}]}}),
                    ]}
                else:
                    yield {"items": [
                        row("spotify:album:a", "Album"),
                        row("spotify:playlist:p", "Playlist", images={"items": [{"sources": [{"url": "https://img/playlist"}]}]}),
                    ]}
        class FakeLibrary:
            def __init__(self, client):
                self.queries = FakeQueries()
            @staticmethod
            def _variables(limit, offset, filters, order, query, folder):
                return {"folderUri": folder}
            @staticmethod
            def _page(value):
                return value
        with patch('spotapi_adapter.Library', FakeLibrary):
            result = await Adapter(None).get_web_api_library()
        self.assertTrue(result['ok'], result)
        self.assertEqual([item['uri'] for item in result['albums']], ['spotify:album:a'])
        self.assertEqual(result['albums'][0]['image_url'], 'https://img/album')
        self.assertEqual(result['artists'][0]['image_url'], 'https://img/artist')
        self.assertEqual(result['playlists'][0]['image_url'], 'https://img/playlist')

    def test_search_artwork_from_typed_spotapi_models(self):
        from spotapi.models.catalogue.playlist import Playlist, Images, ImageItem
        from spotapi.models.catalogue.artist import Artist, ArtistProfile as Profile, Visuals, AvatarImage
        from spotapi.models.catalogue.album import Album
        source = Sources(url="https://img/cover")
        items = [
            Playlist(name="P", uri="spotify:playlist:p", images=Images(items=[ImageItem(sources=[source])])),
            Artist(profile=Profile(name="A"), uri="spotify:artist:a", visuals=Visuals(avatar_image=AvatarImage(sources=[source]))),
            Album(name="B", uri="spotify:album:b", cover_art=CoverArt(sources=[source])),
        ]
        for item in items:
            self.assertEqual(format_browse(item)["image_url"], "https://img/cover")

    async def test_authentication_and_rate_limit_errors_are_actionable(self):
        for status, expected in [(401, "connect your Spotify account again"),
                                 (403, "account can access this content"),
                                 (429, "limiting requests")]:
            async def search(*args, **kwargs):
                raise HTTPError("secret detail", status_code=status)
            result = await Adapter(NS(search=search)).search_web_api("test")
            self.assertFalse(result["ok"])
            self.assertIn(expected, result["error"])
            self.assertNotIn("secret", result["error"])

    async def test_client_reused_and_retired_after_active_request(self):
        from unittest.mock import AsyncMock
        class Shared(SpotAPIAdapterMixin):
            async def _spotify_cookie(self):
                return self.cookie
        class Catalogue:
            def __init__(self, client): self.client = client
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
        instance = Shared()
        instance.cookie = "sp_dc=first"
        first = NS(close=AsyncMock())
        second = NS(close=AsyncMock())
        with patch('spotapi_adapter.AsyncClient.from_cookies', AsyncMock(side_effect=[first, second])) as connect, \
             patch('spotapi_adapter.Catalogue', Catalogue):
            async with instance._spotapi_catalogue():
                async with instance._spotapi_catalogue():
                    self.assertEqual(connect.await_count, 1)
                await instance._reset_spotify_client()
                first.close.assert_not_awaited()
                instance.cookie = "sp_dc=second"
                async with instance._spotapi_catalogue():
                    self.assertEqual(connect.await_count, 2)
            first.close.assert_awaited_once()
            await instance._reset_spotify_client()
            second.close.assert_awaited_once()

    async def test_playlist_page_uses_source_offset_and_preserves_gaps(self):
        seen = []
        class Queries:
            async def paginate(self, operation, variables, **kwargs):
                seen.append(variables)
                yield {"items": [{"n": 0}, {"n": 1}, {"n": 2}], "totalCount": 105}
        def entry(row):
            return NS(item=None if row['n'] == 1 else track('spotify:track:1'))
        with patch('spotapi.catalogue._playlist_entry', side_effect=entry):
            result = await Adapter(NS(queries=Queries())).get_spotify_playlist_page(
                'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', 100)
        self.assertTrue(result['ok'], result)
        self.assertEqual([item['position'] for item in result['items']], [100, 102])
        self.assertEqual(result['next_offset'], 103)
        self.assertEqual(seen[0]['offset'], 100)

    async def test_album_metadata_and_tracks_load_concurrently(self):
        started = asyncio.Event()
        async def get_album(uri):
            await asyncio.wait_for(started.wait(), timeout=1)
            return NS(uri=uri, name="Album")
        async def get_tracks(uri):
            started.set()
            yield [track('spotify:track:1')]
        result = await Adapter(NS(get_album=get_album, get_album_tracks=get_tracks)).get_web_api_album_tracks('spotify:album:a')
        self.assertTrue(result['ok'], result)
        self.assertEqual(len(result['items']), 1)

    async def test_errors_do_not_expose_secrets(self):
        async def search(*args, **kwargs):
            raise RuntimeError('secret cookie')
        result = await Adapter(NS(search=search)).search_web_api('test')
        self.assertFalse(result['ok'])
        self.assertNotIn('secret', result['error'])

if __name__ == '__main__':
    unittest.main()
