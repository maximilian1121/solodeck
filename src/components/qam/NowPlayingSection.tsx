import { Focusable, PanelSectionRow, type GamepadEvent } from "@decky/ui";
import { FaVolumeUp } from "react-icons/fa";
import TrackDetailsFocusable, { type TrackItem } from "../TrackDetailsFocusable";

const quietMessageStyle = {
    width: "100%",
    boxSizing: "border-box" as const,
    color: "var(--gpColor-Grey)",
    fontSize: "13px",
    lineHeight: 1.4,
    padding: "8px 12px",
} as const;

export type NowPlayingSectionProps = {
    isDjPlayback: boolean;
    isLoggedIn: boolean;
    soloistDeviceName: string;
    soloistIsActive: boolean | null;
    deviceControlFocused: boolean;
    onActivateSoloist: () => void;
    onDeviceFocusChange: (focused: boolean) => void;
    trackDetails: TrackItem | null;
    canDisplayTrack: (item: TrackItem) => boolean;
    onTrackContextMenu: (event: GamepadEvent) => void;
};

export function NowPlayingSection({
    isDjPlayback,
    isLoggedIn,
    soloistDeviceName,
    soloistIsActive,
    deviceControlFocused,
    onActivateSoloist,
    onDeviceFocusChange,
    trackDetails,
    canDisplayTrack,
    onTrackContextMenu,
}: NowPlayingSectionProps) {
    return (
        <>
            <PanelSectionRow>
                <div style={{ width: "100%" }}>
                    <div
                        style={{
                            fontSize: "14px",
                            fontWeight: 600,
                            lineHeight: 1.3,
                            paddingBottom: "10px",
                        }}
                    >
                        Now Playing{isDjPlayback ? " • DJ" : ""}
                    </div>
                    {isLoggedIn && soloistDeviceName && (
                        <Focusable
                            onActivate={onActivateSoloist}
                            onFocus={() => onDeviceFocusChange(true)}
                            onBlur={() => onDeviceFocusChange(false)}
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
                <PanelSectionRow key={trackDetails.uri ?? "current-track"}>
                    <TrackDetailsFocusable
                        item={trackDetails}
                        animateIn
                        onSecondaryButton={onTrackContextMenu}
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
        </>
    );
}
