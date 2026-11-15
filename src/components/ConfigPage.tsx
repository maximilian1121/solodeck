import {
    ButtonItem,
    PanelSection,
    PanelSectionRow,
    Spinner,
    TextField,
} from "@decky/ui";
import { useEffect, useState } from "react";
import SpotifyAuth from "./SpotifyAuth";
void SpotifyAuth;
import {
    cancelPairing,
    getBuildInfo,
    getConfig,
    getDaemonStatus,
    getDownloadStatus,
    getPairingStatus,
    getSoloistStatus,
    downloadSoloist,
    restartDaemon,
    saveApiKey,
    saveDeviceName,
    startDaemon,
    startPairing,
    stopDaemon,
    type DaemonStatus,
    type DownloadStatus,
    type PairingStatus,
    type SoloistStatus,
} from "../api";
import {
    errorColor,
    hintStyle,
    outputStyle,
    successColor,
    warningStyle,
} from "../styles";

const OUTDATED_MESSAGE =
    "This plugin version is out of date! Spotify invalidates soloist builds after 90 days!";

const SOLOIST_INTRO =
    "Soloist makes your Steam Deck available as a Spotify Connect device. Set up the device name and API key, pair once, then start the daemon.";

function PairingResult({ status }: { status: PairingStatus }) {
    if (status.error) {
        return (
            <div style={{ ...hintStyle, color: errorColor }}>
                {status.error}
            </div>
        );
    }

    if (status.running) {
        return (
            <div
                style={{
                    ...hintStyle,
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                }}
            >
                <Spinner style={{ width: "16px", height: "16px" }} />
                <span>
                    Waiting for you to select this device in the Spotify
                    app&apos;s device picker...
                </span>
            </div>
        );
    }

    if (status.cancelled) {
        return <div style={hintStyle}>Pairing cancelled.</div>;
    }

    if (status.exit_code === 0) {
        return (
            <div style={{ ...hintStyle, color: successColor }}>
                Paired successfully. Soloist can now start without pairing
                again.
            </div>
        );
    }

    if (status.exit_code === 10) {
        return (
            <div style={{ ...hintStyle, color: errorColor }}>
                This soloist build has expired. Download a newer Soloist build
                and try again.
            </div>
        );
    }

    if (status.exit_code !== null) {
        return (
            <div style={{ ...hintStyle, color: errorColor }}>
                Pairing failed (soloist exited with code {status.exit_code}).
            </div>
        );
    }

    return null;
}

