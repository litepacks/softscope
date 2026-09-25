import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/rc.js';
import { parseCliArgs } from '../src/config.js';

test('RC Loader: discovers .softscoperc.json in project root', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softscope-rc-'));
  const rcPath = path.join(tmpDir, '.softscoperc.json');
  fs.writeFileSync(rcPath, JSON.stringify({ iterations: 2500, fuzz: false, top: 20 }), 'utf-8');

  try {
    const { config, configFile } = loadConfig(tmpDir);
    assert.equal(configFile, rcPath);
    assert.equal(config.iterations, 2500);
    assert.equal(config.fuzz, false);
    assert.equal(config.top, 20);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('RC Loader: discovers softscope section in package.json', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softscope-rc-pkg-'));
  const pkgPath = path.join(tmpDir, 'package.json');
  fs.writeFileSync(pkgPath, JSON.stringify({
    name: 'test-app',
    softscope: {
      iterations: 7500,
      failOnRegression: 15
    }
  }), 'utf-8');

  try {
    const { config, configFile } = loadConfig(tmpDir);
    assert.equal(configFile, pkgPath);
    assert.equal(config.iterations, 7500);
    assert.equal(config.failOnRegression, 15);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('RC Loader: CLI flags override config file options', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softscope-rc-override-'));
  const rcPath = path.join(tmpDir, '.softscoperc');
  fs.writeFileSync(rcPath, JSON.stringify({
    iterations: 2000,
    top: 5,
    fuzz: false
  }), 'utf-8');

  try {
    // 1. Without CLI overrides: defaults to config
    const optsDefault = parseCliArgs(['app.js'], tmpDir);
    assert.equal(optsDefault.iterations, 2000);
    assert.equal(optsDefault.top, 5);
    assert.equal(optsDefault.fuzz, false);

    // 2. With CLI overrides: CLI takes precedence
    const optsOverride = parseCliArgs(['app.js', '--iterations', '50000', '--top', '25', '--fuzz'], tmpDir);
    assert.equal(optsOverride.iterations, 50000);
    assert.equal(optsOverride.top, 25);
    assert.equal(optsOverride.fuzz, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('RC Loader: explicit --config loads specified configuration file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'softscope-rc-explicit-'));
  const customConfig = path.join(tmpDir, 'my-custom-config.json');
  fs.writeFileSync(customConfig, JSON.stringify({ iterations: 9999 }), 'utf-8');

  try {
    const opts = parseCliArgs(['app.js', '--config', customConfig], tmpDir);
    assert.equal(opts.iterations, 9999);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
