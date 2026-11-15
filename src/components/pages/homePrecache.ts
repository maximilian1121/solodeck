import { getSpotifyLyrics, getTrackMetadata, type SpotifyLyrics } from "../../api";
import type { TrackItem } from "../TrackDetailsFocusable";

export type CoverPalette = [string, string];

const DEFAULT_PALETTE: CoverPalette = ["#14251f", "#28203c"];
const lyricsCache = new Map<string, SpotifyLyrics | null>();
const lyricsRequests = new Map<string, Promise<SpotifyLyrics | null>>();
const paletteCache = new Map<string, CoverPalette>();
const paletteRequests = new Map<string, Promise<CoverPalette>>();
const artworkCache = new Map<string, string>();
const artworkRequests = new Map<string, Promise<string | null>>();

function remember<K, V>(cache: Map<K, V>, key: K, value: V, limit = 24) {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > limit) cache.delete(cache.keys().next().value as K);
}

export function coverQuality(cover: { size?: string; width?: number; height?: number }) {
    if (cover.width && cover.height) return cover.width * cover.height;
    const size = (cover.size ?? "").toLowerCase();
    const namedSize: Record<string, number> = { small: 64, default: 300, large: 640, xlarge: 1280 };
    if (namedSize[size]) return namedSize[size] ** 2;
    const dimensions = size.match(/(\d{2,5})\s*[x×]\s*(\d{2,5})/);
    if (dimensions) return Number(dimensions[1]) * Number(dimensions[2]);
    const numericSize = Number(size.replace(/[^\d]/g, ""));
    return Number.isFinite(numericSize) && numericSize > 0 ? numericSize ** 2 : 0;
}

export function largestCoverUrl(track: TrackItem | null | undefined) {
    const covers = track?.decorations?.visual_identity?.cover ?? [];
    return covers
        .map((cover, index) => ({ cover, index, quality: coverQuality(cover) }))
        .sort((a, b) => a.quality - b.quality || a.index - b.index)
        .at(-1)?.cover.url;
}

export function loadTrackLyrics(uri: string): Promise<SpotifyLyrics | null> {
    if (lyricsCache.has(uri)) return Promise.resolve(lyricsCache.get(uri) ?? null);
    const pending = lyricsRequests.get(uri);
    if (pending) return pending;
    const request = getSpotifyLyrics(uri)
        .then((result) => result.ok ? result : null)
        .catch((error: unknown) => {
            console.warn("solodeck: could not load track lyrics", error);
            return null;
        })
        .then((result) => {
            remember(lyricsCache, uri, result);
            return result;
        })
        .finally(() => lyricsRequests.delete(uri));
    lyricsRequests.set(uri, request);
    return request;
}

function darken(color: { count: number; r: number; g: number; b: number }) {
    const luminance = 0.2126 * color.r / color.count + 0.7152 * color.g / color.count + 0.0722 * color.b / color.count;
    const factor = Math.min(0.58, 52 / Math.max(1, luminance));
    return `#${[color.r, color.g, color.b].map((channel) => Math.round(channel / color.count * factor).toString(16).padStart(2, "0")).join("")}`;
}

function extractPalette(url: string): Promise<CoverPalette> {
    const cached = paletteCache.get(url);
    if (cached) return Promise.resolve(cached);
    const pending = paletteRequests.get(url);
    if (pending) return pending;

    const request = new Promise<CoverPalette>((resolve) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => {
            try {
                const canvas = document.createElement("canvas");
                canvas.width = 24;
                canvas.height = 24;
                const context = canvas.getContext("2d", { willReadFrequently: true });
                if (!context) return resolve(DEFAULT_PALETTE);
                context.drawImage(image, 0, 0, 24, 24);
                const pixels = context.getImageData(0, 0, 24, 24).data;
                const buckets = new Map<string, { count: number; r: number; g: number; b: number; saturation: number }>();
                for (let i = 0; i < pixels.length; i += 4) {
                    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
                    if (a < 180) continue;
                    const max = Math.max(r, g, b), min = Math.min(r, g, b);
                    const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
                    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0, saturation: 0 };
                    bucket.count += 1;
                    bucket.r += r; bucket.g += g; bucket.b += b;
                    bucket.saturation += max ? (max - min) / max : 0;
                    buckets.set(key, bucket);
                }
                const prominence = (color: { count: number; saturation: number }) =>
                    color.count * (0.55 + color.saturation / Math.max(1, color.count));
                const candidates = [...buckets.values()].sort((a, b) => prominence(b) - prominence(a));
                if (!candidates.length) return resolve(DEFAULT_PALETTE);
                const first = candidates[0];
                const rgb = (color: typeof first) => [color.r / color.count, color.g / color.count, color.b / color.count];
                const firstRgb = rgb(first);
                const second = candidates.find((candidate) => {
                    const secondRgb = rgb(candidate);
                    return Math.hypot(firstRgb[0] - secondRgb[0], firstRgb[1] - secondRgb[1], firstRgb[2] - secondRgb[2]) >= 72;
                }) ?? candidates[1] ?? first;
                resolve([darken(first), darken(second)]);
            } catch {
                resolve(DEFAULT_PALETTE);
            }
        };
        image.onerror = () => resolve(DEFAULT_PALETTE);
        image.src = url;
    }).then((palette) => {
        remember(paletteCache, url, palette);
        return palette;
    }).finally(() => paletteRequests.delete(url));
    paletteRequests.set(url, request);
    return request;
}

export function getTrackPalette(uri: string, url: string): Promise<CoverPalette> {
    const cachedArtwork = artworkCache.get(uri);
    return extractPalette(cachedArtwork ?? url);
}

export function precacheTrack(track: TrackItem) {
    const uri = track.uri;
    if (!uri) return;
    void loadTrackLyrics(uri);

    const initialUrl = largestCoverUrl(track);
    if (initialUrl) void extractPalette(initialUrl);
    if (artworkCache.has(uri) || artworkRequests.has(uri)) return;

    const initialCover = track.decorations?.visual_identity?.cover?.find((cover) => cover.url === initialUrl);
    if (initialUrl && initialCover && coverQuality(initialCover) >= 640 * 640) {
        remember(artworkCache, uri, initialUrl);
        return;
    }

    const request = getTrackMetadata(uri)
        .then((metadata) => {
            const bestUrl = largestCoverUrl(metadata) ?? initialUrl;
            if (bestUrl) {
                remember(artworkCache, uri, bestUrl);
                void extractPalette(bestUrl);
            }
            return bestUrl ?? null;
        })
        .catch((error: unknown) => {
            console.warn("solodeck: could not precache upcoming cover art", error);
            return initialUrl ?? null;
        })
        .finally(() => artworkRequests.delete(uri));
    artworkRequests.set(uri, request);
}
