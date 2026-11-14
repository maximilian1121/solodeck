import {
    Focusable,
    Menu,
    MenuGroup,
    MenuItem,
    ModalRoot,
    showContextMenu,
    TextField,
    Tabs,
} from "@decky/ui";
import {
    getWebApiAlbumTracks,
    getWebApiArtistAlbums,
    getWebApiLibrary,
    getWebApiPlaylistTracks,
    HomeBrowseItem,
    SearchBrowseItem,
    precacheWebApiLibrary,
    searchWebApi,
    type SpotifyBrowseItem,
    type SpotifyContextTrack,
    type SpotifySearchResults,
} from "../api";
import { FaPlay, FaSyncAlt, FaHome, FaSearch } from "react-icons/fa";
import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    useSyncExternalStore,
    type CSSProperties,
    type RefObject,
} from "react";
import { type TrackItem } from "./TrackDetailsFocusable";
import {
    getPlaybackSnapshot,
    subscribePlaybackSnapshot,
} from "./playbackSnapshot";

type CachedExplorerPage = {
    cachedAt: number;
    albums?: SpotifyBrowseItem[];
    albumsNextOffset?: number | null;
    tracks?: SpotifyContextTrack[];
};

type SpotifyExplorerCache = {
    cachedAt: number;
    playlists: SpotifyBrowseItem[];
    albums: SpotifyBrowseItem[];
    artists: SpotifyBrowseItem[];
    pages: Record<string, CachedExplorerPage>;
};

const SPOTIFY_EXPLORER_CACHE_KEY = "solodeck.spotify-explorer.v1";
const SPOTIFY_EXPLORER_CACHE_MAX_PAGES = 12;
const SPOTIFY_EXPLORER_CACHE_MAX_TRACKS_PER_PAGE = 200;
const SPOTIFY_EXPLORER_CACHE_MAX_ITEMS_PER_SECTION = 1000;
const SPOTIFY_TRACK_PAGE_REFRESH_COOLDOWN_MS = 60_000;
const SPOTIFY_ARTIST_PAGE_CACHE_TTL_MS = 30 * 60_000;

