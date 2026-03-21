/**
 * Launcher for Electron dev mode.
 * Removes ELECTRON_RUN_AS_NODE from the environment so Electron runs as a
 * real GUI app instead of a plain Node.js process (VSCode sets this var).
 */
const { spawn } = require('child_process');
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env,
});

child.on('close', (code) => process.exit(code ?? 0));
