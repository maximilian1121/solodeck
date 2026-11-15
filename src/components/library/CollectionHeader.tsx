import { Focusable } from "@decky/ui";
import type { ReactNode, RefObject } from "react";
import type { SpotifyBrowseItem } from "../../api";

type CollectionHeaderProps = {
    item: SpotifyBrowseItem;
    artwork: ReactNode;
    headerRef: RefObject<HTMLDivElement | null>;
    onFocusRow: (element: HTMLElement) => void;
};

export function CollectionHeader({
    item,
    artwork,
    headerRef,
    onFocusRow,
}: CollectionHeaderProps) {
    return (
        <Focusable
            onFocus={(event) => onFocusRow(event.currentTarget)}
            style={{ width: "100%" }}
        >
            <div
                ref={headerRef}
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "14px",
                    paddingBottom: "16px",
                    width: "100%",
                }}
            >
                <Focusable
                    onFocus={(event) => onFocusRow(event.currentTarget)}
                    style={{ flex: "1 1 0", minWidth: 0 }}
                >
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "14px",
                        }}
                    >
                        {artwork}
                        <div style={{ minWidth: 0 }}>
                            <div
                                style={{
                                    fontSize: "20px",
                                    fontWeight: 600,
                                    overflowWrap: "anywhere",
                                }}
                            >
                                {item.name}
                            </div>
                            {item.entity_type !== "artist" && (
                                <div
                                    style={{
                                        color: "var(--gpColor-Grey)",
                                        fontSize: "13px",
                                        paddingTop: "3px",
                                    }}
                                >
                                    {item.entity_type === "album" ? "Album" : "Playlist"}
                                </div>
                            )}
                            {item.creators?.length ? (
                                <div
                                    style={{
                                        color: "var(--gpColor-Grey)",
                                        fontSize: "13px",
                                        paddingTop: "3px",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                    }}
                                >
                                    {item.creators
                                        .map((creator) => creator.name)
                                        .filter(Boolean)
                                        .join(", ")}
                                </div>
                            ) : null}
                        </div>
                    </div>
                </Focusable>
            </div>
        </Focusable>
    );
}

type CompactCollectionBarProps = {
    item: SpotifyBrowseItem;
    image: ReactNode;
    creatorLabel: string;
    visible: boolean;
};

export function CompactCollectionBar({
    item,
    image,
    creatorLabel,
    visible,
}: CompactCollectionBarProps) {
    return (
        <div
            aria-hidden={!visible}
            style={{
                position: "sticky",
                top: 0,
                zIndex: 5,
                height: 0,
                margin: "-4px -4px 0",
                pointerEvents: "none",
            }}
        >
            <div
                style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    height: "56px",
                    boxSizing: "border-box",
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    padding: "6px 8px",
                    background: "var(--gpSystem-Background, #171a21)",
                    borderBottom: "1px solid var(--gpSystem-Separator)",
                    overflow: "hidden",
                    opacity: visible ? 1 : 0,
                    transform: visible ? "translateY(0)" : "translateY(-8px)",
                    pointerEvents: visible ? "auto" : "none",
                    transition: "opacity 180ms ease, transform 220ms ease",
                }}
            >
                {image}
                <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                        style={{
                            fontWeight: 600,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                        }}
                    >
                        {item.name}
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
                        {creatorLabel}
                    </div>
                </div>
            </div>
        </div>
    );
}
