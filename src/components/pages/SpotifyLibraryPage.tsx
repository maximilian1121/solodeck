import { Focusable, showContextMenu } from "@decky/ui";
import overlayImage from "../../overlay.png";
import {
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
    type CSSProperties,
    type RefObject,
} from "react";
import {
    FaCompactDisc,
    FaHome,
    FaMusic,
    FaPlay,
    FaSearch,
    FaUser,
} from "react-icons/fa";
import {
    getSpotifyAlbumPage,
    getSpotifyPlaylistPage,
    getWebApiArtistAlbums,
    getWebApiLibrary,
    HomeBrowseItem,
    SearchBrowseItem,
    searchWebApi,
    type SpotifyBrowseItem,
    type SpotifyContextTrack,
    type SpotifySearchResults,
} from "../../api";
import { type TrackItem } from "../TrackDetailsFocusable";
import { CollectionHeader } from "../library/CollectionHeader";
import BrowsePage from "../library/BrowsePage";
import HomePage from "./HomePage";
import { BrowseItemRow } from "../library/BrowseItemRow";
import { TrackRow } from "../library/TrackRow";
import SearchPanel from "../library/SearchPanel";
import { TrackContextMenu } from "../library/TrackContextMenu";
import {
    cacheExplorerPage,
    getQuotaRetrySeconds,
    quietMessageStyle,
    readSpotifyExplorerCache,
    sectionHeadingStyle,
    SPOTIFY_ARTIST_PAGE_CACHE_TTL_MS,
    SPOTIFY_EXPLORER_CACHE_MAX_ITEMS_PER_SECTION,
    SPOTIFY_TRACK_PAGE_SIZE,
    SPOTIFY_TRACK_PAGE_REFRESH_COOLDOWN_MS,
    trackArtist,
    writeSpotifyExplorerCache,
} from "../library/explorerCache";
import {
    getPlaybackSnapshot,
    subscribePlaybackSnapshot,
} from "../playbackSnapshot";

type BrowseNav = "reset" | "push" | "keep";

