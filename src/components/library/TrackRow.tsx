import { Focusable } from "@decky/ui";
import type { ReactNode } from "react";

export type TrackRowProps = {
    title: string;
    artist: string;
    artwork: ReactNode;
    currentlyPlaying: boolean;
    onPlay: () => void;
    onOpenContextMenu: (event: CustomEvent) => void;
    onFocusRow: (element: HTMLElement) => void;
};

export function TrackRow({
    title,
    artist,
    artwork,
    currentlyPlaying,
    onPlay,
    onOpenContextMenu,
    onFocusRow,
}: TrackRowProps) {
    return (
        <Focusable
            onFocus={(event) => onFocusRow(event.currentTarget)}
            onSecondaryButton={onOpenContextMenu}
            onSecondaryActionDescription="Options"
            onActivate={onPlay}
            style={{ width: "100%" }}
        >
            <button
                type="button"
                tabIndex={-1}
                onClick={onPlay}
                onFocus={(event) => {
                    event.currentTarget.style.backgroundColor =
                        "rgba(255,255,255,0.12)";
                }}
                onBlur={(event) => {
                    event.currentTarget.style.backgroundColor = "transparent";
                }}
                style={{
                    display: "block",
                    width: "100%",
                    boxSizing: "border-box",
                    border: "0",
                    borderRadius: "4px",
                    padding: "2px 4px",
                    background: "transparent",
                    color: "inherit",
                    font: "inherit",
                    textAlign: "left",
                    cursor: "pointer",
                }}
            >
                <div style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%", minHeight: "38px", textAlign: "left" }}>
                    {artwork}
                    <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                            style={{
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                ...(currentlyPlaying ? { color: "#1DB954" } : {}),
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
}
