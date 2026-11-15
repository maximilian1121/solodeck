import { useSyncExternalStore } from "react";
import { playSpotifyTrack, playWebApiTrackInContext } from "../api";
import type { TrackItem } from "./TrackDetailsFocusable";
import SpotifyLibraryPage from "./pages/SpotifyLibraryPage";
import {
    closeSpotifyLibraryPage,
    getSpotifyLibraryRequest,
    subscribeSpotifyLibraryRequest,
} from "./spotifyLibraryNavigation";

export default function SpotifyLibraryRoute() {
    const request = useSyncExternalStore(
        subscribeSpotifyLibraryRequest,
        getSpotifyLibraryRequest,
        getSpotifyLibraryRequest,
    );

    const onPlayTrack = async (
        item: TrackItem,
        contextUri?: string,
        position?: number,
    ) => {
        if (!item.uri) {
            return { ok: false, error: "This Spotify item cannot be played." };
        }
        if (contextUri && position !== undefined) {
            return playWebApiTrackInContext(contextUri, item.uri, position);
        }
        return playSpotifyTrack(item.uri);
    };

    return (
        <SpotifyLibraryPage
            key={request.id}
            onBack={closeSpotifyLibraryPage}
            initialBrowseItem={request.initialBrowseItem}
            onPlayTrack={onPlayTrack}
        />
    );
}
