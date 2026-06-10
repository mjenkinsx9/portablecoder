'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const nodeDir = path.join(repoRoot, 'runtime', 'node');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function getBundledNodeExePath() {
  if (process.platform === 'win32') {
    return path.join(nodeDir, 'node.exe');
  }
  return path.join(nodeDir, 'bin', 'node');
}

function getBundledToolDir(tool) {
  return path.join(repoRoot, 'runtime', tool);
}

function getBundledToolBinPath(tool, binName) {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  const name = binName || tool;
  return path.join(getBundledToolDir(tool), 'node_modules', '.bin', `${name}${ext}`);
}

function getBundledNpmCliPath() {
  if (process.platform === 'win32') {
    return path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  }
  return path.join(nodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

module.exports = {
  repoRoot,
  nodeDir,
  ensureDir,
  fail,
  getBundledNodeExePath,
  getBundledToolDir,
  getBundledToolBinPath,
  getBundledNpmCliPath
};
