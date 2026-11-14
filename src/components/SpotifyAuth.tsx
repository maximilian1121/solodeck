import {
    ButtonItem,
    PanelSection,
    PanelSectionRow,
} from "@decky/ui";
import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
    getAuthStatus,
    logoutSpotify,
    startQrAuth,
    stopQrAuth,
    type ActionResult,
} from "../api";

export default function SpotifyAuth() {
    const [isConnected, setIsConnected] = useState(false);
    const [authUrl, setAuthUrl] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            try {
                const result = await getAuthStatus();
                if (!cancelled) setIsConnected(!!result.ok);
            } catch (e) {
                console.error("solodeck: failed to load auth status", e);
            }
        }

        load();

        const handler = () => {
            setIsConnected(true);
            setAuthUrl(null);
            setError(null);
        };
        window.addEventListener("spotify_auth_success", handler);

        return () => {
            cancelled = true;
            window.removeEventListener("spotify_auth_success", handler);
            void stopQrAuth();
        };
    }, []);

    const handleStart = async () => {
        setError(null);
        setLoading(true);
        try {
            const result = await startQrAuth();
            if (result.url) {
                setAuthUrl(result.url);
            } else if (result.error) {
                setError(result.error);
            } else {
                setError("Unknown error starting auth.");
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        };
    };

    const handleCancel = async () => {
        await stopQrAuth();
        setAuthUrl(null);
        setError(null);
    };

    const handleLogout = async () => {
        setError(null);
        try {
            const result: ActionResult = await logoutSpotify();
            if (result.ok) {
                setIsConnected(false);
                setAuthUrl(null);
            } else {
                setError(result.error ?? "Logout failed.");
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };

    return (
        <PanelSection>
            <PanelSectionRow>
                <div style={{ fontWeight: 600 }}>Spotify Web API</div>
            </PanelSectionRow>

            {isConnected ? (
                <>
                    <PanelSectionRow>
                        <div style={{ fontWeight: 600 }}>Connected</div>
                    </PanelSectionRow>
                    <PanelSectionRow>
                        <ButtonItem
                            layout="below"
                            onClick={handleLogout}
                            disabled={loading}
                        >
                            {loading ? "Signing out..." : "Sign Out"}
                        </ButtonItem>
                    </PanelSectionRow>
                </>
            ) : authUrl ? (
                <>
                    <PanelSectionRow>
                        <div style={{ fontWeight: 600 }}>Scan to Log In</div>
                    </PanelSectionRow>
                    <PanelSectionRow>
                        <div
                            style={{
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                gap: "12px",
                                padding: "12px",
                                background: "#ffffff",
                                borderRadius: "8px",
                            }}
                        >
                            <QRCodeSVG value={authUrl} size={160} />
                            <div
                                style={{
                                    wordBreak: "break-all",
                                    fontSize: "12px",
                                    color: "#333",
                                    textAlign: "center",
                                }}
                            >
                                {authUrl}
                            </div>
                        </div>
                    </PanelSectionRow>
                    <PanelSectionRow>
                        <ButtonItem
                            layout="below"
                            onClick={handleCancel}
                            disabled={loading}
                        >
                            {loading ? "Stopping..." : "Cancel"}
                        </ButtonItem>
                    </PanelSectionRow>
                </>
            ) : (
                <>
                    <PanelSectionRow>
                        <ButtonItem
                            layout="below"
                            onClick={handleStart}
                            disabled={loading}
                        >
                            {loading ? "Starting..." : "Sign in with Phone QR Code"}
                        </ButtonItem>
                    </PanelSectionRow>
                </>
            )}

            {error && (
                <PanelSectionRow>
                    <div style={{ color: "var(--gpColor-Red)", fontSize: "13px" }}>
                        {error}
                    </div>
                </PanelSectionRow>
            )}
        </PanelSection>
    );
}

SpotifyAuth.displayName = "SpotifyAuth";
