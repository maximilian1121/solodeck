import { Field, type GamepadEvent } from "@decky/ui";
import { useEffect, useRef, useState, type CSSProperties } from "react";

type TrackCover = {
    url: string;
    size?: string;
};

export type TrackItem = {
    uri?: string;
    name?: string;
    entity_type?: string;
    decorations?: {
        identity?: {
            name?: string;
            uri?: string;
        };
        visual_identity?: {
            cover?: TrackCover[];
        };
        playback?: {
            duration_ms?: number;
        };
        creators?: {
            entity?: {
                uri?: string;
                decorations?: {
                    identity?: {
                        name?: string;
                        uri?: string;
                    };
                };
            };
        }[];
        parent?: {
            entity?: {
                uri?: string;
                decorations?: {
                    identity?: {
                        name?: string;
                        uri?: string;
                    };
                };
            };
        };
    };
};

function OverflowMarquee({
    text,
    style,
}: {
    text: string;
    style?: CSSProperties;
}) {
    const containerRef = useRef<HTMLDivElement>(null);
    const textRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const container = containerRef.current;
        const content = textRef.current;
        if (!container || !content) return;

        let animation: Animation | undefined;
        const updateAnimation = () => {
            animation?.cancel();
            animation = undefined;

            const distance = content.scrollWidth - container.clientWidth;
            if (distance <= 1) return;

            const travelDuration = (distance / 32) * 1000;
            const pauseDuration = 1000;
            const cycleDuration = 2 * travelDuration + 2 * pauseDuration;
            animation = content.animate(
                [
                    { transform: "translateX(0)", offset: 0 },
                    {
                        transform: "translateX(0)",
                        offset: pauseDuration / cycleDuration,
                        easing: "ease-in-out",
                    },
                    {
                        transform: `translateX(-${distance}px)`,
                        offset: (travelDuration + pauseDuration) / cycleDuration,
                    },
                    {
                        transform: `translateX(-${distance}px)`,
                        offset:
                            (travelDuration + 2 * pauseDuration) /
                            cycleDuration,
                        easing: "ease-in-out",
                    },
                    { transform: "translateX(0)", offset: 1 },
                ],
                {
                    duration: cycleDuration,
                    easing: "linear",
                    iterations: Infinity,
                },
            );
        };

        updateAnimation();
        let resizeTimer: number | undefined;
        const observer = new ResizeObserver(() => {
            if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
            resizeTimer = window.setTimeout(updateAnimation, 250);
        });
        observer.observe(container);
        observer.observe(content);

        return () => {
            observer.disconnect();
            if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
            animation?.cancel();
        };
    }, [text]);

    return (
        <div
            ref={containerRef}
            style={{
                minWidth: 0,
                overflow: "hidden",
                width: "100%",
                ...style,
            }}
        >
            <div
                ref={textRef}
                style={{ display: "inline-block", whiteSpace: "nowrap" }}
            >
                {text}
            </div>
        </div>
    );
}

function getLargestCoverUrl(item: TrackItem): string {
    const sizes = ["small", "default", "large", "xlarge"];
    const covers = item.decorations?.visual_identity?.cover ?? [];
    return (
        [...covers].sort(
            (left, right) =>
                sizes.indexOf(right.size ?? "") -
                sizes.indexOf(left.size ?? ""),
        )[0]?.url ?? ""
    );
}