function daemonSummary(daemon: DaemonStatus): string {
    if (daemon.running) {
        const pid = daemon.pid ? ` (pid ${daemon.pid})` : "";
        const restarts =
            daemon.restarts > 0
                ? ` - restarted ${daemon.restarts} time(s)`
                : "";
        return `Soloist daemon running${pid}${restarts}`;
    }
    if (!daemon.paired) return "Soloist daemon: pair with Spotify first.";
    if (daemon.error) return `Soloist daemon stopped: ${daemon.error}`;
    return "Soloist daemon stopped.";
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

export default function ConfigPage() {
    const [outdated, setOutdated] = useState(false);
    const [soloistInstalled, setSoloistInstalled] = useState(false);
    const [soloistPath, setSoloistPath] = useState("soloist");
    const [download, setDownload] = useState<DownloadStatus>({
        status: "idle",
        downloaded: 0,
        total: 0,
        percent: 0,
        error: null,
    });
    const [apiKey, setApiKey] = useState("");
    const [savedKey, setSavedKey] = useState("");
    const [deviceName, setDeviceName] = useState("");
    const [savedDeviceName, setSavedDeviceName] = useState("");
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [status, setStatus] = useState<PairingStatus>({
        running: false,
        cancelled: false,
        exit_code: null,
        output: [],
        error: null,
    });
    const [daemon, setDaemon] = useState<DaemonStatus>({
        running: false,
        enabled: true,
        paired: false,
        pid: null,
        exit_code: null,
        error: null,
        output: [],
        restarts: 0,
        uptime: null,
    });
    const [logExpanded, setLogExpanded] = useState(false);

    useEffect(() => {
        let cancelled = false;

        getBuildInfo()
            .then((info) => {
                if (!cancelled)
                    setOutdated(info.age_days != null && info.age_days > 90);
            })
            .catch((e) =>
                console.error("solodeck: failed to get build info", e),
            );

        getSoloistStatus()
            .then((s: SoloistStatus) => {
                if (!cancelled) {
                    setSoloistInstalled(s.installed);
                    if (s.path) setSoloistPath(s.path);
                }
            })
            .catch((e) =>
                console.error("solodeck: failed to get soloist status", e),
            );

        getConfig()
            .then((config) => {
                if (cancelled) return;
                setApiKey(config.api_key);
                setSavedKey(config.api_key);
                setDeviceName(config.device_name);
                setSavedDeviceName(config.device_name);
            })
            .catch((e) => console.error("solodeck: failed to get config", e));

        // Pairing may already be running when the page is opened.
        getPairingStatus()
            .then((pairing) => {
                if (!cancelled) setStatus(pairing);
            })
            .catch((e) =>
                console.error("solodeck: failed to get pairing status", e),
            );

        // Download may already be in progress when the page is opened.
        getDownloadStatus()
            .then((dl) => {
                if (!cancelled) setDownload(dl);
            })
            .catch((e) =>
                console.error("solodeck: failed to get download status", e),
            );

        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!status.running) return;

        let cancelled = false;
        const interval = setInterval(() => {
            getPairingStatus()
                .then((pairing) => {
                    if (!cancelled) setStatus(pairing);
                })
                .catch((e) =>
                    console.error("solodeck: failed to get pairing status", e),
                );
        }, 1000);

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [status.running]);

    // Keep the daemon status fresh (it can be restarted or die on its own).
    useEffect(() => {
        let cancelled = false;

        const load = () => {
            getDaemonStatus()
                .then((next) => {
                    if (!cancelled) setDaemon(next);
                })
                .catch((e) =>
                    console.error("solodeck: failed to get daemon status", e),
                );
        };

        load();
        const interval = setInterval(load, 3000);

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, []);

    // Poll the download while it is in progress.
    useEffect(() => {
        if (
            download.status !== "downloading" &&
            download.status !== "extracting"
        )
            return;

        let cancelled = false;
        const interval = setInterval(() => {
            getDownloadStatus()
                .then((dl) => {
                    if (!cancelled) setDownload(dl);
                })
                .catch((e) =>
                    console.error("solodeck: failed to get download status", e),
                );
        }, 1000);

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [download.status]);

    useEffect(() => {
        if (download.status !== "done") return;
        let cancelled = false;
        getSoloistStatus()
            .then((status) => {
                if (!cancelled) {
                    setSoloistInstalled(status.installed);
                    if (status.path) setSoloistPath(status.path);
                }
            })
            .catch((error) => console.error("solodeck: failed to refresh Soloist status", error));
        return () => { cancelled = true; };
    }, [download.status]);

    const handleSave = async () => {
        setBusy(true);
        setMessage(null);
        try {
            const result = await saveApiKey(apiKey);
            if (result.ok) {
                setSavedKey(apiKey.trim());
                setMessage(
                    daemon.running
                        ? "API key saved. Restart the daemon to apply it."
                        : "API key saved.",
                );
            } else {
                setMessage(result.error ?? "Could not save the API key.");
            }
        } catch (e) {
            setMessage(`Could not save the API key: ${e}`);
        } finally {
            setBusy(false);
        }
    };

    const handleSaveDeviceName = async () => {
        setBusy(true);
        setMessage(null);
        try {
            const result = await saveDeviceName(deviceName);
            if (result.ok) {
                setSavedDeviceName(deviceName.trim());
                setMessage("Device name saved.");
            } else {
                setMessage(result.error ?? "Could not save the device name.");
            }
        } catch (e) {
            setMessage(`Could not save the device name: ${e}`);
        } finally {
            setBusy(false);
        }
    };

    const handleDownload = async () => {
        setBusy(true);
        setMessage(null);
        try {
            const result = await downloadSoloist();
            if (!result.ok) {
                setMessage(
                    result.error ?? "Could not start the Soloist download.",
                );
            } else {
                setDownload(await getDownloadStatus());
            }
        } catch (e) {
            setMessage(`Could not start the Soloist download: ${e}`);
        } finally {
            setBusy(false);
        }
    };

    const handlePair = async () => {
        setBusy(true);
        setMessage(null);
        try {
            const result = await startPairing(apiKey);
            if (!result.ok) {
                setMessage(result.error ?? "Could not start pairing.");
                return;
            }
            setSavedKey(apiKey.trim());
            setStatus({
                running: true,
                cancelled: false,
                exit_code: null,
                output: [],
                error: null,
            });
        } catch (e) {
            setMessage(`Could not start pairing: ${e}`);
        } finally {
            setBusy(false);
        }
    };

    const handleCancel = async () => {
        setBusy(true);
        try {
            await cancelPairing();
            setStatus(await getPairingStatus());
        } catch (e) {
            setMessage(`Could not cancel pairing: ${e}`);
        } finally {
            setBusy(false);
        }
    };

    const handleDaemonAction = async (action: "start" | "stop" | "restart") => {
        setBusy(true);
        setMessage(null);
        try {
            if (action !== "stop") {
                if (deviceName.trim() !== savedDeviceName) {
                    const result = await saveDeviceName(deviceName);
                    if (!result.ok) {
                        setMessage(
                            result.error ?? "Could not save the device name.",
                        );
                        return;
                    }
                    setSavedDeviceName(deviceName.trim());
                }
                if (apiKey.trim() !== savedKey) {
                    const result = await saveApiKey(apiKey);
                    if (!result.ok) {
                        setMessage(
                            result.error ?? "Could not save the API key.",
                        );
                        return;
                    }
                    setSavedKey(apiKey.trim());
                }
            }

            const run =
                action === "start"
                    ? startDaemon
                    : action === "stop"
                      ? stopDaemon
                      : restartDaemon;
            const result = await run();
            if (!result.ok) {
                setMessage(
                    result.error ?? `Could not ${action} the Soloist daemon.`,
                );
            }
            setDaemon(await getDaemonStatus());
        } catch (e) {
            setMessage(`Could not ${action} the Soloist daemon: ${e}`);
        } finally {
            setBusy(false);
        }
    };

    const keyChanged = apiKey.trim() !== savedKey;
    const deviceNameChanged = deviceName.trim() !== savedDeviceName;
    const startCommand = [
        shellQuote(soloistPath),
        "--device-name",
        shellQuote(deviceName.trim() || "solodeck"),
        "--api-key",
        shellQuote(apiKey.trim() ? "[redacted]" : "[API key not set]"),
        "--ws",
        shellQuote("127.0.0.1:35797"),
    ].join(" ");

    return (
        <>
            <PanelSection title="Spotify Connect">
                <PanelSectionRow>
                    <div style={hintStyle}>{SOLOIST_INTRO}</div>
                </PanelSectionRow>
                {outdated && (
                    <PanelSectionRow>
                        <div style={warningStyle}>{OUTDATED_MESSAGE}</div>
                    </PanelSectionRow>
                )}
                {!soloistInstalled && (
                    <>
                        <PanelSectionRow>
                            <ButtonItem
                                layout="below"
                                onClick={handleDownload}
                                disabled={
                                    busy ||
                                    download.status === "downloading" ||
                                    download.status === "extracting"
                                }
                            >
                                {download.status === "downloading"
                                    ? "Downloading Soloist..."
                                    : download.status === "extracting"
                                      ? "Installing Soloist..."
                                      : "Download Soloist"}
                            </ButtonItem>
                        </PanelSectionRow>
                        {(download.status === "downloading" ||
                            download.status === "extracting") && (
                            <PanelSectionRow>
                                <div
                                    style={{ ...hintStyle, width: "100%" }}
                                    role="status"
                                    aria-live="polite"
                                >
                                    <div>
                                        {download.status === "extracting"
                                            ? "Installing Soloist..."
                                            : download.total > 0
                                              ? `${Math.min(100, download.percent)}% — ${(download.downloaded / 1048576).toFixed(1)} / ${(download.total / 1048576).toFixed(1)} MiB`
                                              : `Downloading — ${(download.downloaded / 1048576).toFixed(1)} MiB`}
                                    </div>
                                    <progress
                                        aria-label={
                                            download.status === "extracting"
                                                ? "Installing Soloist"
                                                : "Downloading Soloist"
                                        }
                                        max={100}
                                        value={
                                            download.status === "downloading" &&
                                            download.total > 0
                                                ? Math.min(100, download.percent)
                                                : undefined
                                        }
                                        style={{
                                            width: "100%",
                                            marginTop: "8px",
                                        }}
                                    />
                                </div>
                            </PanelSectionRow>
                        )}
                        {download.error && (
                            <PanelSectionRow>
                                <div style={{ ...hintStyle, color: errorColor }}>
                                    Download failed: {download.error}
                                </div>
                            </PanelSectionRow>
                        )}
                        {download.status === "done" && (
                            <PanelSectionRow>
                                <div
                                    style={{ ...hintStyle, color: successColor }}
                                >
                                    Soloist downloaded and ready.
                                </div>
                            </PanelSectionRow>
                        )}
                    </>
                )}
            </PanelSection>

            {soloistInstalled && (
                <PanelSection title="Device setup">
                    <PanelSectionRow>
                        <TextField
                            label="Device name"
                            description="This name appears in Spotify's device picker."
                            value={deviceName}
                            onChange={(e) => {
                                setDeviceName(e.target.value);
                                setMessage(null);
                            }}
                        />
                    </PanelSectionRow>
                    <PanelSectionRow>
                        <TextField
                            label="Soloist API key"
                            description="Create a key in Spotify for Developers. Spotify Premium is required."
                            bIsPassword
                            bShowClearAction
                            value={apiKey}
                            onChange={(e) => {
                                setApiKey(e.target.value);
                                setMessage(null);
                            }}
                        />
                    </PanelSectionRow>
                    <PanelSectionRow>
                        <div style={{ width: "100%" }}>
                            <div style={{ ...hintStyle, marginBottom: "4px" }}>
                                Start command preview (key hidden)
                            </div>
                            <div style={outputStyle}>{startCommand}</div>
                            {(keyChanged || deviceNameChanged) && (
                                <div style={{ ...hintStyle, marginTop: "4px" }}>
                                    Starting or restarting saves these values
                                    automatically.
                                </div>
                            )}
                        </div>
                    </PanelSectionRow>
                    <PanelSectionRow>
                        <ButtonItem
                            layout="below"
                            onClick={handleSaveDeviceName}
                            disabled={
                                busy || !deviceName.trim() || !deviceNameChanged
                            }
                        >
                            Save device name
                        </ButtonItem>
                    </PanelSectionRow>
                    <PanelSectionRow>
                        <ButtonItem
                            layout="below"
                            onClick={handleSave}
                            disabled={
                                busy ||
                                status.running ||
                                !apiKey.trim() ||
                                !keyChanged
                            }
                        >
                            Save API key
                        </ButtonItem>
                    </PanelSectionRow>
                </PanelSection>
            )}

            <PanelSection title="Pair device">
                {message && (
                    <PanelSectionRow>
                        <div style={hintStyle}>{message}</div>
                    </PanelSectionRow>
                )}
                {(status.running ||
                    status.cancelled ||
                    status.exit_code !== null ||
                    status.error) && (
                    <PanelSectionRow>
                        <PairingResult status={status} />
                    </PanelSectionRow>
                )}
                <PanelSectionRow>
                    <ButtonItem
                        layout="below"
                        onClick={handlePair}
                        disabled={
                            busy ||
                            status.running ||
                            daemon.running ||
                            !soloistInstalled ||
                            !apiKey.trim()
                        }
                    >
                        Pair with Spotify
                    </ButtonItem>
                </PanelSectionRow>
                {status.running && (
                    <PanelSectionRow>
                        <ButtonItem
                            layout="below"
                            onClick={handleCancel}
                            disabled={busy}
                        >
                            Cancel pairing
                        </ButtonItem>
                    </PanelSectionRow>
                )}
                {status.output.length > 0 && (
                    <PanelSectionRow>
                        <div style={outputStyle}>
                            {status.output.slice(-8).join("\n")}
                        </div>
                    </PanelSectionRow>
                )}
            </PanelSection>

            <PanelSection title="Soloist daemon">
                <PanelSectionRow>
                    <div
                        style={{
                            ...hintStyle,
                            color: daemon.running
                                ? successColor
                                : daemon.error
                                  ? errorColor
                                  : undefined,
                        }}
                    >
                        {daemonSummary(daemon)}
                    </div>
                </PanelSectionRow>
                <PanelSectionRow>
                    <ButtonItem
                        layout="below"
                        onClick={() =>
                            handleDaemonAction(
                                daemon.running ? "stop" : "start",
                            )
                        }
                        disabled={busy || !daemon.paired || !soloistInstalled}
                    >
                        {daemon.running
                            ? "Stop Soloist"
                            : "Start Soloist"}
                    </ButtonItem>
                </PanelSectionRow>
                <PanelSectionRow>
                    <ButtonItem
                        layout="below"
                        onClick={() => handleDaemonAction("restart")}
                        disabled={
                            busy ||
                            !daemon.paired ||
                            !daemon.running ||
                            !soloistInstalled
                        }
                    >
                        Restart Soloist
                    </ButtonItem>
                </PanelSectionRow>
                {!daemon.running && daemon.error && daemon.output.length > 0 && (
                    <PanelSectionRow>
                        <div style={outputStyle}>
                            {daemon.output.slice(-8).join("\n")}
                        </div>
                    </PanelSectionRow>
                )}
            </PanelSection>

            <PanelSection title="Diagnostics">
                <PanelSectionRow>
                    <ButtonItem
                        layout="below"
                        onClick={() => setLogExpanded(!logExpanded)}
                    >
                        {logExpanded ? "Hide Soloist log" : "Show Soloist log"}
                    </ButtonItem>
                </PanelSectionRow>
                {logExpanded && daemon.output.length > 0 && (
                    <PanelSectionRow>
                        <div style={outputStyle}>
                            {daemon.output.slice(-20).join("\n")}
                        </div>
                    </PanelSectionRow>
                )}
            </PanelSection>

            <SpotifyAuth />
        </>
    );
}
