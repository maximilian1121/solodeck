import { Navigation } from "@decky/ui";
import type { SpotifyBrowseItem } from "../api";

export const SPOTIFY_LIBRARY_ROUTE = "/solodeck/library";

export type SpotifyLibraryRequest = {
    id: number;
    initialBrowseItem?: SpotifyBrowseItem;
};

let currentRequest: SpotifyLibraryRequest = { id: 0 };
const listeners = new Set<() => void>();

export function getSpotifyLibraryRequest(): SpotifyLibraryRequest {
    return currentRequest;
}

export function subscribeSpotifyLibraryRequest(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function openSpotifyLibraryPage(initialBrowseItem?: SpotifyBrowseItem) {
    currentRequest = {
        id: currentRequest.id + 1,
        initialBrowseItem,
    };
    listeners.forEach((listener) => listener());
    Navigation.Navigate(SPOTIFY_LIBRARY_ROUTE);
    Navigation.CloseSideMenus();
}

export function closeSpotifyLibraryPage() {
    Navigation.NavigateBack();
}
