import { Focusable, TextField } from "@decky/ui";
import type { ReactNode } from "react";
import type { SpotifyBrowseItem, SpotifyContextTrack, SpotifySearchResults } from "../../api";
import { quietMessageStyle } from "./explorerCache";

type SearchTab = "all" | "tracks" | "albums" | "artists" | "playlists";

type SearchPanelProps = {
    searchText: string;
    onSearchTextChange: (value: string) => void;
    searchLoading: boolean;
    searchResults: SpotifySearchResults | null;
    activeTab: SearchTab;
    onShowTab: (tab: SearchTab) => void;
    onBrowseItem: (item: SpotifyBrowseItem) => void;
    renderBrowseButton: (item: SpotifyBrowseItem, onClick: () => void) => ReactNode;
    renderTrackButton: (entry: SpotifyContextTrack) => ReactNode;
};

export default function SearchPanel({
    searchText,
    onSearchTextChange,
    searchLoading,
    searchResults,
    activeTab,
    onShowTab,
    onBrowseItem,
    renderBrowseButton,
    renderTrackButton,
}: SearchPanelProps) {
    const status = (
        <>
            {searchLoading && <div style={quietMessageStyle}>Searching Spotify...</div>}
            {searchResults && !searchResults.ok && (
                <div style={{ ...quietMessageStyle, color: "var(--gpColor-Red)" }}>
                    {searchResults.error}
                </div>
            )}
        </>
    );
    const browseRows = (items: SpotifyBrowseItem[] | undefined) =>
        items?.map((item) => renderBrowseButton(item, () => onBrowseItem(item)));

    const tabs: { id: SearchTab; title: string }[] = [
        { id: "all", title: "All" },
        { id: "tracks", title: "Tracks" },
        { id: "albums", title: "Albums" },
        { id: "artists", title: "Artists" },
        { id: "playlists", title: "Playlists" },
    ];

    const tabContent: Record<SearchTab, ReactNode> = {
        all: <>
            {status}
            {searchResults?.tracks?.map((item, position) => renderTrackButton({ item, position }))}
            {browseRows([
                ...(searchResults?.playlists ?? []),
                ...(searchResults?.artists ?? []),
                ...(searchResults?.albums ?? []),
            ])}
        </>,
        tracks: <>{status}{searchResults?.tracks?.map((item, position) => renderTrackButton({ item, position }))}</>,
        albums: <>{status}{browseRows(searchResults?.albums)}</>,
        artists: <>{status}{browseRows(searchResults?.artists)}</>,
        playlists: <>{status}{browseRows(searchResults?.playlists)}</>,
    };

    return (
        <div style={{ height: "100%", minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <Focusable flow-children="vertical" style={{ flex: "0 0 auto", minHeight: 0 }}>
                <TextField
                    label="Search Spotify"
                    value={searchText}
                    onChange={(event) => onSearchTextChange(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            event.stopPropagation();
                        }
                    }}
                />
            </Focusable>
            <div role="tablist" aria-label="Search result types" style={{ display: "flex", flex: "0 0 auto", minWidth: 0, overflowX: "auto", overflowY: "hidden", gap: "4px", padding: "8px 0" }}>
                {tabs.map((tab) => {
                    const selected = activeTab === tab.id;
                    return (
                        <Focusable
                            key={tab.id}
                            role="tab"
                            aria-selected={selected}
                            onActivate={() => onShowTab(tab.id)}
                            style={{ flex: "0 0 auto", borderRadius: "4px", background: selected ? "rgba(255,255,255,0.14)" : "transparent", color: selected ? "#fff" : "var(--gpColor-Grey)", padding: "7px 12px", fontSize: "14px", fontWeight: selected ? 600 : 500 }}
                        >
                            {tab.title}
                        </Focusable>
                    );
                })}
            </div>
            <div
                role="tabpanel"
                aria-label={`${tabs.find((tab) => tab.id === activeTab)?.title ?? "All"} search results`}
                style={{ flex: "1 1 0", minHeight: 0, minWidth: 0, overflowY: "auto", overflowX: "hidden", overscrollBehavior: "contain", paddingBottom: "20px" }}
            >
                {searchResults?.ok && !searchLoading && !(
                    searchResults.tracks?.length ||
                    searchResults.playlists?.length ||
                    searchResults.albums?.length ||
                    searchResults.artists?.length
                ) && <div style={quietMessageStyle}>No results found. Try a different search.</div>}
                {tabContent[activeTab]}
            </div>
        </div>
    );
}
