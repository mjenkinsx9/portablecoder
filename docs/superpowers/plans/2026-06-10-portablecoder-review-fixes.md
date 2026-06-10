# PortableCoder Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the correctness bugs, CI theater, supply-chain gaps, and dead code found in the 2026-06-10 repo review, and add a real test suite.

**Architecture:** `scripts/pcoder.cjs` stays a single-file CLI but exports its pure helpers behind a `require.main` guard so they become unit-testable with `node:test`. Shell/PS scripts are fixed in place. CI stops masking failures and actually bootstraps + smoke-tests the launcher.

**Tech Stack:** Node.js 22 (built-in `node:test`, no new dependencies), cmd/batch, PowerShell 5.1-compatible scripts, GitHub Actions.

**Decisions locked in:**
- License: MIT (single-author launcher repo; change the task if you prefer another license).
- `profiles/` is removed (vestigial — referenced by exactly one `fs.existsSync` check).
- Default Windows run mode becomes `host-native` (matches README and actual behavior).

**File map:**

| File | Action | Responsibility |
|---|---|---|
| `package.json` | Create | Test runner entry point, repo metadata |
| `tests/pcoder.test.cjs` | Create | Unit tests for pure helpers |
| `tests/cli.test.cjs` | Create | Spawn-based CLI smoke tests |
| `scripts/pcoder.cjs` | Modify | Export helpers, fix spawn quoting, fix tar excludes, bash check, default mode |
| `scripts/pcoder.cmd` | Modify | Fix stale `%errorlevel%` |
| `scripts/lib/paths.cjs` | Modify | Remove unused exports |
| `scripts/runtime/bootstrap-host-native.cjs` | Modify | Node checksum verification, real retry loop |
| `scripts/runtime/windows/bootstrap-runtime.ps1` | Modify | Ubuntu image checksum verification |
| `scripts/runtime/windows/start-vm.ps1` | Modify | Use manifest memory/vcpu, use user-data template |
| `scripts/runtime/windows/smoke-check.ps1` | Modify | known_hosts consistency |
| `scripts/runtime/linux/smoke-check.sh` | Modify | Fix unsupported `run <tool>` syntax |
| `runtime/linux/vm-manifest.json` | Modify | Add image SHA256SUMS URL |
| `.github/workflows/ci.yml` | Modify | Remove `\|\| true`, run tests, pin actions, fix model id |
| `scripts/runtime/windows/apply-start-vm-port-fix.ps1/.cmd` | Delete | Dead code (patch already applied) |
| `profiles/` + catalog `default_profile` keys + `pwsh` entry | Delete | Vestigial |
| `LICENSE` | Create | MIT |

---

### Task 1: Test scaffold — make pcoder.cjs importable and add package.json

**Files:**
- Create: `package.json`
- Modify: `scripts/pcoder.cjs:1535` (the `main(...)` call at the bottom)
- Create: `tests/pcoder.test.cjs`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "portablecoder",
  "version": "0.1.0",
  "private": true,
  "description": "Portable launcher for AI coding CLIs (Claude Code, OpenAI Codex)",
  "license": "MIT",
  "scripts": {
    "test": "node --test tests/"
  }
}
```

- [ ] **Step 2: Guard `main()` and export helpers in `scripts/pcoder.cjs`**

Replace the last line of the file:

```js
main(process.argv.slice(2));
```

with:

```js
if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  parseRunArgs,
  isToolUpdateInvocation,
  buildRemoteProjectPath,
  prependPath,
  shellEscape
};
```

(`escapeCmdArg` is added to this export list in Task 3.)

- [ ] **Step 3: Write the first failing test**

Create `tests/pcoder.test.cjs`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseRunArgs,
  isToolUpdateInvocation,
  buildRemoteProjectPath,
  prependPath,
  shellEscape
} = require('../scripts/pcoder.cjs');

test('parseRunArgs: flags before -- are parsed, args after -- pass through', () => {
  const p = parseRunArgs(['--tool', 'codex', '--project', '/tmp/x', '--', '--mode', 'evil']);
  assert.equal(p.tool, 'codex');
  assert.equal(p.project, '/tmp/x');
  assert.deepEqual(p.toolArgs, ['--mode', 'evil']);
});

test('parseRunArgs: unknown args become toolArgs', () => {
  const p = parseRunArgs(['--resume', 'some prompt']);
  assert.deepEqual(p.toolArgs, ['--resume', 'some prompt']);
  assert.equal(p.tool, null);
});

test('parseRunArgs: --no-sync-back sets flag', () => {
  const p = parseRunArgs(['--no-sync-back']);
  assert.equal(p.noSyncBack, true);
});

test('isToolUpdateInvocation: matches only the first arg', () => {
  assert.equal(isToolUpdateInvocation('claude', ['--update']), true);
  assert.equal(isToolUpdateInvocation('claude', ['update']), true);
  assert.equal(isToolUpdateInvocation('claude', ['-p', 'update my code']), false);
  assert.equal(isToolUpdateInvocation('claude', []), false);
  assert.equal(isToolUpdateInvocation('codex', ['--self-update']), true);
});

test('buildRemoteProjectPath: sanitizes name and is deterministic', () => {
  const a = buildRemoteProjectPath('/home/p/projects/', '/tmp/My Project!');
  const b = buildRemoteProjectPath('/home/p/projects', '/tmp/My Project!');
  assert.equal(a, b);
  assert.match(a, /^\/home\/p\/projects\/My_Project_-[0-9a-f]{8}$/);
});

test('prependPath: finds existing PATH key case-insensitively and dedupes', () => {
  const sep = process.platform === 'win32' ? ';' : ':';
  const env = { Path: `/usr/bin` };
  prependPath(env, '/opt/node');
  assert.equal(env.Path, `/opt/node${sep}/usr/bin`);
  assert.equal(Object.keys(env).length, 1);
  prependPath(env, '/opt/node'); // already first — no change
  assert.equal(env.Path, `/opt/node${sep}/usr/bin`);
});

test('shellEscape: single quotes are escaped for POSIX sh', () => {
  assert.equal(shellEscape(`it's`), `'it'"'"'s'`);
  assert.equal(shellEscape('plain'), `'plain'`);
});
```

- [ ] **Step 4: Run tests to verify they pass (helpers already exist)**

Run: `node --test tests/`
Expected: all 7 tests PASS. If `shellEscape` expectation fails, inspect actual output — the implementation at `scripts/pcoder.cjs:1480` uses a template literal with `\"` escapes; the test documents the actual `'"'"'` POSIX idiom. Fix the test expectation to match real output only if the real output is still valid POSIX escaping.

- [ ] **Step 5: Commit**

```bash
git add package.json tests/pcoder.test.cjs scripts/pcoder.cjs
git commit -m "test: add unit test scaffold and export pcoder helpers"
```

---

### Task 2: Fix stale %errorlevel% in pcoder.cmd

`exit /b %errorlevel%` inside a parenthesized `if` block expands at parse time, so `pcoder.cmd` currently returns the errorlevel from *before* node ran — i.e. the launcher almost always exits 0 even when the tool fails.

**Files:**
- Modify: `scripts/pcoder.cmd` (entire file)

- [ ] **Step 1: Rewrite without parenthesized blocks**

Replace the entire file content with:

```bat
@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."
set "PORTABLE_NODE=%REPO_ROOT%\runtime\node\node.exe"

