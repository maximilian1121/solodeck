import {
    ButtonItem,
    PanelSection,
    PanelSectionRow,
    Spinner,
    TextField,
} from "@decky/ui";
import { useEffect, useState } from "react";
import {
    cancelWebApiAuth,
    cancelPairing,
    getBuildInfo,
    getConfig,
    getDaemonStatus,
    getDownloadStatus,
    getPairingStatus,
    getSoloistStatus,
    getSoloistVersion,
    getWebApiAuthStatus,
    downloadSoloist,
    restartDaemon,
    saveApiKey,
    saveDeviceName,
    startWebApiAuth,
    startDaemon,
    startPairing,
    stopDaemon,
    type DaemonStatus,
    type DownloadStatus,
    type PairingStatus,
    type SoloistStatus,
    type WebApiAuthStatus,
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
    "Spotify Soloist is the official Spotify Connect CLI/daemon for headless or ";
("custom applications. This plugin downloads it on demand, configures your ");
("Spotify API key, pairs the Steam Deck as a Spotify Connect device, and keeps ");
("the Soloist daemon running so your Deck shows up in Spotify.");

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
    const [soloistVersion, setSoloistVersion] = useState<string | null>(null);
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
    const [webApiClientId, setWebApiClientId] = useState("");
    const [webApiStatus, setWebApiStatus] = useState<WebApiAuthStatus>({
        status: "idle",
        error: null,
        authorization_url: null,
        client_id: "",
        configured: false,
    });
    const [webApiAuthUrl, setWebApiAuthUrl] = useState("");
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

        getSoloistVersion()
            .then((version) => {
                if (!cancelled) setSoloistVersion(version);
            })
            .catch(() => {
                // soloist not downloaded yet - that's expected until the user clicks download.
            });

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
                setWebApiClientId(config.web_api_client_id);
            })
            .catch((e) => console.error("solodeck: failed to get config", e));

        getWebApiAuthStatus()
            .then((auth) => {
                if (!cancelled) {
                    setWebApiStatus(auth);
                    setWebApiAuthUrl(auth.authorization_url ?? "");
                }
            })
            .catch((e) =>
                console.error("solodeck: failed to get Web API status", e),
            );

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
        if (
            webApiStatus.status !== "pending" &&
            webApiStatus.status !== "exchanging"
        ) {
            return;
        }

        let cancelled = false;
        const interval = setInterval(() => {
            getWebApiAuthStatus()
            .then((auth) => {
                if (!cancelled) {
                    setWebApiStatus(auth);
                    setWebApiAuthUrl(auth.authorization_url ?? "");
                }
            })
                .catch((e) =>
                    console.error("solodeck: failed to get Web API status", e),
                );
        }, 1000);

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [webApiStatus.status]);

    // Poll while soloist waits for the device to be picked in the Spotify app.
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

    const handleWebApiAuth = async () => {
        setBusy(true);
        setMessage(null);
        try {
            const result = await startWebApiAuth(webApiClientId);
            if (!result.ok || !result.authorization_url) {
                setMessage(
                    result.error ?? "Could not start Spotify Web API authorization.",
                );
                return;
            }
            setWebApiClientId(webApiClientId.trim());
            setWebApiAuthUrl(result.authorization_url);
            setMessage("Choose which browser to use for Spotify authorization.");
            setWebApiStatus({
                status: "pending",
                error: null,
                authorization_url: result.authorization_url,
                client_id: webApiClientId.trim(),
                configured: true,
            });
        } catch (e) {
            setMessage(`Could not start Spotify Web API authorization: ${e}`);
        } finally {
            setBusy(false);
        }
    };

    const handleOpenAuthInDeckBrowser = () => {
        if (!webApiAuthUrl) return;
        try {
            const openedWindow = window.open(webApiAuthUrl, "_blank");
            if (!openedWindow) {
                setMessage(
                    "The Deck browser could not be opened. Check the browser popup setting and try again.",
                );
                return;
            }
            setMessage("Opened Spotify authorization in the Deck browser.");
        } catch (e) {
            console.error("solodeck: failed to open Deck browser", e);
            setMessage(`Could not open the Deck browser: ${e}`);
        }
    };

    const handleOpenAuthInDefaultBrowser = () => {
        if (!webApiAuthUrl) return;
        try {
            SteamClient.System.OpenInSystemBrowser(webApiAuthUrl);
            setMessage("Opened Spotify authorization in the default browser.");
        } catch (e) {
            console.error("solodeck: failed to open default browser", e);
            setMessage(`Could not open the default browser: ${e}`);
        }
    };

    const handleCancelWebApiAuth = async () => {
        try {
            await cancelWebApiAuth();
            setWebApiAuthUrl("");
            setWebApiStatus((current) => ({ ...current, status: "idle" }));
        } catch (e) {
            setMessage(`Could not cancel Spotify authorization: ${e}`);
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
        <PanelSection>
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
                            {download.status === "downloading" ||
                            download.status === "extracting"
                                ? `Downloading Soloist... ${download.percent}%`
                                : "Download Soloist"}
                        </ButtonItem>
                    </PanelSectionRow>
                    {download.error && (
                        <PanelSectionRow>
                            <div style={{ ...hintStyle, color: errorColor }}>
                                Download failed: {download.error}
                            </div>
                        </PanelSectionRow>
                    )}
                    {download.status === "done" && (
                        <PanelSectionRow>
                            <div style={{ ...hintStyle, color: successColor }}>
                                Soloist downloaded and ready.
                            </div>
                        </PanelSectionRow>
                    )}
                </>
            )}

            {soloistInstalled && (
                <>
                    <PanelSectionRow>
                        <TextField
                            label="Soloist device name"
                            description="The name shown in Spotify's device picker. Defaults to 'solodeck'."
                            value={deviceName}
                            onChange={(e) => {
                                setDeviceName(e.target.value);
                                setMessage(null);
                            }}
                        />
                    </PanelSectionRow>

                    <PanelSectionRow>
                        <TextField
                            label="Spotify Soloist API key"
                            description="Generate one at Spotify for Developers. The account must have Spotify Premium."
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
                                Soloist start command preview (API key hidden)
                            </div>
                            <div style={outputStyle}>{startCommand}</div>
                            {(keyChanged || deviceNameChanged) && (
                                <div style={{ ...hintStyle, marginTop: "4px" }}>
                                    Starting or restarting the daemon saves
                                    these current values first.
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
                            Save Device Name
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

                    <PanelSectionRow>
                        <ButtonItem
                            layout="below"
                            onClick={handlePair}
                            disabled={
                                busy ||
                                status.running ||
                                daemon.running ||
                                !apiKey.trim()
                            }
                        >
                            Start pairing for soloist
                        </ButtonItem>
                    </PanelSectionRow>
                </>
            )}

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
                        handleDaemonAction(daemon.running ? "stop" : "start")
                    }
                    disabled={busy || !daemon.paired || !soloistInstalled}
                >
                    {daemon.running
                        ? "Stop Soloist daemon"
                        : "Start Soloist daemon"}
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
                    Restart Soloist daemon
                </ButtonItem>
            </PanelSectionRow>

            {!daemon.running && daemon.error && daemon.output.length > 0 && (
                <PanelSectionRow>
                    <div style={outputStyle}>
                        {daemon.output.slice(-8).join("\n")}
                    </div>
                </PanelSectionRow>
            )}

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

            <PanelSectionRow>
                <div style={{ ...hintStyle, fontWeight: 600 }}>
                    Optional Spotify Web API
                </div>
            </PanelSectionRow>

            <PanelSectionRow>
                <div style={hintStyle}>
                    The Web API fills in missing track metadata and powers the
                    QAM library explorer. Reconnect Spotify Web API to grant
                    private and collaborative playlist access if those
                    playlists are missing. Status:{" "}
                    <strong>
                        {webApiStatus.status === "connected"
                            ? "Connected"
                            : webApiStatus.status === "pending" ||
                                webApiStatus.status === "exchanging"
                              ? "Waiting for Spotify authorization"
                              : webApiStatus.status === "error"
                                ? "Authorization error"
                                : webApiStatus.configured
                                  ? "Not authorized"
                                  : "Not configured"}
                    </strong>
                </div>
            </PanelSectionRow>

            <PanelSectionRow>
                <TextField
                    label="Spotify Web API Client ID"
                    description="Create a Spotify app and add http://127.0.0.1:48256/callback as a Redirect URI. Loopback HTTP is allowed by Spotify; this is not the Soloist API key."
                    value={webApiClientId}
                    onChange={(event) => {
                        setWebApiClientId(event.target.value);
                        setWebApiAuthUrl("");
                    }}
                />
            </PanelSectionRow>

            <PanelSectionRow>
                <ButtonItem
                    layout="below"
                    onClick={handleWebApiAuth}
                    disabled={
                        busy ||
                        !webApiClientId.trim() ||
                        webApiStatus.status === "pending" ||
                        webApiStatus.status === "exchanging"
                    }
                >
                    {webApiStatus.status === "connected"
                        ? "Reconnect Spotify Web API"
                        : "Set up Spotify Web API"}
                </ButtonItem>
            </PanelSectionRow>

            {webApiAuthUrl && (
                <>
                    <PanelSectionRow>
                        <ButtonItem
                            layout="below"
                            onClick={handleOpenAuthInDefaultBrowser}
                        >
                            Open in default browser
                        </ButtonItem>
                    </PanelSectionRow>
                    <PanelSectionRow>
                        <ButtonItem
                            layout="below"
                            onClick={handleOpenAuthInDeckBrowser}
                        >
                            Open in Deck browser
                        </ButtonItem>
                    </PanelSectionRow>
                    <PanelSectionRow>
                        <div style={hintStyle}>
                            Spotify will return to this Deck after you authorize.
                        </div>
                    </PanelSectionRow>
                    <PanelSectionRow>
                        <ButtonItem
                            layout="below"
                            onClick={handleCancelWebApiAuth}
                        >
                            Cancel Spotify authorization
                        </ButtonItem>
                    </PanelSectionRow>
                </>
            )}

            {webApiStatus.error && (
                <PanelSectionRow>
                    <div style={{ ...hintStyle, color: errorColor }}>
                        {webApiStatus.error}
                    </div>
                </PanelSectionRow>
            )}

            <PanelSectionRow>
                <div style={hintStyle}>
                    {soloistVersion ?? "soloist unavailable"}
                </div>
            </PanelSectionRow>
        </PanelSection>
    );
}
