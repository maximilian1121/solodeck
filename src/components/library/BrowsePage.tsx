import { Focusable } from "@decky/ui";
import { Fragment, type CSSProperties, type ReactNode } from "react";
import { FaSyncAlt } from "react-icons/fa";
import type { SpotifyBrowseItem, SpotifyContextTrack } from "../../api";
import { CompactCollectionBar } from "./CollectionHeader";
import { isSpotifyDj, quietMessageStyle } from "./explorerCache";

type BrowsePageProps = {
    item: SpotifyBrowseItem;
    collapsed: boolean;
    breadcrumbPath: SpotifyBrowseItem[];
    onSelectBreadcrumb: (item: SpotifyBrowseItem, index: number) => void;
    onFocusRow: (element: HTMLElement) => void;
    compactImage: ReactNode;
    header: ReactNode;
    tracks: SpotifyContextTrack[];
    albums: SpotifyBrowseItem[];
    albumsNextOffset: number | null;
    loadingMoreAlbums: boolean;
    contentLoading: boolean;
    contentError: string;
    playError: string;
    quotaActive: boolean;
    quotaRemainingSeconds: number;
    refreshCooldownSeconds: number;
    browseButtonStyle: CSSProperties;
    onRefresh: () => void;
    onLoadMoreAlbums: () => void;
    renderHeading: (label: string) => ReactNode;
    renderBrowseItem: (item: SpotifyBrowseItem) => ReactNode;
    renderTrack: (entry: SpotifyContextTrack, contextUri?: string) => ReactNode;
};

