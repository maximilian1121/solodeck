import { PanelSectionRow, type GamepadEvent } from "@decky/ui";
import TrackDetailsFocusable, { type TrackItem } from "../TrackDetailsFocusable";

export type QueueEntry = {
    uid?: string;
    source?: string;
    item: TrackItem;
};

const quietMessageStyle = {
    width: "100%",
    boxSizing: "border-box" as const,
    color: "var(--gpColor-Grey)",
    fontSize: "13px",
    lineHeight: 1.4,
    padding: "8px 12px",
} as const;

export function QueueSection({
    isDjPlayback,
    repeatMode,
    promotingEntry,
    promotingUri,
    upcoming,
    canDisplayTrack,
    onOpenTrackContextMenu,
}: {
    isDjPlayback: boolean;
    repeatMode: string;
    promotingEntry: QueueEntry | null;
    promotingUri: string | null;
    upcoming: QueueEntry[];
    canDisplayTrack: (item: TrackItem) => boolean;
    onOpenTrackContextMenu: (item: TrackItem, event: GamepadEvent) => void;
}) {
    if (isDjPlayback || repeatMode === "track") return null;

    const visibleUpcoming = upcoming.filter((entry) =>
        canDisplayTrack(entry.item),
    );
    const visiblePromotingEntry =
        promotingEntry &&
        promotingUri === promotingEntry.item.uri &&
        canDisplayTrack(promotingEntry.item)
            ? promotingEntry
            : null;

    return (
        <>
            <PanelSectionRow>
                <div style={{ fontSize: "14px", fontWeight: 600, lineHeight: 1.3, paddingBottom: "10px" }}>
                    Up Next
                </div>
            </PanelSectionRow>
            {visiblePromotingEntry && (
                <PanelSectionRow
                    key={`promoting-${visiblePromotingEntry.uid ?? promotingUri}`}
                >
                    <TrackDetailsFocusable
                        item={visiblePromotingEntry.item}
                        mode="small"
                        promoting
                        onSecondaryButton={(event) =>
                            onOpenTrackContextMenu(visiblePromotingEntry.item, event)
                        }
                    />
                </PanelSectionRow>
            )}
            {visibleUpcoming.length > 0 || visiblePromotingEntry ? (
                visibleUpcoming.map((entry, index) => (
                    <PanelSectionRow
                        key={entry.uid ?? entry.item.uri ?? index}
                    >
                        <TrackDetailsFocusable
                            item={entry.item}
                            mode="small"
                            onSecondaryButton={(event) =>
                                onOpenTrackContextMenu(entry.item, event)
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
    );
}
