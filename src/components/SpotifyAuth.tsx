import { ButtonItem, PanelSection, PanelSectionRow, TextField } from "@decky/ui";
import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
    cancelSpotifyBrowserLogin,
    connectSpotify,
    forgetSpotifySession,
    getAuthStatus,
    getSpotifyBrowserLoginStatus,
    getSpotifyPasteStatus,
    getSpotifySavedSessionStatus,
    logoutSpotify,
    saveSpotifySession,
    saveSpotifySessionUnencrypted,
    startSpotifyBrowserLogin,
    startSpotifyPasteServer,
    stopSpotifyPasteServer,
    unlockSpotifySession,
    unlockSpotifySessionUnencrypted,
    type SpotifyPasteServerStatus,
} from "../api";

function clearExplorerCache() {
    try {
        window.localStorage.removeItem("solodeck.spotify-explorer.v1");
        window.localStorage.removeItem("solodeck.spotify-explorer.v2");
    } catch (error) {
        console.warn("solodeck: could not clear Spotify library cache", error);
    }
}

export default function SpotifyAuth() {
    const [connected, setConnected] = useState(false);
    const [saved, setSaved] = useState(false);
    const [savedEncrypted, setSavedEncrypted] = useState(true);
    const [loadingStatus, setLoadingStatus] = useState(true);
    const [cookie, setCookie] = useState("");
    const [password, setPassword] = useState("");
    const [confirmation, setConfirmation] = useState("");
    const [saving, setSaving] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [browserPending, setBrowserPending] = useState(false);
    const [manual, setManual] = useState(false);
    const [pasteServer, setPasteServer] = useState<SpotifyPasteServerStatus>({ running: false });
    const [pasteBusy, setPasteBusy] = useState(false);
    const [pasteMessage, setPasteMessage] = useState<string | null>(null);

    useEffect(() => {
        let mounted = true;
        Promise.all([getAuthStatus(), getSpotifySavedSessionStatus()])
            .then(async ([isConnected, status]) => {
                if (!mounted) return;
                setSaved(status.saved);
                const encrypted = status.encrypted !== false;
                setSavedEncrypted(encrypted);
                if (isConnected) {
                    setConnected(true);
                    if (status.unencrypted) {
                        setMessage("Unencrypted Spotify session restored automatically.");
                    }
                    return;
                }
                if (status.unencrypted) {
                    setMessage("Could not restore the saved unencrypted session. Sign in to Spotify again.");
                }
            })
            .catch(() => {
                if (mounted) setMessage("Could not check Spotify connection.");
            })
            .finally(() => {
                if (mounted) setLoadingStatus(false);
            });
        return () => { mounted = false; };
    }, []);

    useEffect(() => {
        let mounted = true;
        getSpotifyPasteStatus()
            .then((status) => {
                if (mounted) setPasteServer(status);
            })
            .catch(() => {
                if (mounted) setPasteMessage("Could not check the temporary paste page.");
            });
        return () => { mounted = false; };
    }, []);

    useEffect(() => {
        if (!pasteServer.running) return;
        let mounted = true;
        let checking = false;
        const check = async () => {
            if (checking) return;
            checking = true;
            try {
                const status = await getSpotifyPasteStatus();
                if (!mounted) return;
                setPasteServer(status);
                if (!status.running) {
                    const isConnected = await getAuthStatus();
                    if (!mounted) return;
                    if (isConnected) {
                        clearExplorerCache();
                        setConnected(true);
                        setMessage("Spotify connected from the other device.");
                        setPasteMessage("The one-time paste page has closed.");
                    } else {
                        setPasteMessage("The temporary paste page expired or was stopped.");
                    }
                }
            } catch {
                if (mounted) setPasteMessage("Could not check the temporary paste page.");
            } finally {
                checking = false;
            }
        };
        const timer = window.setInterval(() => void check(), 1000);
        return () => {
            mounted = false;
            window.clearInterval(timer);
        };
    }, [pasteServer.running]);

    useEffect(() => {
        if (!connected) return;
        let mounted = true;
        const checkConnection = async () => {
            try {
                const isConnected = await getAuthStatus();
                if (mounted && !isConnected) {
                    setConnected(false);
                    setMessage("Spotify session is no longer loaded. Connect again to browse your library.");
                }
            } catch {
                // Keep the current status during temporary RPC failures.
            }
        };
        const timer = window.setInterval(() => void checkConnection(), 10_000);
        return () => {
            mounted = false;
            window.clearInterval(timer);
        };
    }, [connected]);

    useEffect(() => {
        let active = true;
        const check = async () => {
            try {
                const status = await getSpotifyBrowserLoginStatus();
                if (!active) return;
                setBrowserPending(status.status === "pending");
                if (status.status === "connected") {
                    clearExplorerCache();
                    setConnected(true);
                    setMessage("Connected for this session. You can save it with a password below.");
                } else if (status.status === "error") {
                    setMessage(status.error ?? "Spotify sign-in failed.");
                }
            } catch {
                if (active) setMessage("Could not check Spotify sign-in status.");
            }
        };
        void check();
        if (!browserPending) return () => { active = false; };
        const timer = window.setInterval(() => void check(), 1000);
        return () => { active = false; window.clearInterval(timer); };
    }, [browserPending]);

    const startBrowserLogin = async () => {
        setBusy(true);
        setMessage(null);
        try {
            const result = await startSpotifyBrowserLogin();
            if (result.ok) {
                setBrowserPending(true);
                setMessage("Complete sign-in in the browser window.");
            } else setMessage(result.error ?? "Could not start Spotify sign-in.");
        } catch {
            setMessage("Could not start Spotify sign-in.");
        } finally { setBusy(false); }
    };

    const cancelBrowserLogin = async () => {
        setBusy(true);
        try {
            await cancelSpotifyBrowserLogin();
            setBrowserPending(false);
            setMessage("Spotify sign-in cancelled.");
        } catch { setMessage("Could not cancel Spotify sign-in."); }
        finally { setBusy(false); }
    };

    const startPasteServer = async () => {
        setPasteBusy(true);
        setPasteMessage(null);
        try {
            const result = await startSpotifyPasteServer();
            if (result.ok && result.url) {
                setPasteServer({
                    running: true,
                    url: result.url,
                    urls: result.urls,
                    expires_in: result.expires_in,
                });
                setPasteMessage("Open this address on a trusted device on the same network.");
            } else {
                setPasteMessage(result.error ?? "Could not start the temporary paste page.");
            }
        } catch {
            setPasteMessage("Could not start the temporary paste page.");
        } finally {
            setPasteBusy(false);
        }
    };

    const stopPasteServer = async () => {
        setPasteBusy(true);
        try {
            const result = await stopSpotifyPasteServer();
            if (result.ok) {
                setPasteServer({ running: false });
                setPasteMessage("Temporary paste page stopped.");
            } else {
                setPasteMessage(result.error ?? "Could not stop the temporary paste page.");
            }
        } catch {
            setPasteMessage("Could not stop the temporary paste page.");
        } finally {
            setPasteBusy(false);
        }
    };

    const connect = async () => {
        setBusy(true);
        setMessage(null);
        try {
            const result = await connectSpotify(cookie);
            if (result.ok) {
                clearExplorerCache();
                setCookie("");
                setConnected(true);
                setMessage("Connected for this session. You can save it with a password below.");
            } else setMessage(result.error ?? "Could not connect to Spotify.");
        } catch { setMessage("Could not connect to Spotify. Please try again."); }
        finally { setBusy(false); }
    };

    const disconnect = async () => {
        setBusy(true);
        setMessage(null);
        try {
            const result = await logoutSpotify();
            if (result.ok) {
                clearExplorerCache();
                setConnected(false);
                setSaving(false);
                setPassword("");
                setConfirmation("");
                setMessage(saved ? "Disconnected. Your saved session is still available." : "Disconnected.");
            } else setMessage(result.error ?? "Could not disconnect Spotify.");
        } catch { setMessage("Could not disconnect Spotify. Please try again."); }
        finally { setBusy(false); }
    };

    const saveSession = async () => {
        if (!password || password !== confirmation) {
            setMessage("Enter the same password twice.");
            return;
        }
        setBusy(true);
        setMessage(null);
        try {
            const result = await saveSpotifySession(password);
            if (result.ok) {
                setSaved(true);
                setSavedEncrypted(true);
                setSaving(false);
                setMessage("Session saved. Enter this password to unlock it after restarting.");
            } else setMessage(result.error ?? "Could not save your Spotify session.");
        } catch { setMessage("Could not save your Spotify session."); }
        finally { setPassword(""); setConfirmation(""); setBusy(false); }
    };

    const saveUnencrypted = async () => {
        setBusy(true);
        setMessage(null);
        try {
            const result = await saveSpotifySessionUnencrypted();
            if (result.ok) {
                setSaved(true);
                setSavedEncrypted(false);
                setMessage("Session saved without encryption. Anyone who can read plugin settings can use your Spotify account.");
            } else setMessage(result.error ?? "Could not save the session.");
        } catch { setMessage("Could not save the session."); }
        finally { setBusy(false); }
    };

    const unlock = async () => {
        setBusy(true);
        setMessage(null);
        try {
            const result = savedEncrypted
                ? await unlockSpotifySession(password)
                : await unlockSpotifySessionUnencrypted();
            if (result.ok) {
                clearExplorerCache();
                setConnected(true);
                setMessage("Spotify session unlocked.");
            } else setMessage(result.error ?? "Could not unlock your Spotify session.");
        } catch { setMessage("Could not unlock your Spotify session."); }
        finally { setPassword(""); setBusy(false); }
    };

    const forget = async () => {
        setBusy(true);
        setMessage(null);
        try {
            const result = await forgetSpotifySession();
            if (result.ok) {
                setSaved(false);
                setPassword("");
                setConfirmation("");
                setMessage("Saved session removed.");
            } else setMessage(result.error ?? "Could not remove the saved session.");
        } catch { setMessage("Could not remove the saved session."); }
        finally { setBusy(false); }
    };

    const pasteUrls = pasteServer.urls ?? [];
    const allPasteUrls = pasteServer.url && !pasteUrls.some((entry) => entry.url === pasteServer.url)
        ? [{ label: "Primary address", url: pasteServer.url }, ...pasteUrls]
        : pasteUrls;

    return (
        <PanelSection title="Spotify account">
            {loadingStatus ? (
                <PanelSectionRow><div>Checking Spotify connection...</div></PanelSectionRow>
            ) : connected ? (
                <>
                    <PanelSectionRow><div>Connected{saved ? (savedEncrypted ? "; an encrypted session is saved." : "; an unencrypted session is saved.") : " for this session."}</div></PanelSectionRow>
                    <PanelSectionRow>
                        <ButtonItem layout="below" onClick={disconnect} disabled={busy}>Disconnect Spotify</ButtonItem>
                    </PanelSectionRow>
                    {!saving ? (
                        <PanelSectionRow>
                            <ButtonItem layout="below" onClick={() => setSaving(true)} disabled={busy}>
                                {saved ? "Replace saved session" : "Save session with a password"}
                            </ButtonItem>
                        </PanelSectionRow>
                    ) : (
                        <>
                            <PanelSectionRow><div>Choose a strong password. You will need it to unlock this session after the plugin restarts.</div></PanelSectionRow>
                            <PanelSectionRow><TextField label="Password" bIsPassword bShowClearAction value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} /></PanelSectionRow>
                            <PanelSectionRow><TextField label="Confirm password" bIsPassword bShowClearAction value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={busy} /></PanelSectionRow>
                            <PanelSectionRow><ButtonItem layout="below" onClick={saveSession} disabled={busy || !password || !confirmation}>{busy ? "Saving..." : "Save encrypted session"}</ButtonItem></PanelSectionRow>
                            <PanelSectionRow><ButtonItem layout="below" onClick={() => { setSaving(false); setPassword(""); setConfirmation(""); }} disabled={busy}>Cancel</ButtonItem></PanelSectionRow>
                            {!saved && <PanelSectionRow><ButtonItem layout="below" onClick={saveUnencrypted} disabled={busy}>Save without encryption</ButtonItem></PanelSectionRow>}
                        </>
                    )}
                </>
            ) : (
                <>
                    {saved && <>
                        <PanelSectionRow><div>{savedEncrypted ? "Unlock your encrypted Spotify session with your password." : "Your unencrypted session will unlock automatically when the plugin starts."}</div></PanelSectionRow>
                        {savedEncrypted && <>
                            <PanelSectionRow><TextField label="Session password" bIsPassword bShowClearAction value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy || browserPending} /></PanelSectionRow>
                            <PanelSectionRow><ButtonItem layout="below" onClick={unlock} disabled={busy || browserPending || !password}>{busy ? "Unlocking..." : "Unlock Spotify"}</ButtonItem></PanelSectionRow>
                        </>}
                    </>}
                    <PanelSectionRow><ButtonItem layout="below" onClick={browserPending ? cancelBrowserLogin : startBrowserLogin} disabled={busy}>{browserPending ? "Cancel Spotify sign-in" : "Sign in to Spotify"}</ButtonItem></PanelSectionRow>
                    <PanelSectionRow><ButtonItem layout="below" onClick={() => setManual(!manual)} disabled={browserPending || busy}>{manual ? "Hide manual connection" : "Manual connection"}</ButtonItem></PanelSectionRow>
                    {manual && <>
                        <PanelSectionRow><div>In Desktop Mode, sign in at open.spotify.com. In browser developer tools, select Application (or Storage), then Cookies and open.spotify.com. Copy the sp_dc cookie value and paste it below. Treat it like a password.</div></PanelSectionRow>
                        <PanelSectionRow><TextField label="Spotify sp_dc cookie" bIsPassword bShowClearAction value={cookie} onChange={(event) => setCookie(event.target.value)} disabled={busy} /></PanelSectionRow>
                        <PanelSectionRow><ButtonItem layout="below" onClick={connect} disabled={busy || !cookie.trim()}>{busy ? "Connecting..." : "Connect Spotify"}</ButtonItem></PanelSectionRow>
                    </>}
                </>
            )}
            {saved && !loadingStatus && !saving && <PanelSectionRow><ButtonItem layout="below" onClick={forget} disabled={busy || browserPending}>Remove saved session</ButtonItem></PanelSectionRow>}
            {message && <PanelSectionRow><div role="status">{message}</div></PanelSectionRow>}
            <PanelSectionRow>
                <div
                    role="alert"
                    style={{
                        width: "100%",
                        boxSizing: "border-box",
                        border: "3px solid #ff3b30",
                        borderRadius: "4px",
                        background: "rgba(255, 59, 48, 0.18)",
                        color: "#ff766f",
                        padding: "12px",
                        fontWeight: 700,
                        lineHeight: 1.35,
                    }}
                >
                    <div style={{ fontSize: "16px", marginBottom: "8px" }}>
                        DO NOT DO THIS ON A NETWORK YOU DO NOT FULLY TRUST.
                        THIS IS PURE HTTP.
                    </div>
                    <div style={{ fontWeight: 500 }}>
                        The temporary page sends your Spotify session cookie
                        unencrypted over the local network. Anyone able to
                        monitor that network could steal your account session.
                        Use only a trusted private network; never use public or
                        shared Wi-Fi. The page closes after one successful paste
                        or when its timer expires.
                    </div>
                </div>
            </PanelSectionRow>
            {pasteServer.running && pasteServer.url ? (
                <>
                    <PanelSectionRow>
                        <div style={{ width: "100%" }}>
                            <div style={{ fontWeight: 600, marginBottom: "6px" }}>
                                Temporary paste page is active
                            </div>
                            <div style={{ marginBottom: "8px" }}>
                                On a trusted device already signed in to Spotify,
                                copy the <code>sp_dc</code> cookie from the desktop
                browser&apos;s developer tools (Application or Storage → Cookies
                → open.spotify.com). Then scan this QR code or open one of the
                addresses below on that device and paste the cookie. Clear its
                clipboard afterwards.
                            </div>
                            <div style={{ display: "flex", justifyContent: "center", padding: "10px", background: "white", borderRadius: "4px" }}>
                                <QRCodeSVG value={pasteServer.url} size={164} aria-label="Temporary Spotify cookie paste page address" />
                            </div>
                            {allPasteUrls
                                .filter((entry) => entry.url.startsWith("http://"))
                                .map((entry) => (
                                    <div key={`${entry.label}-${entry.url}`} style={{ marginTop: "6px", overflowWrap: "anywhere", fontSize: "12px" }}>
                                        <a
                                            href={entry.url}
                                            target="_blank"
                                            rel="noreferrer"
                                            style={{ color: "var(--gpColor-Blue, #66c0f4)" }}
                                        >
                                            {entry.label}: {entry.url}
                                        </a>
                                    </div>
                                ))}
                            {pasteServer.expires_in !== undefined && (
                                <div style={{ marginTop: "6px" }}>
                                    Expires in about {Math.max(0, Math.ceil(pasteServer.expires_in / 60))} minute(s).
                                </div>
                            )}
                        </div>
                    </PanelSectionRow>
                    <PanelSectionRow>
                        <ButtonItem layout="below" onClick={stopPasteServer} disabled={pasteBusy}>
                            {pasteBusy ? "Stopping..." : "Stop temporary paste page"}
                        </ButtonItem>
                    </PanelSectionRow>
                </>
            ) : (
                <PanelSectionRow>
                    <ButtonItem layout="below" onClick={startPasteServer} disabled={pasteBusy || busy}>
                        {pasteBusy ? "Starting..." : "Start temporary LAN paste page"}
                    </ButtonItem>
                </PanelSectionRow>
            )}
            <PanelSectionRow>
                <div style={{ fontSize: "13px" }}>
                    Sign in on a separate device first. This page only transfers
                    the cookie to SoloDeck; it does not save the cookie on that device.
                </div>
            </PanelSectionRow>
            {pasteMessage && <PanelSectionRow><div role="status">{pasteMessage}</div></PanelSectionRow>}
        </PanelSection>
    );
}

SpotifyAuth.displayName = "SpotifyAuth";