export default function SpotifyLibraryPage({
    onBack,
    onPlayTrack,
    initialBrowseItem,
}: {
    onBack: () => void;
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
    const [libraryRetry, setLibraryRetry] = useState(0);
    const [page, setPage] = useState<"home" | "search" | "browse">("home");
    const [collectionHeaderCollapsed, setCollectionHeaderCollapsed] =
        useState(false);
    const [searchText, setSearchText] = useState("");
    const [searchTab, setSearchTab] = useState<
        "all" | "tracks" | "albums" | "artists" | "playlists"
    >("all");
    const [searchResults, setSearchResults] =
        useState<SpotifySearchResults | null>(null);
    const [searchLoading, setSearchLoading] = useState(false);
    const [browseItem, setBrowseItem] = useState<SpotifyBrowseItem | null>(
        initialBrowseItem ?? HomeBrowseItem,
    );
    const [breadcrumbPath, setBreadcrumbPath] = useState<SpotifyBrowseItem[]>(
        [],
    );
    const [albums, setAlbums] = useState<SpotifyBrowseItem[]>([]);
    const [albumsNextOffset, setAlbumsNextOffset] = useState<number | null>(
        null,
    );
    const [loadingMoreAlbums, setLoadingMoreAlbums] = useState(false);
    const [tracks, setTracks] = useState<SpotifyContextTrack[]>([]);
    const [tracksNextOffset, setTracksNextOffset] = useState<number | null>(
        null,
    );
    const [loadingMoreTracks, setLoadingMoreTracks] = useState(false);
    const loadingMoreTracksRef = useRef<number | null>(null);
    const [contentLoading, setContentLoading] = useState(false);
    const [contentError, setContentError] = useState("");
    const [playError, setPlayError] = useState("");
    const [quotaUntil, setQuotaUntil] = useState<number | null>(null);
    const [quotaNow, setQuotaNow] = useState(Date.now);
    const [refreshClock, setRefreshClock] = useState(Date.now);
    const contentRequestRef = useRef(0);
    const libraryScrollRef = useRef<HTMLDivElement>(null);
    const detailsScrollRef = useRef<HTMLDivElement>(null);
    const collectionHeaderRef = useRef<HTMLDivElement>(null);
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

    useEffect(() => {
        writeSpotifyExplorerCache(explorerCache);
    }, [explorerCache]);

    useEffect(() => {
        let cancelled = false;
        setLibraryRefreshing(true);
        setLibraryError("");
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
    }, [initialBrowseItem?.uri, libraryRetry]);

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
        setSearchResults(null);
        setSearchLoading(true);
        const timer = window.setTimeout(() => {
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
        {
            forceRefresh = false,
            nav = "reset",
        }: { forceRefresh?: boolean; nav?: BrowseNav } = {},
    ) => {
        if (
            item.entity_type === "playlist" ||
            item.entity_type === "album" ||
            item.entity_type === "artist"
        ) {
            setCollectionHeaderCollapsed(false);
            if (detailsScrollRef.current)
                detailsScrollRef.current.scrollTop = 0;
        }
        const cachedPage = explorerCache.pages[item.uri];
        const hasCachedTrackPage =
            (item.entity_type === "playlist" || item.entity_type === "album") &&
            Boolean(cachedPage?.tracks?.length);
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
        const requestId = ++contentRequestRef.current;

        // reset: library/search/home click, wipes the trail
        // push: came from a track menu or an artist's album list, append
        // keep: breadcrumb click or refresh, caller owns the trail
        const isPseudo =
            item.uri === "solodeck:home" || item.uri === "solodeck:search";
        if (nav === "reset") {
            setBreadcrumbPath(isPseudo ? [] : [item]);
        } else if (nav === "push") {
            setBreadcrumbPath((prev) => {
                const existing = prev.findIndex(
                    (crumb) => crumb.uri === item.uri,
                );
                return existing >= 0
                    ? prev.slice(0, existing + 1)
                    : [...prev, item];
            });
        }

        setSearchText("");
        setSearchResults(null);
        setBrowseItem(item);
        setAlbums(cachedPage?.albums ?? []);
        setAlbumsNextOffset(cachedPage?.albumsNextOffset ?? null);
        setLoadingMoreAlbums(false);
        const cachedTracks = cachedPage?.tracks ?? [];
        const initialCachedTracks = cachedTracks.slice(
            0,
            SPOTIFY_TRACK_PAGE_SIZE,
        );
        const firstUnshownCachedTrack =
            cachedTracks[initialCachedTracks.length];
        const cachedTrackOffset =
            firstUnshownCachedTrack?.position ??
            (cachedPage?.tracksComplete
                ? null
                : (cachedPage?.tracksNextOffset ??
                  (cachedTracks.length > 0
                      ? cachedTracks[cachedTracks.length - 1].position + 1
                      : 0)));
        setTracks(initialCachedTracks);
        setTracksNextOffset(cachedTrackOffset);
        setLoadingMoreTracks(false);
        loadingMoreTracksRef.current = null;
        setContentError("");
        if (item.entity_type === "home") {
            setContentLoading(false);
            return;
        }
        const hasCachedArtistPage =
            item.entity_type === "artist" && cachedPage?.albums !== undefined;
        setContentLoading(
            (!hasCachedTrackPage && !hasCachedArtistPage) || forceRefresh,
        );
        try {
            if (
                item.entity_type === "playlist" ||
                item.entity_type === "album"
            ) {
                if (hasCachedTrackPage && !forceRefresh) {
                    setContentLoading(false);
                    return;
                }
                setContentLoading(true);
                const fetchPage =
                    item.entity_type === "playlist"
                        ? getSpotifyPlaylistPage
                        : getSpotifyAlbumPage;
                const result = await fetchPage(item.uri, 0);
                if (!result.ok)
                    throw new Error(result.error ?? "Could not load tracks.");
                if (requestId !== contentRequestRef.current) return;
                const nextTracks = result.items ?? [];
                const nextOffset = result.next_offset ?? null;
                setTracks(nextTracks);
                setTracksNextOffset(nextOffset);
                setExplorerCache((current) =>
                    cacheExplorerPage(current, item.uri, {
                        cachedAt: Date.now(),
                        tracks: nextTracks,
                        tracksNextOffset: nextOffset,
                        tracksComplete: nextOffset === null,
                    }),
                );
            } else if (item.entity_type === "artist") {
                if (
                    !forceRefresh &&
                    cachedPage?.albums &&
                    Date.now() - cachedPage.cachedAt <
                        SPOTIFY_ARTIST_PAGE_CACHE_TTL_MS
                ) {
                    return;
                }
                setContentLoading(true);
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

    const loadMoreTracks = async () => {
        const item = browseItem;
        if (
            !item ||
            (item.entity_type !== "playlist" && item.entity_type !== "album") ||
            tracksNextOffset === null ||
            contentLoading ||
            loadingMoreTracksRef.current !== null
        ) {
            return;
        }

        const requestId = contentRequestRef.current;
        loadingMoreTracksRef.current = requestId;
        setLoadingMoreTracks(true);
        setContentError("");
        const offset = tracksNextOffset;
        try {
            const cachedPage = explorerCache.pages[item.uri];
            const cachedTracks = cachedPage?.tracks ?? [];
            const lastVisiblePosition =
                tracks[tracks.length - 1]?.position ?? -1;
            const nextCachedIndex = cachedTracks.findIndex(
                (track) => track.position > lastVisiblePosition,
            );

            if (nextCachedIndex >= 0) {
                const cachedBatch = cachedTracks.slice(
                    nextCachedIndex,
                    nextCachedIndex + SPOTIFY_TRACK_PAGE_SIZE,
                );
                const nextVisiblePosition =
                    cachedTracks[nextCachedIndex + cachedBatch.length]
                        ?.position;
                setTracks((current) => [...current, ...cachedBatch]);
                setTracksNextOffset(
                    nextVisiblePosition ??
                        (cachedPage?.tracksComplete
                            ? null
                            : (cachedPage?.tracksNextOffset ?? offset)),
                );
                return;
            }

            const fetchPage =
                item.entity_type === "playlist"
                    ? getSpotifyPlaylistPage
                    : getSpotifyAlbumPage;
            const result = await fetchPage(item.uri, offset);
            if (!result.ok)
                throw new Error(result.error ?? "Could not load more tracks.");
            if (requestId !== contentRequestRef.current) return;
            const nextBatch = result.items ?? [];
            const nextOffset = result.next_offset ?? null;
            if (nextOffset !== null && nextOffset <= offset) {
                throw new Error("Could not load the remaining tracks.");
            }
            const nextTracks = [...tracks, ...nextBatch];
            setTracks(nextTracks);
            setTracksNextOffset(nextOffset);
            setExplorerCache((current) =>
                cacheExplorerPage(current, item.uri, {
                    cachedAt: Date.now(),
                    tracks: nextTracks,
                    tracksNextOffset: nextOffset,
                    tracksComplete: nextOffset === null,
                }),
            );
        } catch (error) {
            if (requestId === contentRequestRef.current) {
                setContentError(
                    error instanceof Error
                        ? error.message
                        : "Could not load more tracks.",
                );
            }
        } finally {
            if (loadingMoreTracksRef.current === requestId) {
                loadingMoreTracksRef.current = null;
                setLoadingMoreTracks(false);
            }
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
                {resolvedIcon && (
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
                {imageUrl && imageUrl !== "/" && (
                    <>
                        <img
                            key={imageUrl}
                            src={imageUrl}
                            onError={(event) => {
                                event.currentTarget.style.display = "none";
                            }}
                            alt=""
                            style={{
                                width: "100%",
                                height: "100%",
                                objectFit: "cover",
                                position: "absolute",
                                inset: 0,
                            }}
                        />
                        <img
                            src={overlayImage}
                            alt=""
                            style={{
                                width: "100%",
                                height: "100%",
                                objectFit: "cover",
                                position: "absolute",
                                inset: 0,
                                mixBlendMode: "multiply",
                                pointerEvents: "none",
                            }}
                        />
                    </>
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
            <BrowseItemRow
                key={item.uri}
                item={item}
                onClick={onClick}
                selected={selected}
                currentlyPlaying={currentlyPlaying}
                image={browseImage(
                    item.image_url,
                    item.entity_type === "artist",
                    30,
                    currentlyPlaying,
                    icon ??
                        (item.entity_type === "artist" ? (
                            <FaUser />
                        ) : item.entity_type === "album" ? (
                            <FaCompactDisc />
                        ) : (
                            <FaMusic />
                        )),
                )}
                scrollRef={scrollRef}
                onFocusRow={centerFocusedRow}
            />
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
                        void openBrowseItem(
                            {
                                uri: albumUri,
                                name: albumName,
                                entity_type: "album",
                                image_url: albumImage ?? null,
                            },
                            { nav: "push" },
                        );
                    }}
                    onOpenArtist={(artist) =>
                        void openBrowseItem(
                            {
                                uri: artist.uri,
                                name: artist.name,
                                entity_type: "artist",
                                image_url: null,
                            },
                            { nav: "push" },
                        )
                    }
                />,
                menuParent,
            );
        };

        return (
            <TrackRow
                key={`${entry.position}-${entry.item.uri ?? title}`}
                title={title}
                artist={artist}
                artwork={browseImage(
                    entry.item.decorations?.visual_identity?.cover?.[0]?.url ??
                        (browseItem?.entity_type === "album"
                            ? browseItem.image_url
                            : undefined),
                    false,
                    30,
                    isCurrentContextTrack,
                )}
                currentlyPlaying={isCurrentContextTrack}
                onPlay={() =>
                    void playTrack(entry.item, contextUri, entry.position)
                }
                onOpenContextMenu={openTrackMenu}
                onFocusRow={centerFocusedRow}
            />
        );
    };

    const handlePageBack = () => {
        if (page === "search") {
            setSearchTab("all");
            void openBrowseItem(HomeBrowseItem);
            return;
        }
        if (breadcrumbPath.length > 1) {
            const parentPath = breadcrumbPath.slice(0, -1);
            const parent = parentPath[parentPath.length - 1];
            setBreadcrumbPath(parentPath);
            void openBrowseItem(parent, { nav: "keep" });
            return;
        }
        onBack();
    };

    return (
        <Focusable
            flow-children="vertical"
            onCancel={(event) => {
                event.stopPropagation();
                handlePageBack();
            }}
            style={{
                boxSizing: "border-box",
                width: "100%",
                height: "calc(100% - 80px)",
                maxWidth: "100%",
                maxHeight: "calc(100% - 80px)",
                minWidth: "0",
                minHeight: "0",
                display: "flex",
                flexDirection: "column",
                position: "relative",
                padding: "0px 12px 0px 12px", // THIS IS NEEDED SO IT DOESNT CLIP INTO THE FOOTER OR HEADER!!!
                gap: "12px",
                overflow: "hidden",
                margin: "40px 0 40px 0", // THIS IS NEEDED SO IT DOESNT CLIP INTO THE FOOTER OR HEADER!!!
            }}
        >
            <Focusable
                flow-children="horizontal"
                style={{
                    flex: "1 1 0",
                    minHeight: 0,
                    minWidth: 0,
                    display: "grid",
                    gridTemplateColumns: "minmax(140px, 20%) minmax(0, 1fr)",
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
                            boxSizing: "border-box",
                            paddingBottom: "16px",
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
                                <div>{libraryError}</div>
                                <Focusable
                                    onActivate={() =>
                                        setLibraryRetry((value) => value + 1)
                                    }
                                >
                                    <button
                                        type="button"
                                        tabIndex={-1}
                                        style={browseButtonStyle}
                                        onClick={() =>
                                            setLibraryRetry(
                                                (value) => value + 1,
                                            )
                                        }
                                    >
                                        Retry library
                                    </button>
                                </Focusable>
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
                        {renderFocusableHeading("Playlists", libraryScrollRef, {
                            fontSize: "14px",
                            fontWeight: 600,
                            lineHeight: 1.3,
                            padding: "4px 0",
                        })}
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
                        {renderFocusableHeading("Albums", libraryScrollRef, {
                            fontSize: "14px",
                            fontWeight: 600,
                            lineHeight: 1.3,
                            padding: "4px 0",
                        })}
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
                        {renderFocusableHeading("Artists", libraryScrollRef, {
                            fontSize: "14px",
                            fontWeight: 600,
                            lineHeight: 1.3,
                            padding: "4px 0",
                        })}
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
                            visibility:
                                contentLoading || loadingMoreTracks
                                    ? "visible"
                                    : "hidden",
                            pointerEvents: "none",
                        }}
                    >
                        {loadingMoreTracks
                            ? "Loading more tracks..."
                            : page === "browse" &&
                              (albums.length > 0 || tracks.length > 0
                                  ? "Refreshing Spotify..."
                                  : "Loading Spotify...")}
                    </div>
                    <div
                        ref={detailsScrollRef}
                        onScroll={(event) => {
                            const isCollection =
                                browseItem?.entity_type === "playlist" ||
                                browseItem?.entity_type === "album" ||
                                browseItem?.entity_type === "artist";
                            const viewport =
                                event.currentTarget.getBoundingClientRect();
                            const header =
                                collectionHeaderRef.current?.getBoundingClientRect();
                            setCollectionHeaderCollapsed(
                                isCollection &&
                                    header !== undefined &&
                                    header.bottom <= viewport.top,
                            );
                            const { scrollTop, scrollHeight, clientHeight } =
                                event.currentTarget;
                            if (
                                page === "browse" &&
                                isCollection &&
                                tracksNextOffset !== null &&
                                scrollHeight - scrollTop - clientHeight < 420
                            ) {
                                void loadMoreTracks();
                            }
                        }}
                        style={{
                            flex: "1 1 0",
                            minHeight: 0,
                            overflowY: page === "search" ? "hidden" : "auto",
                            overflowX: "hidden",
                            boxSizing: "border-box",
                            paddingRight: "8px",
                            paddingBottom: "24px",
                            paddingTop: "8px",
                            display: page === "search" ? "flex" : undefined,
                            flexDirection: page === "search" ? "column" : undefined,
                        }}
                    >
                        {page === "search" ? (
                            <SearchPanel
                                searchText={searchText}
                                onSearchTextChange={setSearchText}
                                searchLoading={searchLoading}
                                searchResults={searchResults}
                                activeTab={searchTab}
                                onShowTab={setSearchTab}
                                onBrowseItem={(item) =>
                                    void openBrowseItem(item)
                                }
                                renderBrowseButton={renderBrowseButton}
                                renderTrackButton={renderTrackButton}
                            />
                        ) : page === "browse" && browseItem ? (
                            <BrowsePage
                                item={browseItem}
                                collapsed={collectionHeaderCollapsed}
                                breadcrumbPath={breadcrumbPath}
                                onSelectBreadcrumb={(crumb, index) => {
                                    setBreadcrumbPath(
                                        breadcrumbPath.slice(0, index + 1),
                                    );
                                    void openBrowseItem(crumb, { nav: "keep" });
                                }}
                                onFocusRow={(element) =>
                                    centerFocusedRow(element)
                                }
                                compactImage={browseImage(
                                    browseItem.image_url ?? undefined,
                                    false,
                                    40,
                                    false,
                                )}
                                header={
                                    <CollectionHeader
                                        item={browseItem}
                                        headerRef={collectionHeaderRef}
                                        artwork={browseImage(
                                            browseItem.image_url === "/"
                                                ? undefined
                                                : browseItem.image_url,
                                            browseItem.entity_type === "artist",
                                            72,
                                            false,
                                            browseItem.icon ??
                                                (browseItem.entity_type ===
                                                "artist" ? (
                                                    <FaUser />
                                                ) : browseItem.entity_type ===
                                                  "album" ? (
                                                    <FaCompactDisc />
                                                ) : (
                                                    <FaMusic />
                                                )),
                                        )}
                                        onFocusRow={centerFocusedRow}
                                    />
                                }
                                tracks={tracks}
                                albums={albums}
                                albumsNextOffset={albumsNextOffset}
                                loadingMoreAlbums={loadingMoreAlbums}
                                contentLoading={contentLoading}
                                contentError={contentError}
                                playError={playError}
                                quotaActive={quotaUntil !== null}
                                quotaRemainingSeconds={quotaRemainingSeconds}
                                refreshCooldownSeconds={refreshCooldownSeconds}
                                browseButtonStyle={browseButtonStyle}
                                onRefresh={() =>
                                    void openBrowseItem(browseItem, {
                                        forceRefresh: true,
                                        nav: "keep",
                                    })
                                }
                                onLoadMoreAlbums={() =>
                                    void loadMoreArtistAlbums()
                                }
                                renderHeading={(label) =>
                                    renderFocusableHeading(
                                        label,
                                        detailsScrollRef,
                                    )
                                }
                                renderBrowseItem={(item) =>
                                    renderBrowseButton(
                                        item,
                                        () =>
                                            void openBrowseItem(item, {
                                                nav: "push",
                                            }),
                                    )
                                }
                                renderTrack={(entry, contextUri) =>
                                    renderTrackButton(entry, contextUri)
                                }
                            />
                        ) : (
                            <HomePage />
                        )}
                    </div>
                </Focusable>
            </Focusable>
        </Focusable>
    );
}
