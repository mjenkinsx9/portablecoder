'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseRunArgs,
  isToolUpdateInvocation,
  buildRemoteProjectPath,
  prependPath,
  shellEscape,
  compareVersions,
  isUpdateCheckDue,
  readBundledToolVersion
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

  // Dedup only applies when dir is already the first entry; a dir that
  // appears later in PATH is prepended again (documents current behavior).
  const env2 = { Path: `/usr/bin${sep}/opt/node` };
  prependPath(env2, '/opt/node');
  assert.equal(env2.Path, `/opt/node${sep}/usr/bin${sep}/opt/node`);
});

test('shellEscape: single quotes are escaped for POSIX sh', () => {
  assert.equal(shellEscape(`it's`), `'it'"'"'s'`);
  assert.equal(shellEscape('plain'), `'plain'`);
});

const { escapeCmdArg } = require('../scripts/pcoder.cjs');

test('escapeCmdArg: quotes and caret-escapes metacharacters', () => {
  assert.equal(escapeCmdArg('abc'), '^"abc^"');
  assert.equal(escapeCmdArg('a b'), '^"a b^"');
  assert.equal(escapeCmdArg('a"b'), '^"a\\^"b^"');
  assert.equal(escapeCmdArg('100%'), '^"100^%^"');
  assert.equal(escapeCmdArg('a&b|c'), '^"a^&b^|c^"');
  assert.equal(escapeCmdArg('trailing\\'), '^"trailing\\\\^"');
});

test('escapeCmdArg: double-escapes metacharacters for .cmd/.bat shims', () => {
  assert.equal(escapeCmdArg('a&b', true), '^^^"a^^^&b^^^"');
  assert.equal(escapeCmdArg('plain', true), '^^^"plain^^^"');
});

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

test('readBundledToolVersion: returns a version string or null, never throws', () => {
  const claudeVersion = readBundledToolVersion('claude', {
    npm_package: '@anthropic-ai/claude-code'
  });
  assert.ok(claudeVersion === null || /^\d+\.\d+/.test(claudeVersion));
  assert.equal(readBundledToolVersion('nonexistent-tool', { npm_package: 'no-such-pkg' }), null);
});