export default function TrackDetailsFocusable({
    item,
    subtitle,
    mode = "tall",
    animateIn = false,
    promoting = false,
    onSecondaryButton,
}: {
    item: TrackItem;
    subtitle?: string;
    mode?: "small" | "tall";
    animateIn?: boolean;
    promoting?: boolean;
    onSecondaryButton?: (event: GamepadEvent) => void;
}) {
    const [focused, setFocused] = useState(false);
    const contentRef = useRef<HTMLDivElement>(null);
    const coverRef = useRef<HTMLImageElement>(null);
    const subtitleRef = useRef<HTMLDivElement>(null);
    const progress = mode === "tall" || focused ? 1 : 0;
    const minHeight = 2.375 + 2.375 * progress;
    const verticalPadding = 2 + 6 * progress;
    const coverSize = 2 + 2 * progress;
    const queueRow = mode === "small";
    const queueContentHeight = 2.375 + 2.375 * progress;
    const providedTitle = (
        item.decorations?.identity?.name ??
        item.name ??
        ""
    )
        .replace(/\s*\(?spotify:track:[^\s)]+\)?\s*$/i, "")
        .trim();
    const uriId = item.uri?.trim().split(":").pop();
    const entityLabel =
        item.entity_type === "track"
            ? "Track"
            : item.entity_type === "episode"
              ? "Episode"
              : item.entity_type
                ? item.entity_type.charAt(0).toUpperCase() +
                  item.entity_type.slice(1)
                : "Item";
    const title =
        providedTitle ||
        (uriId && uriId !== item.uri ? `${entityLabel} ${uriId}` : entityLabel);
    const coverUrl = getLargestCoverUrl(item);
    const creators =
        item.decorations?.creators
            ?.map((creator) => creator.entity?.decorations?.identity?.name)
            .filter((name): name is string => Boolean(name))
            .join(", ") ?? "";

    useEffect(() => {
        if (!animateIn && !promoting) return;
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches)
            return;

        const content = contentRef.current;
        const cover = coverRef.current;
        const artist = subtitleRef.current;
        if (!content) return;

        const animations: Animation[] = [];
        if (promoting) {
            animations.push(
                content.animate(
                    [
                        { transform: "translateY(0) scale(1)", opacity: 1 },
                        {
                            transform: "translateY(-56px) scale(0.82)",
                            opacity: 0,
                        },
                    ],
                    { duration: 460, easing: "cubic-bezier(0.2, 0.75, 0.25, 1)" },
                ),
            );
            if (cover) {
                animations.push(
                    cover.animate(
                        [{ transform: "scale(1)" }, { transform: "scale(0.72)" }],
                        {
                            duration: 460,
                            easing: "cubic-bezier(0.2, 0.75, 0.25, 1)",
                        },
                    ),
                );
            }
            if (artist) {
                animations.push(
                    artist.animate([{ opacity: 1 }, { opacity: 0 }], {
                        duration: 180,
                        easing: "ease-out",
                    }),
                );
            }
        } else {
            animations.push(
                content.animate(
                    [
                        { transform: "translateY(36px) scale(0.94)", opacity: 0 },
                        { transform: "translateY(0) scale(1)", opacity: 1 },
                    ],
                    {
                        duration: 480,
                        easing: "cubic-bezier(0.2, 0.75, 0.25, 1)",
                    },
                ),
            );
            if (cover) {
                animations.push(
                    cover.animate(
                        [{ transform: "scale(0.68)" }, { transform: "scale(1)" }],
                        {
                            duration: 520,
                            easing: "cubic-bezier(0.2, 0.75, 0.25, 1)",
                        },
                    ),
                );
            }
            if (artist) {
                animations.push(
                    artist.animate([{ opacity: 0 }, { opacity: 1 }], {
                        delay: 160,
                        duration: 360,
                        easing: "ease-out",
                    }),
                );
            }
        }

        return () => animations.forEach((animation) => animation.cancel());
    }, [animateIn, promoting, item.uri]);

    return (
        <Field
            focusable
            highlightOnFocus
            padding="none"
            childrenLayout="below"
            spacingBetweenLabelAndChild="none"
            onGamepadFocus={() => setFocused(true)}
            onGamepadBlur={() => setFocused(false)}
            onSecondaryButton={onSecondaryButton}
            onSecondaryActionDescription={
                onSecondaryButton ? "Options" : undefined
            }
        >
            <div
                style={{
                    width: "100%",
                    height: queueRow
                        ? `${focused ? 4.75 : 2.375}rem`
                        : undefined,
                    minHeight: queueRow
                        ? `${focused ? 4.75 : 2.375}rem`
                        : `${minHeight}rem`,
                    display: "flex",
                    alignItems: "center",
                    overflow: "hidden",
                    transition: queueRow
                        ? "height 220ms ease, min-height 220ms ease"
                        : undefined,
                }}
            >
                <div
                    ref={contentRef}
                    style={{
                        display: "flex",
                        flexDirection: "row",
                        gap: "8px",
                        alignItems: progress < 1 ? "center" : "flex-start",
                        boxSizing: "border-box",
                        height: queueRow
                            ? `${queueContentHeight}rem`
                            : undefined,
                        minHeight: queueRow ? undefined : `${minHeight}rem`,
                        minWidth: 0,
                        padding: `${verticalPadding}px 8px`,
                        overflow: "hidden",
                        width: "100%",
                        transition:
                            "height 220ms ease, padding 220ms ease",
                    }}
                >
                    {coverUrl && (
                        <img
                            ref={coverRef}
                            style={{
                                width: `${coverSize}rem`,
                                height: `${coverSize}rem`,
                                borderRadius: "2px",
                                objectFit: "cover",
                                flexShrink: 0,
                                transition: "width 220ms ease, height 220ms ease",
                            }}
                            src={coverUrl}
                            alt=""
                        />
                    )}
                    <span
                        style={{
                            display: "flex",
                            flex: "1 1 0%",
                            flexDirection: "column",
                            justifyContent: "flex-start",
                            minWidth: 0,
                        }}
                    >
                        <OverflowMarquee
                            text={title}
                            style={{ fontWeight: "bold" }}
                        />
                        {(subtitle || creators) && (
                            <div
                                ref={subtitleRef}
                                style={{
                                    overflow: "hidden",
                                    transition: "max-height 220ms ease",
                                    maxHeight: `${1.5 * progress}em`,
                                }}
                            >
                                <OverflowMarquee
                                    text={subtitle ?? creators}
                                    style={{
                                        opacity: progress,
                                        maxHeight: `${1.5 * progress}em`,
                                        transform: `translateY(${(progress - 1) * 100}%)`,
                                        fontStyle: "italic",
                                        fontSize: "0.9rem",
                                        fontWeight: "normal",
                                        transition:
                                            "opacity 220ms ease, transform 220ms ease",
                                    }}
                                />
                            </div>
                        )}
                    </span>
                </div>
            </div>
        </Field>
    );
}
