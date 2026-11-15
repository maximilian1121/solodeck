"""Tests for the Connect device selection and playback adapter."""
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, "py_modules")
import spotapi_playback


class Plugin(spotapi_playback.SpotAPIPlaybackMixin):
    def _load_settings(self):
        return {"device_name": "Steam Deck"}

    async def _spotify_cookie(self):
        return "sp_dc=test"

    @staticmethod
    def _spotapi_log_failure(operation, error):
        pass


class PlaybackTests(unittest.IsolatedAsyncioTestCase):
    async def test_play_targets_soloist_and_preserves_selected_offset(self):
        device = types.SimpleNamespace(name="steam deck")
        player = types.SimpleNamespace(
            devices=[device],
            is_ready=True,
            select=lambda value: None,
            play=AsyncMock(),
        )
        client = types.SimpleNamespace(close=AsyncMock())

        plugin = Plugin()
        with patch.object(
            plugin, "_get_or_create_player", AsyncMock(return_value=(player, client))
        ):
            result = await plugin.play_web_api_track_in_context(
                "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M",
                "spotify:track:4iV5W9uYEdYUVa79Axb7Rh",
                3,
            )
        self.assertEqual(result, {"ok": True})
        player.play.assert_awaited_once_with(
            "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M", offset=3, wait=False
        )

    async def test_missing_device_reports_error(self):
        player = types.SimpleNamespace(devices=[], is_ready=True)
        client = types.SimpleNamespace(close=AsyncMock())

        plugin = Plugin()
        with patch.object(
            plugin, "_get_or_create_player", AsyncMock(return_value=(player, client))
        ):
            result = await plugin.play_web_api_track_in_context(
                "spotify:album:4aawyAB9vmqN3uQ7FjRGTy",
                "spotify:track:4iV5W9uYEdYUVa79Axb7Rh",
                0,
            )
        self.assertFalse(result["ok"])
        self.assertIn("Soloist", result["error"])

    async def test_duplicate_device_names_do_not_play_on_an_arbitrary_device(self):
        player = types.SimpleNamespace(
            devices=[
                types.SimpleNamespace(name="Steam Deck"),
                types.SimpleNamespace(name="STEAM DECK"),
            ],
            is_ready=True,
            select=unittest.mock.Mock(),
            play=AsyncMock(),
        )
        client = types.SimpleNamespace(close=AsyncMock())

        plugin = Plugin()
        with patch.object(
            plugin, "_get_or_create_player", AsyncMock(return_value=(player, client))
        ):
            result = await plugin.play_web_api_track_in_context(
                "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M",
                "spotify:track:4iV5W9uYEdYUVa79Axb7Rh",
                0,
            )
        self.assertFalse(result["ok"])
        self.assertIn("unique name", result["error"])
        player.select.assert_not_called()
        player.play.assert_not_awaited()

    async def test_invalid_selection_is_rejected_before_authentication(self):
        plugin = Plugin()
        with patch.object(
            plugin, "_get_or_create_player", AsyncMock()
        ) as mock_get:
            result = await plugin.play_web_api_track_in_context(
                "spotify:artist:4iV5W9uYEdYUVa79Axb7Rh",
                "spotify:track:4iV5W9uYEdYUVa79Axb7Rh",
                0,
            )
        self.assertFalse(result["ok"])
        mock_get.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
