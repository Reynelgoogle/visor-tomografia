/**
 * Visor de Tomografía — versión portable para Windows (Electron).
 *
 * No hay instalador ni servidor: carga el build de Vite (dist/index.html)
 * desde el propio .exe, todo en local. Sin conexión no se sube nada.
 *
 * Para probar tiempos de carga: al arrancar escribe un log
 * `visor-timing.log` junto al .exe con el tiempo hasta que la ventana
 * está lista y hasta que la app termina de cargar, y también lo muestra
 * en la consola (VISOR_DEVTOOLS=1 abre las DevTools).
 */
const { app, BrowserWindow, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const startedAt = Date.now();
const logLines = [`started=${new Date().toISOString()}`];

function writeTimingLog() {
  try {
    const dir = path.dirname(app.getPath('exe'));
    const file = path.join(dir, 'visor-timing.log');
    fs.appendFileSync(file, logLines.join('\n') + '\n', 'utf8');
  } catch (err) {
    console.error('[visor] no se pudo escribir visor-timing.log:', err.message);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'Visor de Tomografía',
    backgroundColor: '#07090D',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  Menu.setApplicationMenu(null);

  const readyMs = Date.now() - startedAt;
  logLines.push(`app-ready-ms=${readyMs}`);
  console.log(`[visor] app ready in ${readyMs} ms`);

  win.webContents.on('did-finish-load', () => {
    const loadMs = Date.now() - startedAt;
    logLines.push(`window-load-ms=${loadMs}`);
    console.log(`[visor] window loaded in ${loadMs} ms`);
    writeTimingLog();
  });

  if (process.env.VISOR_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  return win;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
