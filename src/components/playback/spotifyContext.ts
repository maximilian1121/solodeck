import type { TrackItem } from "../TrackDetailsFocusable";

export function getObject(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object"
        ? (value as Record<string, unknown>)
        : null;
}

export function isSpotifyDjContext(context: unknown): boolean {
    const contextObject = getObject(context);
    if (!contextObject) return false;

    const decorations = getObject(contextObject.decorations);
    const identity = getObject(decorations?.identity);
    const uri = typeof contextObject.uri === "string" ? contextObject.uri : "";
    const entityType =
        typeof contextObject.entity_type === "string"
            ? contextObject.entity_type
            : "";
    const name = typeof identity?.name === "string" ? identity.name.trim() : "";

    return (
        entityType.toLowerCase() === "dj" ||
        /^(?:spotify\s+)?dj$/i.test(name) ||
        /^spotify:dj(?::|$)/i.test(uri)
    );
}

export function spotifyContextUri(context: unknown): string | null {
    const uri = getObject(context)?.uri;
    return typeof uri === "string" && uri.length > 0 ? uri : null;
}

export function spotifyTrackAlbumUri(item: TrackItem | null): string | null {
    const uri = item?.decorations?.parent?.entity?.uri;
    return typeof uri === "string" && uri.length > 0 ? uri : null;
}
