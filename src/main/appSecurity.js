/**
 * appSecurity.js — one place for "which pages are ours" and window hardening.
 *
 *   - Dev mode is decided only by whether the app is packaged. (An env var
 *     used to switch an installed build into dev mode, where it would load —
 *     and trust — whatever happened to be listening on localhost:5173.)
 *   - Production trusts exactly our bundled page, not any file: URL.
 *   - Windows never navigate or open popups; allowed external links go to
 *     the user's browser.
 */

const { app, shell, session } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const isDev = !app.isPackaged;
const DEV_ORIGIN = 'http://localhost:5173';

const RENDERER_DIR = path.join(__dirname, '..', '..', 'dist', 'renderer');
const APP_PAGES = new Set([
  pathToFileURL(path.join(RENDERER_DIR, 'control', 'index.html')).href,
]);

const EXTERNAL_HOSTS = new Set(['www.17lands.com', '17lands.com', 'scryfall.com', 'www.scryfall.com']);

function isTrustedAppUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (isDev) return u.origin === DEV_ORIGIN;
    u.hash = '';
    u.search = '';
    return APP_PAGES.has(u.href);
  } catch {
    return false;
  }
}

function isAllowedExternalUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.protocol === 'https:' && EXTERNAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** No popups, no navigation away from our page (dev: same-origin reloads only). */
function hardenContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (isDev && isTrustedAppUrl(url)) return;
    event.preventDefault();
    if (isAllowedExternalUrl(url)) shell.openExternal(url);
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

const hardenWindow = (win) => hardenContents(win.webContents);

/**
 * App-wide: refuse every browser permission request (camera, notifications,
 * …), and harden every web contents as it's created — not just the windows
 * passed to hardenWindow.
 */
function hardenSessions() {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.on('web-contents-created', (_event, contents) => hardenContents(contents));
}

const WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  spellcheck: false,
  devTools: isDev,
};

module.exports = { isDev, DEV_ORIGIN, isTrustedAppUrl, isAllowedExternalUrl, hardenWindow, hardenSessions, WEB_PREFERENCES };
