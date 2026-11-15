import { callable } from "@decky/api";
import type { TrackItem } from "./components/TrackDetailsFocusable";

// Build metadata baked in by build.py (see main.py's get_build_info)
export type BuildInfo = {
    version: string | null;
    build_time: number | null;
    age_days: number | null;
};

export type Config = {
    api_key: string;
    device_name: string;
    paired: boolean;
};

export type SpotifyBrowseItem = {
    uri: string;
    name: string;
    entity_type: "playlist" | "artist" | "album" | "home";
    image_url: string | null;
    icon?: string;
};

export const HomeBrowseItem: SpotifyBrowseItem = {
    uri: "solodeck:home",
    name: "Home",
    entity_type: "home",
    image_url: "/",
    icon: "home",
};

export const SearchBrowseItem: SpotifyBrowseItem = {
    uri: "solodeck:search",
    name: "Search",
    entity_type: "home",
    image_url: "/",
    icon: "search",
};

export type SpotifyContextTrack = {
    position: number;
    item: TrackItem;
};

export type SpotifyLibrary = {
    ok: boolean;
    error?: string;
    playlists?: SpotifyBrowseItem[];
    albums?: SpotifyBrowseItem[];
    artists?: SpotifyBrowseItem[];
};

export type SpotifySearchResults = {
    ok: boolean;
    error?: string;
    tracks?: TrackItem[];
    playlists?: SpotifyBrowseItem[];
    artists?: SpotifyBrowseItem[];
    albums?: SpotifyBrowseItem[];
};

export type PairingStatus = {
    running: boolean;
    cancelled: boolean;
    exit_code: number | null;
    output: string[];
    error: string | null;
};

export type DaemonStatus = {
    running: boolean;
    enabled: boolean;
    paired: boolean;
    pid: number | null;
    exit_code: number | null;
    error: string | null;
    output: string[];
    restarts: number;
    uptime: number | null;
};

export type SoloistStatus = {
    installed: boolean;
    version: string | null;
    path: string | null;
};

export type DownloadStatus = {
    status: string; // "idle" | "downloading" | "extracting" | "done" | "failed"
    downloaded: number;
    total: number;
    percent: number;
    error: string | null;
};

export type ActionResult = {
    ok: boolean;
    error?: string;
};

export const getBuildInfo = callable<[], BuildInfo>("get_build_info");
export const getSoloistVersion = callable<[], string>("get_soloist_version");

// Soloist installation (downloaded at runtime, never bundled)
export const getSoloistStatus = callable<[], SoloistStatus>(
    "get_soloist_status",
);
export const downloadSoloist = callable<[], ActionResult>("download_soloist");
export const getDownloadStatus = callable<[], DownloadStatus>(
    "get_download_status",
);

export const getConfig = callable<[], Config>("get_config");
export const saveApiKey = callable<[api_key: string], ActionResult>(
    "save_api_key",
);
export const saveDeviceName = callable<[device_name: string], ActionResult>(
    "save_device_name",
);
export const getTrackMetadata = callable<[uri: string], TrackItem | null>(
    "get_track_metadata",
);
export const getWebApiLibrary = callable<[], SpotifyLibrary>(
    "get_web_api_library",
);
export const precacheWebApiLibrary = callable<[], ActionResult & { cached?: boolean }>(
    "precache_web_api_library",
);
export const getWebApiPlaylistTracks = callable<
    [uri: string],
    { ok: boolean; error?: string; items?: SpotifyContextTrack[] }
>("get_web_api_playlist_tracks");
export const getSpotifyPlaylistPage = callable<
    [uri: string, offset: number],
    { ok: boolean; error?: string; items?: SpotifyContextTrack[]; next_offset?: number | null }
>("get_spotify_playlist_page");
export const getSpotifyAlbumPage = callable<
    [uri: string, offset: number],
    { ok: boolean; error?: string; items?: SpotifyContextTrack[]; next_offset?: number | null }
>("get_spotify_album_page");
export const getWebApiArtistAlbums = callable<
    [uri: string, offset: number],
    {
        ok: boolean;
        error?: string;
        items?: SpotifyBrowseItem[];
        next_offset?: number | null;
    }
>("get_web_api_artist_albums");
export const getWebApiAlbumTracks = callable<
    [uri: string],
    { ok: boolean; error?: string; items?: SpotifyContextTrack[] }
>("get_web_api_album_tracks");
export const searchWebApi = callable<[query: string], SpotifySearchResults>(
    "search_web_api",
);
export const playWebApiTrackInContext = callable<
    [contextUri: string, trackUri: string, position: number],
    ActionResult
>("play_web_api_track_in_context");

export const startPairing = callable<[api_key: string], ActionResult>(
    "start_pairing",
);
export const getPairingStatus = callable<[], PairingStatus>(
    "get_pairing_status",
);
export const cancelPairing = callable<[], ActionResult>("cancel_pairing");

export const getDaemonStatus = callable<[], DaemonStatus>("get_daemon_status");
export const startDaemon = callable<[], ActionResult>("start_daemon");
export const stopDaemon = callable<[], ActionResult>("stop_daemon");
export const restartDaemon = callable<[], ActionResult>("restart_daemon");

export const connectSpotify = callable<[cookie: string], ActionResult & { persistent?: boolean }>(
    "connect_spotify",
);
export const getAuthStatus = callable<[], boolean>("get_auth_status");
export const logoutSpotify = callable<[], ActionResult & { warning?: string }>("logout_spotify");

export type SpotifyBrowserLoginStatus = {
    status: "idle" | "pending" | "connected" | "cancelled" | "error";
    error?: string;
    persistent?: boolean;
};
export const startSpotifyBrowserLogin = callable<[], ActionResult>("start_spotify_browser_login");
export const getSpotifyBrowserLoginStatus = callable<[], SpotifyBrowserLoginStatus>("get_spotify_browser_login_status");
export const cancelSpotifyBrowserLogin = callable<[], ActionResult>("cancel_spotify_browser_login");

export const getSpotifySavedSessionStatus = callable<[], { saved: boolean; encrypted?: boolean; unencrypted?: boolean }>("get_spotify_saved_session_status");
export const saveSpotifySessionUnencrypted = callable<[], ActionResult>("save_spotify_session_unencrypted");
export const unlockSpotifySessionUnencrypted = callable<[], ActionResult>("unlock_spotify_session_unencrypted");
export const saveSpotifySession = callable<[password: string], ActionResult>("save_spotify_session");
export const unlockSpotifySession = callable<[password: string], ActionResult>("unlock_spotify_session");
export const forgetSpotifySession = callable<[], ActionResult>("forget_spotify_session");
