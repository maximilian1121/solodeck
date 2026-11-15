import { Menu, MenuGroup, MenuItem } from "@decky/ui";

export type TrackContextMenuProps = {
    title: string;
    artists: { uri: string; name: string }[];
    albumAvailable: boolean;
    onOpenAlbum: () => void;
    onOpenArtist: (artist: { uri: string; name: string }) => void;
};

export function TrackContextMenu({
    title,
    artists,
    albumAvailable,
    onOpenAlbum,
    onOpenArtist,
}: TrackContextMenuProps) {
    return (
        <Menu label={title}>
            <MenuItem disabled={!albumAvailable} onSelected={onOpenAlbum}>
                Album
            </MenuItem>
            {artists.length > 0 && (
                <MenuGroup label="Artists">
                    {artists.map((artist) => (
                        <MenuItem
                            key={artist.uri}
                            onSelected={() => onOpenArtist(artist)}
                        >
                            {artist.name}
                        </MenuItem>
                    ))}
                </MenuGroup>
            )}
        </Menu>
    );
}