function getQuotaRetrySeconds(error: string | undefined) {
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

function readSpotifyExplorerCache(): SpotifyExplorerCache {
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
                    pages[uri] = {
                        cachedAt: page.cachedAt,
                        albums: Array.isArray(page.albums)
                            ? page.albums.filter(isBrowseItem).slice(0, 100)
                            : undefined,
                        albumsNextOffset:
                            typeof page.albumsNextOffset === "number" &&
                            page.albumsNextOffset >= 0
                                ? page.albumsNextOffset
                                : null,
                        tracks: Array.isArray(page.tracks)
                            ? page.tracks
                                  .filter(
                                      (entry): entry is SpotifyContextTrack =>
                                          Boolean(entry) &&
                                          typeof entry.position === "number" &&
                                          Boolean(entry.item) &&
                                          typeof entry.item === "object",
                                  )
                                  .slice(
                                      0,
                                      SPOTIFY_EXPLORER_CACHE_MAX_TRACKS_PER_PAGE,
                                  )
                            : undefined,
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

function writeSpotifyExplorerCache(cache: SpotifyExplorerCache) {
    try {
        window.localStorage.setItem(
            SPOTIFY_EXPLORER_CACHE_KEY,
            JSON.stringify(cache),
        );
    } catch (error) {
        console.warn("solodeck: could not save Spotify explorer cache", error);
    }
}

function cacheExplorerPage(
    cache: SpotifyExplorerCache,
    uri: string,
    page: CachedExplorerPage,
): SpotifyExplorerCache {
    const pages = {
        ...cache.pages,
        [uri]: {
            ...cache.pages[uri],
            ...page,
            albums: page.albums?.slice(0, 100),
            tracks: page.tracks?.slice(
                0,
                SPOTIFY_EXPLORER_CACHE_MAX_TRACKS_PER_PAGE,
            ),
        },
    };
    const retainedPages = Object.fromEntries(
        Object.entries(pages)
            .sort((left, right) => right[1].cachedAt - left[1].cachedAt)
            .slice(0, SPOTIFY_EXPLORER_CACHE_MAX_PAGES),
    );
    return { ...cache, pages: retainedPages };
}

const sectionHeadingStyle = {
    fontSize: "14px",
    fontWeight: 600,
    lineHeight: 1.3,
    paddingBottom: "10px",
} as const;

const quietMessageStyle = {
    width: "100%",
    boxSizing: "border-box" as const,
    color: "var(--gpColor-Grey)",
    fontSize: "13px",
    lineHeight: 1.4,
    padding: "8px 12px",
} as const;

function trackArtist(item: TrackItem): string {
    return (
        item.decorations?.creators
            ?.map((creator) =>
                creator.entity?.decorations?.identity?.name?.trim(),
            )
            .filter(Boolean)
            .join(", ") ?? ""
    );
}

export type TrackContextMenuProps = {
    title: string;
    artists: { uri: string; name: string }[];
    albumAvailable: boolean;
    onOpenAlbum: () => void;
    onOpenArtist: (artist: { uri: string; name: string }) => void;
};

export function TrackContextMenu({
    title,
    artists,
    albumAvailable,
    onOpenAlbum,
    onOpenArtist,
}: TrackContextMenuProps) {
    return (
        <Menu label={title}>
            <MenuItem disabled={!albumAvailable} onSelected={onOpenAlbum}>
                Album
            </MenuItem>
            {artists.length > 0 && (
                <MenuGroup label="Artists">
                    {artists.map((artist) => (
                        <MenuItem
                            key={artist.uri}
                            onSelected={() => onOpenArtist(artist)}
                        >
                            {artist.name}
                        </MenuItem>
                    ))}
                </MenuGroup>
            )}
        </Menu>
    );
}

export default function SpotifyLibraryModal({
    closeModal,
    onPlayTrack,
    initialBrowseItem,
}: {
    closeModal: () => void;
    onPlayTrack: (
        item: TrackItem,
        contextUri?: string,
        position?: number,
    ) => Promise<{ ok: boolean; error?: string }>;
    initialBrowseItem?: SpotifyBrowseItem;
}) {
    const playback = useSyncExternalStore(
        subscribePlaybackSnapshot,
        getPlaybackSnapshot,
        getPlaybackSnapshot,
    );
    const [explorerCache, setExplorerCache] = useState(
        readSpotifyExplorerCache,
    );
    const [library, setLibrary] = useState<{
        playlists: SpotifyBrowseItem[];
        albums: SpotifyBrowseItem[];
        artists: SpotifyBrowseItem[];
    }>(() => ({
        playlists: explorerCache.playlists,
        albums: explorerCache.albums,
        artists: explorerCache.artists,
    }));
    const [libraryLoading, setLibraryLoading] = useState(
        () =>
            explorerCache.playlists.length === 0 &&
            explorerCache.albums.length === 0 &&
            explorerCache.artists.length === 0,
    );
    const [libraryRefreshing, setLibraryRefreshing] = useState(true);
    const [libraryError, setLibraryError] = useState("");
    const [page, setPage] = useState<"home" | "search" | "browse">("home");
    const [searchText, setSearchText] = useState("");
    const [searchTab, setSearchTab] = useState<
        "all" | "tracks" | "albums" | "artists"
    >("all");
    const [searchResults, setSearchResults] =
        useState<SpotifySearchResults | null>(null);
    const [searchLoading, setSearchLoading] = useState(false);
    const [browseItem, setBrowseItem] = useState<SpotifyBrowseItem | null>(
        initialBrowseItem ?? HomeBrowseItem,
    );
    const [parentBrowseItem, setParentBrowseItem] =
        useState<SpotifyBrowseItem | null>(null);
    const [albums, setAlbums] = useState<SpotifyBrowseItem[]>([]);
    const [albumsNextOffset, setAlbumsNextOffset] = useState<number | null>(
        null,
    );
    const [loadingMoreAlbums, setLoadingMoreAlbums] = useState(false);
    const [tracks, setTracks] = useState<SpotifyContextTrack[]>([]);
    const [contentLoading, setContentLoading] = useState(false);
    const [contentError, setContentError] = useState("");
    const [playError, setPlayError] = useState("");
    const [quotaUntil, setQuotaUntil] = useState<number | null>(null);
    const [quotaNow, setQuotaNow] = useState(Date.now);
    const [refreshClock, setRefreshClock] = useState(Date.now);
    const contentRequestRef = useRef(0);
    const modalContentRef = useRef<HTMLDivElement>(null);
    const libraryScrollRef = useRef<HTMLDivElement>(null);
    const detailsScrollRef = useRef<HTMLDivElement>(null);
    const scrollAnimationsRef = useRef(
        new WeakMap<HTMLDivElement, { frame: number; target: number }>(),
    );

    useEffect(() => {
        const quotaError = [
            libraryError,
            contentError,
            playError,
            searchResults?.error,
        ].find((error) => getQuotaRetrySeconds(error) !== null);
        const retrySeconds = getQuotaRetrySeconds(quotaError);
        if (retrySeconds !== null) {
            setQuotaUntil(Date.now() + retrySeconds * 1000);
            setQuotaNow(Date.now());
        }
    }, [contentError, libraryError, playError, searchResults?.error]);

    useEffect(() => {
        if (quotaUntil === null) return;

        const updateCountdown = () => {
            const now = Date.now();
            setQuotaNow(now);
            if (now >= quotaUntil) setQuotaUntil(null);
        };
        const interval = window.setInterval(updateCountdown, 1000);
        updateCountdown();
        return () => window.clearInterval(interval);
    }, [quotaUntil]);

    const quotaRemainingSeconds =
        quotaUntil === null
            ? 0
            : Math.max(0, Math.ceil((quotaUntil - quotaNow) / 1000));
    const quotaDays = Math.floor(quotaRemainingSeconds / 86400);
    const quotaHours = Math.floor((quotaRemainingSeconds % 86400) / 3600);
    const quotaMinutes = Math.floor((quotaRemainingSeconds % 3600) / 60);
    const quotaSeconds = quotaRemainingSeconds % 60;
    const cachedBrowsePage = browseItem && explorerCache.pages[browseItem.uri];
    const refreshCooldownSeconds =
        browseItem &&
        (browseItem.entity_type === "playlist" ||
            browseItem.entity_type === "album") &&
        cachedBrowsePage?.tracks !== undefined
            ? Math.max(
                  0,
                  Math.ceil(
                      (cachedBrowsePage.cachedAt +
                          SPOTIFY_TRACK_PAGE_REFRESH_COOLDOWN_MS -
                          refreshClock) /
                          1000,
                  ),
              )
            : 0;

    // Derive the active page from browseItem.
    // browseItem.uri "solodeck:home" -> home page
    // browseItem.uri "solodeck:search" -> search page
    // anything else (playlist/album/artist) -> browse page
    useEffect(() => {
        if (!browseItem) {
            setPage("home");
        } else if (browseItem.uri === "solodeck:search") {
            setPage("search");
        } else if (browseItem.uri === "solodeck:home") {
            setPage("home");
        } else {
            setPage("browse");
        }
    }, [browseItem]);

    useEffect(() => {
        if (
            !browseItem ||
            (browseItem.entity_type !== "playlist" &&
                browseItem.entity_type !== "album") ||
            explorerCache.pages[browseItem.uri]?.tracks === undefined
        ) {
            return;
        }

        const timer = window.setInterval(
            () => setRefreshClock(Date.now()),
            1000,
        );
        return () => window.clearInterval(timer);
    }, [browseItem, explorerCache.pages]);

    const centerFocusedRow = (
        element: HTMLElement,
        scrollRef: RefObject<HTMLDivElement | null> = detailsScrollRef,
    ) => {
        const scroller = scrollRef.current;
        if (!scroller) return;
        const itemBounds = element.getBoundingClientRect();
        const scrollerBounds = scroller.getBoundingClientRect();
        const scrollTop = Math.max(
            0,
            Math.min(
                scroller.scrollHeight - scroller.clientHeight,
                scroller.scrollTop +
                    itemBounds.top +
                    itemBounds.height / 2 -
                    (scrollerBounds.top + scrollerBounds.height / 2),
            ),
        );
        const animations = scrollAnimationsRef.current;
        const activeAnimation = animations.get(scroller);
        if (activeAnimation) {
            activeAnimation.target = scrollTop;
            return;
        }

        const animation = {
            frame: 0,
            target: scrollTop,
        };
        const animate = () => {
            if (!scroller.isConnected) {
                animations.delete(scroller);
                return;
            }
            const remaining = animation.target - scroller.scrollTop;
            if (Math.abs(remaining) < 1.5) {
                scroller.scrollTop = animation.target;
                animations.delete(scroller);
                return;
            }
            scroller.scrollTop += remaining * 0.28;
            animation.frame = window.requestAnimationFrame(animate);
        };
        animations.set(scroller, animation);
        animation.frame = window.requestAnimationFrame(animate);
    };

    const renderFocusableHeading = (
        label: string,
        scrollRef: RefObject<HTMLDivElement | null>,
        style: CSSProperties = sectionHeadingStyle,
        icon?: React.ReactNode,
    ) => (
        <Focusable
            onFocus={(event) =>
                centerFocusedRow(event.currentTarget, scrollRef)
            }
            style={{ width: "100%" }}
        >
            <div
                style={{
                    ...style,
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                }}
            >
                {icon && <span style={{ fontSize: "14px" }}>{icon}</span>}
                {label}
            </div>
        </Focusable>
    );

    useLayoutEffect(() => {
        const dialogForm = modalContentRef.current?.closest<HTMLFormElement>(
            'form[role="dialog"]',
        );
        const preventSearchSubmit = (event: Event) => {
            if (
                event.target instanceof HTMLInputElement &&
                modalContentRef.current?.contains(event.target)
            ) {
                event.preventDefault();
                event.stopPropagation();
            }
        };
        dialogForm?.addEventListener("submit", preventSearchSubmit);
        const modalShell = dialogForm?.parentElement?.parentElement;
        if (!modalShell) {
            return () =>
                dialogForm?.removeEventListener("submit", preventSearchSubmit);
        }

        const previousWidth = modalShell.style.width;
        const previousHeight = modalShell.style.height;
        modalShell.style.width = "90%";
        modalShell.style.height = "100%";

        return () => {
            dialogForm?.removeEventListener("submit", preventSearchSubmit);
            modalShell.style.width = previousWidth;
            modalShell.style.height = previousHeight;
        };
    }, []);

    useEffect(() => {
        writeSpotifyExplorerCache(explorerCache);
    }, [explorerCache]);

    useEffect(() => {
        let cancelled = false;
        setLibraryLoading(true);
        setLibraryRefreshing(true);
        getWebApiLibrary()
            .then((result) => {
                if (cancelled) return;
                if (!result.ok) {
                    setLibraryError(
                        result.error ?? "Could not load your Spotify library.",
                    );
                    return;
                }
                const nextLibrary = {
                    playlists: result.playlists ?? [],
                    albums: result.albums ?? [],
                    artists: result.artists ?? [],
                };
                setLibrary(nextLibrary);
                setExplorerCache((current) => ({
                    ...current,
                    cachedAt: Date.now(),
                    playlists: nextLibrary.playlists.slice(
                        0,
                        SPOTIFY_EXPLORER_CACHE_MAX_ITEMS_PER_SECTION,
                    ),
                    albums: nextLibrary.albums.slice(
                        0,
                        SPOTIFY_EXPLORER_CACHE_MAX_ITEMS_PER_SECTION,
                    ),
                    artists: nextLibrary.artists.slice(
                        0,
                        SPOTIFY_EXPLORER_CACHE_MAX_ITEMS_PER_SECTION,
                    ),
                }));
                setLibraryError("");
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    console.error(
                        "solodeck: failed to load Spotify library",
                        error,
                    );
                    setLibraryError("Could not load your Spotify library.");
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setLibraryLoading(false);
                    setLibraryRefreshing(false);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [initialBrowseItem?.uri]);

    // Precache the library on the Python side once per session so the UI
    // loads instantly. The Python side caches with a TTL and only refreshes
    // occasionally, not on every modal open.
    useEffect(() => {
        let cancelled = false;
        void precacheWebApiLibrary()
            .then((result) => {
                if (!cancelled && !result.ok) {
                    console.warn(
                        "solodeck: library precache failed:",
                        result.error,
                    );
                }
            })
            .catch((error) => {
                if (!cancelled) {
                    console.warn("solodeck: library precache error", error);
                }
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(
        () => () => {
            contentRequestRef.current += 1;
        },
        [],
    );

    useEffect(() => {
        const query = searchText.trim();
        if (!query) {
            setSearchResults(null);
            setSearchLoading(false);
            return;
        }
        let cancelled = false;
        const timer = window.setTimeout(() => {
            setSearchLoading(true);
            console.log(query);
            searchWebApi(query)
                .then((result) => {
                    if (!cancelled) setSearchResults(result);
                })
                .catch((error: unknown) => {
                    if (!cancelled) {
                        console.error("solodeck: Spotify search failed", error);
                        setSearchResults({
                            ok: false,
                            error: "Spotify search failed.",
                        });
                    }
                })
                .finally(() => {
                    if (!cancelled) setSearchLoading(false);
                });
        }, 350);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [searchText]);

    const openBrowseItem = async (
        item: SpotifyBrowseItem,
        parentItem: SpotifyBrowseItem | null = null,
        forceRefresh = false,
    ) => {
        const requestId = ++contentRequestRef.current;
        const cachedPage = explorerCache.pages[item.uri];
        const hasCachedTrackPage =
            (item.entity_type === "playlist" || item.entity_type === "album") &&
            cachedPage?.tracks !== undefined;
        const refreshCooldownRemaining =
            cachedPage?.tracks !== undefined
                ? cachedPage.cachedAt +
                  SPOTIFY_TRACK_PAGE_REFRESH_COOLDOWN_MS -
                  Date.now()
                : 0;
        if (forceRefresh && refreshCooldownRemaining > 0) {
            setContentError(
                `Please wait ${Math.ceil(refreshCooldownRemaining / 1000)} seconds before refreshing this page.`,
            );
            return;
        }
        setParentBrowseItem(
            item.entity_type === "album" && parentItem?.entity_type === "artist"
                ? parentItem
                : null,
        );
        setSearchText("");
        setSearchResults(null);
        setBrowseItem(item);
        setAlbums(cachedPage?.albums ?? []);
        setAlbumsNextOffset(cachedPage?.albumsNextOffset ?? null);
        setLoadingMoreAlbums(false);
        setTracks(cachedPage?.tracks ?? []);
        setContentError("");
        if (item.entity_type === "home") {
            setContentLoading(false);
            return;
        }
        setContentLoading(!hasCachedTrackPage || forceRefresh);
        try {
            if (item.entity_type === "playlist") {
                if (hasCachedTrackPage && !forceRefresh) return;
                const result = await getWebApiPlaylistTracks(item.uri);
                if (!result.ok)
                    throw new Error(result.error ?? "Could not load playlist.");
                if (requestId !== contentRequestRef.current) return;
                const nextTracks = result.items ?? [];
                setTracks(nextTracks);
                setExplorerCache((current) =>
                    cacheExplorerPage(current, item.uri, {
                        cachedAt: Date.now(),
                        tracks: nextTracks,
                    }),
                );
            } else if (item.entity_type === "artist") {
                if (
                    cachedPage?.albums &&
                    Date.now() - cachedPage.cachedAt <
                        SPOTIFY_ARTIST_PAGE_CACHE_TTL_MS
                ) {
                    return;
                }
                const result = await getWebApiArtistAlbums(item.uri, 0);
                if (!result.ok)
                    throw new Error(result.error ?? "Could not load artist.");
                if (requestId !== contentRequestRef.current) return;
                const nextAlbums = result.items ?? [];
                setAlbums(nextAlbums);
                setAlbumsNextOffset(result.next_offset ?? null);
                setExplorerCache((current) =>
                    cacheExplorerPage(current, item.uri, {
                        cachedAt: Date.now(),
                        albums: nextAlbums,
                        albumsNextOffset: result.next_offset ?? null,
                    }),
                );
            } else {
                if (hasCachedTrackPage && !forceRefresh) return;
                const result = await getWebApiAlbumTracks(item.uri);
                if (!result.ok)
                    throw new Error(result.error ?? "Could not load album.");
                if (requestId !== contentRequestRef.current) return;
                const nextTracks = result.items ?? [];
                setTracks(nextTracks);
                setExplorerCache((current) =>
                    cacheExplorerPage(current, item.uri, {
                        cachedAt: Date.now(),
                        tracks: nextTracks,
                    }),
                );
            }
        } catch (error) {
            if (requestId !== contentRequestRef.current) return;
            setContentError(
                error instanceof Error
                    ? error.message
                    : "Could not load Spotify content.",
            );
        } finally {
            if (requestId === contentRequestRef.current)
                setContentLoading(false);
        }
    };

    useEffect(() => {
        if (initialBrowseItem) void openBrowseItem(initialBrowseItem);
    }, [initialBrowseItem?.uri]);

    const loadMoreArtistAlbums = async () => {
        if (
            !browseItem ||
            browseItem.entity_type !== "artist" ||
            albumsNextOffset === null ||
            loadingMoreAlbums
        ) {
            return;
        }
        const requestId = contentRequestRef.current;
        const artistUri = browseItem.uri;
        const offset = albumsNextOffset;
        setLoadingMoreAlbums(true);
        setContentError("");
        try {
            const result = await getWebApiArtistAlbums(artistUri, offset);
            if (!result.ok)
                throw new Error(
                    result.error ?? "Could not load more artist albums.",
                );
            if (
                requestId !== contentRequestRef.current ||
                browseItem?.uri !== artistUri
            ) {
                return;
            }
            const nextAlbums = result.items ?? [];
            setAlbums((current) => {
                const knownUris = new Set(current.map((album) => album.uri));
                return [
                    ...current,
                    ...nextAlbums.filter((album) => !knownUris.has(album.uri)),
                ];
            });
            setAlbumsNextOffset(result.next_offset ?? null);
            setExplorerCache((current) =>
                cacheExplorerPage(current, artistUri, {
                    cachedAt: Date.now(),
                    albums: [
                        ...(current.pages[artistUri]?.albums ?? []),
                        ...nextAlbums,
                    ],
                    albumsNextOffset: result.next_offset ?? null,
                }),
            );
        } catch (error) {
            if (requestId !== contentRequestRef.current) return;
            setContentError(
                error instanceof Error
                    ? error.message
                    : "Could not load more artist albums.",
            );
        } finally {
            if (requestId === contentRequestRef.current)
                setLoadingMoreAlbums(false);
        }
    };

    const returnToBrowseParent = () => {
        const parent = parentBrowseItem;
        setParentBrowseItem(null);
        if (parent) {
            void openBrowseItem(parent);
            return;
        }
        ++contentRequestRef.current;
        setBrowseItem(HomeBrowseItem);
        setAlbums([]);
        setTracks([]);
        setContentError("");
    };

    const playTrack = async (
        item: TrackItem,
        contextUri?: string,
        position?: number,
    ) => {
        if (!item.uri) return;
        setPlayError("");
        try {
            const result = await onPlayTrack(item, contextUri, position);
            if (!result.ok)
                setPlayError(result.error ?? "Could not start playback.");
        } catch (error) {
            console.error("solodeck: failed to start Spotify playback", error);
            setPlayError(
                error instanceof Error
                    ? error.message
                    : "Could not start playback.",
            );
        }
    };

    const browseRowStyle = {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        width: "100%",
        minHeight: "38px",
        textAlign: "left" as const,
    };
    const browseButtonStyle = {
        display: "block",
        width: "100%",
        boxSizing: "border-box" as const,
        border: "0",
        borderRadius: "4px",
        padding: "2px 4px",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        textAlign: "left" as const,
        cursor: "pointer",
    };

    // Resolve a string icon name (from SpotifyBrowseItem.icon) to an FA icon.
    function iconNameToElement(
        name: string,
        size: number,
    ): React.ReactNode | null {
        switch (name) {
            case "home":
                return <FaHome size={size * 0.5} />;
            case "search":
                return <FaSearch size={size * 0.5} />;
            default:
                return null;
        }
    }

    const browseImage = (
        imageUrl: string | null | undefined,
        circular = false,
        size = 30,
        showPlayingIcon = false,
        fallbackIcon?: string | React.ReactNode,
    ) => {
        const resolvedIcon =
            typeof fallbackIcon === "string"
                ? iconNameToElement(fallbackIcon, size)
                : fallbackIcon;
        return (
            <div
                style={{
                    width: `${size}px`,
                    height: `${size}px`,
                    flex: `0 0 ${size}px`,
                    borderRadius: circular ? "50%" : "3px",
                    overflow: "hidden",
                    background: "rgba(255,255,255,0.08)",
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                }}
            >
                {imageUrl && imageUrl !== "/" && (
                    <img
                        src={imageUrl}
                        alt=""
                        style={{
                            width: "100%",
                            height: "100%",
                            objectFit: "cover",
                        }}
                    />
                )}
                {(!imageUrl || imageUrl === "/") && resolvedIcon && (
                    <span
                        style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: "100%",
                            height: "100%",
                            fontSize: size * 0.5,
                            lineHeight: 1,
                        }}
                    >
                        {resolvedIcon}
                    </span>
                )}
                {showPlayingIcon && (
                    <span
                        aria-label="Currently playing"
                        style={{
                            position: "absolute",
                            right: "2px",
                            bottom: "2px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: "14px",
                            height: "14px",
                            borderRadius: "50%",
                            color: "var(--gpColor-Green)",
                            background: "rgba(0,0,0,0.75)",
                        }}
                    >
                        <FaPlay size={7} />
                    </span>
                )}
            </div>
        );
    };

    const renderBrowseButton = (
        item: SpotifyBrowseItem,
        onClick: () => void,
        selected = false,
        scrollRef: RefObject<HTMLDivElement | null> = detailsScrollRef,
        icon?: string | React.ReactNode,
    ) => {
        const currentlyPlaying =
            (item.entity_type === "playlist" &&
                playback.contextUri === item.uri) ||
            (item.entity_type === "album" &&
                (playback.contextUri === item.uri ||
                    playback.currentTrackAlbumUri === item.uri));
        return (
            <Focusable
                key={item.uri}
                onFocus={(event) =>
                    centerFocusedRow(event.currentTarget, scrollRef)
                }
                onActivate={onClick}
                style={{ width: "100%" }}
            >
                <button
                    type="button"
                    tabIndex={-1}
                    aria-pressed={selected}
                    onClick={onClick}
                    onFocus={(event) => {
                        event.currentTarget.style.backgroundColor =
                            "rgba(255,255,255,0.12)";
                    }}
                    onBlur={(event) => {
                        event.currentTarget.style.backgroundColor = selected
                            ? "rgba(255,255,255,0.08)"
                            : "transparent";
                    }}
                    style={{
                        ...browseButtonStyle,
                        background: selected
                            ? "rgba(255,255,255,0.08)"
                            : "transparent",
                    }}
                >
                    <div style={browseRowStyle}>
                        {browseImage(
                            item.image_url,
                            item.entity_type === "artist",
                            30,
                            currentlyPlaying,
                            icon,
                        )}
                        <div style={{ minWidth: 0, flex: 1 }}>
                            <div
                                style={{
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                    fontWeight: selected ? 600 : 400,
                                    ...(currentlyPlaying
                                        ? { color: "#1DB954" }
                                        : {}),
                                }}
                            >
                                {item.name}
                            </div>
                        </div>
                    </div>
                </button>
            </Focusable>
        );
    };

    const renderTrackButton = (
        entry: SpotifyContextTrack,
        contextUri?: string,
    ) => {
        const title =
            entry.item.decorations?.identity?.name ??
            entry.item.name ??
            "Unknown track";
        const artist = trackArtist(entry.item);
        const isCurrentContextTrack =
            (browseItem?.entity_type === "playlist" ||
                browseItem?.entity_type === "album") &&
            contextUri === browseItem.uri &&
            playback.contextUri === browseItem.uri &&
            playback.currentTrackUri === entry.item.uri;
        const artists = (entry.item.decorations?.creators ?? [])
            .map((creator) => {
                const entity = creator.entity;
                const identity = entity?.decorations?.identity;
                const uri = entity?.uri ?? identity?.uri;
                return typeof uri === "string" &&
                    typeof identity?.name === "string"
                    ? { uri, name: identity.name }
                    : null;
            })
            .filter(
                (artist): artist is { uri: string; name: string } =>
                    artist !== null,
            );
        const albumEntity = entry.item.decorations?.parent?.entity;
        const albumUri =
            albumEntity?.uri ??
            (browseItem?.entity_type === "album" ? browseItem.uri : undefined);
        const albumName =
            albumEntity?.decorations?.identity?.name ??
            (browseItem?.entity_type === "album" ? browseItem.name : undefined);
        const albumImage =
            entry.item.decorations?.visual_identity?.cover?.[0]?.url ??
            (browseItem?.entity_type === "album" ? browseItem.image_url : null);

        const openTrackMenu = (event: CustomEvent) => {
            const menuParent = event.currentTarget ?? undefined;
            showContextMenu(
                <TrackContextMenu
                    title={title}
                    artists={artists}
                    albumAvailable={Boolean(albumUri && albumName)}
                    onOpenAlbum={() => {
                        if (!albumUri || !albumName) return;
                        void openBrowseItem({
                            uri: albumUri,
                            name: albumName,
                            entity_type: "album",
                            image_url: albumImage ?? null,
                        });
                    }}
                    onOpenArtist={(artist) =>
                        void openBrowseItem({
                            uri: artist.uri,
                            name: artist.name,
                            entity_type: "artist",
                            image_url: null,
                        })
                    }
                />,
                menuParent,
            );
        };

        return (
            <Focusable
                key={`${entry.position}-${entry.item.uri ?? title}`}
                onFocus={(event) => centerFocusedRow(event.currentTarget)}
                onSecondaryButton={openTrackMenu}
                onSecondaryActionDescription="Options"
                onActivate={() =>
                    void playTrack(entry.item, contextUri, entry.position)
                }
                style={{ width: "100%" }}
            >
                <button
                    type="button"
                    tabIndex={-1}
                    onClick={() =>
                        void playTrack(entry.item, contextUri, entry.position)
                    }
                    onFocus={(event) => {
                        event.currentTarget.style.backgroundColor =
                            "rgba(255,255,255,0.12)";
                    }}
                    onBlur={(event) => {
                        event.currentTarget.style.backgroundColor =
                            "transparent";
                    }}
                    style={browseButtonStyle}
                >
                    <div style={browseRowStyle}>
                        {browseImage(
                            entry.item.decorations?.visual_identity?.cover?.[0]
                                ?.url ??
                                (browseItem?.entity_type === "album"
                                    ? browseItem.image_url
                                    : undefined),
                            false,
                            30,
                            isCurrentContextTrack,
                        )}
                        <div style={{ minWidth: 0, flex: 1 }}>
                            <div
                                style={{
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                    ...(isCurrentContextTrack
                                        ? { color: "#1DB954" }
                                        : {}),
                                }}
                            >
                                {title}
                            </div>
                            <div
                                style={{
                                    color: "var(--gpColor-Grey)",
                                    fontSize: "12px",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                }}
                            >
                                {artist}
                            </div>
                        </div>
                    </div>
                </button>
            </Focusable>
        );
    };

    return (
        <ModalRoot bAllowFullSize closeModal={closeModal}>
            <div
                ref={modalContentRef}
                style={{
                    boxSizing: "border-box",
                    width: "80vw",
                    height: "80vh",
                    maxWidth: "80vw",
                    maxHeight: "80vh",
                    minWidth: "0",
                    minHeight: "0",
                    display: "flex",
                    flexDirection: "column",
                    position: "relative",
                    padding: "12px",
                    gap: "12px",
                    overflow: "hidden",
                }}
            >
                <Focusable
                    flow-children="horizontal"
                    style={{
                        flex: "1 1 0",
                        minHeight: 0,
                        minWidth: 0,
                        display: "grid",
                        gridTemplateColumns:
                            "minmax(140px, 20%) minmax(0, 1fr)",
                        gap: "8px",
                    }}
                >
                    <Focusable
                        flow-children="vertical"
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            minHeight: 0,
                            minWidth: 0,
                            paddingRight: "8px",
                            borderRight: "1px solid var(--gpSystem-Separator)",
                        }}
                    >
                        <div
                            aria-live="polite"
                            style={{
                                flex: "0 0 18px",
                                height: "18px",
                                overflow: "hidden",
                                color: "var(--gpColor-Grey)",
                                fontSize: "11px",
                                lineHeight: "18px",
                                textAlign: "right",
                                visibility:
                                    libraryRefreshing && !libraryLoading
                                        ? "visible"
                                        : "hidden",
                                pointerEvents: "none",
                            }}
                        >
                            Updating library...
                        </div>
                        <div
                            ref={libraryScrollRef}
                            style={{
                                flex: "1 1 0",
                                minHeight: 0,
                                overflowY: "auto",
                                overflowX: "hidden",
                            }}
                        >
                            {libraryLoading && (
                                <div style={quietMessageStyle}>
                                    Loading your library...
                                </div>
                            )}
                            {libraryError && (
                                <div
                                    style={{
                                        ...quietMessageStyle,
                                        color: "var(--gpColor-Red)",
                                    }}
                                >
                                    {libraryError}
                                </div>
                            )}
                            {renderBrowseButton(
                                HomeBrowseItem,
                                () => void openBrowseItem(HomeBrowseItem),
                                browseItem?.uri === HomeBrowseItem.uri,
                                libraryScrollRef,
                                HomeBrowseItem.icon,
                            )}
                            {renderBrowseButton(
                                SearchBrowseItem,
                                () => void openBrowseItem(SearchBrowseItem),
                                browseItem?.uri === SearchBrowseItem.uri,
                                libraryScrollRef,
                                SearchBrowseItem.icon,
                            )}
                            {renderFocusableHeading(
                                "Playlists",
                                libraryScrollRef,
                                {
                                    fontSize: "14px",
                                    fontWeight: 600,
                                    lineHeight: 1.3,
                                    padding: "4px 0",
                                },
                            )}
                            {!libraryLoading &&
                                library.playlists.map((item) =>
                                    renderBrowseButton(
                                        item,
                                        () => void openBrowseItem(item),
                                        browseItem?.uri === item.uri,
                                        libraryScrollRef,
                                    ),
                                )}
                            {!libraryLoading &&
                                !libraryError &&
                                library.playlists.length === 0 && (
                                    <div style={quietMessageStyle}>
                                        No playlists found.
                                    </div>
                                )}
                            <div
                                style={{
                                    borderTop:
                                        "1px solid var(--gpSystem-Separator)",
                                    margin: "8px 0",
                                }}
                            />
                            {renderFocusableHeading(
                                "Albums",
                                libraryScrollRef,
                                {
                                    fontSize: "14px",
                                    fontWeight: 600,
                                    lineHeight: 1.3,
                                    padding: "4px 0",
                                },
                            )}
                            {!libraryLoading &&
                                library.albums.map((item) =>
                                    renderBrowseButton(
                                        item,
                                        () => void openBrowseItem(item),
                                        browseItem?.uri === item.uri,
                                        libraryScrollRef,
                                    ),
                                )}
                            {!libraryLoading &&
                                !libraryError &&
                                library.albums.length === 0 && (
                                    <div style={quietMessageStyle}>
                                        No saved albums found.
                                    </div>
                                )}
                            <div
                                style={{
                                    borderTop:
                                        "1px solid var(--gpSystem-Separator)",
                                    margin: "8px 0",
                                }}
                            />
                            {renderFocusableHeading(
                                "Artists",
                                libraryScrollRef,
                                {
                                    fontSize: "14px",
                                    fontWeight: 600,
                                    lineHeight: 1.3,
                                    padding: "4px 0",
                                },
                            )}
                            {!libraryLoading &&
                                library.artists.map((item) =>
                                    renderBrowseButton(
                                        item,
                                        () => void openBrowseItem(item),
                                        browseItem?.uri === item.uri,
                                        libraryScrollRef,
                                    ),
                                )}
                            {!libraryLoading &&
                                !libraryError &&
                                library.artists.length === 0 && (
                                    <div style={quietMessageStyle}>
                                        No followed artists found.
                                    </div>
                                )}
                        </div>
                    </Focusable>
                    <Focusable
                        flow-children="vertical"
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            minHeight: 0,
                            minWidth: 0,
                        }}
                    >
                        <div
                            aria-live="polite"
                            style={{
                                flex: "0 0 18px",
                                height: "18px",
                                overflow: "hidden",
                                color: "var(--gpColor-Grey)",
                                fontSize: "11px",
                                lineHeight: "18px",
                                textAlign: "right",
                                visibility: contentLoading
                                    ? "visible"
                                    : "hidden",
                                pointerEvents: "none",
                            }}
                        >
                            {page === "browse" &&
                                (albums.length > 0 || tracks.length > 0
                                    ? "Refreshing Spotify..."
                                    : "Loading Spotify...")}
                        </div>
                        <div
                            ref={detailsScrollRef}
                            style={{
                                flex: "1 1 0",
                                minHeight: 0,
                                overflowY: "auto",
                                overflowX: "hidden",
                                paddingRight: "8px",
                            }}
                        >
                            {page === "search" ? (
                                <>
                                    <Focusable
                                        flow-children="vertical"
                                        style={{
                                            flex: "0 0 auto",
                                            minHeight: 0,
                                        }}
                                    >
                                        <TextField
                                            label="Search Spotify"
                                            value={searchText}
                                            onChange={(event) =>
                                                setSearchText(
                                                    event.target.value,
                                                )
                                            }
                                            onKeyDown={(event) => {
                                                if (event.key === "Enter") {
                                                    event.preventDefault();
                                                    event.stopPropagation();
                                                }
                                            }}
                                        />
                                    </Focusable>
                                    <Tabs
                                        tabs={[
                                            {
                                                id: "all",
                                                title: "All",
                                                content: (
                                                    <>
                                                        {searchLoading && (
                                                            <div
                                                                style={
                                                                    quietMessageStyle
                                                                }
                                                            >
                                                                Searching
                                                                Spotify...
                                                            </div>
                                                        )}
                                                        {searchResults &&
                                                            !searchResults.ok && (
                                                                <div
                                                                    style={{
                                                                        ...quietMessageStyle,
                                                                        color: "var(--gpColor-Red)",
                                                                    }}
                                                                >
                                                                    {
                                                                        searchResults.error
                                                                    }
                                                                </div>
                                                            )}
                                                        {searchResults?.tracks?.map(
                                                            (item, position) =>
                                                                renderTrackButton(
                                                                    {
                                                                        item,
                                                                        position,
                                                                    },
                                                                ),
                                                        )}
                                                        {[
                                                            ...(searchResults?.playlists ??
                                                                []),
                                                            ...(searchResults?.artists ??
                                                                []),
                                                            ...(searchResults?.albums ??
                                                                []),
                                                        ].map((item) =>
                                                            renderBrowseButton(
                                                                item,
                                                                () =>
                                                                    void openBrowseItem(
                                                                        item,
                                                                    ),
                                                            ),
                                                        )}
                                                    </>
                                                ),
                                            },
                                            {
                                                id: "tracks",
                                                title: "Tracks",
                                                content: (
                                                    <>
                                                        {searchLoading && (
                                                            <div
                                                                style={
                                                                    quietMessageStyle
                                                                }
                                                            >
                                                                Searching
                                                                Spotify...
                                                            </div>
                                                        )}
                                                        {searchResults &&
                                                            !searchResults.ok && (
                                                                <div
                                                                    style={{
                                                                        ...quietMessageStyle,
                                                                        color: "var(--gpColor-Red)",
                                                                    }}
                                                                >
                                                                    {
                                                                        searchResults.error
                                                                    }
                                                                </div>
                                                            )}
                                                        {searchResults?.tracks?.map(
                                                            (item, position) =>
                                                                renderTrackButton(
                                                                    {
                                                                        item,
                                                                        position,
                                                                    },
                                                                ),
                                                        )}
                                                    </>
                                                ),
                                            },
                                            {
                                                id: "albums",
                                                title: "Albums",
                                                content: (
                                                    <>
                                                        {searchLoading && (
                                                            <div
                                                                style={
                                                                    quietMessageStyle
                                                                }
                                                            >
                                                                Searching
                                                                Spotify...
                                                            </div>
                                                        )}
                                                        {searchResults &&
                                                            !searchResults.ok && (
                                                                <div
                                                                    style={{
                                                                        ...quietMessageStyle,
                                                                        color: "var(--gpColor-Red)",
                                                                    }}
                                                                >
                                                                    {
                                                                        searchResults.error
                                                                    }
                                                                </div>
                                                            )}
                                                        {searchResults?.albums?.map(
                                                            (item) =>
                                                                renderBrowseButton(
                                                                    item,
                                                                    () =>
                                                                        void openBrowseItem(
                                                                            item,
                                                                        ),
                                                                ),
                                                        )}
                                                    </>
                                                ),
                                            },
                                            {
                                                id: "artists",
                                                title: "Artists",
                                                content: (
                                                    <>
                                                        {searchLoading && (
                                                            <div
                                                                style={
                                                                    quietMessageStyle
                                                                }
                                                            >
                                                                Searching
                                                                Spotify...
                                                            </div>
                                                        )}
                                                        {searchResults &&
                                                            !searchResults.ok && (
                                                                <div
                                                                    style={{
                                                                        ...quietMessageStyle,
                                                                        color: "var(--gpColor-Red)",
                                                                    }}
                                                                >
                                                                    {
                                                                        searchResults.error
                                                                    }
                                                                </div>
                                                            )}
                                                        {searchResults?.artists?.map(
                                                            (item) =>
                                                                renderBrowseButton(
                                                                    item,
                                                                    () =>
                                                                        void openBrowseItem(
                                                                            item,
                                                                        ),
                                                                ),
                                                        )}
                                                    </>
                                                ),
                                            },
                                        ]}
                                        activeTab={searchTab}
                                        onShowTab={setSearchTab}
                                    />
                                </>
                            ) : page === "browse" && browseItem ? (
                                <>
                                    {parentBrowseItem && (
                                        <div
                                            style={{
                                                display: "flex",
                                                alignItems: "center",
                                                gap: "12px",
                                                marginBottom: "12px",
                                            }}
                                        >
                                            <Focusable
                                                onActivate={
                                                    returnToBrowseParent
                                                }
                                                style={{
                                                    flex: "0 0 auto",
                                                }}
                                            >
                                                <button
                                                    type="button"
                                                    tabIndex={-1}
                                                    onClick={
                                                        returnToBrowseParent
                                                    }
                                                    style={{
                                                        ...browseButtonStyle,
                                                        width: "auto",
                                                        padding: "6px 10px",
                                                        background:
                                                            "rgba(255,255,255,0.08)",
                                                    }}
                                                >
                                                    Back to{" "}
                                                    {parentBrowseItem.name}
                                                </button>
                                            </Focusable>
                                        </div>
                                    )}
                                    <Focusable
                                        onFocus={(event) =>
                                            centerFocusedRow(
                                                event.currentTarget,
                                            )
                                        }
                                        style={{ width: "100%" }}
                                    >
                                        <div
                                            style={{
                                                display: "flex",
                                                alignItems: "center",
                                                gap: "14px",
                                                paddingBottom: "16px",
                                            }}
                                        >
                                            {browseImage(
                                                browseItem.image_url === "/"
                                                    ? undefined
                                                    : browseItem.image_url,
                                                browseItem.entity_type ===
                                                    "artist",
                                                72,
                                                false,
                                                browseItem.icon,
                                            )}
                                            <div style={{ minWidth: 0 }}>
                                                <div
                                                    style={{
                                                        fontSize: "20px",
                                                        fontWeight: 600,
                                                        overflowWrap:
                                                            "anywhere",
                                                    }}
                                                >
                                                    {browseItem.name}
                                                </div>
                                                {browseItem.entity_type !==
                                                    "artist" && (
                                                    <div
                                                        style={{
                                                            color: "var(--gpColor-Grey)",
                                                            fontSize: "13px",
                                                            paddingTop: "3px",
                                                        }}
                                                    >
                                                        {browseItem.entity_type ===
                                                        "album"
                                                            ? "Album"
                                                            : "Playlist"}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </Focusable>
                                    {quotaUntil !== null && (
                                        <div
                                            style={{
                                                ...quietMessageStyle,
                                                background:
                                                    "var(--gpSystem-DarkGrey)",
                                                borderRadius: "8px",
                                                marginBottom: "12px",
                                                textAlign: "center",
                                            }}
                                        >
                                            <div
                                                style={{
                                                    fontSize: "15px",
                                                    fontWeight: 700,
                                                    marginBottom: "6px",
                                                }}
                                            >
                                                Your WebAPI quota has exceeded!
                                            </div>
                                            <div
                                                style={{
                                                    color: "var(--gpColor-Grey)",
                                                    fontSize: "13px",
                                                    lineHeight: 1.5,
                                                }}
                                            >
                                                Please come back in {quotaDays}d{" "}
                                                {quotaHours}h {quotaMinutes}m
                                                and {quotaSeconds}sec.
                                            </div>
                                        </div>
                                    )}
                                    {renderFocusableHeading(
                                        browseItem.entity_type === "artist"
                                            ? "Albums and singles"
                                            : browseItem.entity_type === "album"
                                              ? "Tracks"
                                              : "Playlist tracks",
                                        detailsScrollRef,
                                    )}
                                    {(browseItem.entity_type === "playlist" ||
                                        browseItem.entity_type === "album") && (
                                        <Focusable
                                            onActivate={() => {
                                                if (
                                                    contentLoading ||
                                                    refreshCooldownSeconds > 0
                                                ) {
                                                    return;
                                                }
                                                void openBrowseItem(
                                                    browseItem,
                                                    parentBrowseItem,
                                                    true,
                                                );
                                            }}
                                            style={{ width: "100%" }}
                                        >
                                            <button
                                                type="button"
                                                tabIndex={-1}
                                                disabled={
                                                    contentLoading ||
                                                    refreshCooldownSeconds > 0
                                                }
                                                onClick={() =>
                                                    contentLoading ||
                                                    refreshCooldownSeconds > 0
                                                        ? undefined
                                                        : void openBrowseItem(
                                                              browseItem,
                                                              parentBrowseItem,
                                                              true,
                                                          )
                                                }
                                                style={{
                                                    ...browseButtonStyle,
                                                    ...quietMessageStyle,
                                                    alignItems: "center",
                                                    display: "flex",
                                                    gap: "8px",
                                                    justifyContent: "center",
                                                    cursor:
                                                        contentLoading ||
                                                        refreshCooldownSeconds >
                                                            0
                                                            ? "default"
                                                            : "pointer",
                                                    opacity:
                                                        contentLoading ||
                                                        refreshCooldownSeconds >
                                                            0
                                                            ? 0.6
                                                            : 1,
                                                }}
                                            >
                                                <FaSyncAlt aria-hidden="true" />
                                                {contentLoading
                                                    ? "Refreshing tracks..."
                                                    : refreshCooldownSeconds > 0
                                                      ? `Refresh available in ${refreshCooldownSeconds}s`
                                                      : "Refresh tracks"}
                                            </button>
                                        </Focusable>
                                    )}
                                    {contentError && (
                                        <div
                                            style={{
                                                ...quietMessageStyle,
                                                color: "var(--gpColor-Red)",
                                            }}
                                        >
                                            {contentError}
                                        </div>
                                    )}
                                    {playError && (
                                        <div
                                            style={{
                                                ...quietMessageStyle,
                                                color: "var(--gpColor-Red)",
                                            }}
                                        >
                                            {playError}
                                        </div>
                                    )}
                                    {albums.map((item) =>
                                        renderBrowseButton(
                                            item,
                                            () =>
                                                void openBrowseItem(
                                                    item,
                                                    browseItem.entity_type ===
                                                        "artist"
                                                        ? browseItem
                                                        : null,
                                                ),
                                        ),
                                    )}
                                    {browseItem.entity_type === "artist" &&
                                        albumsNextOffset !== null && (
                                            <Focusable
                                                onActivate={
                                                    loadMoreArtistAlbums
                                                }
                                                style={{ width: "100%" }}
                                            >
                                                <button
                                                    type="button"
                                                    tabIndex={-1}
                                                    disabled={loadingMoreAlbums}
                                                    onClick={
                                                        loadMoreArtistAlbums
                                                    }
                                                    style={{
                                                        ...browseButtonStyle,
                                                        ...quietMessageStyle,
                                                        cursor: loadingMoreAlbums
                                                            ? "default"
                                                            : "pointer",
                                                    }}
                                                >
                                                    {loadingMoreAlbums
                                                        ? "Loading more albums..."
                                                        : "Load more albums"}
                                                </button>
                                            </Focusable>
                                        )}
                                    {tracks.map((entry) =>
                                        renderTrackButton(
                                            entry,
                                            browseItem?.entity_type ===
                                                "playlist" ||
                                                browseItem?.entity_type ===
                                                    "album"
                                                ? browseItem.uri
                                                : undefined,
                                        ),
                                    )}
                                    {!contentLoading &&
                                        !contentError &&
                                        browseItem.entity_type === "artist" &&
                                        albums.length === 0 && (
                                            <div style={quietMessageStyle}>
                                                No albums or singles found.
                                            </div>
                                        )}
                                    {!contentLoading &&
                                        !contentError &&
                                        browseItem.entity_type !== "artist" &&
                                        tracks.length === 0 && (
                                            <div style={quietMessageStyle}>
                                                No playable tracks found.
                                            </div>
                                        )}
                                </>
                            ) : (
                                // Custom home page — display current state as raw JSON.
                                <div
                                    style={{
                                        width: "100%",
                                        height: "100%",
                                        overflowY: "auto",
                                        padding: "12px",
                                    }}
                                >
                                    For now this is just a debug page. It will
                                    serve a purpouse later!
                                    <pre
                                        style={{
                                            margin: 0,
                                            fontSize: "12px",
                                            lineHeight: 1.4,
                                            color: "var(--gpColor-Grey)",
                                            whiteSpace: "pre-wrap",
                                            wordBreak: "break-all",
                                        }}
                                    >
                                        {JSON.stringify(
                                            {
                                                page,
                                                library: {
                                                    playlists:
                                                        library.playlists
                                                            .length,
                                                    albums: library.albums
                                                        .length,
                                                    artists:
                                                        library.artists.length,
                                                },
                                                libraryLoading,
                                                libraryError,
                                                browseItem: browseItem
                                                    ? {
                                                          uri: browseItem.uri,
                                                          name: browseItem.name,
                                                          entity_type:
                                                              browseItem.entity_type,
                                                      }
                                                    : null,
                                                parentBrowseItem:
                                                    parentBrowseItem
                                                        ? {
                                                              uri: parentBrowseItem.uri,
                                                              name: parentBrowseItem.name,
                                                              entity_type:
                                                                  parentBrowseItem.entity_type,
                                                          }
                                                        : null,
                                                albums: albums.length,
                                                albumsNextOffset,
                                                loadingMoreAlbums,
                                                tracks: tracks.length,
                                                contentLoading,
                                                contentError,
                                                playError,
                                                quotaUntil,
                                                searchText,
                                                searchLoading,
                                                searchResults: searchResults
                                                    ? {
                                                          ok: searchResults.ok,
                                                          tracks:
                                                              searchResults
                                                                  .tracks
                                                                  ?.length ?? 0,
                                                          playlists:
                                                              searchResults
                                                                  .playlists
                                                                  ?.length ?? 0,
                                                          artists:
                                                              searchResults
                                                                  .artists
                                                                  ?.length ?? 0,
                                                          albums:
                                                              searchResults
                                                                  .albums
                                                                  ?.length ?? 0,
                                                      }
                                                    : null,
                                            },
                                            null,
                                            2,
                                        )}
                                    </pre>
                                </div>
                            )}
                        </div>
                    </Focusable>
                </Focusable>
            </div>
        </ModalRoot>
    );
}
