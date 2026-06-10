#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const {
  getBundledToolBinPath,
  getBundledNodeExePath,
  getBundledToolDir
} = require('./lib/paths.cjs');

const repoRoot = path.resolve(__dirname, '..');
const stateDir = path.join(repoRoot, 'state');
const settingsPath = path.join(stateDir, 'settings.json');
const authStateRoot = path.join(stateDir, 'auth');
const vmManifestPath = path.join(repoRoot, 'runtime', 'linux', 'vm-manifest.json');
const vmStateDir = path.join(repoRoot, 'state', 'vm');
const vmSshPortPath = path.join(vmStateDir, 'ssh-port.txt');
const catalogPath = path.join(__dirname, 'adapters', 'catalog.json');
const runModeValues = new Set(['linux-portable', 'host-native', 'linux-wsl']);
const windowsDefaultModeValues = new Set(['linux-portable', 'host-native']);
const authModeValues = new Set(['oauth', 'api']);
const SYNC_EXCLUDES = ['runtime', 'state', '.git', 'node_modules'];

const CATALOG = loadCatalog();
const SUPPORTED_TOOLS = Object.entries(CATALOG)
  .filter(([, meta]) => meta && meta.npm_package)
  .map(([tool]) => tool);
const DEFAULT_TOOL = SUPPORTED_TOOLS.includes('claude') ? 'claude' : SUPPORTED_TOOLS[0];

function loadCatalog() {
  try {
    return JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  } catch (error) {
    console.error(`Error: failed to read ${catalogPath}: ${error.message}`);
    process.exit(1);
  }
}

function getToolMeta(tool) {
  const meta = CATALOG[tool];
  if (!meta) {
    fail(`Unknown tool '${tool}'. Supported: ${SUPPORTED_TOOLS.join(', ')}`);
  }
  return meta;
}

function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'doctor':
      commandDoctor();
      return;
    case 'setup':
      commandSetup(rest);
      return;
    case 'auth':
      commandAuth(rest);
      return;
    case 'runtime':
      commandRuntime(rest);
      return;
    case 'run':
      commandRun(rest);
      return;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
    case undefined:
      commandRun([]);
      return;
    default:
      // Tool name as command: `pcoder claude ...` or `pcoder codex ...`
      if (SUPPORTED_TOOLS.includes(command)) {
        commandRun(['--tool', command, ...rest]);
        return;
      }
      // Otherwise pass through to the default tool (preserves `pcoder --resume`, etc.).
      commandRun([command, ...rest]);
  }
}

function printHelp() {
  console.log('Portable AI Coding CLI Launcher');
  console.log('');
  console.log('Usage:');
  console.log('  pcoder                          Launch default tool in current directory');
  console.log('  pcoder <tool> [args...]         Launch a specific tool (e.g. pcoder codex)');
  console.log('  pcoder [-- <tool args...>]      Launch default tool with extra args');
  console.log('  pcoder doctor                   Check environment health');
  console.log('  pcoder setup [--init]           Initialize or show settings');
  console.log('    [--claude-auth <oauth|api>]');
  console.log('    [--codex-auth <oauth|api>]');
  console.log('    [--default-tool <claude|codex>]');
  console.log('    [--windows-mode <linux-portable|host-native>]');
  console.log('    [--sync-back <true|false>]');
  console.log('    [--auto-update <true|false>]');
  console.log('    [--show]');
  console.log('  pcoder auth status              Show auth status (all tools)');
  console.log('  pcoder auth login [--tool <claude|codex>]    Log in via OAuth');
  console.log('  pcoder auth logout [--tool <claude|codex>]   Log out');
  console.log('  pcoder runtime probe            Probe available runtimes');
  console.log('  pcoder runtime bootstrap        Download/install Windows VM runtime');
  console.log('  pcoder runtime bootstrap-host-native [--tool <claude|codex|all>]');
  console.log('  pcoder run [--tool <claude|codex>]');
  console.log('             [--mode <linux-portable|host-native>]');
  console.log('             [--project <path>] [--no-sync-back] [-- <tool args...>]');
  console.log('');
  console.log('Supported tools:');
  for (const tool of SUPPORTED_TOOLS) {
    console.log(`  ${tool.padEnd(8)} - ${CATALOG[tool].display_name}`);
  }
  console.log('');
  console.log('Auth modes:');
  console.log("  oauth  - use the tool's native OAuth login (credentials stored portably)");
  console.log("  api    - inject the tool's API key env var at launch time");
  console.log('');
  console.log('Run modes:');
  console.log('  host-native     - run the tool directly on host (uses bundled or system binary)');
  console.log(
    '  linux-portable  - run inside the bundled QEMU Linux VM (Windows only; claude only)'
  );
  console.log('');
  console.log('Updating bundled tools:');
  console.log("  Use the bootstrap, not the tools' built-in self-updaters:");
  console.log('    pcoder runtime bootstrap-host-native --tool <claude|codex|all> --force');
  console.log('  pcoder refuses `claude --update`, `claude update`, `codex update`, etc.');
  console.log('  because they corrupt the bundled install. Set PCODER_ALLOW_TOOL_UPDATE=1');
  console.log('  to bypass (not recommended).');
}

function commandDoctor() {
  const checks = [];
  const requiredDirs = ['runtime', 'state', 'scripts'];
  for (const rel of requiredDirs) {
    const abs = path.join(repoRoot, rel);
    checks.push({
      label: `dir:${rel}`,
      ok: fs.existsSync(abs) && fs.statSync(abs).isDirectory(),
      detail: abs
    });
  }

  const settings = loadSettings();

  checks.push({
    label: 'settings:file',
    ok: settingsFileExists(),
    detail: settingsFileExists()
      ? path.relative(repoRoot, settingsPath)
      : "missing (run 'pcoder setup --init')"
  });

  checks.push({
    label: 'settings:default-tool',
    ok: SUPPORTED_TOOLS.includes(settings.default_tool),
    detail: settings.default_tool
  });

  checks.push({
    label: 'settings:auto-update',
    ok: true,
    detail: settings.auto_update === false ? 'false' : 'true'
  });

  for (const tool of SUPPORTED_TOOLS) {
    const meta = CATALOG[tool];
    const authMode = settings.auth[tool] || 'oauth';
    const runner = resolveRunner(tool, process.env);
    checks.push({
      label: `tool:${tool}:runner`,
      ok: Boolean(runner),
      detail: runner
        ? `${runner} (auth=${authMode})`
        : `not found — run 'pcoder runtime bootstrap-host-native --tool ${tool}' or set ${meta.command_env}`
    });

    if (authMode === 'api') {
      const keyEnv = meta.api_key_env;
      const aliasEnv = meta.api_key_alias_env;
      const hasKey = Boolean(process.env[keyEnv] || (aliasEnv && process.env[aliasEnv]));
      checks.push({
        label: `${tool}:api-key`,
        ok: hasKey,
        detail: hasKey
          ? `${keyEnv}${aliasEnv ? ` or ${aliasEnv}` : ''} set`
          : `missing ${keyEnv} (api auth mode)`
      });
    } else {
      const authPaths = getPortableHostAuthPaths(tool);
      checks.push({
        label: `${tool}:oauth`,
        ok: true,
        detail: `oauth home: ${path.relative(repoRoot, authPaths.home)}`
      });
    }
  }

  let failed = 0;
  for (const check of checks) {
    if (check.ok) {
      console.log(`[ok]   ${check.label} -> ${check.detail}`);
    } else {
      failed += 1;
      console.log(`[fail] ${check.label} -> ${check.detail}`);
    }
  }

  if (failed > 0) {
    process.exitCode = 2;
    console.log(`\nDoctor completed with ${failed} failed check(s).`);
    console.log("Run 'pcoder setup --init' for first-time setup.");
    return;
  }

  console.log('\nDoctor completed: all checks passed.');
}

