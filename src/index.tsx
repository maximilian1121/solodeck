import { staticClasses } from "@decky/ui";
import { definePlugin, routerHook } from "@decky/api";
import { FaSpotify } from "react-icons/fa";
import ConfigPage from "./components/ConfigPage";
import SpotifyLibraryRoute from "./components/SpotifyLibraryRoute";
import { SPOTIFY_LIBRARY_ROUTE } from "./components/spotifyLibraryNavigation";
import { installQamTab, uninstallQamTab } from "./qamTab";

export default definePlugin(() => {
    installQamTab();
    routerHook.removeRoute(SPOTIFY_LIBRARY_ROUTE);
    routerHook.addRoute(SPOTIFY_LIBRARY_ROUTE, SpotifyLibraryRoute, {
        exact: true,
    });

    return {
        name: "solodeck",
        titleView: <div className={staticClasses.Title}>solodeck</div>,
        content: <ConfigPage />,
        icon: <FaSpotify />,
        onDismount: () => {
            uninstallQamTab();
            routerHook.removeRoute(SPOTIFY_LIBRARY_ROUTE);
        },
    };
});