if not exist "%PORTABLE_NODE%" goto :try_system_node
"%PORTABLE_NODE%" "%SCRIPT_DIR%pcoder.cjs" %*
exit /b %errorlevel%

:try_system_node
where node >nul 2>nul
if not %errorlevel% equ 0 goto :no_node
node "%SCRIPT_DIR%pcoder.cjs" %*
exit /b %errorlevel%

:no_node
echo Error: node not found. Bundle runtime\node or install node in PATH.
exit /b 1
```

(Outside parenthesized blocks, `%errorlevel%` is expanded per-line, after the preceding command runs. Delayed expansion is deliberately avoided because it corrupts `!` characters in user arguments.)

- [ ] **Step 2: Verify exit code propagation manually**

Run in cmd.exe (PowerShell wraps exit codes differently — use cmd):

```bat
scripts\pcoder.cmd setup --definitely-not-a-flag
echo exit=%errorlevel%
```

Expected: `Error: Unknown setup flag: --definitely-not-a-flag` then `exit=1` (previously `exit=0`).

- [ ] **Step 3: Commit**

```bash
git add scripts/pcoder.cmd
git commit -m "fix: propagate tool exit code from pcoder.cmd"
```

---

### Task 3: Fix Windows argument mangling (spawnSync shell:true)

`cp.spawnSync(runner, args, { shell: true })` on Windows joins args with **no quoting**, so `pcoder claude -p "fix the bug"` arrives at claude as three separate args, and any repo path containing a space breaks the runner invocation entirely. Fix with cross-spawn-style cmd.exe escaping.

**Files:**
- Modify: `scripts/pcoder.cjs` (add helpers; replace 3 spawn call sites at ~lines 320, 526, 1216)
- Test: `tests/pcoder.test.cjs`

- [ ] **Step 1: Write failing tests for the escaper**

Append to `tests/pcoder.test.cjs`:

```js
const { escapeCmdArg } = require('../scripts/pcoder.cjs');

