import type { SpotifyBrowseItem, SpotifyContextTrack } from "../../api";
import type { TrackItem } from "../TrackDetailsFocusable";

export type CachedExplorerPage = {
    cachedAt: number;
    albums?: SpotifyBrowseItem[];
    albumsNextOffset?: number | null;
    tracks?: SpotifyContextTrack[];
    tracksNextOffset?: number | null;
    tracksComplete?: boolean;
};

export type SpotifyExplorerCache = {
    cachedAt: number;
    playlists: SpotifyBrowseItem[];
    albums: SpotifyBrowseItem[];
    artists: SpotifyBrowseItem[];
    pages: Record<string, CachedExplorerPage>;
};

const SPOTIFY_EXPLORER_CACHE_KEY = "solodeck.spotify-explorer.v2";
const SPOTIFY_EXPLORER_CACHE_MAX_PAGES = 12;
const SPOTIFY_EXPLORER_CACHE_MAX_TRACKS_PER_PAGE = 200;
export const SPOTIFY_EXPLORER_CACHE_MAX_ITEMS_PER_SECTION = 1000;
export const SPOTIFY_TRACK_PAGE_REFRESH_COOLDOWN_MS = 60_000;
export const SPOTIFY_ARTIST_PAGE_CACHE_TTL_MS = 30 * 60_000;
export const SPOTIFY_TRACK_PAGE_SIZE = 30;

export function getQuotaRetrySeconds(error: string | undefined) {
    if (!error || !/QUOTA_EXCEEDED|app quota exceeded/i.test(error)) {
        return null;
    }

    const retrySeconds = error.match(
        /(?:retry after|about)\s+(\d+)\s*seconds?/i,
    );
    return retrySeconds ? Math.max(1, Number(retrySeconds[1])) : null;
}

function isBrowseItem(value: unknown): value is SpotifyBrowseItem {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<SpotifyBrowseItem>;
    return (
        typeof item.uri === "string" &&
        typeof item.name === "string" &&
        (item.entity_type === "playlist" ||
            item.entity_type === "artist" ||
            item.entity_type === "album") &&
        (typeof item.image_url === "string" || item.image_url === null)
    );
}

export function readSpotifyExplorerCache(): SpotifyExplorerCache {
    const emptyCache: SpotifyExplorerCache = {
        cachedAt: 0,
        playlists: [],
        albums: [],
        artists: [],
        pages: {},
    };
    try {
        const serialized = window.localStorage.getItem(
            SPOTIFY_EXPLORER_CACHE_KEY,
        );
        if (!serialized) return emptyCache;
        const parsed: unknown = JSON.parse(serialized);
        if (!parsed || typeof parsed !== "object") return emptyCache;
        const cache = parsed as Partial<SpotifyExplorerCache>;
        const pages: Record<string, CachedExplorerPage> = {};
        if (cache.pages && typeof cache.pages === "object") {
            Object.entries(cache.pages)
                .filter(
                    (entry): entry is [string, CachedExplorerPage] =>
                        Boolean(entry[1]) &&
                        typeof entry[1] === "object" &&
                        typeof entry[1].cachedAt === "number",
                )
                .sort((left, right) => right[1].cachedAt - left[1].cachedAt)
                .slice(0, SPOTIFY_EXPLORER_CACHE_MAX_PAGES)
                .forEach(([uri, page]) => {
                    const validTracks = Array.isArray(page.tracks)
                        ? page.tracks
                              .filter(
                                  (entry): entry is SpotifyContextTrack =>
                                      Boolean(entry) &&
                                      typeof entry.position === "number" &&
                                      Boolean(entry.item) &&
                                      typeof entry.item === "object",
                              )
                        : undefined;
                    const storedTracks = validTracks?.slice(
                        0,
                        SPOTIFY_EXPLORER_CACHE_MAX_TRACKS_PER_PAGE,
                    );
                    const legacyTrackCursor =
                        validTracks && validTracks.length > 0
                            ? validTracks[
                                  Math.min(
                                      validTracks.length,
                                      SPOTIFY_EXPLORER_CACHE_MAX_TRACKS_PER_PAGE,
                                  ) - 1
                              ].position + 1
                            : 0;
                    pages[uri] = {
                        cachedAt: page.cachedAt,
                        albums: Array.isArray(page.albums)
                            ? page.albums.filter(isBrowseItem).slice(0, 100)
                            : undefined,
                        tracksComplete:
                            (page.tracksComplete === true &&
                                Boolean(validTracks?.length) &&
                                (validTracks?.length ?? 0) <=
                                    SPOTIFY_EXPLORER_CACHE_MAX_TRACKS_PER_PAGE) ||
                            (page.tracksComplete === undefined &&
                                Boolean(validTracks?.length) &&
                                (validTracks?.length ?? 0) <
                                    SPOTIFY_EXPLORER_CACHE_MAX_TRACKS_PER_PAGE),
                        tracksNextOffset:
                            typeof page.tracksNextOffset === "number" &&
                            page.tracksNextOffset >= 0
                                ? page.tracksNextOffset
                                : page.tracksComplete === true
                                  ? null
                                  : legacyTrackCursor,
                        albumsNextOffset:
                            typeof page.albumsNextOffset === "number" &&
                            page.albumsNextOffset >= 0
                                ? page.albumsNextOffset
                                : null,
                        tracks: storedTracks,
                    };
                });
        }
        return {
            cachedAt: typeof cache.cachedAt === "number" ? cache.cachedAt : 0,
            playlists: Array.isArray(cache.playlists)
                ? cache.playlists
                      .filter(isBrowseItem)
                      .slice(0, SPOTIFY_EXPLORER_CACHE_MAX_ITEMS_PER_SECTION)
                : [],
            albums: Array.isArray(cache.albums)
                ? cache.albums
                      .filter(isBrowseItem)
                      .slice(0, SPOTIFY_EXPLORER_CACHE_MAX_ITEMS_PER_SECTION)
                : [],
            artists: Array.isArray(cache.artists)
                ? cache.artists
                      .filter(isBrowseItem)
                      .slice(0, SPOTIFY_EXPLORER_CACHE_MAX_ITEMS_PER_SECTION)
                : [],
            pages,
        };
    } catch (error) {
        console.warn("solodeck: could not read Spotify explorer cache", error);
        return emptyCache;
    }
}

