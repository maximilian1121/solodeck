import { staticClasses } from "@decky/ui";
import { definePlugin } from "@decky/api";
import { FaSpotify } from "react-icons/fa";
import ConfigPage from "./components/ConfigPage";
import { installQamTab, uninstallQamTab } from "./qamTab";

export default definePlugin(() => {
  installQamTab();

  return {
    name: "solodeck",
    titleView: <div className={staticClasses.Title}>solodeck</div>,
    content: <ConfigPage />,
    icon: <FaSpotify />,
    onDismount: uninstallQamTab,
  };
});