test('escapeCmdArg: quotes and caret-escapes metacharacters', () => {
  assert.equal(escapeCmdArg('abc'), '^"abc^"');
  assert.equal(escapeCmdArg('a b'), '^"a b^"');
  assert.equal(escapeCmdArg('a"b'), '^"a\\^"b^"');
  assert.equal(escapeCmdArg('100%'), '^"100^%^"');
  assert.equal(escapeCmdArg('a&b|c'), '^"a^&b^|c^"');
  assert.equal(escapeCmdArg('trailing\\'), '^"trailing\\\\^"');
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/`
Expected: FAIL — `escapeCmdArg is not a function`.

- [ ] **Step 3: Implement `escapeCmdArg` and `spawnToolSync` in `scripts/pcoder.cjs`**

Add near `prependPath` (after line ~982):

```js
// cmd.exe argument escaping, following the algorithm used by cross-spawn:
// 1. double backslashes preceding a quote and escape the quote,
// 2. double trailing backslashes (they precede our closing quote),
// 3. wrap in quotes, 4. caret-escape cmd metacharacters.
function escapeCmdArg(arg) {
  let escaped = String(arg).replace(/(\\*)"/g, '$1$1\\"');
  escaped = escaped.replace(/(\\*)$/, '$1$1');
  escaped = `"${escaped}"`;
  return escaped.replace(/[()%!^"<>&|]/g, '^$&');
}

// spawnSync that survives spaces/quotes in runner path and args on Windows.
// Direct spawn of .cmd shims is blocked since the Node 18 EINVAL hardening,
// so on win32 we build a fully-escaped command line and hand it to cmd.exe
// with verbatim arguments (the cross-spawn approach).
function spawnToolSync(runner, args, options) {
  if (process.platform !== 'win32') {
    return cp.spawnSync(runner, args, options);
  }
  const command = [escapeCmdArg(runner), ...args.map(escapeCmdArg)].join(' ');
  return cp.spawnSync('cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
    ...options,
    windowsVerbatimArguments: true
  });
}
```

- [ ] **Step 4: Replace the three call sites**

In `commandAuth` (line ~320):

```js
  const result = spawnToolSync(runner, [action], {
    cwd: repoRoot,
    stdio: 'inherit',
    env
  });
```

In `commandRun` (line ~526):

```js
  const result = spawnToolSync(runner, parsed.toolArgs, {
    cwd: projectPath,
    stdio: 'inherit',
    env: mergedEnv
  });
```

In `runPortableHostNative` (line ~1216):

```js
  const result = spawnToolSync(runner, toolArgs, {
    cwd: projectPath,
    stdio: 'inherit',
    env
  });
```

(All three drop the `shell: process.platform === 'win32'` property.)

- [ ] **Step 5: Add `escapeCmdArg` to module.exports**

```js
module.exports = {
  parseRunArgs,
  isToolUpdateInvocation,
  buildRemoteProjectPath,
  prependPath,
  shellEscape,
  escapeCmdArg
};
```

- [ ] **Step 6: Run tests**

Run: `node --test tests/`
Expected: PASS (13 tests).

- [ ] **Step 7: Manual verification on Windows**

```bat
scripts\pcoder.cmd claude -p "say exactly: two words" --output-format text
```

Expected: the prompt arrives intact (previously claude received `say`, `exactly:`, `two`, `words` as separate args).

- [ ] **Step 8: Commit**

```bash
git add scripts/pcoder.cjs tests/pcoder.test.cjs
git commit -m "fix: escape tool arguments properly on Windows instead of shell:true"
```

---

### Task 4: Fix smoke-check.sh (`run <tool>` is not a supported syntax)

`pcoder run codex --mode ...` puts `codex` into `toolArgs` and runs the *default* tool with a stray `codex` argument. The smoke test has therefore never tested what it claims. CI hides this with `|| true` (fixed in Task 9).

**Files:**
- Modify: `scripts/runtime/linux/smoke-check.sh:36-51`

- [ ] **Step 1: Fix the two invocations**

Replace lines 36-51 with:

```bash
echo ""
echo "=== Testing codex in portable-native mode ==="
if "${PCODER}" run --tool codex --mode linux-portable -- --version 2>&1 | grep -q "codex"; then
    echo "OK: codex works in portable-native mode"
else
    echo "FAIL: codex portable-native mode failed"
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
```

- [ ] **Step 2: Verify locally (requires bootstrapped runtime) or rely on CI in Task 9**

Run: `bash scripts/runtime/linux/smoke-check.sh` on a machine with `runtime/node` + both tools installed (or accept CI verification in Task 9).
Expected: `All smoke tests passed`.

- [ ] **Step 3: Commit**

```bash
git add scripts/runtime/linux/smoke-check.sh
git commit -m "fix: smoke-check used unsupported 'run <tool>' positional syntax"
```

---

### Task 5: Default Windows mode → host-native; fix doctor's profiles check

`defaultSettings()` still says `windows_default_mode: 'linux-portable'` while the README (correctly, given the auto-fallback logic) documents host-native as the default. Also `doctor` requires a `profiles/` dir which Task 10 deletes.

**Files:**
- Modify: `scripts/pcoder.cjs:700` (defaultSettings) and `scripts/pcoder.cjs:131` (doctor requiredDirs)

- [ ] **Step 1: Change the default**

In `defaultSettings()`:

```js
    runtime: {
      windows_default_mode: 'host-native',
      sync_back_default: true
    }
```

- [ ] **Step 2: Drop `profiles` from doctor's required dirs**

```js
  const requiredDirs = ['runtime', 'state', 'scripts'];
```

- [ ] **Step 3: Verify**

Run: `node scripts/pcoder.cjs setup --init && node scripts/pcoder.cjs setup --show`
Expected: `windows default mode: host-native`.

- [ ] **Step 4: Commit**

```bash
git add scripts/pcoder.cjs
git commit -m "fix: default windows mode is host-native, matching README and fallback logic"
```

---

### Task 6: Anchor tar sync excludes and check for bash on Windows

`--exclude=runtime` matches **any** path component named `runtime`, so a project with `src/runtime/` silently doesn't sync into the VM. And VM sync shells out to bare `bash` on Windows with no availability check.

**Files:**
- Modify: `scripts/pcoder.cjs:21` (SYNC_EXCLUDES usage in syncProjectToVm/syncProjectFromVm, lines ~1393 and ~1427)

- [ ] **Step 1: Anchor the excludes**

In `syncProjectToVm` (line ~1393):

```js
  // Anchor with ./ so only top-level dirs are excluded — tar stores paths as
  // ./runtime/... when archiving from '.', and a bare --exclude=runtime would
  // also drop e.g. src/runtime/ from the project.
  const tarExcludes = SYNC_EXCLUDES.map((e) => `--exclude=./${e}`).join(' ');
```

In `syncProjectFromVm` (line ~1427), same replacement:

```js
  const tarExcludes = SYNC_EXCLUDES.map((e) => `--exclude=./${e}`).join(' ');
```

- [ ] **Step 2: Fail clearly when bash is missing on Windows**

At the top of `syncProjectToVm` and `syncProjectFromVm`, before building the script:

```js
  if (process.platform === 'win32' && !commandExists('bash')) {
    fail('VM project sync requires bash on PATH (Git for Windows or WSL). Install Git for Windows: https://git-scm.com/downloads/win');
  }
```

- [ ] **Step 3: Verify exclusion behavior with plain tar**

```bash
mkdir -p /tmp/sync-test/src/runtime /tmp/sync-test/runtime
touch /tmp/sync-test/src/runtime/keep.txt /tmp/sync-test/runtime/drop.txt
cd /tmp/sync-test && tar cf - --exclude=./runtime . | tar tf - | sort
```

Expected: output contains `./src/runtime/keep.txt` and does NOT contain `./runtime/drop.txt`.

- [ ] **Step 4: Commit**

```bash
git add scripts/pcoder.cjs
git commit -m "fix: anchor VM sync tar excludes to project root; check for bash on Windows"
```

---

### Task 7: known_hosts consistency in smoke-check.ps1

`pcoder.cjs` and `stop-vm.ps1` both learned that `UserKnownHostsFile=NUL` breaks Windows OpenSSH (NUL is treated as a real file → host key mismatch errors). `smoke-check.ps1:49` still uses NUL.

**Files:**
- Modify: `scripts/runtime/windows/smoke-check.ps1:36-53` (Invoke-Ssh)

- [ ] **Step 1: Use the shared known_hosts file**

Add after line 19 (`$pidFile = ...`):

```powershell
$knownHostsFile = Join-Path $stateDir 'known_hosts'
```

In `Invoke-Ssh`, replace:

```powershell
    '-o', 'UserKnownHostsFile=NUL',
```

with:

```powershell
    '-o', "UserKnownHostsFile=$knownHostsFile",
```

- [ ] **Step 2: Verify syntax**

Run: `powershell -NoProfile -Command "& { . { $(Get-Content -Raw scripts/runtime/windows/smoke-check.ps1) } }" -ErrorAction Stop` — or simpler, on Windows: `powershell -NoProfile -Command "[scriptblock]::Create((Get-Content -Raw 'scripts\runtime\windows\smoke-check.ps1')) | Out-Null; 'parse ok'"`
Expected: `parse ok`.

- [ ] **Step 3: Commit**

```bash
git add scripts/runtime/windows/smoke-check.ps1
git commit -m "fix: smoke-check.ps1 uses state/vm/known_hosts instead of NUL"
```

---

### Task 8: Checksum verification for Node.js and the Ubuntu image; real download retry

Node is fetched from nodejs.org and the Ubuntu image from cloud-images.ubuntu.com with no integrity check. Also `downloadFileSync`'s `for (i < 6)` retry loop exits the process on the first attempt either way — it has never retried.

**Files:**
- Modify: `scripts/runtime/bootstrap-host-native.cjs` (downloadFileSync, downloadAndExtractNode)
- Modify: `runtime/linux/vm-manifest.json`
- Modify: `scripts/runtime/windows/bootstrap-runtime.ps1` (image download block, line ~146)

- [ ] **Step 1: Make downloadFileSync actually retry**

Replace the embedded script in `downloadFileSync` (`scripts/runtime/bootstrap-host-native.cjs:252-287`) with:

```js
function downloadFileSync(url, dest) {
  const script = `
    const fs = require('fs');
    const {pipeline} = require('stream/promises');

    async function attempt(target, dest) {
      const res = await fetch(target, {redirect: 'follow'});
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const total = parseInt(res.headers.get('content-length') || '0', 10);
      let downloaded = 0;
      const transform = new (require('stream').Transform)({
        transform(chunk, enc, cb) {
          downloaded += chunk.length;
          if (total > 0) {
            const pct = Math.floor(downloaded / total * 100);
            process.stderr.write('\\r  ' + pct + '% (' + Math.floor(downloaded / 1048576) + ' MB)');
          }
          cb(null, chunk);
        }
      });
      await pipeline(res.body, transform, fs.createWriteStream(dest));
      process.stderr.write('\\n');
    }

    (async () => {
      const target = ${JSON.stringify(url)};
      const dest = ${JSON.stringify(dest)};
      let lastError = null;
      for (let i = 0; i < 3; i++) {
        try {
          await attempt(target, dest);
          process.exit(0);
        } catch (e) {
          lastError = e;
          process.stderr.write('\\n  attempt ' + (i + 1) + ' failed: ' + e.message + '\\n');
          await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
        }
      }
      console.error(lastError.message);
      process.exit(1);
    })();
  `;
  const result = cp.spawnSync(process.execPath, ['-e', script], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.status !== 0) {
    fail(`Download failed: ${url}`);
  }
}
```

- [ ] **Step 2: Verify Node archive against SHASUMS256.txt**

Add `const crypto = require('crypto');` to the requires at the top of `bootstrap-host-native.cjs`, then add these two functions and wire them into `downloadAndExtractNode` right after the download:

```js
function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function verifyNodeChecksum(downloadPath, fileName) {
  const shasumsUrl = `https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`;
  const shasumsPath = path.join(tmpDir, 'node-SHASUMS256.txt');
  downloadFileSync(shasumsUrl, shasumsPath);
  const line = fs.readFileSync(shasumsPath, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().endsWith(fileName));
  if (!line) {
    fail(`No checksum entry for ${fileName} in ${shasumsUrl}`);
  }
  const expected = line.trim().split(/\s+/)[0].toLowerCase();
  const actual = sha256File(downloadPath);
  if (actual !== expected) {
    fail(`Node.js download checksum mismatch for ${fileName}: expected ${expected}, got ${actual}`);
  }
  console.log('Checksum verified (SHA-256).');
}
```

In `downloadAndExtractNode`, after `console.log(\`Downloaded: ${downloadPath}\`);` add:

```js
  verifyNodeChecksum(downloadPath, fileName);
```

- [ ] **Step 3: Add the image checksum URL to the manifest**

In `runtime/linux/vm-manifest.json`, extend `bootstrap.windows`:

```json
    "windows": {
      "qemu_installer_url": "https://qemu.weilnetz.de/w64/qemu-w64-setup-20260324.exe",
      "qemu_installer_sha512_url": "https://qemu.weilnetz.de/w64/qemu-w64-setup-20260324.sha512",
      "ubuntu_image_url": "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img",
      "ubuntu_image_sha256sums_url": "https://cloud-images.ubuntu.com/noble/current/SHA256SUMS"
    }
```

- [ ] **Step 4: Verify the Ubuntu image in bootstrap-runtime.ps1**

Replace the image download block (`scripts/runtime/windows/bootstrap-runtime.ps1:146-152`) with:

```powershell
$ubuntuShaSumsUrl = if ($env:PCODER_UBUNTU_SHA256SUMS_URL) { $env:PCODER_UBUNTU_SHA256SUMS_URL } else { $bootstrap.ubuntu_image_sha256sums_url }

if ($Force -or -not (Test-Path $vmImage)) {
  Download-File -Url $ubuntuImageUrl -Destination $vmImage

  if ($ubuntuShaSumsUrl) {
    $imageFileName = [System.IO.Path]::GetFileName($ubuntuImageUrl)
    $sumsPath = Join-Path $stateTmpDir 'ubuntu-SHA256SUMS'
    Download-File -Url $ubuntuShaSumsUrl -Destination $sumsPath
    $sumLine = (Get-Content $sumsPath) | Where-Object { $_ -match [regex]::Escape($imageFileName) } | Select-Object -First 1
    if (-not $sumLine) {
      throw "No checksum entry for $imageFileName in $ubuntuShaSumsUrl"
    }
    $expectedHash = ($sumLine -split '\s+')[0].TrimStart('\').ToLowerInvariant()
    $actualHash = (Get-FileHash -Path $vmImage -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
      throw "Ubuntu image hash mismatch. expected=$expectedHash actual=$actualHash"
    }
    Write-Host 'Ubuntu image checksum verified (SHA-256).'
  } else {
    Write-Host 'Warning: no SHA256SUMS URL configured; skipping image verification.'
  }
}
```

(Note: Ubuntu's SHA256SUMS format is `<hash> *<filename>`; the `TrimStart('\')` handles nothing — the hash is the first token. The split handles both `*file` and plain `file` forms.)

- [ ] **Step 5: Verify the Node path end-to-end**

Run: `node scripts/runtime/bootstrap-host-native.cjs --node-only --force`
Expected: download progress, then `Checksum verified (SHA-256).`, then `Bundled Node.js version: v22.14.0`.

- [ ] **Step 6: Commit**

```bash
git add scripts/runtime/bootstrap-host-native.cjs scripts/runtime/windows/bootstrap-runtime.ps1 runtime/linux/vm-manifest.json
git commit -m "feat: verify Node.js and Ubuntu image checksums; make download retry real"
```

---

### Task 9: CI — stop masking failures, run the tests, pin actions, fix the model id

Current CI: prettier `|| true`, smoke-check `|| true`, doctor `|| true`, an unpinned `@master` action, and a Claude review job pinned to the nonexistent model id `claude-sonnet-4-6-20250514`.

**Files:**
- Modify: `.github/workflows/ci.yml` (whole file)
- Create: `.prettierrc.json`
- Create: `.prettierignore`

- [ ] **Step 1: Add prettier config matching existing code style**

`.prettierrc.json`:

```json
{
  "singleQuote": true,
  "printWidth": 100,
  "trailingComma": "none"
}
```

`.prettierignore`:

```
runtime/
state/
apps/
docs/
*.md
```

(Markdown excluded to avoid churn in README prose; scripts and JSON are the targets.)

- [ ] **Step 2: Format once so the check starts green**

Run: `npx prettier --write "scripts/**/*.cjs" "scripts/**/*.json" "profiles/**/*.json" ".github/**/*.yml" "package.json"`
Then: `node --test tests/` and `node --check scripts/pcoder.cjs`
Expected: tests still PASS (formatting must not change behavior). Review the diff before committing.

- [ ] **Step 3: Rewrite ci.yml**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  lint:
    name: Lint & Format
    runs-on: blacksmith
    steps:
      - uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Prettier check
        run: npx --yes prettier --check "scripts/**/*.cjs" "scripts/**/*.json" "package.json"

      - name: ShellCheck
        uses: ludeeus/action-shellcheck@2.0.0
        with:
          scandir: scripts/

  security:
    name: Security Scan
    runs-on: blacksmith
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Install gitleaks
        run: |
          VERSION=$(curl -sSf https://api.github.com/repos/gitleaks/gitleaks/releases/latest | grep -oP '"tag_name":\s*"v\K[^"]+')
          curl -sSfL "https://github.com/gitleaks/gitleaks/releases/latest/download/gitleaks_${VERSION}_linux_x64.tar.gz" | tar xz
          sudo mv gitleaks /usr/local/bin/

      - name: Gitleaks
        run: gitleaks detect --source . --verbose

  test:
    name: Test & Validate
    runs-on: blacksmith
    steps:
      - uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Validate launcher syntax
        run: node --check scripts/pcoder.cjs

      - name: Unit tests
        run: node --test tests/

      - name: Initialize settings
        run: scripts/pcoder setup --init

      - name: Bootstrap host-native runtime (both tools)
        run: scripts/pcoder runtime bootstrap-host-native --tool all

      - name: Doctor check
        run: scripts/pcoder doctor

      - name: Smoke test
        run: scripts/runtime/linux/smoke-check.sh

  claude-review:
    name: Claude Code Review
    runs-on: blacksmith
    if: github.event_name == 'pull_request'
    permissions:
      contents: read
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Claude Code Review
        uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          model: claude-sonnet-4-6
          direct_prompt: |
            Review this PR for:
            - Security issues (especially in launcher scripts)
            - Logic errors and edge cases
            - Error handling gaps
            - JavaScript/Node.js best practices
            - Cross-platform compatibility (Windows/Linux/macOS)
            - Adherence to existing code patterns in the repo

            Focus on substantive issues. Skip minor style comments that linters would catch.
```

Changes: every `|| true` removed; unit tests added; bootstrap runs for real so doctor and smoke-check exercise actual binaries; `@beta` → `@v1` to match the other workflow; model fixed to `claude-sonnet-4-6`; shellcheck pinned to `2.0.0`.

- [ ] **Step 4: Validate workflow syntax**

Run: `npx --yes yaml-lint .github/workflows/ci.yml` (or `node -e "require('js-yaml')"`-equivalent; simplest: push to a branch and watch the run).
Expected: valid YAML; CI green on the PR.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml .prettierrc.json .prettierignore
git add -u
git commit -m "ci: remove || true masking, run unit tests and real smoke test, pin actions, fix model id"
```

---

### Task 10: Delete dead code and vestigial structure

Three removals: (a) `apply-start-vm-port-fix.*` — a self-patching script whose patch is already present in the committed `start-vm.ps1`; (b) `profiles/` — referenced by exactly one `existsSync` check (removed in Task 5); (c) unused exports in `paths.cjs`. Plus: unify the duplicated cloud-init user-data (the tracked template with `<SSH_PUBLIC_KEY_PLACEHOLDER>` is dead — `start-vm.ps1` generates its own copy inline) and wire the ignored `default_memory_mb`/`default_vcpu` manifest values.

**Files:**
- Delete: `scripts/runtime/windows/apply-start-vm-port-fix.ps1`, `scripts/runtime/windows/apply-start-vm-port-fix.cmd`
- Delete: `profiles/` (all contents)
- Modify: `scripts/adapters/catalog.json` (remove `default_profile` keys and the `pwsh` entry)
- Modify: `scripts/lib/paths.cjs` (remove `claudeDir`, `getBundledClaudeBinPath`)
- Modify: `scripts/runtime/windows/start-vm.ps1` (use user-data template; use manifest memory/vcpu)
- Modify: `README.md` (remove `profiles/` from File Layout section)

- [ ] **Step 1: Delete the patch scripts and profiles**

```bash
git rm scripts/runtime/windows/apply-start-vm-port-fix.ps1 scripts/runtime/windows/apply-start-vm-port-fix.cmd
git rm -r profiles/
```

- [ ] **Step 2: Clean catalog.json**

Remove the `"default_profile"` line from the `claude` and `codex` entries, and delete the entire `"pwsh"` entry (it has no `npm_package`, is filtered out of `SUPPORTED_TOOLS`, and nothing reads `PCODER_PWSH_CMD`). Resulting file contains only `claude` and `codex` objects.

- [ ] **Step 3: Clean paths.cjs exports**

Remove `getBundledClaudeBinPath` function and the `claudeDir` / `getBundledClaudeBinPath` entries from `module.exports` (verified unused: `grep -rn "getBundledClaudeBinPath\|claudeDir" scripts/` shows only the definition).

- [ ] **Step 4: Make start-vm.ps1 read the user-data template**

Replace the `Write-CloudInitSeed` function body's inline here-string (`scripts/runtime/windows/start-vm.ps1:76-95`) with:

```powershell
  $userDataTemplate = Join-Path $repoRoot 'runtime\linux\cloud-init\user-data'
  if (-not (Test-Path $userDataTemplate)) {
    throw "Missing cloud-init user-data template: $userDataTemplate"
  }
  $userData = (Get-Content $userDataTemplate -Raw)
  $userData = $userData.Replace('<SSH_PUBLIC_KEY_PLACEHOLDER>', $PublicKey)
  $userData = $userData.Replace('- name: portable', "- name: $UserName")
  $userData | Out-File -Encoding utf8 -FilePath $cloudInitUserDataPath
```

- [ ] **Step 5: Wire manifest memory/vcpu into start-vm.ps1**

After the existing path-setup block (after line ~23), add:

```powershell
$manifestPath = Join-Path $repoRoot 'runtime\linux\vm-manifest.json'
$vmMemoryMb = 4096
$vmVcpu = 2
if (Test-Path $manifestPath) {
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.default_memory_mb) { $vmMemoryMb = [int]$manifest.default_memory_mb }
  if ($manifest.default_vcpu) { $vmVcpu = [int]$manifest.default_vcpu }
}
```

And change `$baseArgs`:

```powershell
$baseArgs = @(
  '-m', "$vmMemoryMb",
  '-smp', "$vmVcpu",
  '-display', 'none',
  '-drive', "file=$vmImage,if=virtio,format=qcow2",
  '-netdev', "user,id=net0,hostfwd=tcp::$sshPort-:22",
  '-device', 'virtio-net-pci,netdev=net0',
  '-smbios', "type=1,serial=ds=nocloud-net;s=http://10.0.2.2:$cloudInitPort/"
)
```

- [ ] **Step 6: Update README File Layout**

Remove the `profiles/` block (lines 272-275 of current README) and the `default_profile` mention if any. Also remove `apply-start-vm-port-fix` if mentioned.

- [ ] **Step 7: Verify nothing references the deleted pieces**

Run: `grep -rn "default_profile\|apply-start-vm-port-fix\|profiles/" scripts/ README.md .github/`
Expected: no matches (or only this plan file).
Run: `node --test tests/ && node --check scripts/pcoder.cjs && node scripts/pcoder.cjs doctor`
Expected: tests pass; doctor no longer checks `dir:profiles`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: remove dead patch script, vestigial profiles system, unused exports; single-source cloud-init user-data; honor vm-manifest memory/vcpu"
```

---

### Task 11: Add LICENSE

**Files:**
- Create: `LICENSE`

- [ ] **Step 1: Create MIT license**

```
MIT License

Copyright (c) 2026 Mike Jenkins

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Commit**

```bash
git add LICENSE
git commit -m "docs: add MIT license"
```

---

### Task 12: Auto-update bundled tools on launch

Implements `docs/superpowers/specs/2026-06-10-auto-update-design.md` (approach A, approved): on host-native launch, at most once per 24h per tool, check the npm registry (3s timeout, fail-open) and reinstall via the existing bootstrap if a newer version exists. On by default; `pcoder setup --auto-update false` or `PCODER_AUTO_UPDATE=0` disables.

**Files:**
- Modify: `scripts/pcoder.cjs` (new helpers, settings field, commandRun hook, help text)
- Modify: `scripts/runtime/bootstrap-host-native.cjs` (new `--no-node` flag)
- Modify: `.gitignore` (add `state/update-check.json`)
- Modify: `README.md` (document the feature)
- Test: `tests/pcoder.test.cjs`

- [ ] **Step 1: Write failing tests for the pure helpers**

Append to `tests/pcoder.test.cjs`:

```js
const { compareVersions, isUpdateCheckDue } = require('../scripts/pcoder.cjs');

test('compareVersions: numeric dotted-segment comparison', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.4', '1.2.3'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('3.0.0-beta', '3.0.0'), 0); // prerelease suffix ignored
});

test('isUpdateCheckDue: 24h window', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 1750000000000;
  assert.equal(isUpdateCheckDue(undefined, now), true);
  assert.equal(isUpdateCheckDue({}, now), true);
  assert.equal(isUpdateCheckDue({ last_check: now - DAY + 1 }, now), false);
  assert.equal(isUpdateCheckDue({ last_check: now - DAY }, now), true);
  assert.equal(isUpdateCheckDue({ last_check: 'garbage' }, now), true);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/`
Expected: FAIL — `compareVersions is not a function`.

- [ ] **Step 3: Implement the helpers in `scripts/pcoder.cjs`**

Add after the `refuseToolUpdate` function:

```js
const updateCheckPath = path.join(stateDir, 'update-check.json');
const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Compare dotted version strings numerically per segment ("1.10.0" > "1.9.9").
// Non-numeric suffixes in a segment are ignored ("3-beta" -> 3). Returns -1/0/1.
function compareVersions(a, b) {
  const pa = String(a).split('.').map((s) => parseInt(s, 10) || 0);
  const pb = String(b).split('.').map((s) => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

function isUpdateCheckDue(record, nowMs) {
  if (!record || typeof record.last_check !== 'number') return true;
  return (nowMs - record.last_check) >= AUTO_UPDATE_INTERVAL_MS;
}

function loadUpdateCheckState() {
  try {
    const raw = JSON.parse(fs.readFileSync(updateCheckPath, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (_) {
    return {};
  }
}

function saveUpdateCheckState(state) {
  try {
    ensureDir(stateDir);
    fs.writeFileSync(updateCheckPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch (_) {}
}

function readBundledToolVersion(tool, meta) {
  try {
    const pkgPath = path.join(
      getBundledToolDir(tool), 'node_modules', ...meta.npm_package.split('/'), 'package.json'
    );
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || null;
  } catch (_) {
    return null;
  }
}

function fetchLatestVersion(npmPackage) {
  const url = `https://registry.npmjs.org/${npmPackage}/latest`;
  const script = `fetch(${JSON.stringify(url)}).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then((j) => { if (!j.version) throw new Error('no version'); process.stdout.write(j.version); }).catch(() => process.exit(1));`;
  const result = cp.spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true
  });
  if (result.error || result.status !== 0 || !result.stdout) return null;
  const version = result.stdout.trim();
  return /^\d+\.\d+/.test(version) ? version : null;
}

// Approach A from docs/superpowers/specs/2026-06-10-auto-update-design.md:
// daily registry check, fail-open, reinstall via bootstrap before launch.
function maybeAutoUpdate(tool, meta, settings) {
  if (process.env.PCODER_AUTO_UPDATE === '0') return;
  if (settings.auto_update === false) return;
  if (!getBundledToolPath(tool)) return; // only bundled installs are ours to update

  const state = loadUpdateCheckState();
  if (!isUpdateCheckDue(state[tool], Date.now())) return;

  const installed = readBundledToolVersion(tool, meta);
  const latest = installed ? fetchLatestVersion(meta.npm_package) : null;

  state[tool] = { last_check: Date.now(), latest: latest || (state[tool] && state[tool].latest) || null };
  saveUpdateCheckState(state);

  if (!installed || !latest || compareVersions(latest, installed) <= 0) return;

  console.log(`Updating ${tool} ${installed} -> ${latest}...`);
  const bootstrapScript = path.join(repoRoot, 'scripts', 'runtime', 'bootstrap-host-native.cjs');
  const result = cp.spawnSync(process.execPath, [bootstrapScript, '--tool', tool, '--force', '--no-node'], {
    cwd: repoRoot,
    stdio: 'inherit'
  });
  if (result.error || result.status !== 0) {
    console.error(`Warning: auto-update of ${tool} failed; launching the installed version. Run 'pcoder runtime bootstrap-host-native --tool ${tool} --force' to retry.`);
  }
}
```

- [ ] **Step 4: Hook into commandRun (host-native path only)**

In `commandRun`, immediately before `const runner = resolveRunner(tool, mergedEnv);`:

```js
  maybeAutoUpdate(tool, meta, settings);
```

- [ ] **Step 5: Add the `auto_update` setting**

In `defaultSettings()` add `auto_update: true` after `default_tool`. In `normalizeSettings`, add to the base `settings` object `auto_update: defaults.auto_update`, and after the `default_tool` handling:

```js
  if (raw.auto_update !== undefined) {
    if (typeof raw.auto_update !== 'boolean') {
      fail('settings.auto_update must be true or false.');
    }
    settings.auto_update = raw.auto_update;
  }
```

In `parseSetupArgs`, add a parsed field `autoUpdate: undefined` and the flag:

```js
    if (arg === '--auto-update') {
      parsed.autoUpdate = parseBooleanFlagValue(args[i + 1], '--auto-update');
      parsed.persist = true;
      i += 1;
      continue;
    }
```

In `commandSetup`, after the `syncBack` block:

```js
  if (typeof parsed.autoUpdate === 'boolean') {
    changed = changed || settings.auto_update !== parsed.autoUpdate;
    settings.auto_update = parsed.autoUpdate;
  }
```

In `printSettings`, after the default tool line:

```js
  console.log(`  auto update: ${settings.auto_update === false ? 'false' : 'true'}`);
```

In `printHelp`, add `[--auto-update <true|false>]` to the setup flag list.

- [ ] **Step 6: Add `--no-node` to bootstrap-host-native.cjs**

In `parseArgs`, add `noNode: false` to the parsed object and:

```js
    if (arg === '--no-node') {
      parsed.noNode = true;
      continue;
    }
```

In `main`, replace the node-presence block:

```js
  const nodeExe = getBundledNodeExePath();
  if (parsed.noNode) {
    if (!fs.existsSync(nodeExe)) {
      fail('--no-node requires the bundled Node.js to already exist. Run the bootstrap without --no-node first.');
    }
    console.log(`Using existing bundled Node.js: ${nodeExe}`);
  } else if (!force && fs.existsSync(nodeExe)) {
    console.log(`Bundled Node.js already present: ${nodeExe}`);
    console.log('Use --force to re-download.');
  } else {
    downloadAndExtractNode(nodeUrl, platform);
  }
```

(`main` already destructures `parsed`; add `const noNode = parsed.noNode;` alongside the others or reference `parsed.noNode` directly as shown.)

- [ ] **Step 7: Export the new pure helpers**

Add `compareVersions` and `isUpdateCheckDue` to `module.exports` in `scripts/pcoder.cjs`.

- [ ] **Step 8: gitignore and README**

Append to `.gitignore`:

```
state/update-check.json
```

Add a README section after "Updating bundled tools":

```markdown
### Automatic updates

By default, `pcoder` checks npm for a newer version of the bundled tool at most once
per 24 hours when launching it (3-second timeout; if the registry is unreachable the
installed version launches immediately). When an update is found it is installed via
the safe bootstrap path before the tool starts.

```bat
REM Disable permanently
scripts\pcoder setup --auto-update false

REM Disable for one invocation
set PCODER_AUTO_UPDATE=0
```
```

Also add `PCODER_AUTO_UPDATE` to the Environment Variables table: `Set to 0 to skip the automatic update check for this invocation`.

- [ ] **Step 9: Run tests**

Run: `node --test tests/`
Expected: PASS, including the two new tests.

- [ ] **Step 10: Manual verification**

```bash
node scripts/pcoder.cjs setup --show          # shows "auto update: true"
node scripts/pcoder.cjs setup --auto-update false
node scripts/pcoder.cjs setup --show          # shows "auto update: false"
node scripts/pcoder.cjs setup --auto-update true
```

With a bundled tool installed: temporarily edit `runtime/claude/node_modules/@anthropic-ai/claude-code/package.json` version to `0.0.1`, delete `state/update-check.json`, run `node scripts/pcoder.cjs claude --version` and confirm `Updating claude 0.0.1 -> ...` followed by a reinstall and the real version printing.

- [ ] **Step 11: Commit**

```bash
git add scripts/pcoder.cjs scripts/runtime/bootstrap-host-native.cjs tests/pcoder.test.cjs .gitignore README.md
git commit -m "feat: auto-update bundled tools on launch (daily npm check, fail-open)"
```

---

### Task 13: Final verification sweep

- [ ] **Step 1: Full local check**

```bash
node --check scripts/pcoder.cjs
node --test tests/
node scripts/pcoder.cjs --help
node scripts/pcoder.cjs setup --init
node scripts/pcoder.cjs doctor
```

Expected: syntax ok, all tests pass, help prints, doctor passes (or fails only on missing tool runners if runtime isn't bootstrapped locally — `tool:*:runner` checks).

- [ ] **Step 2: Push the branch and confirm CI is green without any `|| true`**

(All tasks are executed on the `fix/review-findings` branch, created before Task 1 began.)

```bash
git push -u origin fix/review-findings
gh pr create --fill
gh run watch
```

Expected: lint, security, and test jobs all green; smoke test actually executes both tools.

---

## Self-Review Notes

- **Coverage:** every finding from the review maps to a task — exit codes (T2), arg quoting (T3), smoke-check syntax (T4), CI masking + model id + pinning (T9), checksums + fake retry (T8), tar excludes + bash dependency (T6), known_hosts inconsistency (T7), default-mode drift (T5), dead code/profiles/user-data duplication/manifest wiring (T10), LICENSE (T11), tests (T1, T3).
- **Not planned (deliberate):** the `pcoder <typo>` → "launch default tool with typo as prompt arg" passthrough is by design (it's how `pcoder --resume` works); the WHPX→TCG port-probe TOCTOU race is acceptable for a local dev VM; `pcoder setup --show` being a silent no-op flag is cosmetic.
- **Type consistency:** `spawnToolSync(runner, args, options)` signature used identically at all three call sites; `escapeCmdArg` exported in Task 3 and consumed by tests added in the same task.
