import {
    Field,
    Focusable,
    NavEntryPositionPreferences,
    PanelSection,
    PanelSectionRow,
    SliderField,
    ButtonItem,
    showModal,
    showContextMenu,
    staticClasses,
} from "@decky/ui";
import {
    getTrackMetadata,
    playWebApiTrackInContext,
    type SpotifyBrowseItem,
} from "../api";
import {
    FaCheckCircle,
    FaCircle,
    FaPause,
    FaPlay,
    FaRandom,
    FaRedo,
    FaStepBackward,
    FaStepForward,
    FaVolumeUp,
} from "react-icons/fa";
import { useEffect, useRef, useState, type ReactNode } from "react";
import TrackDetailsFocusable, { type TrackItem } from "./TrackDetailsFocusable";
import { updatePlaybackSnapshot } from "./playbackSnapshot";
import SpotifyLibraryModal, { TrackContextMenu } from "./SpotifyLibraryModal";

const SOLOIST_WS_URL = "ws://127.0.0.1:35797";
const STATE_REFRESH_INTERVAL_MS = 10_000;
const ACTION_SETTLE_TIMEOUT_MS = 1500;
const METADATA_CACHE_MAX_ENTRIES = 500;
const METADATA_CACHE_TTL_MS = 30 * 60_000;
const METADATA_CACHE_CLEANUP_INTERVAL_MS = 5 * 60_000;

type CachedTrackMetadata = {
    item: TrackItem;
    cachedAt: number;
};

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

type QueueEntry = {
    uid?: string;
    source?: string;
    item: TrackItem;
};

type PositionAnchor = {
    positionMs: number;
    timestampMs: number;
    speed: number;
};

type ActionControlProps = {
    id: string;
    label: string;
    icon: ReactNode;
    focused: boolean;
    active?: boolean;
    preferredFocus?: boolean;
    onFocusChange: (focused: boolean) => void;
    onActivate: () => void;
};

function ActionControl({
    id,
    label,
    icon,
    focused,
    active = false,
    preferredFocus = false,
    onFocusChange,
    onActivate,
}: ActionControlProps) {
    return (
        <div
            style={{
                boxSizing: "border-box",
                width: "48px",
                height: "48px",
                minWidth: "48px",
                minHeight: "48px",
                flex: "0 0 48px",
                padding: 0,
            }}
        >
            <Field
                key={id}
                focusable
                highlightOnFocus={false}
                preferredFocus={preferredFocus}
                padding="none"
                childrenLayout="below"
                spacingBetweenLabelAndChild="none"
                onGamepadFocus={() => onFocusChange(true)}
                onGamepadBlur={() => onFocusChange(false)}
                onClick={onActivate}
            >
                <div
                    role="img"
                    aria-label={label}
                    style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexDirection: "column",
                        gap: "3px",
                        boxSizing: "border-box",
                        width: "48px",
                        height: "48px",
                        borderRadius: "8px",
                        color: active ? "#1ed760" : "inherit",
                        background: focused
                            ? "rgba(255, 255, 255, 0.16)"
                            : "transparent",
                        outline: "none",
                    }}
                >
                    {icon}
                    {active && (
                        <span
                            aria-hidden="true"
                            style={{
                                background: "#1ed760",
                                borderRadius: "50%",
                                height: "4px",
                                width: "4px",
                            }}
                        />
                    )}
                </div>
            </Field>
        </div>
    );
}

function getObject(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object"
        ? (value as Record<string, unknown>)
        : null;
}

function isSpotifyDjContext(context: unknown): boolean {
    const contextObject = getObject(context);
    if (!contextObject) return false;

    const decorations = getObject(contextObject.decorations);
    const identity = getObject(decorations?.identity);
    const uri = typeof contextObject.uri === "string" ? contextObject.uri : "";
    const entityType =
        typeof contextObject.entity_type === "string"
            ? contextObject.entity_type
            : "";
    const name = typeof identity?.name === "string" ? identity.name.trim() : "";

    return (
        entityType.toLowerCase() === "dj" ||
        /^(?:spotify\s+)?dj$/i.test(name) ||
        /^spotify:dj(?::|$)/i.test(uri)
    );
}

