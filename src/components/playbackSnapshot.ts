export type PlaybackSnapshot = {
    currentTrackUri: string | null;
    currentTrackAlbumUri: string | null;
    contextUri: string | null;
};

let playbackSnapshot: PlaybackSnapshot = {
    currentTrackUri: null,
    currentTrackAlbumUri: null,
    contextUri: null,
};

const playbackSnapshotListeners = new Set<() => void>();

export function subscribePlaybackSnapshot(listener: () => void) {
    playbackSnapshotListeners.add(listener);
    return () => {
        playbackSnapshotListeners.delete(listener);
    };
}

export function getPlaybackSnapshot() {
    return playbackSnapshot;
}

export function updatePlaybackSnapshot(update: Partial<PlaybackSnapshot>) {
    const next = { ...playbackSnapshot, ...update };
    if (
        next.currentTrackUri === playbackSnapshot.currentTrackUri &&
        next.currentTrackAlbumUri === playbackSnapshot.currentTrackAlbumUri &&
        next.contextUri === playbackSnapshot.contextUri
    ) {
        return;
    }

    playbackSnapshot = next;
    playbackSnapshotListeners.forEach((listener) => listener());
}
