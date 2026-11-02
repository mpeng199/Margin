/**
 * Margin.app — the native shell. The daemon (launchd agent) owns data, sync, rules and scheduling;
 * this process gives it a window with vibrancy, a menu bar, a tray item, a global capture shortcut,
 * and Notification Center delivery under the app's own name.
 */
const { app, BrowserWindow, Menu, Tray, Notification, globalShortcut, ipcMain, shell, nativeImage, systemPreferences, nativeTheme } = require('electron');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PORT = Number(process.env.MARGIN_PORT || 7317);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CAPTURE_SHORTCUT = process.env.MARGIN_CAPTURE_SHORTCUT || 'Control+Option+Space';
let win = null;
let capture = null;
let tray = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.setName('Margin');

function health() {
  return new Promise((resolve) => {
    const req = http.get(`${ORIGIN}/api/health`, { timeout: 800 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function ensureDaemon() {
  if (await health()) return true;
  // Ask launchd to (re)start the agent installed by start.sh.
  execFile('launchctl', ['kickstart', `gui/${process.getuid()}/dev.minimike.margin`], () => {});
  for (let i = 0; i < 40; i++) { if (await health()) return true; await new Promise((r) => setTimeout(r, 250)); }
  return false;
}

function accentHex() {
  try { return '#' + systemPreferences.getAccentColor().slice(0, 6); } catch { return null; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 760, minHeight: 540,
    title: 'Margin',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.loadURL(`${ORIGIN}/`);
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) showWindow(); });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); app.dock?.hide(); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN)) { e.preventDefault(); shell.openExternal(url); } });
}

function showWindow(pathToOpen) {
  if (!win) createWindow();
  app.dock?.show();
  win.show();
  win.focus();
  if (pathToOpen) win.webContents.send('margin:navigate', pathToOpen);
}

function openCapture() {
  if (capture && !capture.isDestroyed()) { capture.show(); capture.focus(); return; }
  capture = new BrowserWindow({
    width: 560, height: 132, frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true, show: false,
    vibrancy: 'hud', visualEffectState: 'active', backgroundColor: '#00000000', roundedCorners: true, center: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  capture.loadURL(`${ORIGIN}/capture-panel`);
  capture.once('ready-to-show', () => { capture.show(); capture.focus(); });
  capture.on('blur', () => capture && !capture.isDestroyed() && capture.close());
}

/** Notifications arrive from the daemon over SSE; Notification Center shows them as Margin. */
function listen() {
  // Reconnect exactly once per connection however it ends (clean end, abrupt close when the daemon
  // restarts, or a refused connection while it's starting).
  let retried = false;
  const retry = (ms) => { if (!retried) { retried = true; setTimeout(listen, ms); } };
  const req = http.get(`${ORIGIN}/api/stream?client=shell`, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /event: (.*)/.exec(block)?.[1];
        const data = /data: (.*)/.exec(block)?.[1];
        if (ev === 'notify' && data) {
          const n = JSON.parse(data);
          const note = new Notification({ title: n.title, body: n.body, silent: n.category === 'wellbeing' });
          note.on('click', () => showWindow(n.path));
          note.show();
        }
      }
    });
    res.on('end', () => retry(2000));
    res.on('close', () => retry(2000));
    res.on('error', () => retry(3000));
  });
  req.on('error', () => retry(3000));
  req.on('close', () => retry(3000));
}

function buildMenu() {
  const go = (p) => () => showWindow(p);
  const template = [
    { label: 'Margin', submenu: [
      { role: 'about' },
      { label: 'Check for Updates…', click: go('/settings/update') },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'Cmd+,', click: go('/settings') },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
      { label: 'Quit Margin', accelerator: 'Cmd+Q', click: () => { quitting = true; app.quit(); } },
    ] },
    { label: 'File', submenu: [
      { label: 'Quick Capture', accelerator: 'Cmd+N', click: () => { showWindow(); win.webContents.send('margin:capture'); } },
      { label: 'Start Shutdown', click: go('/shutdown') },
      { type: 'separator' }, { role: 'close' },
    ] },
    { role: 'editMenu' },
    { label: 'Go', submenu: [
      { label: 'Today', accelerator: 'Cmd+1', click: go('/today') },
      { label: 'Calendar', accelerator: 'Cmd+2', click: go('/calendar') },
      { label: 'Projects', accelerator: 'Cmd+3', click: go('/projects') },
      { label: 'Weekly Review', accelerator: 'Cmd+4', click: go('/review') },
      { label: 'Habits', accelerator: 'Cmd+5', click: go('/habits') },
      { label: 'Training', accelerator: 'Cmd+6', click: go('/training') },
      { label: 'Insights', accelerator: 'Cmd+7', click: go('/insights') },
      { label: 'Ask Claude', accelerator: 'Cmd+8', click: go('/ask') },
      { label: 'Get Help', click: go('/help') },
      { type: 'separator' },
      { label: 'Review Changes', click: go('/changes') },
      { label: 'Command Palette', accelerator: 'Cmd+K', click: () => { showWindow(); win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'K', modifiers: ['meta'] }); } },
    ] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Get Help (988)', click: go('/help') }, { label: 'Setup Guide', click: () => shell.openExternal('file://' + path.resolve(__dirname, '..', 'README.md')) }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function buildTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Margin');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Margin', click: () => showWindow() },
    { label: 'Check for Updates…', click: () => showWindow('/settings/update') },
    { label: `Quick Capture (${CAPTURE_SHORTCUT.replace('Control', '⌃').replace('Option', '⌥').replace('Space', 'Space').replace(/\+/g, '')})`, click: openCapture },
    { label: 'Get Help', click: () => showWindow('/help') },
    { type: 'separator' },
    { label: 'Quit Margin', click: () => { quitting = true; app.quit(); } },
  ]));
}

ipcMain.on('margin:accent', (e) => { e.returnValue = accentHex(); });
ipcMain.on('margin:close-capture', () => capture && !capture.isDestroyed() && capture.close());
ipcMain.on('margin:open-external', (_e, url) => { if (/^https?:/.test(url)) shell.openExternal(url); });

app.on('second-instance', () => showWindow());
app.on('activate', () => showWindow());
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());

app.whenReady().then(async () => {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true, args: ['--hidden'] });
  buildMenu();
  buildTray();
  const ok = await ensureDaemon();
  if (!ok) {
    new Notification({ title: 'Margin couldn’t start its background service', body: 'Run ./start.sh in the Margin folder.' }).show();
  }
  createWindow();
  listen();
  if (!globalShortcut.register(CAPTURE_SHORTCUT, openCapture)) console.warn('Capture shortcut is taken:', CAPTURE_SHORTCUT);
  systemPreferences.subscribeNotification?.('AppleColorPreferencesChangedNotification', () => win?.webContents.reload());
  nativeTheme.on('updated', () => {});
});