function commandSetup(args) {
  const parsed = parseSetupArgs(args);
  const hadSettings = settingsFileExists();
  const settings = parsed.init ? defaultSettings() : loadSettings();
  let changed = parsed.init;

  if (parsed.claudeAuth) {
    changed = changed || settings.auth.claude !== parsed.claudeAuth;
    settings.auth.claude = parsed.claudeAuth;
  }
  if (parsed.codexAuth) {
    changed = changed || settings.auth.codex !== parsed.codexAuth;
    settings.auth.codex = parsed.codexAuth;
  }
  if (parsed.defaultTool) {
    changed = changed || settings.default_tool !== parsed.defaultTool;
    settings.default_tool = parsed.defaultTool;
  }
  if (parsed.windowsMode) {
    changed = changed || settings.runtime.windows_default_mode !== parsed.windowsMode;
    settings.runtime.windows_default_mode = parsed.windowsMode;
  }
  if (typeof parsed.syncBack === 'boolean') {
    changed = changed || settings.runtime.sync_back_default !== parsed.syncBack;
    settings.runtime.sync_back_default = parsed.syncBack;
  }
  if (typeof parsed.autoUpdate === 'boolean') {
    changed = changed || settings.auto_update !== parsed.autoUpdate;
    settings.auto_update = parsed.autoUpdate;
  }

  const shouldSave = changed || parsed.persist;
  if (shouldSave) {
    saveSettings(settings);
  }

  if (shouldSave) {
    console.log('Setup saved to state/settings.json');
    console.log('');
  } else if (!hadSettings) {
    console.log(
      "Settings not initialized yet. Run 'pcoder setup --init' to create state/settings.json."
    );
    console.log('');
  }
  printSettings(settings, hadSettings || shouldSave);
}

function commandAuth(args) {
  const action = args[0];
  const hasSettings = settingsFileExists();
  const settings = hasSettings ? loadSettings() : defaultSettings();

  if (!action || action === 'status') {
    printAuthStatus(settings, hasSettings);
    return;
  }

  if (action !== 'login' && action !== 'logout') {
    fail(
      'Usage: pcoder auth <status|login|logout> [--tool <claude|codex>] [--mode <linux-portable|host-native>]'
    );
  }
  if (!hasSettings) {
    fail("Settings not initialized. Run 'pcoder setup --init' before auth login/logout.");
  }

  const parsed = parseAuthArgs(args.slice(1));
  const tool = resolveTool(parsed.tool, settings);
  const meta = getToolMeta(tool);
  const mode = resolveRunMode(parsed.mode, settings);
  const authMode = settings.auth[tool] || 'oauth';

  if (action === 'login' && authMode === 'api') {
    console.log(`[warn] ${tool} auth mode is api; OAuth login is optional.`);
  }

  // For the duration of the auth subcommand, force oauth env wiring so the
  // tool writes credentials into our portable auth home rather than relying
  // on an API key.
  const authCommandSettings = {
    ...settings,
    auth: { ...settings.auth, [tool]: 'oauth' }
  };

  if (mode === 'linux-portable') {
    if (!meta.vm_supported) {
      fail(`linux-portable mode is not supported for tool '${tool}'. Use --mode host-native.`);
    }
    runInLinuxPortableVm({
      tool,
      projectPath: repoRoot,
      mergedEnv: applyPortableHostAuthEnv({ ...process.env }, authCommandSettings, tool),
      toolArgs: [action],
      noSyncBack: true,
      skipProjectSync: true,
      authMode: 'oauth',
      settings
    });
    return;
  }

  if (mode === 'linux-wsl') {
    fail('linux-wsl mode is not implemented yet. Use --mode linux-portable or --mode host-native.');
  }

  if (mode !== 'host-native') {
    fail(`Unsupported auth mode target '${mode}'.`);
  }

  const env = applyPortableHostAuthEnv({ ...process.env }, authCommandSettings, tool);
  const runner = resolveRunner(tool, env);
  if (!runner) {
    fail(
      `No ${tool} executable found. Run 'pcoder runtime bootstrap-host-native --tool ${tool}' or set ${meta.command_env}.`
    );
  }
  applyBundledNodePath(env);
  applyClaudeWindowsShellEnv(env, tool);

  const result = spawnToolSync(runner, [action], {
    cwd: repoRoot,
    stdio: 'inherit',
    env
  });
  if (result.error) {
    fail(`Failed to run ${tool} ${action}: ${result.error.message}`);
  }
  process.exitCode = typeof result.status === 'number' ? result.status : 1;
}

function commandRuntime(args) {
  const action = args[0];
  if (!action || action === 'probe') {
    commandRuntimeProbe();
    return;
  }
  if (action === 'bootstrap' || action === 'install') {
    commandRuntimeBootstrap(args.slice(1));
    return;
  }
  if (action === 'bootstrap-host-native' || action === 'bootstrap-host') {
    commandRuntimeBootstrapHostNative(args.slice(1));
    return;
  }
  fail('Usage: pcoder runtime <probe|bootstrap|bootstrap-host-native>');
}

function commandRuntimeProbe() {
  const probes = [
    { key: 'bundled-qemu', cmd: path.join(repoRoot, 'runtime', 'qemu', 'qemu-system-x86_64.exe') },
    { key: 'wsl', cmd: 'wsl' },
    { key: 'proot', cmd: 'proot' },
    { key: 'docker', cmd: 'docker' },
    { key: 'podman', cmd: 'podman' },
    { key: 'limactl', cmd: 'limactl' },
    { key: 'qemu-system-x86_64', cmd: 'qemu-system-x86_64' }
  ];

  console.log(`host_platform=${process.platform}`);
  for (const probe of probes) {
    console.log(`${probe.key}=${commandOrPathExists(probe.cmd) ? 'yes' : 'no'}`);
  }

  const recommendation = recommendRuntimeBackend(process.platform, probes);
  console.log(`recommended_backend=${recommendation}`);
  if (process.platform === 'win32') {
    console.log('vm_accel_policy=try_whpx_then_fallback_tcg');
  }
}

function commandRuntimeBootstrap(args) {
  if (process.platform !== 'win32') {
    fail('runtime bootstrap is currently implemented for Windows hosts only.');
  }

  const supported = new Set(['--force']);
  for (const arg of args) {
    if (!supported.has(arg)) {
      fail(`Unknown runtime bootstrap flag: ${arg}`);
    }
  }

  const bootstrapScript = path.join(
    repoRoot,
    'scripts',
    'runtime',
    'windows',
    'bootstrap-runtime.cmd'
  );
  if (!fs.existsSync(bootstrapScript)) {
    fail(`Missing runtime bootstrap script: ${bootstrapScript}`);
  }

  const cmdArgs = ['/c', bootstrapScript];
  if (args.includes('--force')) {
    cmdArgs.push('--force');
  }

  const result = cp.spawnSync('cmd.exe', cmdArgs, {
    cwd: repoRoot,
    stdio: 'inherit'
  });
  if (result.error) {
    fail(`Failed to execute runtime bootstrap script: ${result.error.message}`);
  }
  process.exitCode = typeof result.status === 'number' ? result.status : 1;
}

