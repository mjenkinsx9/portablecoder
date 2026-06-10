# Auto-Update on Launch — Design

**Date:** 2026-06-10
**Status:** Approved (approach A: check-and-update at launch, on by default)

## Goal

Keep the bundled Claude Code and Codex installs current without the user running
`pcoder runtime bootstrap-host-native --force` manually, and without ever using the
tools' built-in self-updaters (which pcoder refuses because an interrupted in-place
update corrupts the hardlinked bundled install).

## Behavior

On `pcoder run` (and the `pcoder <tool>` / bare `pcoder` shortcuts) in **host-native
mode**, before launching the tool:

1. **Skip conditions** (checked in order, all silent):
   - `PCODER_AUTO_UPDATE=0` in the environment, or `settings.auto_update === false`
   - the tool is not a bundled install (no `runtime/<tool>/node_modules/.bin/<bin>`),
     e.g. resolved via `PCODER_*_CMD` or system PATH — nothing for us to update
   - the last check for this tool was less than 24 hours ago
2. **Version check:** read the installed version from
   `runtime/<tool>/node_modules/<npm_package>/package.json`, then fetch
   `https://registry.npmjs.org/<npm_package>/latest` in a child Node process with a
   3-second timeout. Record the check timestamp in `state/update-check.json`
   **regardless of outcome** so an offline machine pays the 3s penalty at most once
   per 24h, not on every launch.
3. **Fail-open:** any network/parse failure → launch the installed version, no error.
4. **Update:** if the registry version is newer (numeric dotted-segment compare),
   print `Updating <tool> <old> -> <new>...` and run
   `scripts/runtime/bootstrap-host-native.cjs --tool <tool> --force --no-node`
   synchronously, then launch. `--no-node` is a new bootstrap flag that skips the
   Node.js re-download (Node updates remain manual/explicit).
5. **Update failure:** print a warning, re-resolve the runner; if the binary is still
   present launch it, otherwise fail with a pointer to re-run the bootstrap.

## Configuration

- `state/settings.json`: new top-level `auto_update` boolean, default `true`.
- `pcoder setup --auto-update <true|false>` to change it.
- `PCODER_AUTO_UPDATE=0` env var disables for one invocation (wins over settings).
- `pcoder doctor` reports the auto-update setting.

## State

`state/update-check.json` (gitignored via existing `state/` patterns — add an explicit
ignore entry): `{ "<tool>": { "last_check": <epoch-ms>, "latest": "<version>" } }`.
Corrupt or missing file is treated as "never checked".

## Out of scope

- VM mode (the guest is provisioned by cloud-init; updating tools inside the VM image
  is a separate concern).
- Updating the bundled Node.js runtime automatically.
- `auth login` invocations (kept fast; the run path covers normal usage).

## Components

- `scripts/pcoder.cjs`:
  - `compareVersions(a, b)` — pure, exported, unit-tested.
  - `readBundledToolVersion(tool, meta)` — reads bundled package.json, null on failure.
  - `fetchLatestVersion(npmPackage)` — child-process fetch with timeout, null on failure.
  - `maybeAutoUpdate(tool, meta, settings)` — orchestrates skip conditions, check
    cache, comparison, and bootstrap invocation. Called from `commandRun` just before
    `resolveRunner` in the host-native path.
  - `parseSetupArgs` / `defaultSettings` / `normalizeSettings` / `printSettings` gain
    the `auto_update` field.
- `scripts/runtime/bootstrap-host-native.cjs`: new `--no-node` flag (requires the
  bundled Node to already exist; skips download/extract).

## Error handling summary

| Failure | Result |
|---|---|
| Offline / registry timeout | Launch installed version; check cached for 24h |
| Corrupt update-check.json | Treated as never-checked; overwritten on next check |
| npm install fails mid-update | Warning printed; launch old binary if intact, else fail with bootstrap hint |
| Bundled package.json unreadable | Skip update silently (counts as a completed check) |

## Testing

- Unit: `compareVersions` (equal, patch/minor/major newer, different lengths,
  non-numeric segments), `shouldCheckForUpdate`-style cache-window logic via exported
  helper with injected timestamps.
- Integration: CI smoke run exercises the skip path (fresh bootstrap = already latest).