export default function BrowsePage({
    item,
    collapsed,
    breadcrumbPath,
    onSelectBreadcrumb,
    onFocusRow,
    compactImage,
    header,
    tracks,
    albums,
    albumsNextOffset,
    loadingMoreAlbums,
    contentLoading,
    contentError,
    playError,
    quotaActive,
    quotaRemainingSeconds,
    refreshCooldownSeconds,
    browseButtonStyle,
    onRefresh,
    onLoadMoreAlbums,
    renderHeading,
    renderBrowseItem,
    renderTrack,
}: BrowsePageProps) {
    const quotaDays = Math.floor(quotaRemainingSeconds / 86400);
    const quotaHours = Math.floor((quotaRemainingSeconds % 86400) / 3600);
    const quotaMinutes = Math.floor((quotaRemainingSeconds % 3600) / 60);
    const quotaSeconds = quotaRemainingSeconds % 60;
    const creatorLabel =
        (item.creators ?? []).map((creator) => creator.name).filter(Boolean).join(", ") ||
        tracks
            .map((track) =>
                track.item.decorations?.creators
                    ?.map((creator) => creator.entity?.decorations?.identity?.name?.trim())
                    .filter(Boolean)
                    .join(", ") ?? "",
            )
            .filter((name, index, names) => names.indexOf(name) === index)
            .join(", ") ||
        (item.entity_type === "album"
            ? "Album"
            : item.entity_type === "artist"
              ? "Artist"
              : "Playlist");
    const refreshDisabled = contentLoading || refreshCooldownSeconds > 0;

    return (
        <>
            {(item.entity_type === "playlist" ||
                item.entity_type === "album" ||
                item.entity_type === "artist") && (
                <CompactCollectionBar
                    item={item}
                    image={compactImage}
                    creatorLabel={creatorLabel}
                    visible={collapsed}
                />
            )}
            {breadcrumbPath.length > 1 && (
                <Focusable
                    flow-children="horizontal"
                    style={{
                        display: "flex",
                        flexWrap: "nowrap",
                        alignItems: "center",
                        gap: "4px",
                        marginBottom: "12px",
                        width: "100%",
                        overflow: "hidden",
                    }}
                >
                    {breadcrumbPath.map((crumb, index) => {
                        const isLast = index === breadcrumbPath.length - 1;
                        const goToCrumb = () => {
                            if (!isLast) onSelectBreadcrumb(crumb, index);
                        };
                        return (
                            <Fragment key={crumb.uri}>
                                {index > 0 && (
                                    <span
                                        style={{
                                            flex: "0 0 auto",
                                            color: "var(--gpColor-Grey)",
                                            fontSize: "12px",
                                        }}
                                    >
                                        /
                                    </span>
                                )}
                                <Focusable
                                    onActivate={goToCrumb}
                                    onFocus={(event) => {
                                        event.currentTarget.scrollIntoView({
                                            inline: "nearest",
                                            block: "nearest",
                                        });
                                        onFocusRow(event.currentTarget);
                                    }}
                                    style={{ flex: "0 0 auto" }}
                                >
                                    <button
                                        type="button"
                                        tabIndex={-1}
                                        onClick={goToCrumb}
                                        onFocus={(event) => {
                                            event.currentTarget.style.backgroundColor =
                                                "rgba(255,255,255,0.12)";
                                        }}
                                        onBlur={(event) => {
                                            event.currentTarget.style.backgroundColor =
                                                isLast
                                                    ? "rgba(255,255,255,0.08)"
                                                    : "transparent";
                                        }}
                                        style={{
                                            ...browseButtonStyle,
                                            width: "auto",
                                            maxWidth: "240px",
                                            padding: "4px 8px",
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                            fontWeight: isLast ? 600 : 400,
                                            background: isLast
                                                ? "rgba(255,255,255,0.08)"
                                                : "transparent",
                                        }}
                                    >
                                        {crumb.name}
                                    </button>
                                </Focusable>
                            </Fragment>
                        );
                    })}
                </Focusable>
            )}
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "14px",
                    width: "100%",
                }}
            >
                {header}
                {(item.entity_type === "playlist" ||
                    (item.entity_type === "album" && !isSpotifyDj(item))) && (
                    <Focusable
                        onActivate={() => {
                            if (!refreshDisabled) onRefresh();
                        }}
                        style={{ flex: "0 0 auto" }}
                    >
                        <button
                            type="button"
                            tabIndex={-1}
                            disabled={refreshDisabled}
                            onClick={() => {
                                if (!refreshDisabled) onRefresh();
                            }}
                            onFocus={(event) => {
                                event.currentTarget.style.backgroundColor =
                                    "rgba(255,255,255,0.12)";
                            }}
                            onBlur={(event) => {
                                event.currentTarget.style.backgroundColor =
                                    "transparent";
                            }}
                            style={{
                                ...browseButtonStyle,
                                width: "auto",
                                padding: "6px 12px",
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                whiteSpace: "nowrap",
                                cursor: refreshDisabled ? "default" : "pointer",
                                opacity: refreshDisabled ? 0.6 : 1,
                            }}
                        >
                            <FaSyncAlt aria-hidden="true" />
                            {contentLoading
                                ? "Refreshing..."
                                : refreshCooldownSeconds > 0
                                  ? `${refreshCooldownSeconds}s`
                                  : "Refresh"}
                        </button>
                    </Focusable>
                )}
            </div>
            {quotaActive && (
                <div
                    style={{
                        ...quietMessageStyle,
                        background: "var(--gpSystem-DarkGrey)",
                        borderRadius: "8px",
                        marginBottom: "12px",
                        textAlign: "center",
                    }}
                >
                    <div
                        style={{
                            fontSize: "15px",
                            fontWeight: 700,
                            marginBottom: "6px",
                        }}
                    >
                        Your WebAPI quota has exceeded!
                    </div>
                    <div
                        style={{
                            color: "var(--gpColor-Grey)",
                            fontSize: "13px",
                            lineHeight: 1.5,
                        }}
                    >
                        Please come back in {quotaDays}d {quotaHours}h {quotaMinutes}m and {quotaSeconds}sec.
                    </div>
                </div>
            )}
            {renderHeading(
                item.entity_type === "artist"
                    ? "Albums and singles"
                    : item.entity_type === "album"
                      ? "Tracks"
                      : "Playlist tracks",
            )}
            {contentError && (
                <div style={{ ...quietMessageStyle, color: "var(--gpColor-Red)" }}>
                    {contentError}
                </div>
            )}
            {playError && (
                <div style={{ ...quietMessageStyle, color: "var(--gpColor-Red)" }}>
                    {playError}
                </div>
            )}
            {albums.map((album) => renderBrowseItem(album))}
            {item.entity_type === "artist" && albumsNextOffset !== null && (
                <Focusable onActivate={onLoadMoreAlbums} style={{ width: "100%" }}>
                    <button
                        type="button"
                        tabIndex={-1}
                        disabled={loadingMoreAlbums}
                        onClick={onLoadMoreAlbums}
                        style={{
                            ...browseButtonStyle,
                            ...quietMessageStyle,
                            cursor: loadingMoreAlbums ? "default" : "pointer",
                        }}
                    >
                        {loadingMoreAlbums ? "Loading more albums..." : "Load more albums"}
                    </button>
                </Focusable>
            )}
            {tracks.map((track) =>
                renderTrack(
                    track,
                    item.entity_type === "playlist" || item.entity_type === "album"
                        ? item.uri
                        : undefined,
                ),
            )}
            {!contentLoading && !contentError && item.entity_type === "artist" && albums.length === 0 && (
                <div style={quietMessageStyle}>No albums or singles found.</div>
            )}
            {!contentLoading && !contentError && item.entity_type !== "artist" && tracks.length === 0 && (
                isSpotifyDj(item) ? (
                    <div
                        style={{
                            ...quietMessageStyle,
                            background: "var(--gpSystem-DarkGrey)",
                            borderRadius: "8px",
                            textAlign: "center",
                        }}
                    >
                        Unfortunately spotify does not expose any way to start DJ, if you want to use Spotify DJ please use any offical Spotify client.
                    </div>
                ) : (
                    <div style={quietMessageStyle}>No playable tracks found.</div>
                )
            )}
        </>
    );
}