function commandRuntimeBootstrapHostNative(args) {
  const bootstrapScript = path.join(repoRoot, 'scripts', 'runtime', 'bootstrap-host-native.cjs');
  if (!fs.existsSync(bootstrapScript)) {
    fail(`Missing bootstrap script: ${bootstrapScript}`);
  }
  const nodeExe = process.execPath;
  const result = cp.spawnSync(nodeExe, [bootstrapScript, ...args], {
    cwd: repoRoot,
    stdio: 'inherit'
  });
  if (result.error) {
    fail(`Failed to execute host-native bootstrap: ${result.error.message}`);
  }
  process.exitCode = typeof result.status === 'number' ? result.status : 1;
}

function recommendRuntimeBackend(platform, probes) {
  const available = new Set(probes.filter((p) => commandOrPathExists(p.cmd)).map((p) => p.key));
  if (platform === 'win32') {
    if (available.has('bundled-qemu') || available.has('qemu-system-x86_64')) {
      return 'bundled-vm-qemu-auto-accel-fallback';
    }
    if (available.has('wsl')) {
      return 'wsl-optional-no-bundled-engine';
    }
    return 'bundled-vm-qemu-missing';
  }

  if (platform === 'darwin') {
    if (available.has('limactl')) {
      return 'lima-vm';
    }
    if (available.has('docker')) {
      return 'docker-vm';
    }
    return 'host-native-fallback';
  }

  if (platform === 'linux') {
    if (available.has('proot')) {
      return 'proot-userspace';
    }
    if (available.has('podman')) {
      return 'podman-container';
    }
    if (available.has('docker')) {
      return 'docker-container';
    }
    return 'host-native-fallback';
  }

  return 'host-native-fallback';
}

function commandRun(args) {
  const parsed = parseRunArgs(args);
  const settings = loadSettings();
  const tool = resolveTool(parsed.tool, settings);
  const meta = getToolMeta(tool);

  if (!process.env.PCODER_ALLOW_TOOL_UPDATE && isToolUpdateInvocation(tool, parsed.toolArgs)) {
    refuseToolUpdate(tool, parsed.toolArgs[0]);
    return;
  }

  const mergedEnv = { ...process.env };
  const authMode = settings.auth[tool] || 'oauth';
  applyPortableHostAuthEnv(mergedEnv, settings, tool);
  applyAuthCompatibilityEnv(mergedEnv, tool);

  if (authMode === 'api') {
    const keyEnv = meta.api_key_env;
    const aliasEnv = meta.api_key_alias_env;
    const hasKey = Boolean(mergedEnv[keyEnv] || (aliasEnv && mergedEnv[aliasEnv]));
    if (!hasKey) {
      fail(
        `${tool} auth mode is 'api' but ${keyEnv} is not set. Set the env var or switch to oauth with 'pcoder setup --${tool}-auth oauth'.`
      );
    }
  }

  const projectPath = parsed.project ? path.resolve(parsed.project) : process.cwd();
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    fail(`Project path does not exist or is not a directory: ${projectPath}`);
  }

  const mode = resolveRunMode(parsed.mode, settings, tool);
  const noSyncBack =
    parsed.noSyncBack === true ? true : !Boolean(settings.runtime.sync_back_default);

  if (mode === 'linux-portable') {
    if (!meta.vm_supported) {
      fail(`linux-portable mode is not supported for tool '${tool}'. Use --mode host-native.`);
    }
    runInLinuxPortableVm({
      tool,
      projectPath,
      mergedEnv,
      toolArgs: parsed.toolArgs,
      noSyncBack,
      skipProjectSync: false,
      authMode,
      settings
    });
    return;
  }

  if (mode === 'linux-wsl') {
    fail('linux-wsl mode is not implemented yet. Use --mode linux-portable or --mode host-native.');
  }

  if (mode !== 'host-native') {
    fail(`Unsupported run mode '${mode}'. Supported modes: linux-portable, host-native`);
  }

  maybeAutoUpdate(tool, meta, settings, mergedEnv);
  const runner = resolveRunner(tool, mergedEnv);
  if (!runner) {
    fail(
      `No ${tool} executable found. Run 'pcoder runtime bootstrap-host-native --tool ${tool}' to install, or set ${meta.command_env}.`
    );
  }

  applyBundledNodePath(mergedEnv);
  applyClaudeWindowsShellEnv(mergedEnv, tool);

  const result = spawnToolSync(runner, parsed.toolArgs, {
    cwd: projectPath,
    stdio: 'inherit',
    env: mergedEnv
  });

  if (result.error) {
    fail(`Failed to launch '${runner}': ${result.error.message}`);
  }

  process.exitCode = typeof result.status === 'number' ? result.status : 1;
}

function parseRunArgs(args) {
  const parsed = { project: null, mode: null, tool: null, noSyncBack: false, toolArgs: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') {
      parsed.toolArgs = parsed.toolArgs.concat(args.slice(i + 1));
      return parsed;
    }
    if (arg === '--project') {
      parsed.project = args[i + 1] || null;
      i += 1;
      continue;
    }
    if (arg === '--mode') {
      parsed.mode = args[i + 1] || null;
      i += 1;
      continue;
    }
    if (arg === '--tool') {
      parsed.tool = args[i + 1] || null;
      i += 1;
      continue;
    }
    if (arg === '--no-sync-back') {
      parsed.noSyncBack = true;
      continue;
    }
    parsed.toolArgs.push(arg);
  }
  return parsed;
}

function parseSetupArgs(args) {
  const parsed = {
    init: false,
    claudeAuth: null,
    codexAuth: null,
    defaultTool: null,
    windowsMode: null,
    syncBack: undefined,
    autoUpdate: undefined,
    persist: false
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--init') {
      parsed.init = true;
      parsed.persist = true;
      continue;
    }
    if (arg === '--show') {
      continue;
    }
    if (arg === '--claude-auth') {
      parsed.claudeAuth = normalizeAuthModeValue(args[i + 1], '--claude-auth');
      parsed.persist = true;
      i += 1;
      continue;
    }
    if (arg === '--codex-auth') {
      parsed.codexAuth = normalizeAuthModeValue(args[i + 1], '--codex-auth');
      parsed.persist = true;
      i += 1;
      continue;
    }
    if (arg === '--default-tool') {
      parsed.defaultTool = normalizeToolValue(args[i + 1], '--default-tool');
      parsed.persist = true;
      i += 1;
      continue;
    }
    if (arg === '--windows-mode') {
      parsed.windowsMode = normalizeWindowsModeValue(args[i + 1], '--windows-mode');
      parsed.persist = true;
      i += 1;
      continue;
    }
    if (arg === '--sync-back') {
      parsed.syncBack = parseBooleanFlagValue(args[i + 1], '--sync-back');
      parsed.persist = true;
      i += 1;
      continue;
    }
    if (arg === '--auto-update') {
      parsed.autoUpdate = parseBooleanFlagValue(args[i + 1], '--auto-update');
      parsed.persist = true;
      i += 1;
      continue;
    }
    fail(`Unknown setup flag: ${arg}`);
  }
  return parsed;
}

function parseAuthArgs(args) {
  const parsed = { mode: null, tool: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--mode') {
      parsed.mode = args[i + 1] || null;
      i += 1;
      continue;
    }
    if (arg === '--tool') {
      parsed.tool = args[i + 1] || null;
      i += 1;
      continue;
    }
    fail(`Unknown auth flag: ${arg}`);
  }
  return parsed;
}

function parseBooleanFlagValue(rawValue, flagName) {
  const normalized = String(rawValue || '')
    .trim()
    .toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  fail(`Flag ${flagName} expects true or false.`);
}

