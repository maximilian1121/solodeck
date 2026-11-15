import {
    Focusable,
    NavEntryPositionPreferences,
    PanelSection,
    PanelSectionRow,
    SliderField,
    ButtonItem,
    showContextMenu,
    staticClasses,
} from "@decky/ui";
import { type SpotifyBrowseItem } from "../api";
import {
    FaCheckCircle,
    FaCircle,
    FaPause,
    FaPlay,
    FaRandom,
    FaRedo,
    FaStepBackward,
    FaStepForward,
} from "react-icons/fa";
import { useEffect, useRef, useState } from "react";
import type { TrackItem } from "./TrackDetailsFocusable";
import { updatePlaybackProgress, updatePlaybackSnapshot } from "./playbackSnapshot";
import { TrackContextMenu } from "./library/TrackContextMenu";
import {
    ActionControl,
    getObject,
    isSpotifyDjContext,
    SmoothSeekSlider,
    spotifyContextUri,
    spotifyTrackAlbumUri,
} from "./playback";
import { openSpotifyLibraryPage } from "./spotifyLibraryNavigation";
import { QueueSection, type QueueEntry } from "./qam/QueueSection";
import { NowPlayingSection } from "./qam/NowPlayingSection";
import { useTrackMetadata } from "./qam/useTrackMetadata";

const SOLOIST_WS_URL = "ws://127.0.0.1:35797";
// Background refresh: poll soloist's playback/queue state every 5 seconds
// independent of user interaction so the QAM stays in sync while idle.
const STATE_REFRESH_INTERVAL_MS = 5_000;
const ACTION_SETTLE_TIMEOUT_MS = 1500;
type PlaybackValues = {
    playing: boolean;
    shuffle: boolean;
    repeat: string;
};

type PendingPlaybackUpdates = {
    playing?: { value: boolean; timer: number };
    shuffle?: { value: boolean; timer: number };
    repeat?: { value: string; timer: number };
};

type PositionAnchor = {
    positionMs: number;
    timestampMs: number;
    speed: number;
};

