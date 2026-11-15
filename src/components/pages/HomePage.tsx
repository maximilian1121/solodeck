import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getSpotifyLyrics, getTrackMetadata, type SpotifyLyrics } from "../../api";
import {
    getPlaybackProgressSnapshot,
    getPlaybackSnapshot,
    subscribePlaybackProgress,
    subscribePlaybackSnapshot,
} from "../playbackSnapshot";

function coverQuality(cover: { size?: string; width?: number; height?: number }) {
    if (cover.width && cover.height) return cover.width * cover.height;
    const size = (cover.size ?? "").toLowerCase();
    const namedSize: Record<string, number> = {
        small: 64,
        default: 300,
        large: 640,
        xlarge: 1280,
    };
    if (namedSize[size]) return namedSize[size] ** 2;
    const dimensions = size.match(/(\d{2,5})\s*[x×]\s*(\d{2,5})/);
    if (dimensions) return Number(dimensions[1]) * Number(dimensions[2]);
    const numericSize = Number(size.replace(/[^\d]/g, ""));
    return Number.isFinite(numericSize) && numericSize > 0 ? numericSize ** 2 : 0;
}

export default function HomePage() {
    const playback = useSyncExternalStore(
        subscribePlaybackSnapshot,
        getPlaybackSnapshot,
        getPlaybackSnapshot,
    );
    const progress = useSyncExternalStore(
        subscribePlaybackProgress,
        getPlaybackProgressSnapshot,
        getPlaybackProgressSnapshot,
    );
    const [lyrics, setLyrics] = useState<SpotifyLyrics | null>(null);
    const [loading, setLoading] = useState(false);
    const [positionMs, setPositionMs] = useState(progress.positionMs);
    const [coverColors, setCoverColors] = useState<[string, string]>(["#14251f", "#28203c"]);
    const [coverUpgrade, setCoverUpgrade] = useState<{ uri: string; url: string } | null>(null);
    const lyricsContainerRef = useRef<HTMLElement>(null);
    const activeLineRef = useRef<HTMLDivElement>(null);
    const uri = playback.currentTrackUri;
    const track = playback.currentTrack;
    const title = track?.decorations?.identity?.name ?? track?.name ?? "";
    const artists = (track?.decorations?.creators ?? [])
        .map((creator) => creator.entity?.decorations?.identity?.name?.trim())
        .filter((name): name is string => Boolean(name));
    const covers = track?.decorations?.visual_identity?.cover ?? [];
    const selectedCover = covers.length
        ? covers
              .map((cover, index) => ({ cover, index, quality: coverQuality(cover) }))
              .sort((a, b) => a.quality - b.quality || a.index - b.index)
              .at(-1)?.cover.url
        : undefined;
    const coverUrl = uri && coverUpgrade?.uri === uri ? coverUpgrade.url : selectedCover;

    useEffect(() => {
        let active = true;
        setCoverUpgrade(null);
        if (!uri || coverQuality(covers.find((cover) => cover.url === selectedCover) ?? {}) >= 640 * 640) {
            return () => { active = false; };
        }
        // Soloist's immediate playback update can contain only a thumbnail.
        // Enrich just the artwork in the background; track details render at once.
        getTrackMetadata(uri)
            .then((item) => {
                const bestCover = item?.decorations?.visual_identity?.cover?.[0]?.url;
                if (active && bestCover) setCoverUpgrade({ uri, url: bestCover });
            })
            .catch((error: unknown) => {
                console.warn("solodeck: could not load high-resolution cover art", error);
            });
        return () => { active = false; };
    }, [uri, selectedCover]);

    useEffect(() => {
        if (!coverUrl) return;
        setCoverColors(["#14251f", "#28203c"]);
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => {
            try {
                const canvas = document.createElement("canvas");
                canvas.width = 24;
                canvas.height = 24;
                const context = canvas.getContext("2d", { willReadFrequently: true });
                if (!context) return;
                context.drawImage(image, 0, 0, 24, 24);
                const pixels = context.getImageData(0, 0, 24, 24).data;
                const buckets = new Map<string, { count: number; r: number; g: number; b: number; saturation: number }>();
                for (let i = 0; i < pixels.length; i += 4) {
                    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
                    if (a < 180) continue;
                    const max = Math.max(r, g, b), min = Math.min(r, g, b);
                    const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
                    const current = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0, saturation: 0 };
                    current.count += 1;
                    current.r += r; current.g += g; current.b += b;
                    current.saturation += max ? (max - min) / max : 0;
                    buckets.set(key, current);
                }
                const prominence = (color: (typeof buckets extends Map<string, infer T> ? T : never)) =>
                    color.count * (0.55 + color.saturation / Math.max(1, color.count));
                const candidates = [...buckets.values()].sort((a, b) => prominence(b) - prominence(a));
                const darkColor = (color: (typeof candidates)[number]) => {
                    const factor = Math.min(0.58, 52 / Math.max(1, 0.2126 * color.r / color.count + 0.7152 * color.g / color.count + 0.0722 * color.b / color.count));
                    return `#${[color.r, color.g, color.b].map((channel) => Math.round(channel / color.count * factor).toString(16).padStart(2, "0")).join("")}`;
                };
                if (candidates.length) {
                    const first = candidates[0];
                    const average = (color: (typeof candidates)[number]) => [
                        color.r / color.count,
                        color.g / color.count,
                        color.b / color.count,
                    ];
                    const firstRgb = average(first);
                    const second = candidates.find((candidate) => {
                        if (candidate === first) return false;
                        const rgb = average(candidate);
                        const distance = Math.hypot(
                            firstRgb[0] - rgb[0],
                            firstRgb[1] - rgb[1],
                            firstRgb[2] - rgb[2],
                        );
                        return distance >= 72;
                    }) ?? candidates[1] ?? first;
                    setCoverColors([darkColor(first), darkColor(second)]);
                }
            } catch {
                // If the CDN doesn't permit canvas sampling, keep the legible fallback colors.
            }
        };
        image.src = coverUrl;
    }, [coverUrl]);

    useEffect(() => {
        const elapsed = progress.isPlaying
            ? Math.max(0, Date.now() - progress.timestampMs)
            : 0;
        setPositionMs(
            Math.min(
                progress.durationMs || Number.MAX_SAFE_INTEGER,
                progress.positionMs + elapsed,
            ),
        );
    }, [progress]);

    useEffect(() => {
        let active = true;
        if (!uri) {
            setLyrics(null);
            setLoading(false);
            return () => { active = false; };
        }
        setLyrics(null);
        setLoading(true);
        getSpotifyLyrics(uri)
            .then((result) => {
                if (active) setLyrics(result.ok ? result : null);
            })
            .catch((error: unknown) => {
                console.warn("solodeck: could not load track lyrics", error);
                if (active) setLyrics(null);
            })
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => { active = false; };
    }, [uri]);

    const activeIndex = useMemo(() => {
        const lines = lyrics?.lines ?? [];
        if (lyrics?.sync_type !== "LINE_SYNCED") return -1;
        let found = -1;
        for (let index = 0; index < lines.length; index += 1) {
            if (lines[index].start_time_ms <= positionMs) found = index;
            else break;
        }
        return found;
    }, [lyrics, positionMs]);

    useEffect(() => {
        const container = lyricsContainerRef.current;
        const line = activeLineRef.current;
        if (!container || !line) return;
        const containerRect = container.getBoundingClientRect();
        const lineRect = line.getBoundingClientRect();
        const top = container.scrollTop + lineRect.top - containerRect.top - container.clientHeight / 2 + line.clientHeight / 2;
        container.scrollTo({ top, behavior: "smooth" });
    }, [activeIndex]);

    const visibleLines = lyrics?.lines ?? [];
    const isSynced = lyrics?.sync_type === "LINE_SYNCED";

    return (
        <main
            aria-label="Solodeck home"
            style={{
                boxSizing: "border-box",
                width: "100%",
                height: "100%",
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                padding: "18px 20px 24px",
                overflow: "hidden",
            }}
        >
            <header style={{ flex: "0 0 auto", paddingBottom: "14px" }}>
                <h1 style={{ margin: 0, fontSize: "36px", lineHeight: 1.1, fontWeight: 700 }}>solodeck</h1>
            </header>
            <div style={{ display: "flex", flex: "1 1 auto", minHeight: 0, minWidth: 0, gap: "24px" }}>
            <section aria-label="Now playing" style={{ width: "34%", minWidth: "180px", maxWidth: "340px", flex: "0 1 34%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", gap: "14px", padding: "8px" }}>
                <div style={{ width: "100%", aspectRatio: "1", maxHeight: "min(42vh, 340px)", borderRadius: "10px", overflow: "hidden", background: "rgba(255,255,255,0.08)", boxShadow: "0 10px 32px rgba(0,0,0,0.35)" }}>
                    {coverUrl ? <img src={coverUrl} alt="" decoding="async" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
                </div>
                <div style={{ width: "100%", minWidth: 0 }}>
                    <div style={{ fontSize: "22px", lineHeight: 1.2, fontWeight: 700, overflowWrap: "anywhere" }}>{title || (uri ? "Loading track…" : "Nothing is playing")}</div>
                    {artists.length > 0 && <div style={{ paddingTop: "7px", color: "var(--gpColor-Grey)", fontSize: "16px", lineHeight: 1.35, overflowWrap: "anywhere" }}>{artists.join(", ")}</div>}
                </div>
            </section>
            <section
                ref={lyricsContainerRef}
                aria-label="Lyrics"
                aria-live="polite"
                onWheel={(event) => event.preventDefault()}
                onTouchMove={(event) => event.preventDefault()}
                style={{
                    flex: "1 1 auto",
                    minWidth: 0,
                    minHeight: 0,
                    overflowY: "hidden",
                    overscrollBehavior: "none",
                    touchAction: "none",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: visibleLines.length ? "flex-start" : "center",
                    gap: "16px",
                    padding: "22px 24px",
                    borderRadius: "14px",
                    background: `linear-gradient(135deg, ${coverColors[0]} 0%, ${coverColors[1]} 100%)`,
                    boxShadow: "inset 0 1px rgba(255,255,255,0.12), 0 12px 36px rgba(0,0,0,0.28)",
                    maskImage: visibleLines.length ? "linear-gradient(transparent, black 9%, black 91%, transparent)" : undefined,
                }}
            >
                {loading ? (
                    <p style={{ color: "var(--gpColor-Grey)", fontSize: "20px", textAlign: "center" }}>Loading lyrics…</p>
                ) : visibleLines.length ? (
                    <>
                    <div aria-hidden="true" style={{ flex: "0 0 max(0px, calc(50% - 64px))" }} />
                    {visibleLines.map((line, index) => (
                        <div
                            key={`${line.start_time_ms}-${index}`}
                            ref={index === activeIndex ? activeLineRef : undefined}
                            style={{
                                textAlign: "center",
                                fontSize: "22px",
                                lineHeight: 1.25,
                                fontWeight: 600,
                                color: "#fff",
                                opacity: !isSynced || activeIndex < 0 || Math.abs(index - activeIndex) <= 3 ? 1 : 0.32,
                                textShadow: index === activeIndex ? "0 0 4px rgba(255,255,255,0.32)" : "0 1px 5px rgba(0,0,0,0.28)",
                                background: "transparent",
                                borderRadius: "10px",
                                padding: "8px 12px",
                                filter: index === activeIndex ? "drop-shadow(0 0 4px rgba(255,255,255,0.22))" : "none",
                                transition: "opacity 220ms linear, filter 220ms linear",
                                overflowWrap: "anywhere",
                            }}
                        >
                            {line.words || "♪"}
                        </div>
                    ))}
                    <div aria-hidden="true" style={{ flex: "0 0 max(0px, calc(50% - 64px))" }} />
                    </>
                ) : (
                    <p style={{ color: "var(--gpColor-Grey)", fontSize: "20px", textAlign: "center", margin: 0 }}>
                        {uri ? "Lyrics aren’t available for this track." : "Play a track to see its lyrics."}
                    </p>
                )}
            </section>
            </div>
        </main>
    );
}
