import { Focusable } from "@decky/ui";
import type { ReactNode, RefObject } from "react";
import type { SpotifyBrowseItem } from "../../api";

export type BrowseItemRowProps = {
    item: SpotifyBrowseItem;
    onClick: () => void;
    selected?: boolean;
    currentlyPlaying?: boolean;
    image: ReactNode;
    scrollRef?: RefObject<HTMLDivElement | null>;
    onFocusRow: (element: HTMLElement, scrollRef?: RefObject<HTMLDivElement | null>) => void;
};

export function BrowseItemRow({
    item,
    onClick,
    selected = false,
    currentlyPlaying = false,
    image,
    scrollRef,
    onFocusRow,
}: BrowseItemRowProps) {
    return (
        <Focusable
            onFocus={(event) => onFocusRow(event.currentTarget, scrollRef)}
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
                    display: "block",
                    width: "100%",
                    boxSizing: "border-box",
                    border: "0",
                    borderRadius: "4px",
                    padding: "2px 4px",
                    background: selected ? "rgba(255,255,255,0.08)" : "transparent",
                    color: "inherit",
                    font: "inherit",
                    textAlign: "left",
                    cursor: "pointer",
                }}
            >
                <div style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%", minWidth: 0, minHeight: "38px", textAlign: "left" }}>
                    {image}
                    <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                            style={{
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                fontWeight: selected ? 600 : 400,
                                ...(currentlyPlaying ? { color: "#1DB954" } : {}),
                            }}
                        >
                            {item.name}
                        </div>
                    </div>
                </div>
            </button>
        </Focusable>
    );
}
