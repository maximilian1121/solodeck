import { callable } from "@decky/api";

// Build metadata baked in by build.py (see main.py's get_build_info)
export type BuildInfo = {
    version: string | null;
    build_time: number | null;
    age_days: number | null;
};

export type Config = {
    api_key: string;
    device_name: string;
    paired: boolean;
};

export type SoloistStatus = {
    installed: boolean;
    version: string | null;
    path: string | null;
};

export type DownloadStatus = {
    status: string; // "idle" | "downloading" | "extracting" | "done" | "failed"
    downloaded: number;
    total: number;
    percent: number;
    error: string | null;
};

export type PairingStatus = {
    running: boolean;
    cancelled: boolean;
    exit_code: number | null;
    output: string[];
    error: string | null;
};

export type DaemonStatus = {
    running: boolean;
    enabled: boolean;
    paired: boolean;
    pid: number | null;
    exit_code: number | null;
    error: string | null;
    output: string[];
    restarts: number;
    uptime: number | null;
};

export type ActionResult = {
    ok: boolean;
    error?: string;
};

export const getBuildInfo = callable<[], BuildInfo>("get_build_info");
export const getSoloistVersion = callable<[], string>("get_soloist_version");

// Soloist installation (downloaded at runtime, never bundled)
export const getSoloistStatus = callable<[], SoloistStatus>("get_soloist_status");
export const downloadSoloist = callable<[], ActionResult>("download_soloist");
export const getDownloadStatus = callable<[], DownloadStatus>("get_download_status");

export const getConfig = callable<[], Config>("get_config");
export const saveApiKey = callable<[api_key: string], ActionResult>("save_api_key");
export const saveDeviceName = callable<[device_name: string], ActionResult>("save_device_name");

// Spotify API (spotapi) QR authentication
export const startQrAuth = callable<[], { url?: string; error?: string }>(
    "start_qr_auth",
);
export const stopQrAuth = callable<[], ActionResult>("stop_qr_auth");
export const getAuthStatus = callable<[], { ok: boolean }>("get_auth_status");
export const logoutSpotify = callable<[], ActionResult>("logout_spotify");

// Soloist pairing
export const startPairing = callable<[api_key: string], ActionResult>(
    "start_pairing",
);
export const getPairingStatus = callable<[], PairingStatus>("get_pairing_status");
export const cancelPairing = callable<[], ActionResult>("cancel_pairing");

// Soloist daemon
export const getDaemonStatus = callable<[], DaemonStatus>("get_daemon_status");
export const startDaemon = callable<[], ActionResult>("start_daemon");
export const stopDaemon = callable<[], ActionResult>("stop_daemon");
export const restartDaemon = callable<[], ActionResult>("restart_daemon");