import { useEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { getTrackMetadata } from "../../api";
import type { TrackItem } from "../TrackDetailsFocusable";
import { getObject, spotifyTrackAlbumUri } from "../playback";
import { updatePlaybackSnapshot } from "../playbackSnapshot";
import type { QueueEntry } from "./QueueSection";

const METADATA_CACHE_MAX_ENTRIES = 500;
const METADATA_CACHE_TTL_MS = 30 * 60_000;
const METADATA_CACHE_CLEANUP_INTERVAL_MS = 5 * 60_000;

type CachedTrackMetadata = {
    item: TrackItem;
    cachedAt: number;
};

type UseTrackMetadataOptions = {
    currentTrackUriRef: MutableRefObject<string | null>;
    upcomingRef: MutableRefObject<QueueEntry[]>;
    promotingUriRef: MutableRefObject<string | null>;
    durationRef: MutableRefObject<number>;
    setTrackDetails: Dispatch<SetStateAction<TrackItem | null>>;
    setUpcoming: Dispatch<SetStateAction<QueueEntry[]>>;
    setPromotingEntry: Dispatch<SetStateAction<QueueEntry | null>>;
    setDurationMs: Dispatch<SetStateAction<number>>;
};

export function useTrackMetadata({
    currentTrackUriRef,
    upcomingRef,
    promotingUriRef,
    durationRef,
    setTrackDetails,
    setUpcoming,
    setPromotingEntry,
    setDurationMs,
}: UseTrackMetadataOptions) {
    const metadataByUriRef = useRef(new Map<string, CachedTrackMetadata>());
    const metadataRequestsRef = useRef(
        new Map<string, Promise<TrackItem | null>>(),
    );
    const metadataRetryAtRef = useRef(new Map<string, number>());
    const metadataAttemptAtRef = useRef(new Map<string, number>());
    const [metadataTriedUris, setMetadataTriedUris] = useState<Set<string>>(
        () => new Set(),
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
                if (metadataByUriRef.current.size > METADATA_CACHE_MAX_ENTRIES) {
                    const oldestUri = metadataByUriRef.current.keys().next().value;
                    if (oldestUri) metadataByUriRef.current.delete(oldestUri);
                }
                metadataRetryAtRef.current.delete(uri);
                setTrackDetails((current) =>
                    current?.uri === uri && !hasUsefulTrackMetadata(current)
                        ? metadata
                        : current,
                );
                if (currentTrackUriRef.current === uri) {
                    updatePlaybackSnapshot({ currentTrack: metadata });
                }
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
                if (metadataRetryAtRef.current.size > METADATA_CACHE_MAX_ENTRIES) {
                    const oldestUri = metadataRetryAtRef.current.keys().next().value;
                    if (oldestUri) metadataRetryAtRef.current.delete(oldestUri);
                }
                console.warn(
                    `solodeck: Spotify metadata lookup failed for ${uri}`,
                    error,
                );
            })
            .then(() => {
                metadataAttemptAtRef.current.delete(uri);
                metadataAttemptAtRef.current.set(uri, Date.now());
                const evictedUris: string[] = [];
                while (metadataAttemptAtRef.current.size > METADATA_CACHE_MAX_ENTRIES) {
                    const oldestUri = metadataAttemptAtRef.current.keys().next().value;
                    if (!oldestUri) break;
                    metadataAttemptAtRef.current.delete(oldestUri);
                    evictedUris.push(oldestUri);
                }
                setMetadataTriedUris((current) => {
                    const next = new Set(current);
                    next.add(uri);
                    evictedUris.forEach((evictedUri) => next.delete(evictedUri));
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

    useEffect(() => {
        const cleanupMetadataCaches = () => {
            const now = Date.now();
            const activeUris = new Set<string>();
            if (currentTrackUriRef.current)
                activeUris.add(currentTrackUriRef.current);
            if (promotingUriRef.current) activeUris.add(promotingUriRef.current);
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

    const clearMetadataCaches = () => {
        metadataByUriRef.current.clear();
        metadataRetryAtRef.current.clear();
        metadataAttemptAtRef.current.clear();
        setMetadataTriedUris(new Set());
    };

    return {
        canDisplayTrack,
        withCachedMetadata,
        requestTrackMetadata,
        clearMetadataCaches,
    };
}