function normalizeAuthModeValue(rawValue, context) {
  const value = String(rawValue || '')
    .trim()
    .toLowerCase();
  if (!authModeValues.has(value)) {
    fail(`${context} must be one of: oauth, api`);
  }
  return value;
}

function normalizeToolValue(rawValue, context) {
  const value = String(rawValue || '')
    .trim()
    .toLowerCase();
  if (!SUPPORTED_TOOLS.includes(value)) {
    fail(`${context} must be one of: ${SUPPORTED_TOOLS.join(', ')}`);
  }
  return value;
}

function normalizeRunModeValue(rawValue, context) {
  const value = String(rawValue || '').trim();
  if (!runModeValues.has(value)) {
    fail(`${context} must be one of: linux-portable, host-native, linux-wsl`);
  }
  return value;
}

function normalizeWindowsModeValue(rawValue, context) {
  const value = normalizeRunModeValue(rawValue, context);
  if (!windowsDefaultModeValues.has(value)) {
    fail(`${context} must be one of: linux-portable, host-native`);
  }
  return value;
}

function defaultSettings() {
  const auth = {};
  for (const tool of SUPPORTED_TOOLS) {
    auth[tool] = 'oauth';
  }
  return {
    version: 1,
    default_tool: DEFAULT_TOOL,
    auto_update: true,
    auth,
    runtime: {
      windows_default_mode: 'host-native',
      sync_back_default: true
    }
  };
}

function settingsFileExists() {
  return fs.existsSync(settingsPath);
}

function loadSettings() {
  if (!settingsFileExists()) {
    return defaultSettings();
  }
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    fail(`Invalid JSON in ${path.relative(repoRoot, settingsPath)}: ${error.message}`);
  }
  return normalizeSettings(raw);
}

function normalizeSettings(raw) {
  const defaults = defaultSettings();
  const settings = {
    version: defaults.version,
    default_tool: defaults.default_tool,
    auto_update: defaults.auto_update,
    auth: { ...defaults.auth },
    runtime: { ...defaults.runtime }
  };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`Settings file ${path.relative(repoRoot, settingsPath)} must contain a JSON object.`);
  }

  if (raw.default_tool !== undefined) {
    settings.default_tool = normalizeToolValue(raw.default_tool, 'settings.default_tool');
  }

  if (raw.auto_update !== undefined) {
    if (typeof raw.auto_update !== 'boolean') {
      fail('settings.auto_update must be true or false.');
    }
    settings.auto_update = raw.auto_update;
  }

  if (raw.auth !== undefined) {
    if (!raw.auth || typeof raw.auth !== 'object' || Array.isArray(raw.auth)) {
      fail('settings.auth must be an object when present.');
    }
    for (const tool of SUPPORTED_TOOLS) {
      if (raw.auth[tool] !== undefined) {
        settings.auth[tool] = normalizeAuthModeValue(raw.auth[tool], `settings.auth.${tool}`);
      }
    }
  }

  if (raw.runtime !== undefined) {
    if (!raw.runtime || typeof raw.runtime !== 'object' || Array.isArray(raw.runtime)) {
      fail('settings.runtime must be an object when present.');
    }
    if (raw.runtime.windows_default_mode !== undefined) {
      settings.runtime.windows_default_mode = normalizeWindowsModeValue(
        raw.runtime.windows_default_mode,
        'settings.runtime.windows_default_mode'
      );
    }
    if (raw.runtime.sync_back_default !== undefined) {
      if (typeof raw.runtime.sync_back_default !== 'boolean') {
        fail('settings.runtime.sync_back_default must be true or false.');
      }
      settings.runtime.sync_back_default = raw.runtime.sync_back_default;
    }
  }

  return settings;
}

