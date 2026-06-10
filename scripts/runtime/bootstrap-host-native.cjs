#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const {
  repoRoot, nodeDir, ensureDir, fail,
  getBundledNodeExePath, getBundledToolDir, getBundledToolBinPath, getBundledNpmCliPath
} = require('../lib/paths.cjs');

const NODE_VERSION = 'v22.14.0';
const tmpDir = path.join(repoRoot, 'state', 'tmp');
const catalogPath = path.join(__dirname, '..', 'adapters', 'catalog.json');

function loadCatalog() {
  try {
    return JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  } catch (error) {
    fail(`Failed to read ${catalogPath}: ${error.message}`);
  }
}

function installableTools(catalog) {
  return Object.entries(catalog)
    .filter(([, meta]) => meta && meta.npm_package)
    .map(([tool]) => tool);
}

function main(argv) {
  const catalog = loadCatalog();
  const installable = installableTools(catalog);

  const parsed = parseArgs(argv, installable);
  const force = parsed.force;
  const nodeOnly = parsed.nodeOnly;
  const noNode = parsed.noNode;
  const requestedTools = parsed.tools;

  ensureDir(tmpDir);

  const platform = process.platform;
  const arch = process.arch;
  const nodeUrl = buildNodeUrl(platform, arch);

  console.log(`Platform: ${platform}/${arch}`);
  console.log(`Node.js:  ${NODE_VERSION}`);
  if (!nodeOnly) {
    console.log(`Tools:    ${requestedTools.join(', ')}`);
  }
  console.log('');

  const nodeExe = getBundledNodeExePath();
  if (noNode) {
    if (!fs.existsSync(nodeExe)) {
      fail(
        '--no-node requires the bundled Node.js to already exist. Run the bootstrap without --no-node first.'
      );
    }
    console.log(`Using existing bundled Node.js: ${nodeExe}`);
  } else if (!force && fs.existsSync(nodeExe)) {
    console.log(`Bundled Node.js already present: ${nodeExe}`);
    console.log('Use --force to re-download.');
  } else {
    downloadAndExtractNode(nodeUrl, platform);
  }

  if (!fs.existsSync(getBundledNodeExePath())) {
    fail(`Node.js bootstrap failed — expected binary not found: ${getBundledNodeExePath()}`);
  }

  const version = cp.execSync(`"${getBundledNodeExePath()}" --version`, { encoding: 'utf8' }).trim();
  console.log(`Bundled Node.js version: ${version}`);
  console.log('');

  if (nodeOnly) {
    console.log('--node-only: skipping tool installs.');
    return;
  }

  for (const tool of requestedTools) {
    installTool(tool, catalog[tool], force);
  }

  console.log('');
  console.log('Host-native bootstrap complete.');
  console.log(`  node:   ${getBundledNodeExePath()}`);
  for (const tool of requestedTools) {
    const meta = catalog[tool];
    console.log(`  ${tool.padEnd(6)}: ${getBundledToolBinPath(tool, meta.bin_name)}`);
  }
  console.log('');
  console.log('Next: scripts/pcoder (will auto-detect bundled runtime)');
}

function parseArgs(argv, installable) {
  const parsed = { force: false, nodeOnly: false, noNode: false, tools: ['claude'] };
  let toolsExplicit = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') {
      parsed.force = true;
      continue;
    }
    if (arg === '--node-only') {
      parsed.nodeOnly = true;
      continue;
    }
    if (arg === '--no-node') {
      parsed.noNode = true;
      continue;
    }
    if (arg === '--tool') {
      const value = argv[i + 1];
      if (!value) {
        fail('--tool requires a value (one of: ' + installable.concat(['all']).join(', ') + ')');
      }
      i += 1;
      toolsExplicit = true;
      if (value === 'all') {
        parsed.tools = installable.slice();
      } else {
        const requested = value.split(',').map((s) => s.trim()).filter(Boolean);
        for (const t of requested) {
          if (!installable.includes(t)) {
            fail(`Unknown tool '${t}'. Supported: ${installable.concat(['all']).join(', ')}`);
          }
        }
        parsed.tools = requested;
      }
      continue;
    }
    fail(`Unknown bootstrap flag: ${arg}`);
  }

  if (!toolsExplicit) {
    // Default: install claude only (preserve historical behavior).
    parsed.tools = ['claude'];
  }
  return parsed;
}

function installTool(tool, meta, force) {
  if (!meta || !meta.npm_package) {
    fail(`Tool '${tool}' is not installable (missing npm_package in catalog).`);
  }

  const toolDir = getBundledToolDir(tool);
  const toolBin = getBundledToolBinPath(tool, meta.bin_name);

  if (!force && fs.existsSync(toolBin)) {
    console.log(`Bundled ${meta.display_name} already present: ${toolBin}`);
    console.log('Use --force to re-install.');
  } else {
    installNpmPackage(toolDir, meta.npm_package, meta.display_name);
  }

  if (!fs.existsSync(toolBin)) {
    fail(`${meta.display_name} install failed — expected binary not found: ${toolBin}`);
  }

  try {
    // On Windows toolBin is a .cmd shim — Node can't execute batch files, so
    // run it through the shell directly (execSync always uses a shell).
    const probe =
      process.platform === 'win32'
        ? `"${toolBin}" --version`
        : `"${getBundledNodeExePath()}" "${toolBin}" --version`;
    const out = cp.execSync(probe, { encoding: 'utf8', timeout: 30000 }).trim();
    console.log(`Bundled ${meta.display_name} version: ${out}`);
  } catch (_) {
    console.log(`Bundled ${meta.display_name} installed (version check skipped).`);
  }
}

