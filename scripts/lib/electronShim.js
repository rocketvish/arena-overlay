/**
 * Minimal stand-in for the `electron` module so main-process modules can be
 * required from plain Node scripts (tests, CLI tools).
 *
 * userData points at a throwaway temp dir unless ARENA_OVERLAY_USERDATA is set,
 * so tests never touch the real app's cache or logs.
 */
'use strict';

const Module = require('module');
const os = require('os');
const path = require('path');

const userData = process.env.ARENA_OVERLAY_USERDATA
  ?? path.join(os.tmpdir(), 'arena-overlay-test');

const fakeElectron = {
  app: {
    getPath: () => userData,
    getVersion: () => 'test',
    isPackaged: false,
  },
  ipcMain: { handle: () => {}, on: () => {} },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.apply(this, arguments);
};

module.exports = { userData };
