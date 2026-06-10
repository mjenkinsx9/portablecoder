#!/usr/bin/env bash
# Portable Coder smoke test for Linux/macOS
# Run this to verify the portable launcher is working

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../" && pwd)"
PCODER="${REPO_ROOT}/scripts/pcoder"

echo "=== PortableCoder Smoke Test ==="
echo "Repo root: ${REPO_ROOT}"
echo ""

# Check if pcoder exists
if [[ ! -x "${PCODER}" ]]; then
    echo "FAIL: pcoder launcher not found or not executable: ${PCODER}"
    exit 1
fi
echo "OK: pcoder launcher found"

# Check if settings are initialized
if ! "${PCODER}" doctor >/dev/null 2>&1; then
    echo "INFO: Settings not initialized, running setup --init..."
    "${PCODER}" setup --init
fi

echo ""
echo "=== Running doctor ==="
if ! "${PCODER}" doctor; then
    echo "FAIL: Doctor check failed"
    exit 1
fi

echo ""
echo "=== Testing codex in host-native mode ==="
if "${PCODER}" run --tool codex --mode host-native -- --version 2>&1 | grep -qE "^codex(-cli)? [0-9]"; then
    echo "OK: codex works in host-native mode"
else
    echo "FAIL: codex host-native mode failed"
    exit 1
fi

echo ""
echo "=== Testing claude in portable-native mode ==="
if "${PCODER}" run --tool claude --mode linux-portable -- --version 2>&1 | grep -q "Claude Code"; then
    echo "OK: claude works in portable-native mode"
else
    echo "FAIL: claude portable-native mode failed"
    exit 1
fi

echo ""
echo "=== Auth status ==="
"${PCODER}" auth status

echo ""
echo "=== All smoke tests passed ==="