export function writeSpotifyExplorerCache(cache: SpotifyExplorerCache) {
    try {
        const pages = Object.fromEntries(
            Object.entries(cache.pages).map(([uri, page]) => {
                const tracks = page.tracks?.slice(
                    0,
                    SPOTIFY_EXPLORER_CACHE_MAX_TRACKS_PER_PAGE,
                );
                const truncated =
                    (page.tracks?.length ?? 0) >
                    SPOTIFY_EXPLORER_CACHE_MAX_TRACKS_PER_PAGE;
                return [
                uri,
                {
                    ...page,
                    tracks,
                    tracksNextOffset: truncated
                        ? page.tracks?.[
                              SPOTIFY_EXPLORER_CACHE_MAX_TRACKS_PER_PAGE
                          ]?.position ?? page.tracksNextOffset
                        : page.tracksNextOffset,
                    tracksComplete:
                        page.tracksComplete === true &&
                        (tracks?.length ?? 0) > 0 &&
                        !truncated &&
                        (tracks?.length ?? 0) <=
                            SPOTIFY_EXPLORER_CACHE_MAX_TRACKS_PER_PAGE,
                },
                ];
            }),
        );
        window.localStorage.setItem(
            SPOTIFY_EXPLORER_CACHE_KEY,
            JSON.stringify({ ...cache, pages }),
        );
    } catch (error) {
        console.warn("solodeck: could not save Spotify explorer cache", error);
    }
}

export function cacheExplorerPage(
    cache: SpotifyExplorerCache,
    uri: string,
    page: CachedExplorerPage,
): SpotifyExplorerCache {
    const mergedPage = {
        ...cache.pages[uri],
        ...page,
    };
    const storedTracks = mergedPage.tracks?.slice(
        0,
        SPOTIFY_EXPLORER_CACHE_MAX_TRACKS_PER_PAGE,
    );
    const truncated =
        (mergedPage.tracks?.length ?? 0) >
        SPOTIFY_EXPLORER_CACHE_MAX_TRACKS_PER_PAGE;
    const pages = {
        ...cache.pages,
        [uri]: {
            ...mergedPage,
            albums: page.albums?.slice(0, 100),
            tracks: storedTracks,
            tracksNextOffset: truncated
                ? mergedPage.tracks?.[
                      SPOTIFY_EXPLORER_CACHE_MAX_TRACKS_PER_PAGE
                  ]?.position ?? mergedPage.tracksNextOffset
                : mergedPage.tracksNextOffset,
            tracksComplete:
                mergedPage.tracksComplete === true &&
                !truncated &&
                (storedTracks?.length ?? 0) > 0,
        },
    };
    const retainedPages = Object.fromEntries(
        Object.entries(pages)
            .sort((left, right) => right[1].cachedAt - left[1].cachedAt)
            .slice(0, SPOTIFY_EXPLORER_CACHE_MAX_PAGES),
    );
    return { ...cache, pages: retainedPages };
}

export const sectionHeadingStyle = {
    fontSize: "14px",
    fontWeight: 600,
    lineHeight: 1.3,
    paddingBottom: "10px",
} as const;

export const quietMessageStyle = {
    width: "100%",
    boxSizing: "border-box" as const,
    color: "var(--gpColor-Grey)",
    fontSize: "13px",
    lineHeight: 1.4,
    padding: "8px 12px",
} as const;

export function trackArtist(item: TrackItem): string {
    return (
        item.decorations?.creators
            ?.map((creator) =>
                creator.entity?.decorations?.identity?.name?.trim(),
            )
            .filter(Boolean)
            .join(", ") ?? ""
    );
}

export function isSpotifyDj(item: SpotifyBrowseItem | null | undefined): boolean {
    if (!item || item.entity_type === "artist") return false;
    return (
        item.name.trim().toLowerCase() === "dj" &&
        (item.image_url ?? "").toLowerCase().includes("dj")
    );
}