function installNpmPackage(targetDir, pkg, displayName) {
  const nodeExe = getBundledNodeExePath();
  const npmCli = getBundledNpmCliPath();

  if (!fs.existsSync(npmCli)) {
    fail(`npm not found at ${npmCli}. Node.js may not have been extracted correctly.`);
  }

  ensureDir(targetDir);

  // Install pkg@latest explicitly so re-running bootstrap (e.g. after `pcoder
  // runtime bootstrap-host-native --tool <tool> --force`) actually pulls the
  // newest published version, not whatever satisfies the semver range already
  // pinned in the bundled package.json.
  const pkgSpec = pkg.includes('@', 1) ? pkg : `${pkg}@latest`;
  console.log(`Installing ${pkgSpec} (${displayName})...`);
  const sep = process.platform === 'win32' ? ';' : ':';
  const result = cp.spawnSync(nodeExe, [npmCli, 'install', '--prefix', targetDir, pkgSpec], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, PATH: path.dirname(nodeExe) + sep + (process.env.PATH || '') }
  });

  if (result.error) {
    fail(`npm install failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`npm install failed with exit code ${result.status}.`);
  }

  console.log(`${displayName} installed.`);
}

function buildNodeUrl(platform, arch) {
  const base = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}`;
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  if (platform === 'win32') return `${base}-win-${a}.zip`;
  if (platform === 'darwin') return `${base}-darwin-${a}.tar.gz`;
  return `${base}-linux-${a}.tar.xz`;
}

function downloadAndExtractNode(url, platform) {
  const fileName = path.basename(url);
  const downloadPath = path.join(tmpDir, fileName);

  const shasumsUrl = `https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`;
  const shasumsPath = path.join(tmpDir, 'node-SHASUMS256.txt');
  console.log(`Downloading Node.js from ${url}...`);
  downloadFilesSync([
    { url, dest: downloadPath },
    { url: shasumsUrl, dest: shasumsPath }
  ]);
  console.log(`Downloaded: ${downloadPath}`);
  verifyNodeChecksum(downloadPath, fileName, shasumsPath);

  if (fs.existsSync(nodeDir)) {
    fs.rmSync(nodeDir, { recursive: true, force: true });
  }
  ensureDir(nodeDir);

  console.log('Extracting...');
  const extractDir = path.join(tmpDir, 'node-extract');
  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
  ensureDir(extractDir);

  if (platform === 'win32') {
    try {
      cp.execSync(`tar -xf "${downloadPath}" -C "${extractDir}"`, { stdio: 'pipe' });
    } catch (_) {
      cp.execSync(
        `powershell -NoProfile -Command "Expand-Archive -Path '${downloadPath}' -DestinationPath '${extractDir}' -Force"`,
        { stdio: 'pipe' }
      );
    }
  } else if (url.endsWith('.tar.xz')) {
    cp.execSync(`tar -xJf "${downloadPath}" -C "${extractDir}"`, { stdio: 'pipe' });
  } else {
    cp.execSync(`tar -xzf "${downloadPath}" -C "${extractDir}"`, { stdio: 'pipe' });
  }

  const entries = fs.readdirSync(extractDir);
  const nodeExtracted = entries.find((e) => e.startsWith('node-'));
  if (!nodeExtracted) {
    fail(`Could not find extracted Node.js directory in ${extractDir}`);
  }

  const extractedPath = path.join(extractDir, nodeExtracted);
  moveContents(extractedPath, nodeDir);
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.rmSync(downloadPath, { force: true });

  console.log(`Node.js extracted to ${nodeDir}`);
}

// Download one or more files in a single child process (each with 3 retry
// attempts). Batching into one child matters: repeated spawnSync calls hit a
// libuv assertion on Windows under some Node versions (observed on v25).
function downloadFilesSync(files) {
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

    async function downloadWithRetry(target, dest) {
      let lastError = null;
      for (let i = 0; i < 3; i++) {
        try {
          await attempt(target, dest);
          return;
        } catch (e) {
          lastError = e;
          process.stderr.write('\\n  attempt ' + (i + 1) + ' failed for ' + target + ': ' + e.message + (e.cause ? ' (' + (e.cause.code || e.cause.message) + ')' : '') + '\\n');
          if (i < 2) {
            await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
          }
        }
      }
      throw new Error('download failed: ' + target + ': ' + lastError.message);
    }

    (async () => {
      const files = ${JSON.stringify(files)};
      for (const f of files) {
        await downloadWithRetry(f.url, f.dest);
      }
      process.exit(0);
    })().catch((e) => { console.error(e.message); process.exit(1); });
  `;
  const result = cp.spawnSync(process.execPath, ['-e', script], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.status !== 0) {
    fail(`Download failed: ${files.map((f) => f.url).join(', ')}`);
  }
}

function downloadFileSync(url, dest) {
  downloadFilesSync([{ url, dest }]);
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function verifyNodeChecksum(downloadPath, fileName, shasumsPath) {
  const line = fs.readFileSync(shasumsPath, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().endsWith(fileName));
  if (!line) {
    fail(`No checksum entry for ${fileName} in ${shasumsPath}`);
  }
  const expected = line.trim().split(/\s+/)[0].toLowerCase();
  const actual = sha256File(downloadPath);
  if (actual !== expected) {
    fail(`Node.js download checksum mismatch for ${fileName}: expected ${expected}, got ${actual}`);
  }
  console.log('Checksum verified (SHA-256).');
}

function moveContents(src, dest) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    fs.renameSync(path.join(src, entry.name), path.join(dest, entry.name));
  }
}

main(process.argv.slice(2));
