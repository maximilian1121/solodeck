import type { TrackItem } from "./TrackDetailsFocusable";

export type PlaybackSnapshot = {
    currentTrackUri: string | null;
    currentTrackAlbumUri: string | null;
    contextUri: string | null;
    currentTrack: TrackItem | null;
};

export type PlaybackProgressSnapshot = {
    positionMs: number;
    durationMs: number;
    isPlaying: boolean;
    timestampMs: number;
};

let playbackSnapshot: PlaybackSnapshot = {
    currentTrackUri: null,
    currentTrackAlbumUri: null,
    contextUri: null,
    currentTrack: null,
};

let playbackProgressSnapshot: PlaybackProgressSnapshot = {
    positionMs: 0,
    durationMs: 0,
    isPlaying: false,
    timestampMs: Date.now(),
};

const playbackSnapshotListeners = new Set<() => void>();
const playbackProgressListeners = new Set<() => void>();

export function subscribePlaybackProgress(listener: () => void) {
    playbackProgressListeners.add(listener);
    return () => playbackProgressListeners.delete(listener);
}

export function getPlaybackProgressSnapshot() {
    return playbackProgressSnapshot;
}

export function updatePlaybackProgress(update: PlaybackProgressSnapshot) {
    playbackProgressSnapshot = update;
    playbackProgressListeners.forEach((listener) => listener());
}

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
        next.contextUri === playbackSnapshot.contextUri &&
        next.currentTrack === playbackSnapshot.currentTrack
    ) {
        return;
    }

    playbackSnapshot = next;
    playbackSnapshotListeners.forEach((listener) => listener());
}
