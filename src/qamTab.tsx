import {
  ErrorBoundary,
  afterPatch,
  createReactTreePatcher,
  findInReactTree,
  findModuleByExport,
  getReactRoot,
  type Patch,
} from "@decky/ui";
import type { ReactNode } from "react";
import { FaSpotify } from "react-icons/fa";
import QamPanel from "./components/QamPanel";

// solodeck gets its own icon in Steam's Quick Access tab strip (next to
// Steam's tabs and Decky's own). Decky's tabs hook cannot be used for that:
// it re-adds every registered tab whenever its count check does not match the
// tab array, so adding a tab after the QAM has rendered makes every QAM
// render push another copy. Instead this patches the QAM renderer itself and
// only inserts the tab when it is not there yet.
const QAM_TAB_ID = 0x534f4c; // "SOL", clear of Steam's tabs and Decky's 999

// Which load of this module the tab in Steam's tab array was built by. Steam's
// array outlives a plugin reload, so the stale tab (and its old panel code)
// has to be recognised and replaced instead of kept.
const QAM_INSTANCE_KEY = "__solodeck_qam_instance";
const qamInstance =
  ((window as unknown as Record<string, number>)[QAM_INSTANCE_KEY] ?? 0) + 1;
(window as unknown as Record<string, number>)[QAM_INSTANCE_KEY] = qamInstance;

type QamTab = {
  key: number;
  title: null;
  tab: ReactNode;
  panel: ReactNode;
  initialVisibility: boolean;
  solodeckInstance: number;
};

function buildQamTab(visible: boolean): QamTab {
  return {
    key: QAM_TAB_ID,
    title: null,
    tab: <FaSpotify />,
    initialVisibility: visible,
    solodeckInstance: qamInstance,
    panel: (
      <ErrorBoundary>
        <QamPanel />
      </ErrorBoundary>
    ),
  };
}

// Keeps exactly one solodeck tab in Steam's QAM tab array: drops copies left
// by earlier renders/reloads, adds a fresh one after a reload and otherwise
// leaves the existing tab (and its mounted panel) alone.
function syncQamTabs(tabs: any[], visible: boolean) {
  let current: QamTab | null = null;

  for (let i = tabs.length - 1; i >= 0; i--) {
    const tab = tabs[i];
    if (tab?.key !== QAM_TAB_ID) continue;
    if (current === null && tab.solodeckInstance === qamInstance) {
      current = tab;
    } else {
      tabs.splice(i, 1);
    }
  }

  if (current === null) {
    current = buildQamTab(visible);
    tabs.push(current);
  }

  current.initialVisibility = visible;
}

const qamPatches: Patch[] = [];
let qamTabActive = false;
let qamInstallRetry: any = null;

function installQamTabCore(): boolean {
  const qamModule = findModuleByExport((entry: any) =>
    entry?.type?.toString?.()?.includes("QuickAccessMenuBrowserView"),
  );
  if (!qamModule) return false;

  const browserView = Object.values(qamModule).find((entry: any) =>
    entry?.type?.toString?.()?.includes("QuickAccessMenuBrowserView"),
  );
  const embedded = Object.values(qamModule).find((entry: any) =>
    entry?.type?.toString?.()?.includes("QuickAccessMenuEmbedded"),
  );
  if (!browserView) return false;

  const patchHandler = createReactTreePatcher(
    [(tree) => findInReactTree(tree, (node) => node?.props?.onFocusNavDeactivated)],
    (args, ret) => {
      if (!qamTabActive) return ret;
      const tabsNode = findInReactTree(ret, (node) => Array.isArray(node?.props?.tabs));
      if (tabsNode) {
        syncQamTabs(tabsNode.props.tabs, Boolean(args?.[0]?.visible));
      }
      return ret;
    },
    "solodeckQamTab",
  );

  qamPatches.push(afterPatch(browserView, "type", patchHandler));
  if (embedded) qamPatches.push(afterPatch(embedded, "type", patchHandler));

  // The QAM stays mounted for the whole Steam session, so if it is already
  // mounted its fiber still points at the unpatched renderer. Point it at the
  // patched one so the next render goes through us.
  const root = getReactRoot(document.getElementById("root") as any);
  const qamNode =
    root &&
    findInReactTree(
      root,
      (node: any) =>
        node.elementType === browserView ||
        (embedded != null && node.elementType === embedded),
    );
  if (qamNode) {
    qamNode.type = qamNode.elementType.type;
    if (qamNode.alternate) {
      qamNode.alternate.type = qamNode.type;
    }
  }

  return true;
}

export function installQamTab() {
  qamTabActive = true;

  if (installQamTabCore()) return;

  // Steam's QAM module may not be loaded yet; retry for up to ~10 seconds.
  let attempts = 0;
  const maxAttempts = 20;
  qamInstallRetry = setInterval(() => {
    attempts++;
    if (installQamTabCore()) {
      clearInterval(qamInstallRetry!);
      qamInstallRetry = null;
      return;
    }
    if (attempts >= maxAttempts) {
      clearInterval(qamInstallRetry!);
      qamInstallRetry = null;
      console.warn("solodeck: Steam's QAM module not found, QAM tab not added");
    }
  }, 500);
}

export function uninstallQamTab() {
  qamTabActive = false;
  if (qamInstallRetry !== null) {
    clearInterval(qamInstallRetry);
    qamInstallRetry = null;
  }
  for (const patch of qamPatches.splice(0)) patch.unpatch();
}
