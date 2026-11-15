import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import overlayImage from "../../overlay.png";
import { getTrackMetadata, type SpotifyLyrics } from "../../api";
import {
    getPlaybackProgressSnapshot,
    getPlaybackSnapshot,
    subscribePlaybackProgress,
    subscribePlaybackSnapshot,
} from "../playbackSnapshot";
import { coverQuality, getTrackPalette, largestCoverUrl, loadTrackLyrics, precacheTrack } from "./homePrecache";

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
    const [previousCoverColors, setPreviousCoverColors] = useState<[string, string] | null>(null);
    const [coverGradientVisible, setCoverGradientVisible] = useState(true);
    const [coverUpgrade, setCoverUpgrade] = useState<{ uri: string; url: string } | null>(null);
    const lyricsContainerRef = useRef<HTMLElement>(null);
    const activeLineRef = useRef<HTMLDivElement>(null);
    const coverColorsRef = useRef(coverColors);
    const coverFadeFrameRef = useRef<number | null>(null);
    const coverFadeTimerRef = useRef<number | null>(null);
    const uri = playback.currentTrackUri;
    const track = playback.currentTrack;
    const title = track?.decorations?.identity?.name ?? track?.name ?? "";
    const artists = (track?.decorations?.creators ?? [])
        .map((creator) => creator.entity?.decorations?.identity?.name?.trim())
        .filter((name): name is string => Boolean(name));
    const covers = track?.decorations?.visual_identity?.cover ?? [];
    const selectedCover = largestCoverUrl(track);
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
                const bestCover = largestCoverUrl(item);
                if (active && bestCover) setCoverUpgrade({ uri, url: bestCover });
            })
            .catch((error: unknown) => {
                console.warn("solodeck: could not load high-resolution cover art", error);
            });
        return () => { active = false; };
    }, [uri, selectedCover]);

    useEffect(() => {
        playback.upcomingTracks.slice(0, 2).forEach(precacheTrack);
    }, [playback.upcomingTracks]);

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
        loadTrackLyrics(uri)
            .then((result) => {
                if (active) setLyrics(result);
            })
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => { active = false; };
    }, [uri]);

    useEffect(() => {
        if (!uri || !coverUrl) return;
        let active = true;
        getTrackPalette(uri, coverUrl).then((palette) => {
            if (!active || palette[0] === coverColorsRef.current[0] && palette[1] === coverColorsRef.current[1]) return;
            if (coverFadeFrameRef.current !== null) window.cancelAnimationFrame(coverFadeFrameRef.current);
            if (coverFadeTimerRef.current !== null) window.clearTimeout(coverFadeTimerRef.current);
            setPreviousCoverColors(coverColorsRef.current);
            coverColorsRef.current = palette;
            setCoverColors(palette);
            setCoverGradientVisible(false);
            coverFadeFrameRef.current = window.requestAnimationFrame(() => {
                coverFadeFrameRef.current = null;
                setCoverGradientVisible(true);
            });
            coverFadeTimerRef.current = window.setTimeout(() => {
                coverFadeTimerRef.current = null;
                setPreviousCoverColors(null);
            }, 750);
        });
        return () => { active = false; };
    }, [uri, coverUrl]);

    useEffect(() => () => {
        if (coverFadeFrameRef.current !== null) window.cancelAnimationFrame(coverFadeFrameRef.current);
        if (coverFadeTimerRef.current !== null) window.clearTimeout(coverFadeTimerRef.current);
    }, []);

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
            <section aria-label="Now playing" style={{ boxSizing: "border-box", width: "34%", minWidth: "180px", maxWidth: "340px", flex: "0 1 34%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", gap: "14px", padding: 0 }}>
                <div style={{ width: "100%", aspectRatio: "1", maxHeight: "min(42vh, 340px)", borderRadius: "10px", overflow: "hidden", position: "relative", background: "rgba(255,255,255,0.08)", boxShadow: "0 10px 32px rgba(0,0,0,0.35)" }}>
                    {coverUrl && (
                        <>
                            <img src={coverUrl} alt="" decoding="async" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
                            <img src={overlayImage} alt="" aria-hidden="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", mixBlendMode: "multiply", pointerEvents: "none" }} />
                        </>
                    )}
                </div>
                <div style={{ width: "100%", minWidth: 0 }}>
                    <div style={{ fontSize: "22px", lineHeight: 1.2, fontWeight: 700, overflowWrap: "anywhere" }}>{title || (uri ? "Loading track…" : "Nothing is playing")}</div>
                    {artists.length > 0 && <div style={{ paddingTop: "7px", color: "var(--gpColor-Grey)", fontSize: "16px", lineHeight: 1.35, overflowWrap: "anywhere" }}>{artists.join(", ")}</div>}
                </div>
            </section>
            <div
                style={{
                    flex: "1 1 auto",
                    minWidth: 0,
                    minHeight: 0,
                    position: "relative",
                    overflow: "hidden",
                    borderRadius: "14px",
                    isolation: "isolate",
                    background: `linear-gradient(135deg, ${(previousCoverColors ?? coverColors)[0]} 0%, ${(previousCoverColors ?? coverColors)[1]} 100%)`,
                    boxShadow: "inset 0 1px rgba(255,255,255,0.12), 0 12px 36px rgba(0,0,0,0.28)",
                }}
            >
                <div
                    aria-hidden="true"
                    style={{
                        position: "absolute",
                        inset: 0,
                        zIndex: 0,
                        pointerEvents: "none",
                        borderRadius: "inherit",
                        background: `linear-gradient(135deg, ${coverColors[0]} 0%, ${coverColors[1]} 100%)`,
                        opacity: coverGradientVisible ? 1 : 0,
                        transition: "opacity 700ms linear",
                    }}
                />
                <section
                    ref={lyricsContainerRef}
                    aria-label="Lyrics"
                    aria-live="polite"
                    onWheel={(event) => event.preventDefault()}
                    onTouchMove={(event) => event.preventDefault()}
                    style={{
                        position: "absolute",
                        inset: 0,
                        boxSizing: "border-box",
                        overflowY: "hidden",
                        overscrollBehavior: "none",
                        touchAction: "none",
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: visibleLines.length ? "flex-start" : "center",
                        gap: "16px",
                        padding: "22px 24px",
                        borderRadius: "inherit",
                        background: "transparent",
                        maskImage: visibleLines.length ? "linear-gradient(transparent, black 9%, black 91%, transparent)" : undefined,
                    }}
                >
                <div style={{ position: "relative", zIndex: 1, display: "flex", flex: "1 1 auto", minHeight: 0, flexDirection: "column", justifyContent: visibleLines.length ? "flex-start" : "center", gap: "16px" }}>
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
                </div>
            </section>
            </div>
            </div>
        </main>
    );
}
