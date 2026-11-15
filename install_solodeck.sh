#!/usr/bin/env bash
# Self-contained Solodeck installer / updater.
#
# Downloads the latest solodeck source from GitHub, builds the plugin zip,
# and installs it into Decky Loader on this machine (~/homebrew/plugins/solodeck)
# using Decky's own API, then reloads the frontend so the Quick Access Menu
# picks up the new tab.
#
# Usage:
#   chmod +x install_solodeck.sh
#   ./install_solodeck.sh
#
# No other files are needed: this script clones the repo to a temp dir,
# runs deploy.py, and removes the temp dir when done.
set -u

REPO="https://github.com/maximilian1121/solodeck.git"

if ! command -v git >/dev/null 2>&1; then
    echo "git is required but not installed." >&2
    if command -v notify-send >/dev/null 2>&1; then
        notify-send -u critical -t 8000 "solodeck install failed" "git is not installed"
    fi
    exec bash
fi

if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 is required but not installed." >&2
    if command -v notify-send >/dev/null 2>&1; then
        notify-send -u critical -t 8000 "solodeck install failed" "python3 is not installed"
    fi
    exec bash
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "============================================================"
echo "  solodeck install / update"
echo "  cloning $REPO"
echo "============================================================"
echo

if ! git clone -q --depth 1 "$REPO" "$work/solodeck"; then
    echo "Failed to clone solodeck repository." >&2
    if command -v notify-send >/dev/null 2>&1; then
        notify-send -u critical -t 8000 "solodeck install failed" "could not clone repository"
    fi
    exec bash
fi

cd "$work/solodeck"

echo
echo "============================================================"
echo "  building and installing via deploy.py"
echo "============================================================"
echo

python3 deploy.py "$@"
status=$?

echo
if [ $status -eq 0 ]; then
    echo "============================================================"
    echo "  solodeck installed successfully"
    echo "============================================================"
    if command -v notify-send >/dev/null 2>&1; then
        notify-send -u normal -t 5000 "solodeck" "Plugin installed and loaded"
    fi
else
    echo "============================================================"
    echo "  solodeck install FAILED (exit $status)"
    echo "============================================================"
    if command -v notify-send >/dev/null 2>&1; then
        notify-send -u critical -t 10000 "solodeck install failed" "See terminal output above"
    fi
    echo
    echo "Press Enter to close this window..."
    read -r
fi

exit $status