function spotifyContextUri(context: unknown): string | null {
    const uri = getObject(context)?.uri;
    return typeof uri === "string" && uri.length > 0 ? uri : null;
}

function spotifyTrackAlbumUri(item: TrackItem | null): string | null {
    const uri = item?.decorations?.parent?.entity?.uri;
    return typeof uri === "string" && uri.length > 0 ? uri : null;
}

function formatTime(milliseconds: number): string {
    const totalSeconds = Math.floor(Math.max(0, milliseconds) / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function SmoothSeekSlider({
    positionMs,
    durationMs,
    onChange,
}: {
    positionMs: number;
    durationMs: number;
    onChange: (positionMs: number) => void;
}) {
    const [displayPosition, setDisplayPosition] = useState(positionMs);
    const [focused, setFocused] = useState(false);
    const displayPositionRef = useRef(positionMs);

    useEffect(() => {
        const start = displayPositionRef.current;
        const distance = positionMs - start;
        if (Math.abs(distance) < 1) return;

        if (focused) {
            displayPositionRef.current = positionMs;
            setDisplayPosition(positionMs);
            return;
        }

        const duration = 220;
        let frame = 0;
        let startTime: number | undefined;

        const animate = (now: number) => {
            startTime ??= now;
            const progress = Math.min(1, (now - startTime) / duration);
            const easedProgress =
                progress < 0.5
                    ? 4 * progress * progress * progress
                    : 1 - Math.pow(-2 * progress + 2, 3) / 2;
            const nextPosition = start + distance * easedProgress;
            displayPositionRef.current = nextPosition;
            setDisplayPosition(nextPosition);

            if (progress < 1) frame = window.requestAnimationFrame(animate);
        };

        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            displayPositionRef.current = positionMs;
            setDisplayPosition(positionMs);
        } else {
            frame = window.requestAnimationFrame(animate);
        }

        return () => window.cancelAnimationFrame(frame);
    }, [focused, positionMs]);

    const handleChange = (nextPositionMs: number) => {
        displayPositionRef.current = nextPositionMs;
        setDisplayPosition(nextPositionMs);
        onChange(nextPositionMs);
    };

    return (
        <div
            onFocusCapture={() => setFocused(true)}
            onBlurCapture={() => setFocused(false)}
        >
            <SliderField
                label={`${formatTime(displayPosition)} / ${formatTime(durationMs)}`}
                value={displayPosition}
                min={0}
                max={durationMs}
                step={1000}
                showValue={false}
                onChange={handleChange}
            />
        </div>
    );
}

export default function QamPanel() {
    const socketRef = useRef<WebSocket | null>(null);
    const pendingPlaybackRef = useRef<PendingPlaybackUpdates>({});
    const upcomingRef = useRef<QueueEntry[]>([]);
    const promotionTimerRef = useRef<number | undefined>(undefined);
    const promotingUriRef = useRef<string | null>(null);
    const metadataByUriRef = useRef(new Map<string, CachedTrackMetadata>());
    const metadataRequestsRef = useRef(
        new Map<string, Promise<TrackItem | null>>(),
    );
    const metadataRetryAtRef = useRef(new Map<string, number>());
    const metadataAttemptAtRef = useRef(new Map<string, number>());
    const positionAnchorRef = useRef<PositionAnchor | null>(null);
    const durationRef = useRef(0);
    const seekingRef = useRef(false);
    const seekTimeoutRef = useRef<number | undefined>(undefined);
    const volumeTimeoutRef = useRef<number | undefined>(undefined);
    const panelBodyRef = useRef<HTMLDivElement>(null);
    const currentTrackUriRef = useRef<string | null>(null);
    const [trackDetails, setTrackDetails] = useState<TrackItem | null>(null);
    const [upcoming, setUpcoming] = useState<QueueEntry[]>([]);
    const [metadataTriedUris, setMetadataTriedUris] = useState<Set<string>>(
        () => new Set(),
    );
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

    const hasUsefulTrackMetadata = (item: TrackItem): boolean => {
        const title = (
            item.decorations?.identity?.name ??
            item.name ??
            ""
        ).trim();
        const uriId = item.uri?.trim().split(":").pop();
        const fallbackLabel =
            /^(?:track|episode|item)\s+\S+$/i.test(title) &&
            (!uriId || title.toLowerCase() === `track ${uriId.toLowerCase()}`);
        return Boolean(
            title &&
            title.toLowerCase() !== "unknown" &&
            title !== item.uri &&
            !title.startsWith("spotify:") &&
            !fallbackLabel &&
            title !== uriId,
        );
    };

    const canDisplayTrack = (item: TrackItem): boolean =>
        hasUsefulTrackMetadata(item) ||
        Boolean(item.uri && metadataTriedUris.has(item.uri));

    const withCachedMetadata = (item: TrackItem): TrackItem =>
        metadataByUriRef.current.get(item.uri ?? "")?.item ?? item;

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

    const requestTrackMetadata = (item: TrackItem | null) => {
        const uri = item?.uri;
        if (!item || !uri || hasUsefulTrackMetadata(item)) return;

        if (metadataByUriRef.current.has(uri)) return;
        if (metadataRequestsRef.current.has(uri)) return;
        if ((metadataRetryAtRef.current.get(uri) ?? 0) > Date.now()) return;

        const request = getTrackMetadata(uri);
        metadataRequestsRef.current.set(uri, request);
        request
            .then((metadata) => {
                if (!metadata) return;
                metadataByUriRef.current.delete(uri);
                metadataByUriRef.current.set(uri, {
                    item: metadata,
                    cachedAt: Date.now(),
                });
                const albumUri = spotifyTrackAlbumUri(metadata);
                if (currentTrackUriRef.current === uri && albumUri) {
                    updatePlaybackSnapshot({
                        currentTrackAlbumUri: albumUri,
                    });
                }
                const metadataDuration = getObject(
                    getObject(metadata.decorations)?.playback,
                )?.duration_ms;
                if (
                    typeof metadataDuration === "number" &&
                    metadataDuration > 0 &&
                    currentTrackUriRef.current === uri
                ) {
                    durationRef.current = metadataDuration;
                    setDurationMs(metadataDuration);
                }
                if (
                    metadataByUriRef.current.size > METADATA_CACHE_MAX_ENTRIES
                ) {
                    const oldestUri = metadataByUriRef.current
                        .keys()
                        .next().value;
                    if (oldestUri) metadataByUriRef.current.delete(oldestUri);
                }
                metadataRetryAtRef.current.delete(uri);
                setTrackDetails((current) =>
                    current?.uri === uri && !hasUsefulTrackMetadata(current)
                        ? metadata
                        : current,
                );
                setPromotingEntry((current) =>
                    current?.item.uri === uri
                        ? { ...current, item: metadata }
                        : current,
                );
                setUpcoming((current) =>
                    current.map((entry) =>
                        entry.item.uri === uri &&
                        !hasUsefulTrackMetadata(entry.item)
                            ? { ...entry, item: metadata }
                            : entry,
                    ),
                );
            })
            .catch((error) => {
                metadataRetryAtRef.current.set(uri, Date.now() + 60_000);
                if (metadataRetryAtRef.current.size > 500) {
                    const oldestUri = metadataRetryAtRef.current
                        .keys()
                        .next().value;
                    if (oldestUri) metadataRetryAtRef.current.delete(oldestUri);
                }
                console.warn(
                    `solodeck: Web API metadata lookup failed for ${uri}`,
                    error,
                );
            })
            .then(() => {
                metadataAttemptAtRef.current.delete(uri);
                metadataAttemptAtRef.current.set(uri, Date.now());
                const evictedUris: string[] = [];
                while (
                    metadataAttemptAtRef.current.size >
                    METADATA_CACHE_MAX_ENTRIES
                ) {
                    const oldestUri = metadataAttemptAtRef.current
                        .keys()
                        .next().value;
                    if (!oldestUri) break;
                    metadataAttemptAtRef.current.delete(oldestUri);
                    evictedUris.push(oldestUri);
                }
                setMetadataTriedUris((current) => {
                    const next = new Set(current);
                    next.add(uri);
                    evictedUris.forEach((evictedUri) =>
                        next.delete(evictedUri),
                    );
                    while (next.size > METADATA_CACHE_MAX_ENTRIES) {
                        const oldestUri = next.values().next().value;
                        if (!oldestUri) break;
                        next.delete(oldestUri);
                    }
                    return next;
                });
            })
            .finally(() => {
                if (metadataRequestsRef.current.get(uri) === request)
                    metadataRequestsRef.current.delete(uri);
            });
    };

    const openSpotifyLibrary = (initialBrowseItem?: SpotifyBrowseItem) => {
        let modal: ReturnType<typeof showModal>;
        modal = showModal(
            <SpotifyLibraryModal
                closeModal={() => modal.Close()}
                initialBrowseItem={initialBrowseItem}
                onPlayTrack={async (item, contextUri, position) => {
                    if (contextUri && position !== undefined && item.uri) {
                        return playWebApiTrackInContext(
                            contextUri,
                            item.uri,
                            position,
                        );
                    }
                    if (!item.uri) {
                        return {
                            ok: false,
                            error: "This Spotify item cannot be played.",
                        };
                    }
                    return sendCommand("play", { uri: item.uri })
                        ? { ok: true }
                        : {
                              ok: false,
                              error: "Soloist connection is unavailable.",
                          };
                }}
            />,
            window,
            { strTitle: "solodeck", bNeverPopOut: true },
        );
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

    useEffect(() => {
        const cleanupMetadataCaches = () => {
            const now = Date.now();
            const activeUris = new Set<string>();
            if (currentTrackUriRef.current)
                activeUris.add(currentTrackUriRef.current);
            if (promotingUriRef.current)
                activeUris.add(promotingUriRef.current);
            upcomingRef.current.forEach((entry) => {
                if (entry.item.uri) activeUris.add(entry.item.uri);
            });

            for (const [uri, cached] of metadataByUriRef.current) {
                if (
                    !activeUris.has(uri) &&
                    now - cached.cachedAt > METADATA_CACHE_TTL_MS
                ) {
                    metadataByUriRef.current.delete(uri);
                }
            }

            for (const [uri, retryAt] of metadataRetryAtRef.current) {
                if (retryAt <= now) metadataRetryAtRef.current.delete(uri);
            }

            const expiredAttempts = new Set<string>();
            for (const [uri, attemptedAt] of metadataAttemptAtRef.current) {
                if (
                    !activeUris.has(uri) &&
                    now - attemptedAt > METADATA_CACHE_TTL_MS
                ) {
                    metadataAttemptAtRef.current.delete(uri);
                    expiredAttempts.add(uri);
                }
            }
            if (expiredAttempts.size > 0) {
                setMetadataTriedUris((current) => {
                    const next = new Set(current);
                    expiredAttempts.forEach((uri) => next.delete(uri));
                    return next;
                });
            }
        };

        const cleanupTimer = window.setInterval(
            cleanupMetadataCaches,
            METADATA_CACHE_CLEANUP_INTERVAL_MS,
        );
        return () => window.clearInterval(cleanupTimer);
    }, []);

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
        }, 250);
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
                        if (!requestedQueue) {
                            socket?.send(
                                JSON.stringify({
                                    type: "command",
                                    command: "get_queue",
                                    limit: 10,
                                }),
                            );
                            socket?.send(
                                JSON.stringify({
                                    type: "command",
                                    command: "get_state",
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
                        setMetadataTriedUris(new Set());
                        metadataByUriRef.current.clear();
                        metadataRetryAtRef.current.clear();
                        metadataAttemptAtRef.current.clear();
                        setPromotingUri(null);
                        setPromotingEntry(null);
                        promotingUriRef.current = null;
                        setIsDjPlayback(false);
                        updatePlaybackSnapshot({
                            currentTrackUri: null,
                            currentTrackAlbumUri: null,
                            contextUri: null,
                        });
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
                    <PanelSectionRow>
                        <div style={{ width: "100%" }}>
                            <div style={sectionHeadingStyle}>
                                Now Playing{isDjPlayback ? " • DJ" : ""}
                            </div>
                            {isLoggedIn && soloistDeviceName && (
                                <Focusable
                                    onActivate={handleActivateSoloist}
                                    onFocus={() =>
                                        setDeviceControlFocused(true)
                                    }
                                    onBlur={() =>
                                        setDeviceControlFocused(false)
                                    }
                                    style={{
                                        background: deviceControlFocused
                                            ? "rgba(255, 255, 255, 0.16)"
                                            : "transparent",
                                        borderRadius: "4px",
                                        display: "inline-flex",
                                        maxWidth: "100%",
                                        padding: "4px 6px",
                                        width: "fit-content",
                                    }}
                                >
                                    <div
                                        style={{
                                            alignItems: "center",
                                            color: "#1ed760",
                                            display: "flex",
                                            fontSize: "13px",
                                            gap: "6px",
                                            lineHeight: 1.3,
                                            width: "fit-content",
                                        }}
                                    >
                                        <FaVolumeUp aria-hidden="true" />
                                        <span>
                                            {soloistIsActive
                                                ? `Playing on ${soloistDeviceName}`
                                                : `Switch playback to ${soloistDeviceName}`}
                                        </span>
                                    </div>
                                </Focusable>
                            )}
                        </div>
                    </PanelSectionRow>
                    {trackDetails && canDisplayTrack(trackDetails) ? (
                        <PanelSectionRow
                            key={trackDetails.uri ?? "current-track"}
                        >
                            <TrackDetailsFocusable
                                item={trackDetails}
                                animateIn
                                onSecondaryButton={(event) =>
                                    openTrackContextMenu(trackDetails, event)
                                }
                            />
                        </PanelSectionRow>
                    ) : (
                        <PanelSectionRow>
                            <div style={quietMessageStyle}>
                                {trackDetails
                                    ? "Checking track details..."
                                    : "No track details available."}
                            </div>
                        </PanelSectionRow>
                    )}
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
                    {!isDjPlayback && repeatMode !== "track" && (
                        <>
                            <PanelSectionRow>
                                <div style={sectionHeadingStyle}>Up Next</div>
                            </PanelSectionRow>
                            {promotingEntry &&
                                promotingUri === promotingEntry.item.uri &&
                                canDisplayTrack(promotingEntry.item) && (
                                    <PanelSectionRow
                                        key={`promoting-${promotingEntry.uid ?? promotingUri}`}
                                    >
                                        <TrackDetailsFocusable
                                            item={promotingEntry.item}
                                            mode="small"
                                            promoting
                                            onSecondaryButton={(event) =>
                                                openTrackContextMenu(
                                                    promotingEntry.item,
                                                    event,
                                                )
                                            }
                                        />
                                    </PanelSectionRow>
                                )}
                            {upcoming.some((entry) =>
                                canDisplayTrack(entry.item),
                            ) ||
                            (promotingEntry &&
                                promotingUri === promotingEntry.item.uri &&
                                canDisplayTrack(promotingEntry.item)) ? (
                                upcoming
                                    .filter((entry) =>
                                        canDisplayTrack(entry.item),
                                    )
                                    .map((entry, index) => (
                                        <PanelSectionRow
                                            key={
                                                entry.uid ??
                                                entry.item.uri ??
                                                index
                                            }
                                        >
                                            <TrackDetailsFocusable
                                                item={entry.item}
                                                mode="small"
                                                onSecondaryButton={(event) =>
                                                    openTrackContextMenu(
                                                        entry.item,
                                                        event,
                                                    )
                                                }
                                            />
                                        </PanelSectionRow>
                                    ))
                            ) : (
                                <PanelSectionRow>
                                    <div style={quietMessageStyle}>
                                        {upcoming.length > 0
                                            ? "Checking track details..."
                                            : "Queue is empty."}
                                    </div>
                                </PanelSectionRow>
                            )}
                        </>
                    )}
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