function saveSettings(settings) {
  ensureDir(stateDir);
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function printSettings(settings, initialized) {
  console.log('Settings');
  console.log(`  initialized: ${initialized ? 'yes' : 'no'}`);
  console.log(`  default tool: ${settings.default_tool}`);
  console.log(`  auto update: ${settings.auto_update === false ? 'false' : 'true'}`);
  for (const tool of SUPPORTED_TOOLS) {
    console.log(`  ${tool} auth: ${settings.auth[tool] || 'oauth'}`);
  }
  console.log(`  windows default mode: ${settings.runtime.windows_default_mode}`);
  console.log(`  sync back default: ${settings.runtime.sync_back_default ? 'true' : 'false'}`);
  console.log(`  settings file: ${path.relative(repoRoot, settingsPath)}`);
}

function printAuthStatus(settings, initialized) {
  console.log('Auth status');
  console.log(`  settings initialized: ${initialized ? 'yes' : 'no'}`);
  console.log(`  default tool: ${settings.default_tool}`);
  for (const tool of SUPPORTED_TOOLS) {
    const meta = CATALOG[tool];
    const mode = settings.auth[tool] || 'oauth';
    const hostPaths = getPortableHostAuthPaths(tool);
    console.log('');
    console.log(`  ${tool} (${meta.display_name}): ${mode}`);
    if (mode === 'oauth') {
      console.log(`    host oauth home: ${path.relative(repoRoot, hostPaths.home)}`);
      if (meta.vm_supported) {
        console.log(`    vm oauth home:   /home/portable/.pcoder-auth/${tool}`);
      }
    } else {
      console.log(`    api mode: inject ${meta.api_key_env} at launch time`);
    }
  }
}

function getPortableHostAuthPaths(tool) {
  const root = path.join(authStateRoot, tool, 'host');
  const home = path.join(root, 'home');
  const config = path.join(home, '.config');
  const cache = path.join(home, '.cache');
  const data = path.join(home, '.local', 'share');
  const state = path.join(home, '.local', 'state');
  return { root, home, config, cache, data, state };
}

function applyPortableHostAuthEnv(env, settings, tool) {
  const authMode = settings.auth[tool] || 'oauth';
  const meta = getToolMeta(tool);
  env.PCODER_AUTH_MODE = authMode;
  env.PCODER_TOOL = tool;

  if (authMode !== 'oauth') {
    return env;
  }

  const authPaths = getPortableHostAuthPaths(tool);
  ensureDir(authPaths.root);
  ensureDir(authPaths.home);
  ensureDir(authPaths.config);
  ensureDir(authPaths.cache);
  ensureDir(authPaths.data);
  ensureDir(authPaths.state);

  env.HOME = authPaths.home;
  env.XDG_CONFIG_HOME = authPaths.config;
  env.XDG_CACHE_HOME = authPaths.cache;
  env.XDG_DATA_HOME = authPaths.data;
  env.XDG_STATE_HOME = authPaths.state;
  env.PCODER_AUTH_HOME = authPaths.home;

  if (process.platform === 'win32') {
    const appData = path.join(authPaths.home, 'AppData', 'Roaming');
    const localAppData = path.join(authPaths.home, 'AppData', 'Local');
    ensureDir(appData);
    ensureDir(localAppData);
    env.USERPROFILE = authPaths.home;
    env.APPDATA = appData;
    env.LOCALAPPDATA = localAppData;
  }

  if (meta.config_dir_name) {
    const toolConfigDir = path.join(authPaths.home, meta.config_dir_name);
    ensureDir(toolConfigDir);
    if (meta.config_dir_env) {
      env[meta.config_dir_env] = toolConfigDir;
    }
  }

  return env;
}

function applyAuthCompatibilityEnv(env, tool) {
  const meta = getToolMeta(tool);
  const keyEnv = meta.api_key_env;
  const aliasEnv = meta.api_key_alias_env;
  if (aliasEnv && !env[aliasEnv] && env[keyEnv]) {
    env[aliasEnv] = env[keyEnv];
  }
}

function resolveTool(explicitTool, settings) {
  if (explicitTool) {
    return normalizeToolValue(explicitTool, '--tool');
  }
  return settings.default_tool || DEFAULT_TOOL;
}

// Detects invocations that would trigger the tool's built-in self-updater
// (e.g. `claude --update`, `claude update`, `codex update`). Only inspects the
// first arg so a user prompt like `claude -p "update my code"` isn't caught.
function isToolUpdateInvocation(tool, toolArgs) {
  if (!Array.isArray(toolArgs) || toolArgs.length === 0) return false;
  const meta = CATALOG[tool];
  if (!meta || !Array.isArray(meta.update_args) || meta.update_args.length === 0) return false;
  return meta.update_args.includes(toolArgs[0]);
}

// The tools' built-in self-updaters rewrite their own binary in place. With
// pcoder's bundled install the binary is hardlinked across two locations under
// runtime/<tool>/, and an interrupted in-place update leaves both hardlinks
// renamed and no binary in place — breaking the next launch.
function refuseToolUpdate(tool, invokedArg) {
  const meta = getToolMeta(tool);
  const lines = [
    `Error: refusing to run '${tool} ${invokedArg}' through pcoder.`,
    '',
    `${meta.display_name}'s built-in self-updater rewrites its binary in place,`,
    "which corrupts pcoder's bundled install if the update is interrupted.",
    '',
    `To upgrade the bundled ${tool} to the latest version, run:`,
    `  scripts/pcoder runtime bootstrap-host-native --tool ${tool} --force`,
    '',
    `To bypass this check and run '${tool} ${invokedArg}' anyway (not recommended),`,
    'set PCODER_ALLOW_TOOL_UPDATE=1 before invoking pcoder.'
  ];
  console.error(lines.join('\n'));
  process.exitCode = 1;
}

const updateCheckPath = path.join(stateDir, 'update-check.json');
const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Compare dotted version strings numerically per segment ("1.10.0" > "1.9.9").
// Non-numeric suffixes in a segment are ignored ("3-beta" -> 3). Returns -1/0/1.
function compareVersions(a, b) {
  const pa = String(a)
    .split('.')
    .map((s) => parseInt(s, 10) || 0);
  const pb = String(b)
    .split('.')
    .map((s) => parseInt(s, 10) || 0);
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
  return nowMs - record.last_check >= AUTO_UPDATE_INTERVAL_MS;
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
  const pkgPath = path.join(
    getBundledToolDir(tool),
    'node_modules',
    ...meta.npm_package.split('/'),
    'package.json'
  );
  try {
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
function maybeAutoUpdate(tool, meta, settings, env) {
  if (meta.command_env && env[meta.command_env]) return; // override runner in use; bundled install won't launch
  if (process.env.PCODER_AUTO_UPDATE === '0') return;
  if (settings.auto_update === false) return;
  if (!getBundledToolPath(tool)) return; // only bundled installs are ours to update

  const state = loadUpdateCheckState();
  if (!isUpdateCheckDue(state[tool], Date.now())) return;

  const installed = readBundledToolVersion(tool, meta);
  const latest = installed ? fetchLatestVersion(meta.npm_package) : null;

  state[tool] = {
    last_check: Date.now(),
    latest: latest || (state[tool] && state[tool].latest) || null
  };
  saveUpdateCheckState(state);

  if (!installed || !latest || compareVersions(latest, installed) <= 0) return;

  console.log(`Updating ${tool} ${installed} -> ${latest}...`);
  const bootstrapScript = path.join(repoRoot, 'scripts', 'runtime', 'bootstrap-host-native.cjs');
  const result = cp.spawnSync(
    process.execPath,
    [bootstrapScript, '--tool', tool, '--force', '--no-node'],
    {
      cwd: repoRoot,
      stdio: 'inherit'
    }
  );
  if (result.error || result.status !== 0) {
    console.error(
      `Warning: auto-update of ${tool} failed; launching the installed version. Run 'pcoder runtime bootstrap-host-native --tool ${tool} --force' to retry.`
    );
    delete state[tool].last_check;
    saveUpdateCheckState(state);
  }
}

function resolveRunMode(explicitMode, settings, tool) {
  if (explicitMode) {
    return normalizeRunModeValue(explicitMode, '--mode');
  }
  if (process.platform === 'win32') {
    const configured = settings.runtime.windows_default_mode || 'linux-portable';
    const meta = tool ? CATALOG[tool] : null;
    // Auto-prefer host-native if the selected tool has a bundled runtime,
    // or if the tool doesn't support VM mode.
    if (configured === 'linux-portable') {
      if (tool && getBundledToolPath(tool)) {
        return 'host-native';
      }
      if (meta && meta.vm_supported === false) {
        return 'host-native';
      }
    }
    return configured;
  }
  return 'host-native';
}

function resolveRunner(tool, env) {
  const meta = getToolMeta(tool);
  const override = meta.command_env ? env[meta.command_env] : null;
  if (override) {
    return override;
  }
  const bundled = getBundledToolPath(tool);
  if (bundled) {
    return bundled;
  }
  for (const candidate of meta.candidate_commands || []) {
    if (commandExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

function getBundledToolPath(tool) {
  const meta = getToolMeta(tool);
  const candidate = getBundledToolBinPath(tool, meta.bin_name);
  return fs.existsSync(candidate) ? candidate : null;
}

function applyBundledNodePath(env) {
  const nodeExe = getBundledNodeExePath();
  if (!fs.existsSync(nodeExe)) return;
  prependPath(env, path.dirname(nodeExe));
}

// Prepend `dir` to PATH in `env`, finding the existing key case-insensitively.
// Windows env vars are case-insensitive, but a plain object cloned from
// process.env preserves the original casing (typically 'Path' on Windows).
// Without this, `env.PATH = ...` creates a sibling key that leaves the real
// 'Path' value untouched, and downstream spawned processes lose PATH entries.
function prependPath(env, dir) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const existingKey = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  const targetKey = existingKey || 'PATH';
  const current = existingKey ? env[existingKey] : '';
  const lowerCur = (current || '').toLowerCase();
  const lowerDir = dir.toLowerCase();
  if (lowerCur === lowerDir || lowerCur.startsWith(lowerDir + sep)) {
    return;
  }
  env[targetKey] = dir + sep + (current || '');
}

// cmd.exe argument escaping, following the algorithm used by cross-spawn:
// 1. double backslashes preceding a quote and escape the quote,
// 2. double trailing backslashes (they precede our closing quote),
// 3. wrap in quotes, 4. caret-escape cmd metacharacters.
// When the target is a .cmd/.bat shim, cmd parses the command line TWICE
// (once for our cmd.exe /c, once when the shim re-expands %*), so the
// metacharacter escaping must be applied twice (cross-spawn's
// doubleEscapeMetaChars).
function escapeCmdArg(arg, doubleEscapeMeta) {
  let escaped = String(arg).replace(/(\\*)"/g, '$1$1\\"');
  escaped = escaped.replace(/(\\*)$/, '$1$1');
  escaped = `"${escaped}"`;
  escaped = escaped.replace(/[()%!^"<>&|]/g, '^$&');
  if (doubleEscapeMeta) {
    escaped = escaped.replace(/[()%!^"<>&|]/g, '^$&');
  }
  return escaped;
}

// spawnSync that survives spaces/quotes in runner path and args on Windows.
// Direct spawn of .cmd shims is blocked since the Node 18 EINVAL hardening,
// so on win32 we build an escaped command line and hand it to cmd.exe with
// verbatim arguments (the cross-spawn approach). The command token gets plain
// quotes — cmd.exe must tokenize it to resolve the executable, and a
// caret-escaped quote breaks that tokenization. Arguments get caret-escaped
// quoting; for .cmd/.bat runners (npm shims re-expand %* in a second cmd
// parse) the metacharacter escaping is applied twice.
function spawnToolSync(runner, args, options) {
  if (process.platform !== 'win32') {
    return cp.spawnSync(runner, args, options);
  }
  const isBatch = /\.(cmd|bat)$/i.test(String(runner));
  const commandToken = `"${String(runner).replace(/"/g, '')}"`;
  const command = [commandToken, ...args.map((a) => escapeCmdArg(a, isBatch))].join(' ');
  return cp.spawnSync('cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
    ...options,
    windowsVerbatimArguments: true
  });
}

// Claude on Windows requires pwsh/powershell/bash discoverable via PATH at
// startup. Other tools (codex) don't have this requirement, so this is a no-op
// for them.
function applyClaudeWindowsShellEnv(env, tool) {
  if (tool !== 'claude' || process.platform !== 'win32') return;
  const shellTool = resolveWindowsShellTool(process.env);
  if (!shellTool) failNoWindowsShell();
  applyWindowsShellEnv(env, shellTool);
}

// Resolve a shell tool claude can use on Windows (pwsh, powershell, or git bash).
// Must be called with the real env (before applyPortableHostAuthEnv) so that
// LOCALAPPDATA/USERPROFILE point to the host's real locations during discovery.
// Returns { kind: 'pwsh'|'powershell'|'bash', file } or null.
function resolveWindowsShellTool(env) {
  if (process.platform !== 'win32') return null;

  const sysRoot = env.SystemRoot || env.windir || 'C:\\Windows';
  const candidates = [];

  // Bundled pwsh (opt-in, e.g. via a future `pcoder runtime bootstrap-powershell`).
  candidates.push({ kind: 'pwsh', file: path.join(repoRoot, 'runtime', 'powershell', 'pwsh.exe') });

  const pwshOnPath = whereWindows('pwsh.exe', env, sysRoot);
  if (pwshOnPath) candidates.push({ kind: 'pwsh', file: pwshOnPath });

  if (env.ProgramFiles)
    candidates.push({
      kind: 'pwsh',
      file: path.join(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe')
    });
  if (env.LOCALAPPDATA)
    candidates.push({
      kind: 'pwsh',
      file: path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe')
    });
  if (env.USERPROFILE)
    candidates.push({
      kind: 'pwsh',
      file: path.join(env.USERPROFILE, '.dotnet', 'tools', 'pwsh.exe')
    });

  const powershellOnPath = whereWindows('powershell.exe', env, sysRoot);
  if (powershellOnPath) candidates.push({ kind: 'powershell', file: powershellOnPath });

  // Absolute fallback to Windows PowerShell 5.1, which ships with every consumer Windows install.
  candidates.push({
    kind: 'powershell',
    file: path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  });

  if (env.CLAUDE_CODE_GIT_BASH_PATH)
    candidates.push({ kind: 'bash', file: env.CLAUDE_CODE_GIT_BASH_PATH });
  const bashOnPath = whereWindows('bash.exe', env, sysRoot);
  if (bashOnPath) candidates.push({ kind: 'bash', file: bashOnPath });
  const pf = env.ProgramFiles || 'C:\\Program Files';
  const pfx86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  candidates.push({ kind: 'bash', file: path.join(pf, 'Git', 'bin', 'bash.exe') });
  candidates.push({ kind: 'bash', file: path.join(pfx86, 'Git', 'bin', 'bash.exe') });
  if (env.LOCALAPPDATA)
    candidates.push({
      kind: 'bash',
      file: path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
    });

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate.file)) return candidate;
    } catch (_) {}
  }
  return null;
}

function whereWindows(name, env, sysRoot) {
  const whereExe = path.join(sysRoot, 'System32', 'where.exe');
  const cmd = fs.existsSync(whereExe) ? whereExe : 'where';
  const result = cp.spawnSync(cmd, [name], { env, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0 || !result.stdout) return null;
  const firstLine = result.stdout.split(/\r?\n/).find((line) => line.trim());
  return firstLine ? firstLine.trim() : null;
}

function applyWindowsShellEnv(env, tool) {
  if (!tool) return;
  prependPath(env, path.dirname(tool.file));
  if (tool.kind === 'bash' && !env.CLAUDE_CODE_GIT_BASH_PATH) {
    env.CLAUDE_CODE_GIT_BASH_PATH = tool.file;
  }
}

function failNoWindowsShell() {
  const lines = [
    'No shell tool found on this Windows host. Claude Code needs one of:',
    '  - PowerShell 7 (pwsh.exe): https://aka.ms/powershell',
    '  - Windows PowerShell 5.1 at %SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    '  - Git for Windows (bash.exe): https://git-scm.com/downloads/win',
    'Or set CLAUDE_CODE_GIT_BASH_PATH to your bash.exe location.'
  ];
  fail(lines.join('\n'));
}

function runInLinuxPortableVm(options) {
  const {
    tool,
    projectPath,
    mergedEnv,
    toolArgs,
    noSyncBack,
    skipProjectSync,
    authMode,
    settings
  } = options;

  // On non-Windows hosts, linux-portable mode uses portable host-native execution
  // with isolated auth state instead of a VM. This provides portability without
  // requiring Docker/Podman.
  if (process.platform !== 'win32') {
    return runPortableHostNative(options);
  }

  loadJsonSafe(vmManifestPath, 'vm manifest');
  startWindowsVm();

  const sshPort = readVmSshPort();
  const sshHost = mergedEnv.PCODER_VM_HOST || '127.0.0.1';
  const sshUser = mergedEnv.PCODER_VM_USER || 'portable';
  const sshKeyPath =
    mergedEnv.PCODER_VM_SSH_KEY || path.join(repoRoot, 'runtime', 'linux', 'ssh', 'id_ed25519');
  if (!fs.existsSync(sshKeyPath)) {
    fail(
      `Missing VM SSH key: ${sshKeyPath}. Set PCODER_VM_SSH_KEY or provide runtime/linux/ssh/id_ed25519.`
    );
  }

  const sshCmd = resolveSshCommand(mergedEnv);

  waitForVmSshReady({
    sshCmd,
    sshHost,
    sshPort,
    sshUser,
    sshKeyPath,
    timeoutSeconds: resolveVmSshTimeoutSeconds(mergedEnv)
  });

  const remoteRoot = mergedEnv.PCODER_VM_PROJECTS_ROOT || '/home/portable/projects';
  const remoteProjectPath = skipProjectSync
    ? mergedEnv.PCODER_VM_AUTH_WORKDIR || '/home/portable'
    : buildRemoteProjectPath(remoteRoot, projectPath);

  const prepLines = ['set -e'];
  if (skipProjectSync) {
    prepLines.push(`mkdir -p ${shellEscape(remoteProjectPath)}`);
  } else {
    prepLines.push(`mkdir -p ${shellEscape(remoteRoot)}`);
    prepLines.push(`rm -rf ${shellEscape(remoteProjectPath)}`);
    prepLines.push(`mkdir -p ${shellEscape(remoteProjectPath)}`);
  }
  const prepScript = prepLines.join('\n');

  const prepResult = runSshScript({
    sshCmd,
    sshHost,
    sshPort,
    sshUser,
    sshKeyPath,
    script: prepScript,
    inheritOutput: true
  });
  if (prepResult.status !== 0) {
    fail('Failed to prepare remote project directory in VM.');
  }

  if (!skipProjectSync) {
    syncProjectToVm({
      sshCmd,
      sshHost,
      sshPort,
      sshUser,
      sshKeyPath,
      projectPath,
      remoteProjectPath
    });
  }

  const remoteScript = buildRemoteRunScript({
    tool,
    authMode,
    remoteProjectPath,
    toolArgs,
    mergedEnv
  });

  // Upload the run script via base64, then execute it with a TTY so the
  // tool gets interactive input. We can't pipe the script via stdin
  // because the tool needs stdin for user interaction.
  const remoteScriptPath = '/tmp/pcoder-run.sh';
  const encoded = Buffer.from(remoteScript).toString('base64');
  const uploadResult = runSshScript({
    sshCmd,
    sshHost,
    sshPort,
    sshUser,
    sshKeyPath,
    script: `echo '${encoded}' | base64 -d > ${remoteScriptPath} && chmod +x ${remoteScriptPath}`,
    inheritOutput: false
  });
  if (uploadResult.status !== 0) {
    fail('Failed to upload run script to VM.');
  }

  const runResult = runSshInteractive({
    sshCmd,
    sshHost,
    sshPort,
    sshUser,
    sshKeyPath,
    remoteCommand: `bash ${remoteScriptPath}`
  });

  if (!skipProjectSync && !noSyncBack) {
    syncProjectFromVm({
      sshCmd,
      sshHost,
      sshPort,
      sshUser,
      sshKeyPath,
      projectPath,
      remoteProjectPath
    });
  }

  process.exitCode = typeof runResult.status === 'number' ? runResult.status : 1;
}

/**
 * Run the selected tool in portable host-native mode (non-Windows hosts).
 * Uses isolated auth state in state/auth/<tool>/host/ but runs the tool
 * directly on the host without a VM.
 */
function runPortableHostNative(options) {
  const { tool, projectPath, mergedEnv, toolArgs, settings } = options;
  const meta = getToolMeta(tool);

  const runner = resolveRunner(tool, mergedEnv);
  if (!runner) {
    fail(
      `No ${tool} executable found. Run 'pcoder runtime bootstrap-host-native --tool ${tool}' or set ${meta.command_env}.`
    );
  }

  const env = applyPortableHostAuthEnv({ ...mergedEnv }, settings, tool);
  applyBundledNodePath(env);

  const result = spawnToolSync(runner, toolArgs, {
    cwd: projectPath,
    stdio: 'inherit',
    env
  });

  if (result.error) {
    fail(`Failed to launch '${runner}': ${result.error.message}`);
  }

  process.exitCode = typeof result.status === 'number' ? result.status : 1;
}

function startWindowsVm() {
  const startScript = path.join(repoRoot, 'scripts', 'runtime', 'windows', 'start-vm.cmd');
  if (!fs.existsSync(startScript)) {
    fail(`Missing VM start script: ${startScript}`);
  }

  const result = cp.spawnSync('cmd.exe', ['/c', startScript], {
    cwd: repoRoot,
    stdio: 'inherit'
  });

  if (result.error) {
    fail(`Failed to execute VM start script: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`VM start script failed with exit code ${result.status}.`);
  }
}

function readVmSshPort() {
  if (!fs.existsSync(vmSshPortPath)) {
    fail(`Missing VM SSH port file: ${vmSshPortPath}. VM may not be initialized correctly.`);
  }
  const raw = fs.readFileSync(vmSshPortPath, 'utf8').trim();
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    fail(`Invalid VM SSH port value in ${vmSshPortPath}: ${raw}`);
  }
  return String(port);
}

function resolveSshCommand(env) {
  const override = env.PCODER_SSH_CMD;
  if (override) {
    if (!commandOrPathExists(override)) {
      fail(`PCODER_SSH_CMD is set but not found: ${override}`);
    }
    return override;
  }

  const bundled = path.join(repoRoot, 'runtime', 'ssh', 'ssh.exe');
  if (fs.existsSync(bundled)) {
    return bundled;
  }

  if (commandExists('ssh')) {
    return 'ssh';
  }

  fail('No SSH client found. Bundle runtime/ssh/ssh.exe or ensure ssh is available in PATH.');
}

function waitForVmSshReady(options) {
  const { sshCmd, sshHost, sshPort, sshUser, sshKeyPath, timeoutSeconds } = options;
  // Clear stale known_hosts so fresh VM keys are accepted.
  const khPath = vmKnownHostsPath();
  try {
    fs.writeFileSync(khPath, '', 'utf8');
  } catch (_) {}
  const startedAt = Date.now();
  const timeoutMs = timeoutSeconds * 1000;
  while (Date.now() - startedAt < timeoutMs) {
    const probe = runSshScript({
      sshCmd,
      sshHost,
      sshPort,
      sshUser,
      sshKeyPath,
      script: 'echo vm-ready',
      inheritOutput: false
    });
    if (probe.status === 0) {
      return;
    }
    sleepMs(2000);
  }
  fail(`Timed out waiting for VM SSH readiness after ${timeoutSeconds}s.`);
}

function resolveVmSshTimeoutSeconds(env) {
  const raw = env.PCODER_VM_SSH_TIMEOUT_SECONDS;
  if (!raw) {
    return 300;
  }
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 10 || parsed > 3600) {
    fail('PCODER_VM_SSH_TIMEOUT_SECONDS must be an integer between 10 and 3600.');
  }
  return parsed;
}

function buildRemoteProjectPath(remoteRoot, projectPath) {
  const normalizedRoot = remoteRoot.endsWith('/') ? remoteRoot.slice(0, -1) : remoteRoot;
  const baseRaw = path.basename(projectPath) || 'project';
  const baseSafe = baseRaw.replace(/[^A-Za-z0-9._-]/g, '_');
  const hash = crypto
    .createHash('sha1')
    .update(projectPath.toLowerCase())
    .digest('hex')
    .slice(0, 8);
  return `${normalizedRoot}/${baseSafe}-${hash}`;
}

function buildRemoteRunScript(options) {
  const { tool, authMode, remoteProjectPath, toolArgs, mergedEnv } = options;
  const meta = getToolMeta(tool);

  const forwardKeys = (meta.auth_env_vars || []).concat([
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'ALL_PROXY'
  ]);

  const lines = [
    'set -e',
    'if command -v cloud-init >/dev/null 2>&1; then',
    '  _ci_to=${PCODER_CLOUD_INIT_TIMEOUT:-900}',
    '  set +e',
    '  timeout "$_ci_to" cloud-init status --wait 2>/dev/null',
    '  _ci_rc=$?',
    '  set -e',
    '  if [ "$_ci_rc" -eq 124 ]; then',
    '    echo "pcoder: cloud-init wait exceeded ${_ci_to}s; provisioning may be incomplete" >&2',
    '    exit 1',
    '  elif [ "$_ci_rc" -ne 0 ]; then',
    '    echo "pcoder: cloud-init finished with warnings (exit ${_ci_rc}); continuing anyway" >&2',
    '  fi',
    'fi',
    `cd ${shellEscape(remoteProjectPath)}`
  ];

  if ((authMode || 'oauth') === 'oauth') {
    const vmAuthHome = mergedEnv.PCODER_VM_AUTH_HOME || `/home/portable/.pcoder-auth/${tool}`;
    const vmConfig = `${vmAuthHome}/.config`;
    const vmCache = `${vmAuthHome}/.cache`;
    const vmData = `${vmAuthHome}/.local/share`;
    const vmState = `${vmAuthHome}/.local/state`;
    lines.push(
      `mkdir -p ${shellEscape(vmConfig)} ${shellEscape(vmCache)} ${shellEscape(vmData)} ${shellEscape(vmState)}`
    );
    lines.push(`export HOME=${shellEscape(vmAuthHome)}`);
    lines.push(`export XDG_CONFIG_HOME=${shellEscape(vmConfig)}`);
    lines.push(`export XDG_CACHE_HOME=${shellEscape(vmCache)}`);
    lines.push(`export XDG_DATA_HOME=${shellEscape(vmData)}`);
    lines.push(`export XDG_STATE_HOME=${shellEscape(vmState)}`);
    if (meta.config_dir_name) {
      const toolConfigDir = `${vmAuthHome}/${meta.config_dir_name}`;
      lines.push(`mkdir -p ${shellEscape(toolConfigDir)}`);
      if (meta.config_dir_env) {
        lines.push(`export ${meta.config_dir_env}=${shellEscape(toolConfigDir)}`);
      }
    }
  }

  lines.push(`export PCODER_AUTH_MODE=${shellEscape(authMode || 'oauth')}`);
  lines.push(`export PCODER_TOOL=${shellEscape(tool)}`);

  for (const key of forwardKeys) {
    if (mergedEnv[key]) {
      lines.push(`export ${key}=${shellEscape(mergedEnv[key])}`);
    }
  }

  const binName = meta.bin_name || tool;
  const cmdParts = [binName, ...toolArgs].map((part) => shellEscape(part));
  lines.push(cmdParts.join(' '));
  return lines.join('\n');
}

function syncProjectToVm(options) {
  const { sshCmd, sshHost, sshPort, sshUser, sshKeyPath, projectPath, remoteProjectPath } = options;

  if (process.platform === 'win32' && !commandExists('bash')) {
    fail(
      'VM project sync requires bash on PATH (Git for Windows or WSL). Install Git for Windows: https://git-scm.com/downloads/win'
    );
  }

  // Use tar piped through SSH to sync files while excluding large directories
  // that are host-only (runtime binaries, VM images, state, .git).
  // Anchor with ./ so only top-level dirs are excluded — tar stores paths as
  // ./runtime/... when archiving from '.', and a bare --exclude=runtime would
  // also drop e.g. src/runtime/ from the project.
  const tarExcludes = SYNC_EXCLUDES.map((e) => `--exclude=./${e}`).join(' ');
  const sshOpts = buildSshOptsString(sshPort, sshKeyPath);
  const remoteEscaped = shellEscape(remoteProjectPath);
  const sshTarget = `${sshUser}@${sshHost}`;

  const script = `tar cf - ${tarExcludes} . | ${shellEscape(sshCmd)} ${sshOpts} ${sshTarget} tar xf - -C ${remoteEscaped}`;
  const result = cp.spawnSync('bash', ['-c', script], { cwd: projectPath, stdio: 'inherit' });
  if (result.error) {
    fail(`Failed to sync project into VM: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`Project sync to VM failed with exit code ${result.status}.`);
  }
}

function baseSshArgs(sshPort, sshKeyPath) {
  return [
    '-p',
    String(sshPort),
    '-i',
    sshKeyPath,
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    `UserKnownHostsFile=${vmKnownHostsPath()}`
  ];
}

function buildSshOptsString(sshPort, sshKeyPath) {
  return baseSshArgs(sshPort, sshKeyPath)
    .map((a) => (a.includes(' ') || a.includes("'") ? shellEscape(a) : a))
    .concat(['-o', 'BatchMode=yes'])
    .join(' ');
}

function syncProjectFromVm(options) {
  const { sshCmd, sshHost, sshPort, sshUser, sshKeyPath, projectPath, remoteProjectPath } = options;

  if (process.platform === 'win32' && !commandExists('bash')) {
    fail(
      'VM project sync requires bash on PATH (Git for Windows or WSL). Install Git for Windows: https://git-scm.com/downloads/win'
    );
  }

  const tarExcludes = SYNC_EXCLUDES.map((e) => `--exclude=./${e}`).join(' ');
  const sshOpts = buildSshOptsString(sshPort, sshKeyPath);
  const remoteEscaped = shellEscape(remoteProjectPath);
  const sshTarget = `${sshUser}@${sshHost}`;

  const script = `${shellEscape(sshCmd)} ${sshOpts} ${sshTarget} tar cf - -C ${remoteEscaped} ${tarExcludes} . | tar xf -`;
  const result = cp.spawnSync('bash', ['-c', script], { cwd: projectPath, stdio: 'inherit' });
  if (result.error) {
    fail(`Failed to sync project back from VM: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`Project sync-back from VM failed with exit code ${result.status}.`);
  }
}

function runSshScript(options) {
  const { sshCmd, sshHost, sshPort, sshUser, sshKeyPath, script, inheritOutput } = options;
  const args = [
    ...baseSshArgs(sshPort, sshKeyPath),
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=5',
    `${sshUser}@${sshHost}`,
    'bash',
    '-s'
  ];
  const result = cp.spawnSync(sshCmd, args, {
    input: script,
    encoding: 'utf8',
    stdio: inheritOutput ? ['pipe', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe']
  });
  if (result.error) {
    fail(`SSH command failed to start: ${result.error.message}`);
  }
  return result;
}

function runSshInteractive(options) {
  const { sshCmd, sshHost, sshPort, sshUser, sshKeyPath, remoteCommand } = options;
  const args = [
    '-t',
    '-t',
    ...baseSshArgs(sshPort, sshKeyPath),
    '-o',
    'ConnectTimeout=5',
    `${sshUser}@${sshHost}`,
    remoteCommand
  ];
  const result = cp.spawnSync(sshCmd, args, {
    stdio: 'inherit'
  });
  if (result.error) {
    fail(`SSH interactive command failed to start: ${result.error.message}`);
  }
  return result;
}

function shellEscape(value) {
  const raw = String(value);
  return `'${raw.replace(/'/g, `'\"'\"'`)}'`;
}

// Cached path to state/vm/known_hosts — used instead of NUL/dev/null because
// Windows SSH treats 'NUL' as a real file, causing host key mismatch errors.
let _vmKnownHostsPath = null;
function vmKnownHostsPath() {
  if (!_vmKnownHostsPath) {
    _vmKnownHostsPath = path.join(stateDir, 'vm', 'known_hosts');
    ensureDir(path.dirname(_vmKnownHostsPath));
  }
  return _vmKnownHostsPath;
}

function commandOrPathExists(commandOrPath) {
  if (
    commandOrPath.includes('/') ||
    commandOrPath.includes('\\') ||
    /^[A-Za-z]:\\/.test(commandOrPath)
  ) {
    return fs.existsSync(commandOrPath);
  }
  return commandExists(commandOrPath);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function commandExists(command) {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = cp.spawnSync(checker, [command], { stdio: 'ignore' });
  return result.status === 0;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function loadJsonSafe(filePath, label) {
  if (!fs.existsSync(filePath)) {
    fail(`Missing ${label}: ${path.relative(repoRoot, filePath)}`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`Invalid JSON in ${path.relative(repoRoot, filePath)}: ${error.message}`);
  }
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  parseRunArgs,
  isToolUpdateInvocation,
  buildRemoteProjectPath,
  prependPath,
  shellEscape,
  escapeCmdArg,
  compareVersions,
  isUpdateCheckDue,
  readBundledToolVersion
};