export default function QamPanel() {
    const socketRef = useRef<WebSocket | null>(null);
    const pendingPlaybackRef = useRef<PendingPlaybackUpdates>({});
    const upcomingRef = useRef<QueueEntry[]>([]);
    const promotionTimerRef = useRef<number | undefined>(undefined);
    const promotingUriRef = useRef<string | null>(null);
    const positionAnchorRef = useRef<PositionAnchor | null>(null);
    const durationRef = useRef(0);
    const seekingRef = useRef(false);
    const seekTimeoutRef = useRef<number | undefined>(undefined);
    const volumeTimeoutRef = useRef<number | undefined>(undefined);
    const panelBodyRef = useRef<HTMLDivElement>(null);
    const currentTrackUriRef = useRef<string | null>(null);
    const [trackDetails, setTrackDetails] = useState<TrackItem | null>(null);
    const [upcoming, setUpcoming] = useState<QueueEntry[]>([]);
    const [promotingUri, setPromotingUri] = useState<string | null>(null);
    const [promotingEntry, setPromotingEntry] = useState<QueueEntry | null>(
        null,
    );
    const [isDjPlayback, setIsDjPlayback] = useState(false);
    const [deviceControlFocused, setDeviceControlFocused] = useState(false);
    const [soloistDeviceName, setSoloistDeviceName] = useState("");
    const [soloistIsActive, setSoloistIsActive] = useState<boolean | null>(
        null,
    );
    const [isLoggedIn, setIsLoggedIn] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isShuffle, setIsShuffle] = useState(false);
    const [repeatMode, setRepeatMode] = useState("off");
    const [positionMs, setPositionMs] = useState(0);
    const [durationMs, setDurationMs] = useState(0);
    const [volume, setVolume] = useState(50);
    const [focusedAction, setFocusedAction] = useState<string | null>(null);
    const [controlError, setControlError] = useState("");
    const [connectionStatus, setConnectionStatus] = useState(
        "Connecting to Soloist...",
    );
    const {
        canDisplayTrack,
        withCachedMetadata,
        requestTrackMetadata,
        clearMetadataCaches,
    } = useTrackMetadata({
        currentTrackUriRef,
        upcomingRef,
        promotingUriRef,
        durationRef,
        setTrackDetails,
        setUpcoming,
        setPromotingEntry,
        setDurationMs,
    });

    useEffect(() => {
        updatePlaybackProgress({
            positionMs,
            durationMs,
            isPlaying,
            timestampMs: Date.now(),
        });
    }, [positionMs, durationMs, isPlaying]);

    const markTrackPromotion = (item: TrackItem | null) => {
        const uri = item?.uri;
        if (!uri || upcomingRef.current[0]?.item.uri !== uri) return;

        if (promotionTimerRef.current !== undefined)
            window.clearTimeout(promotionTimerRef.current);
        promotingUriRef.current = uri;
        setPromotingUri(uri);
        const topEntry = upcomingRef.current[0];
        setPromotingEntry({
            ...topEntry,
            item: withCachedMetadata(topEntry.item),
        });
        upcomingRef.current = upcomingRef.current.filter(
            (entry) => entry.item.uri !== uri,
        );
        setUpcoming((current) =>
            current.filter((entry) => entry.item.uri !== uri),
        );
        promotionTimerRef.current = window.setTimeout(() => {
            promotingUriRef.current = null;
            setPromotingUri(null);
            setPromotingEntry(null);
            promotionTimerRef.current = undefined;
        }, 480);
    };

    const openSpotifyLibrary = (initialBrowseItem?: SpotifyBrowseItem) => {
        openSpotifyLibraryPage(initialBrowseItem);
    };

    const openTrackContextMenu = (
        item: TrackItem,
        event: import("@decky/ui").GamepadEvent,
    ) => {
        const title =
            item.decorations?.identity?.name ?? item.name ?? "Unknown track";
        const artists = (item.decorations?.creators ?? [])
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
        const album = item.decorations?.parent?.entity;
        const albumUri = album?.uri;
        const albumName = album?.decorations?.identity?.name;
        const albumImage =
            item.decorations?.visual_identity?.cover?.[0]?.url ?? null;

        showContextMenu(
            <TrackContextMenu
                title={title}
                artists={artists}
                albumAvailable={Boolean(albumUri && albumName)}
                onOpenAlbum={() => {
                    if (!albumUri || !albumName) return;
                    openSpotifyLibrary({
                        uri: albumUri,
                        name: albumName,
                        entity_type: "album",
                        image_url: albumImage,
                    });
                }}
                onOpenArtist={(artist) =>
                    openSpotifyLibrary({
                        uri: artist.uri,
                        name: artist.name,
                        entity_type: "artist",
                        image_url: null,
                    })
                }
            />,
            event.currentTarget as HTMLElement,
        );
    };

    const sendCommand = (
        command: string,
        fields: Record<string, unknown> = {},
    ): boolean => {
        const socket = socketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            setControlError("Soloist connection is unavailable.");
            return false;
        }

        try {
            socket.send(
                JSON.stringify({ type: "command", command, ...fields }),
            );
            setControlError("");
            return true;
        } catch (error) {
            console.error(`solodeck: failed to send ${command} command`, error);
            setControlError("Could not send playback command.");
            return false;
        }
    };

    const scrollPanelToTop = () => {
        let element: HTMLElement | null = panelBodyRef.current;
        while (element && element !== document.body) {
            const overflowY = window.getComputedStyle(element).overflowY;
            if (
                /(auto|scroll|overlay)/.test(overflowY) &&
                element.scrollHeight > element.clientHeight + 1
            ) {
                element.scrollTo({ top: 0, behavior: "smooth" });
                return;
            }
            element = element.parentElement;
        }
    };

    const handleSeekChange = (nextPositionMs: number) => {
        const nextPosition = Math.max(
            0,
            Math.min(Math.round(nextPositionMs), durationRef.current),
        );
        seekingRef.current = true;
        setPositionMs(nextPosition);

        if (seekTimeoutRef.current !== undefined)
            window.clearTimeout(seekTimeoutRef.current);
        seekTimeoutRef.current = window.setTimeout(() => {
            seekTimeoutRef.current = undefined;
            if (
                sendCommand("seek", {
                    position_ms: nextPosition,
                })
            ) {
                positionAnchorRef.current = {
                    positionMs: nextPosition,
                    timestampMs: Date.now(),
                    speed: isPlaying ? 1 : 0,
                };
            } else {
                sendCommand("get_state");
            }
            seekingRef.current = false;
        }, 350);
    };

    const handleVolumeChange = (nextVolume: number) => {
        const clampedVolume = Math.max(
            0,
            Math.min(100, Math.round(nextVolume)),
        );
        setVolume(clampedVolume);
        if (volumeTimeoutRef.current !== undefined)
            window.clearTimeout(volumeTimeoutRef.current);
        volumeTimeoutRef.current = window.setTimeout(() => {
            volumeTimeoutRef.current = undefined;
            sendCommand("set_volume", { volume: clampedVolume });
        }, 180);
    };

    const handleActivateSoloist = () => {
        if (sendCommand("activate")) {
            setSoloistIsActive(true);
        }
    };

    useEffect(() => {
        const timer = window.setInterval(() => {
            if (seekingRef.current) return;
            const anchor = positionAnchorRef.current;
            if (!anchor) return;
            const elapsed = Math.max(0, Date.now() - anchor.timestampMs);
            const estimatedPosition = Math.min(
                durationRef.current || Number.MAX_SAFE_INTEGER,
                Math.max(
                    0,
                    anchor.positionMs + elapsed * Math.max(0, anchor.speed),
                ),
            );
            setPositionMs(estimatedPosition);
        }, 100);
        return () => window.clearInterval(timer);
    }, []);

    const predictPlaybackValue = <K extends keyof PlaybackValues>(
        key: K,
        value: PlaybackValues[K],
        dispatch: () => boolean,
    ) => {
        if (!dispatch()) return;

        const previous = pendingPlaybackRef.current[key];
        if (previous) window.clearTimeout(previous.timer);

        const timer = window.setTimeout(() => {
            if (pendingPlaybackRef.current[key]?.timer !== timer) return;
            delete pendingPlaybackRef.current[key];
            sendCommand("get_state");
        }, ACTION_SETTLE_TIMEOUT_MS);

        if (key === "playing") {
            pendingPlaybackRef.current.playing = {
                value: value as boolean,
                timer,
            };
            setIsPlaying(value as boolean);
        } else if (key === "shuffle") {
            pendingPlaybackRef.current.shuffle = {
                value: value as boolean,
                timer,
            };
            setIsShuffle(value as boolean);
        } else {
            pendingPlaybackRef.current.repeat = {
                value: value as string,
                timer,
            };
            setRepeatMode(value as string);
        }
    };

    useEffect(() => {
        let disposed = false;
        let socket: WebSocket | null = null;
        let reconnectTimer: number | undefined;
        let refreshTimer: number | undefined;
        let retryDelay = 1000;
        let requestedQueue = false;

        const clearPendingPlayback = () => {
            const pending = pendingPlaybackRef.current;
            if (pending.playing) window.clearTimeout(pending.playing.timer);
            if (pending.shuffle) window.clearTimeout(pending.shuffle.timer);
            if (pending.repeat) window.clearTimeout(pending.repeat.timer);
            pendingPlaybackRef.current = {};
        };

        const applyServerValue = <K extends keyof PlaybackValues>(
            key: K,
            value: PlaybackValues[K],
        ) => {
            const pending = pendingPlaybackRef.current[key];
            if (pending && pending.value !== value) return;

            if (pending) {
                window.clearTimeout(pending.timer);
                delete pendingPlaybackRef.current[key];
            }

            if (key === "playing") setIsPlaying(value as boolean);
            else if (key === "shuffle") setIsShuffle(value as boolean);
            else setRepeatMode(value as string);
        };

        const connect = () => {
            if (disposed) return;
            setConnectionStatus("Connecting to Soloist...");

            try {
                socket = new WebSocket(SOLOIST_WS_URL);
                socketRef.current = socket;
            } catch (error) {
                console.error(
                    "solodeck: could not create Soloist WebSocket",
                    error,
                );
                scheduleReconnect();
                return;
            }

            socket.onopen = () => {
                if (disposed) return;
                retryDelay = 1000;
                setConnectionStatus("Connected to Soloist");
            };
            socket.onmessage = (event) => {
                if (disposed || typeof event.data !== "string") return;
                try {
                    const message: unknown = JSON.parse(event.data);
                    if (!message || typeof message !== "object") return;
                    const data = message as Record<string, unknown>;

                    if (data.type === "auth_state" && data.logged_in === true) {
                        setIsLoggedIn(true);
                        setSoloistDeviceName(
                            typeof data.device_name === "string"
                                ? data.device_name
                                : "",
                        );
                        setSoloistIsActive(
                            typeof data.is_active === "boolean"
                                ? data.is_active
                                : null,
                        );
                        // Always refresh playback state on (re)connect so
                        // opening the QAM page shows the current soloist
                        // state right away, not just on the next timer tick.
                        socket?.send(
                            JSON.stringify({
                                type: "command",
                                command: "get_state",
                            }),
                        );
                        if (!requestedQueue) {
                            socket?.send(
                                JSON.stringify({
                                    type: "command",
                                    command: "get_queue",
                                    limit: 10,
                                }),
                            );
                            requestedQueue = true;
                        }
                        if (refreshTimer === undefined) {
                            refreshTimer = window.setInterval(() => {
                                if (socket?.readyState !== WebSocket.OPEN)
                                    return;
                                socket.send(
                                    JSON.stringify({
                                        type: "command",
                                        command: "get_queue",
                                        limit: 10,
                                    }),
                                );
                                socket.send(
                                    JSON.stringify({
                                        type: "command",
                                        command: "get_state",
                                    }),
                                );
                            }, STATE_REFRESH_INTERVAL_MS);
                        }
                    } else if (
                        data.type === "auth_state" &&
                        data.logged_in === false
                    ) {
                        requestedQueue = false;
                        clearPendingPlayback();
                        if (refreshTimer !== undefined) {
                            window.clearInterval(refreshTimer);
                            refreshTimer = undefined;
                        }
                        setIsLoggedIn(false);
                        setSoloistDeviceName("");
                        setSoloistIsActive(null);
                        setIsPlaying(false);
                        setIsShuffle(false);
                        setRepeatMode("off");
                        setVolume(50);
                        setTrackDetails(null);
                        currentTrackUriRef.current = null;
                        positionAnchorRef.current = null;
                        durationRef.current = 0;
                        setPositionMs(0);
                        setDurationMs(0);
                        upcomingRef.current = [];
                        setUpcoming([]);
                        clearMetadataCaches();
                        setPromotingUri(null);
                        setPromotingEntry(null);
                        promotingUriRef.current = null;
                        setIsDjPlayback(false);
                        updatePlaybackSnapshot({
                            currentTrackUri: null,
                            currentTrackAlbumUri: null,
                            contextUri: null,
                            currentTrack: null,
                        });
                        updatePlaybackProgress({ positionMs: 0, durationMs: 0, isPlaying: false, timestampMs: Date.now() });
                    } else if (data.type === "playback_state") {
                        if (typeof data.is_active === "boolean") {
                            setSoloistIsActive(data.is_active);
                        }
                        if (
                            typeof data.volume === "number" &&
                            Number.isFinite(data.volume)
                        ) {
                            setVolume(Math.max(0, Math.min(100, data.volume)));
                        }
                        const item =
                            data.item && typeof data.item === "object"
                                ? (data.item as TrackItem)
                                : null;
                        markTrackPromotion(item);
                        const resolvedItem = item
                            ? withCachedMetadata(item)
                            : null;
                        if (
                            currentTrackUriRef.current &&
                            currentTrackUriRef.current !== resolvedItem?.uri
                        ) {
                            if (seekTimeoutRef.current !== undefined) {
                                window.clearTimeout(seekTimeoutRef.current);
                                seekTimeoutRef.current = undefined;
                            }
                            seekingRef.current = false;
                        }
                        currentTrackUriRef.current = resolvedItem?.uri ?? null;
                        setTrackDetails(resolvedItem);
                        requestTrackMetadata(item);
                        const duration = getObject(
                            getObject(resolvedItem?.decorations)?.playback,
                        )?.duration_ms;
                        const position = getObject(data.position);
                        const currentPosition =
                            typeof position?.position_ms === "number"
                                ? position.position_ms
                                : 0;
                        const timestamp =
                            typeof position?.timestamp_ms === "number"
                                ? position.timestamp_ms
                                : Date.now();
                        const speed =
                            typeof position?.speed === "number"
                                ? position.speed
                                : data.status === "playing"
                                  ? 1
                                  : 0;
                        positionAnchorRef.current = {
                            positionMs: currentPosition,
                            timestampMs: timestamp,
                            speed,
                        };
                        seekingRef.current = false;
                        setPositionMs(currentPosition);
                        const nextDuration =
                            typeof duration === "number" && duration > 0
                                ? duration
                                : 0;
                        durationRef.current = nextDuration;
                        setDurationMs(nextDuration);
                        applyServerValue("playing", data.status === "playing");
                        const options = getObject(data.options);
                        if (typeof options?.shuffle === "boolean")
                            applyServerValue("shuffle", options.shuffle);
                        if (typeof options?.repeat === "string")
                            applyServerValue("repeat", options.repeat);
                        setIsDjPlayback(isSpotifyDjContext(data.context));
                        updatePlaybackSnapshot({
                            currentTrackUri: resolvedItem?.uri ?? null,
                            currentTrackAlbumUri:
                                spotifyTrackAlbumUri(resolvedItem),
                            contextUri: spotifyContextUri(data.context),
                            currentTrack: resolvedItem,
                        });
                    } else if (data.type === "device_changed") {
                        if (typeof data.device_name === "string") {
                            setSoloistDeviceName(data.device_name);
                        }
                        if (typeof data.is_active === "boolean") {
                            setSoloistIsActive(data.is_active);
                        }
                    } else if (data.type === "playback_changed") {
                        if (
                            data.status === "playing" ||
                            data.status === "paused"
                        ) {
                            const anchor = positionAnchorRef.current;
                            if (anchor) {
                                const elapsed = Math.max(
                                    0,
                                    Date.now() - anchor.timestampMs,
                                );
                                const currentPosition = Math.min(
                                    durationRef.current ||
                                        Number.MAX_SAFE_INTEGER,
                                    anchor.positionMs +
                                        elapsed * Math.max(0, anchor.speed),
                                );
                                positionAnchorRef.current = {
                                    positionMs: currentPosition,
                                    timestampMs: Date.now(),
                                    speed: data.status === "playing" ? 1 : 0,
                                };
                                setPositionMs(currentPosition);
                            }
                            applyServerValue(
                                "playing",
                                data.status === "playing",
                            );
                        }
                    } else if (
                        data.type === "volume_changed" &&
                        typeof data.volume === "number" &&
                        Number.isFinite(data.volume)
                    ) {
                        setVolume(Math.max(0, Math.min(100, data.volume)));
                    } else if (data.type === "position_sync") {
                        const position = getObject(data.position);
                        if (
                            typeof position?.position_ms === "number" &&
                            typeof position.timestamp_ms === "number"
                        ) {
                            positionAnchorRef.current = {
                                positionMs: position.position_ms,
                                timestampMs: position.timestamp_ms,
                                speed:
                                    typeof position.speed === "number"
                                        ? position.speed
                                        : 0,
                            };
                            if (!seekingRef.current)
                                setPositionMs(position.position_ms);
                        }
                    } else if (data.type === "options_changed") {
                        const options = getObject(data.options);
                        if (typeof options?.shuffle === "boolean")
                            applyServerValue("shuffle", options.shuffle);
                        if (typeof options?.repeat === "string")
                            applyServerValue("repeat", options.repeat);
                    } else if (data.type === "track_changed") {
                        const item =
                            data.item && typeof data.item === "object"
                                ? (data.item as TrackItem)
                                : null;
                        markTrackPromotion(item);
                        const resolvedItem = item
                            ? withCachedMetadata(item)
                            : null;
                        if (
                            currentTrackUriRef.current &&
                            currentTrackUriRef.current !== resolvedItem?.uri
                        ) {
                            if (seekTimeoutRef.current !== undefined) {
                                window.clearTimeout(seekTimeoutRef.current);
                                seekTimeoutRef.current = undefined;
                            }
                            seekingRef.current = false;
                        }
                        currentTrackUriRef.current = resolvedItem?.uri ?? null;
                        updatePlaybackSnapshot({
                            currentTrackUri: resolvedItem?.uri ?? null,
                            currentTrackAlbumUri:
                                spotifyTrackAlbumUri(resolvedItem),
                        });
                        setTrackDetails(resolvedItem);
                        const duration = getObject(
                            getObject(resolvedItem?.decorations)?.playback,
                        )?.duration_ms;
                        const nextDuration =
                            typeof duration === "number" && duration > 0
                                ? duration
                                : 0;
                        durationRef.current = nextDuration;
                        setDurationMs(nextDuration);
                        positionAnchorRef.current = {
                            positionMs: 0,
                            timestampMs: Date.now(),
                            speed: isPlaying ? 1 : 0,
                        };
                        setPositionMs(0);
                        requestTrackMetadata(item);
                    } else if (data.type === "context_changed") {
                        setIsDjPlayback(isSpotifyDjContext(data.context));
                        updatePlaybackSnapshot({
                            contextUri: spotifyContextUri(data.context),
                        });
                    } else if (
                        data.type === "queue_changed" &&
                        Array.isArray(data.upcoming)
                    ) {
                        const queue = data.upcoming.filter(
                            (entry): entry is QueueEntry =>
                                entry !== null &&
                                typeof entry === "object" &&
                                "item" in entry &&
                                entry.item !== null &&
                                typeof entry.item === "object",
                        );
                        upcomingRef.current = queue.map((entry) => ({
                            ...entry,
                            item: withCachedMetadata(entry.item),
                        }));
                        const visibleQueue = upcomingRef.current.filter(
                            (entry) =>
                                entry.item.uri !== promotingUriRef.current,
                        );
                        setUpcoming(visibleQueue);
                        queue.forEach((entry) =>
                            requestTrackMetadata(entry.item),
                        );
                    } else if (data.type === "error") {
                        const message =
                            typeof data.message === "string"
                                ? data.message
                                : "Soloist rejected the playback command.";
                        console.error(
                            "solodeck: Soloist command failed",
                            message,
                        );
                        setControlError(message);
                        clearPendingPlayback();
                        if (socket?.readyState === WebSocket.OPEN) {
                            socket.send(
                                JSON.stringify({
                                    type: "command",
                                    command: "get_state",
                                }),
                            );
                        }
                    }
                } catch {
                    console.error(
                        "solodeck: invalid Soloist WebSocket message",
                    );
                }
            };
            socket.onerror = () => {
                if (!disposed) {
                    setConnectionStatus("Soloist connection unavailable");
                }
            };
            socket.onclose = () => {
                if (disposed) return;
                if (socketRef.current === socket) socketRef.current = null;
                clearPendingPlayback();
                if (refreshTimer !== undefined) {
                    window.clearInterval(refreshTimer);
                    refreshTimer = undefined;
                }
                requestedQueue = false;
                setIsLoggedIn(false);
                setConnectionStatus(
                    "Soloist connection unavailable; retrying...",
                );
                scheduleReconnect();
            };
        };

        const scheduleReconnect = () => {
            if (disposed || reconnectTimer !== undefined) return;
            reconnectTimer = window.setTimeout(() => {
                reconnectTimer = undefined;
                connect();
            }, retryDelay);
            retryDelay = Math.min(retryDelay * 2, 10000);
        };

        connect();

        return () => {
            disposed = true;
            if (reconnectTimer !== undefined)
                window.clearTimeout(reconnectTimer);
            if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
            if (promotionTimerRef.current !== undefined)
                window.clearTimeout(promotionTimerRef.current);
            if (seekTimeoutRef.current !== undefined)
                window.clearTimeout(seekTimeoutRef.current);
            if (volumeTimeoutRef.current !== undefined)
                window.clearTimeout(volumeTimeoutRef.current);
            clearPendingPlayback();
            if (socketRef.current === socket) socketRef.current = null;
            socket?.close();
        };
    }, []);

    // Refresh state whenever the QAM page is opened / the window becomes
    // visible, even if the panel itself stayed mounted in the background.
    useEffect(() => {
        const onVisibilityChange = () => {
            if (
                !document.hidden &&
                isLoggedIn &&
                socketRef.current?.readyState === WebSocket.OPEN
            ) {
                socketRef.current.send(
                    JSON.stringify({ type: "command", command: "get_state" }),
                );
            }
        };
        window.addEventListener("visibilitychange", onVisibilityChange);
        return () =>
            window.removeEventListener(
                "visibilitychange",
                onVisibilityChange,
            );
    }, [isLoggedIn]);

    return (
        <>
            <div
                className={staticClasses.Title}
                style={{
                    display: "flex",
                    paddingRight: "16px",
                    position: "sticky",
                    top: "0px",
                }}
            >
                <div style={{ marginRight: "auto", flex: "0.9 1 0%" }}>
                    solodeck
                </div>
            </div>
            <div ref={panelBodyRef} style={{ paddingTop: "16px" }}>
                <PanelSection>
                    <NowPlayingSection
                        isDjPlayback={isDjPlayback}
                        isLoggedIn={isLoggedIn}
                        soloistDeviceName={soloistDeviceName}
                        soloistIsActive={soloistIsActive}
                        deviceControlFocused={deviceControlFocused}
                        onActivateSoloist={handleActivateSoloist}
                        onDeviceFocusChange={setDeviceControlFocused}
                        trackDetails={trackDetails}
                        canDisplayTrack={canDisplayTrack}
                        onTrackContextMenu={(event) =>
                            trackDetails && openTrackContextMenu(trackDetails, event)
                        }
                    />
                    {isLoggedIn && durationMs > 0 && (
                        <PanelSectionRow>
                            <div onFocusCapture={scrollPanelToTop}>
                                <SmoothSeekSlider
                                    positionMs={positionMs}
                                    durationMs={durationMs}
                                    onChange={handleSeekChange}
                                />
                            </div>
                        </PanelSectionRow>
                    )}
                    <PanelSectionRow>
                        <Focusable
                            onFocusCapture={scrollPanelToTop}
                            flow-children="horizontal"
                            navEntryPreferPosition={
                                NavEntryPositionPreferences.PREFERRED_CHILD
                            }
                            noFocusRing
                            style={{
                                display: "flex",
                                justifyContent: "center",
                                alignItems: "center",
                                gap: "8px",
                                width: "fit-content",
                                maxWidth: "100%",
                                margin: "0 auto",
                                opacity: isLoggedIn ? 1 : 0.5,
                            }}
                        >
                            {[
                                {
                                    id: "shuffle",
                                    label: isShuffle
                                        ? "Shuffle on"
                                        : "Shuffle off",
                                    icon: <FaRandom size={18} />,
                                    active: isShuffle,
                                    onActivate: () => {
                                        if (isLoggedIn)
                                            predictPlaybackValue(
                                                "shuffle",
                                                !isShuffle,
                                                () =>
                                                    sendCommand("set_shuffle", {
                                                        enabled: !isShuffle,
                                                    }),
                                            );
                                    },
                                },
                                {
                                    id: "previous",
                                    label: "Previous",
                                    icon: <FaStepBackward size={18} />,
                                    active: false,
                                    onActivate: () => {
                                        if (isLoggedIn)
                                            sendCommand("skip_prev");
                                    },
                                },
                                {
                                    id: "play-pause",
                                    label: isPlaying ? "Pause" : "Play",
                                    icon: isPlaying ? (
                                        <FaPause size={20} />
                                    ) : (
                                        <FaPlay size={20} />
                                    ),
                                    active: false,
                                    preferredFocus: true,
                                    onActivate: () => {
                                        if (isLoggedIn)
                                            predictPlaybackValue(
                                                "playing",
                                                !isPlaying,
                                                () =>
                                                    sendCommand(
                                                        isPlaying
                                                            ? "pause"
                                                            : "play",
                                                    ),
                                            );
                                    },
                                },
                                {
                                    id: "next",
                                    label: "Next",
                                    icon: <FaStepForward size={18} />,
                                    active: false,
                                    onActivate: () => {
                                        if (isLoggedIn)
                                            sendCommand("skip_next");
                                    },
                                },
                                {
                                    id: "loop",
                                    label:
                                        repeatMode === "track"
                                            ? "Loop 1"
                                            : repeatMode === "context"
                                              ? "Loop on"
                                              : "Loop off",
                                    icon: (
                                        <span
                                            style={{
                                                display: "inline-flex",
                                                alignItems: "center",
                                                gap: "2px",
                                            }}
                                        >
                                            <FaRedo size={18} />
                                            {repeatMode === "track" && (
                                                <span
                                                    style={{
                                                        fontSize: "10px",
                                                        fontWeight: "bold",
                                                    }}
                                                >
                                                    1
                                                </span>
                                            )}
                                        </span>
                                    ),
                                    active: repeatMode !== "off",
                                    onActivate: () => {
                                        if (!isLoggedIn) return;
                                        const nextMode =
                                            repeatMode === "off"
                                                ? "context"
                                                : repeatMode === "context"
                                                  ? "track"
                                                  : "off";
                                        predictPlaybackValue(
                                            "repeat",
                                            nextMode,
                                            () => {
                                                if (nextMode === "track") {
                                                    const contextSent =
                                                        sendCommand(
                                                            "set_repeat_context",
                                                            { enabled: false },
                                                        );
                                                    const trackSent =
                                                        sendCommand(
                                                            "set_repeat_track",
                                                            { enabled: true },
                                                        );
                                                    return (
                                                        contextSent && trackSent
                                                    );
                                                }
                                                const trackSent = sendCommand(
                                                    "set_repeat_track",
                                                    { enabled: false },
                                                );
                                                const contextSent = sendCommand(
                                                    "set_repeat_context",
                                                    {
                                                        enabled:
                                                            nextMode ===
                                                            "context",
                                                    },
                                                );
                                                return trackSent && contextSent;
                                            },
                                        );
                                    },
                                },
                            ].map((control) => (
                                <ActionControl
                                    key={control.id}
                                    id={control.id}
                                    label={control.label}
                                    icon={control.icon}
                                    focused={focusedAction === control.id}
                                    active={control.active}
                                    preferredFocus={control.preferredFocus}
                                    onFocusChange={(focused) =>
                                        setFocusedAction((current) =>
                                            focused
                                                ? control.id
                                                : current === control.id
                                                  ? null
                                                  : current,
                                        )
                                    }
                                    onActivate={control.onActivate}
                                />
                            ))}
                        </Focusable>
                    </PanelSectionRow>
                    {controlError && (
                        <PanelSectionRow>
                            <div
                                role="alert"
                                style={{
                                    width: "100%",
                                    boxSizing: "border-box",
                                    borderRadius: "4px",
                                    backgroundColor: "rgba(255, 91, 91, 0.1)",
                                    color: "var(--gpColor-Red)",
                                    fontSize: "13px",
                                    lineHeight: 1.4,
                                    padding: "8px 12px",
                                }}
                            >
                                {controlError}
                            </div>
                        </PanelSectionRow>
                    )}
                    <QueueSection
                        isDjPlayback={isDjPlayback}
                        repeatMode={repeatMode}
                        promotingEntry={promotingEntry}
                        promotingUri={promotingUri}
                        upcoming={upcoming}
                        canDisplayTrack={canDisplayTrack}
                        onOpenTrackContextMenu={openTrackContextMenu}
                    />
                    <PanelSectionRow>
                        <ButtonItem
                            layout="below"
                            onClick={() => openSpotifyLibrary()}
                        >
                            Browse Library
                        </ButtonItem>
                    </PanelSectionRow>
                    <PanelSectionRow>
                        <SliderField
                            label={`Volume ${volume}%`}
                            value={volume}
                            min={0}
                            max={100}
                            step={1}
                            showValue={false}
                            disabled={!isLoggedIn}
                            onChange={handleVolumeChange}
                        />
                    </PanelSectionRow>
                    <PanelSectionRow>
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                width: "100%",
                                color: "var(--gpColor-Grey)",
                                fontSize: "12px",
                                lineHeight: 1.4,
                                padding: "8px 0",
                                borderTop:
                                    "1px solid var(--gpSystem-Separator)",
                            }}
                        >
                            {connectionStatus === "Connected to Soloist" ? (
                                <FaCheckCircle
                                    aria-hidden="true"
                                    color="var(--gpColor-Green)"
                                />
                            ) : (
                                <FaCircle
                                    aria-hidden="true"
                                    color="var(--gpColor-Grey)"
                                    size={10}
                                />
                            )}
                            <span>{connectionStatus}</span>
                        </div>
                    </PanelSectionRow>
                </PanelSection>
            </div>
        </>
    );
}
