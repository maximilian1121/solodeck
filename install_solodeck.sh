#!/usr/bin/env bash
# Install or update the solodeck Decky plugin on this Steam Deck.
#
# Runs build.py + deploy.py so the latest local code is packaged and pushed
# into Decky Loader (~/homebrew/plugins/solodeck) through Decky's own API,
# then reloads the frontend so the Quick Access Menu picks up the new tab.
#
# Usage: click the .desktop shortcut, or run `./install_solodeck.sh` from a terminal.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 not found" >&2
    if command -v notify-send >/dev/null 2>&1; then
        notify-send -u critical -t 6000 "solodeck install failed" "python3 not found"
    fi
    exec bash
fi

echo "============================================================"
echo "  solodeck install / update"
echo "  directory: $SCRIPT_DIR"
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
        notify-send -u critical -t 8000 "solodeck install failed" "See terminal output above"
    fi
    echo
    echo "Press Enter to close this window..."
    read -r
fi

exit $status
