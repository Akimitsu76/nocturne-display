'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, powerMonitor, dialog } = require('electron');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_DEV = !app.isPackaged || process.argv.includes('--dev');
const CONFIG_DIR = path.join(os.homedir(), '.config', 'nocturne-display');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const AUTOSTART_DIR = path.join(os.homedir(), '.config', 'autostart');
const AUTOSTART_FILE = path.join(AUTOSTART_DIR, 'nocturne-display.desktop');
const ASSETS = path.join(__dirname, '..', 'assets');

const DEFAULTS = {
  enabled: true,
  offTime: '08:00',
  onTime: '19:00',
  output: 'auto',
  backend: 'auto',
  startMinimized: false,
  autostart: false,
  sound: false,
  manualOverride: false,
};

let config = loadConfig();
let win = null;
let tray = null;
let appliedState = 'on';
let lastTarget = null;
let tickTimer = null;
let lastEvent = { time: null, text: 'Aguardando primeiro ciclo...', kind: 'info' };

/* ------------------------------------------------------------------ utils */

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('[nocturne] falha ao salvar config:', err.message);
  }
}

function hasCmd(cmd) {
  const dirs = (process.env.PATH || '').split(':');
  for (const dir of dirs) {
    try {
      fs.accessSync(path.join(dir, cmd), fs.constants.X_OK);
      return true;
    } catch { /* continua */ }
  }
  return false;
}

function run(cmd, args, timeout = 5000) {
  try {
    const r = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      env: { ...process.env },
    });
    return {
      ok: r.status === 0,
      code: r.status,
      out: (r.stdout || '').trim(),
      err: (r.stderr || '').trim(),
      command: `${cmd} ${args.join(' ')}`.trim(),
    };
  } catch (err) {
    return { ok: false, code: null, out: '', err: err.message, command: `${cmd} ${args.join(' ')}`.trim() };
  }
}

function detectBackend(preferred) {
  if (preferred && preferred !== 'auto') return preferred;
  const wayland = !!process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland';
  if (wayland) {
    if (hasCmd('kscreen-doctor')) return 'kscreen';
    if (hasCmd('wlr-randr')) return 'wlr';
    if (hasCmd('ddcutil')) return 'ddcutil';
  }
  if (process.env.DISPLAY && hasCmd('xrandr')) return 'xrandr';
  if (hasCmd('ddcutil')) return 'ddcutil';
  if (process.env.DISPLAY && hasCmd('xset')) return 'dpms';
  return 'none';
}

function backendLabel(backend) {
  return {
    kscreen: 'KDE / KScreen (Wayland)',
    wlr: 'wlroots / sway / Hyprland',
    xrandr: 'X11 / xrandr',
    ddcutil: 'DDC/CI (físico)',
    dpms: 'DPMS (X11, mantém saída)',
    none: 'Nenhum backend detectado',
  }[backend] || backend;
}

/* --------------------------------------------------------------- outputs */

function listOutputs(backend) {
  switch (backend) {
    case 'kscreen': {
      const r = run('kscreen-doctor', ['-o']);
      const out = [];
      const re = /^Output:\s*(\d+)\s+(\S+)\s+(connected|disconnected)\s+(enabled|disabled)/gm;
      let m;
      while ((m = re.exec(r.out))) {
        out.push({
          id: m[1],
          name: m[2],
          connected: m[3] === 'connected',
          state: m[4] === 'enabled' ? 'on' : 'off',
          detail: `${m[2]} · ${m[4] === 'enabled' ? 'acesa' : 'apagada'}`,
        });
      }
      return out;
    }
    case 'wlr': {
      const r = run('wlr-randr', []);
      const out = [];
      let current = null;
      for (const line of r.out.split('\n')) {
        const head = line.match(/^(\S+)\s+(?:"|$)/);
        if (head) {
          current = { id: head[1], name: head[1], connected: true, state: 'on', detail: head[1] };
          out.push(current);
        } else if (current) {
          const en = line.match(/Enabled:\s*(yes|no)/i);
          if (en) {
            current.state = en[1].toLowerCase() === 'yes' ? 'on' : 'off';
            current.detail = `${current.name} · ${current.state === 'on' ? 'acesa' : 'apagada'}`;
          }
        }
      }
      return out;
    }
    case 'xrandr': {
      const r = run('xrandr', ['--query']);
      const out = [];
      const re = /^(\S+)\s+(connected|disconnected)\b(.*)$/gm;
      let m;
      while ((m = re.exec(r.out))) {
        if (m[1] === 'Screen') continue;
        const mode = (m[3].match(/\b\d+x\d+\b/));
        out.push({
          id: m[1],
          name: m[1],
          connected: m[2] === 'connected',
          state: m[2] === 'connected' ? 'on' : 'off',
          detail: `${m[1]} · ${m[2] === 'connected' ? (mode ? mode[0] : 'acesa') : 'desligada'}`,
        });
      }
      return out;
    }
    case 'ddcutil': {
      const r = run('ddcutil', ['detect', '--brief'], 7000);
      const out = [];
      const re = /Display\s+(\d+)/g;
      let m;
      while ((m = re.exec(r.out))) {
        const n = m[1];
        const vcp = run('ddcutil', ['getvcp', 'd6', '--display', n], 5000);
        const val = (vcp.out.match(/VCP\s+D6\s+Power mode\s*\(?\s*(?:0x)?([0-9a-f]+)/i) || [])[1];
        out.push({
          id: n,
          name: `Monitor DDC/CI ${n}`,
          connected: true,
          state: val && parseInt(val, 16) === 0 ? 'off' : 'on',
          detail: `Display ${n} · VCP D6`,
        });
      }
      return out;
    }
    case 'dpms':
      return [{ id: 'all', name: 'Todas as telas (DPMS)', connected: true, state: readDpms(), detail: 'DPMS do servidor X' }];
    default:
      return [];
  }
}

function readDpms() {
  const r = run('xset', ['q']);
  return /Monitor is Off/i.test(r.out) ? 'off' : 'on';
}

function targets(cfg, backend) {
  if (backend === 'dpms') return ['all'];
  if (cfg.output === 'all' || cfg.output === 'auto' || !cfg.output) {
    const outs = listOutputs(backend).filter((o) => o.connected);
    return outs.map((o) => o.id);
  }
  return [cfg.output];
}

/* ----------------------------------------------------------------- power */

function applyState(state, cfg = config) {
  const backend = detectBackend(cfg.backend);
  const list = targets(cfg, backend);
  const results = [];

  if (backend === 'none') {
    return { ok: false, message: 'Nenhum backend de vídeo disponível. Instale kscreen-doctor, wlr-randr, xrandr ou ddcutil.' };
  }

  if (!list.length) {
    return { ok: false, message: `Nenhuma saída detectada via ${backend}. Verifique a aba "Saídas" ou tente outro backend.` };
  }

  if (backend === 'dpms') {
    const r = run('xset', ['dpms', 'force', state]);
    return { ok: r.ok, message: r.ok ? `DPMS ${state === 'off' ? 'desligado' : 'ligado'}` : r.err || r.out };
  }

  for (const id of list) {
    let r;
    switch (backend) {
      case 'kscreen':
        r = state === 'off'
          ? run('kscreen-doctor', [`output.${id}.disable`])
          : run('kscreen-doctor', [`output.${id}.enable`, `output.${id}.preferred`]);
        break;
      case 'wlr':
        r = run('wlr-randr', ['--output', String(id), state === 'off' ? '--off' : '--on']);
        break;
      case 'xrandr':
        r = run('xrandr', ['--output', String(id), state === 'off' ? '--off' : '--auto']);
        break;
      case 'ddcutil':
        r = run('ddcutil', ['setvcp', 'd6', state === 'off' ? '00' : '01', '--display', String(id)], 7000);
        break;
      default:
        r = { ok: false, err: 'backend desconhecido' };
    }
    results.push({ id, ok: r.ok, detail: r.ok ? '' : (r.err || r.out || 'falha') });
  }

  const ok = results.length > 0 && results.every((x) => x.ok);
  const fail = results.filter((x) => !x.ok).map((x) => `${x.id}: ${x.detail}`).join(' | ');
  return {
    ok,
    message: ok
      ? `${list.length > 1 ? `${list.length} saídas` : `Saída ${list[0]}`} ${state === 'off' ? 'apagada' : 'ligada'} via ${backend}`
      : fail,
    backend,
    outputs: list,
  };
}

function readState(cfg = config) {
  const backend = detectBackend(cfg.backend);
  const list = targets(cfg, backend);
  const id = list[0];

  if (backend === 'dpms') return readDpms();
  if (backend === 'none') return appliedState;

  const outputs = listOutputs(backend);
  const chosen = outputs.filter((o) => id === 'all' || o.id === id);
  if (!chosen.length) return appliedState;
  if (backend === 'kscreen' || backend === 'xrandr' || backend === 'wlr') {
    return chosen.every((o) => o.state === 'off') ? 'off' : 'on';
  }
  return chosen.every((o) => o.state === 'off') ? 'off' : 'on';
}

/* ------------------------------------------------------------- scheduler */

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function desiredState(nowMinutes, offMin, onMin) {
  if (offMin === null || onMin === null || offMin === onMin) return 'on';
  if (offMin < onMin) return nowMinutes >= offMin && nowMinutes < onMin ? 'off' : 'on';
  return nowMinutes >= offMin || nowMinutes < onMin ? 'off' : 'on';
}

function nextChange(offMin, onMin, nowMinutes) {
  const times = [offMin, onMin].filter((v) => v !== null).sort((a, b) => a - b);
  if (!times.length) return null;
  const future = times.find((t) => t > nowMinutes);
  const at = future !== undefined ? future : times[0];
  const minutes = future !== undefined ? future - nowMinutes : 1440 - nowMinutes + at;
  return { at, minutes, atLabel: `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}` };
}

function fmtTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return `${h}h ${String(m).padStart(2, '0')}min`;
}

function logEvent(text, kind = 'info') {
  lastEvent = { time: new Date().toISOString(), text, kind };
}

function snapshot() {
  const d = new Date();
  const nowMinutes = d.getHours() * 60 + d.getMinutes();
  const offMin = toMinutes(config.offTime);
  const onMin = toMinutes(config.onTime);
  const backend = detectBackend(config.backend);
  const next = nextChange(offMin, onMin, nowMinutes);
  return {
    config: { ...config },
    state: appliedState,
    target: desiredState(nowMinutes, offMin, onMin),
    backend,
    backendLabel: backendLabel(backend),
    outputs: listOutputs(backend),
    next: next ? { ...next, label: fmtTime(next.minutes), state: next.at === offMin ? 'off' : 'on' } : null,
    lastEvent,
    now: d.toISOString(),
    validSchedule: offMin !== null && onMin !== null && offMin !== onMin,
  };
}

function broadcast() {
  const data = snapshot();
  if (win && !win.isDestroyed()) win.webContents.send('state-changed', data);
  updateTray(data);
  return data;
}

function tick() {
  try {
    const d = new Date();
    const nowMinutes = d.getHours() * 60 + d.getMinutes();
    const target = desiredState(nowMinutes, toMinutes(config.offTime), toMinutes(config.onTime));

    if (target !== lastTarget) {
      lastTarget = target;
      if (config.manualOverride) {
        config.manualOverride = false;
        saveConfig();
      }
    }

    if (config.enabled && !config.manualOverride && target !== appliedState) {
      const res = applyState(target);
      if (res.ok) {
        logEvent(`Ação automática: tela ${target === 'off' ? 'apagada' : 'ligada'} · ${res.message}`, target === 'off' ? 'off' : 'on');
        appliedState = target;
      } else {
        logEvent(`Falha ao ${target === 'off' ? 'apagar' : 'ligar'}: ${res.message}`, 'error');
      }
    }
    broadcast();
  } catch (err) {
    logEvent(`Erro no agendador: ${err.message}`, 'error');
    broadcast();
  }
}

/* --------------------------------------------------------------- tray/ui */

function trayIcon(state) {
  const p = path.join(ASSETS, 'tray', state === 'off' ? 'off.png' : 'on.png');
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? nativeImage.createFromPath(path.join(ASSETS, 'icons', 'icon_64.png')) : img;
}

function updateTray(data) {
  if (!tray || tray.isDestroyed()) return;
  tray.setImage(trayIcon(data.state));
  const status = data.state === 'off' ? 'Tela apagada' : 'Tela acesa';
  const next = data.next ? ` · próxima ação ${data.next.atLabel}` : '';
  tray.setToolTip(`Nocturne Display — ${status}${next}`);
  const menu = Menu.buildFromTemplate([
    { label: 'Abrir vigília', click: () => showWindow() },
    { type: 'separator' },
    { label: 'Apagar tela agora', click: () => manualApply('off') },
    { label: 'Ligar tela agora', click: () => manualApply('on') },
    { type: 'separator' },
    {
      label: 'Agendamento ativo',
      type: 'checkbox',
      checked: !!config.enabled,
      click: (item) => setConfig({ enabled: item.checked }),
    },
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function manualApply(state) {
  const res = applyState(state);
  if (res.ok) {
    appliedState = state;
    config.manualOverride = true;
    saveConfig();
    logEvent(`Ação manual: tela ${state === 'off' ? 'apagada' : 'ligada'} · ${res.message}`, state);
  } else {
    logEvent(`Falha na ação manual: ${res.message}`, 'error');
  }
  broadcast();
  return res;
}

function setConfig(patch) {
  config = { ...config, ...patch };
  saveConfig();
  lastTarget = null;
  tick();
  return snapshot();
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow(false);
  else {
    win.show();
    win.focus();
  }
}

function createWindow(minimized) {
  if (win && !win.isDestroyed()) return;
  win = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 1040,
    minHeight: 660,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    icon: path.join(ASSETS, 'icons', 'icon_256.png'),
    show: !minimized,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' });
  win.on('closed', () => { win = null; });
}

function writeAutostart(enabled) {
  try {
    fs.mkdirSync(AUTOSTART_DIR, { recursive: true });
    if (!enabled) {
      if (fs.existsSync(AUTOSTART_FILE)) fs.unlinkSync(AUTOSTART_FILE);
      return;
    }
    const exe = process.env.APPIMAGE || app.getPath('exe');
    const content = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Nocturne Display',
      'Comment=Vigília automática do monitor para Moonlight',
      `Exec="${exe}" --minimized`,
      'Icon=nocturne-display',
      'OnlyShowIn=GNOME;KDE;XFCE;LXQt;Cinnamon;MATE;Unity;',
      'X-GNOME-Autostart-enabled=true',
      'NoDisplay=false',
      '',
    ].join('\n');
    fs.writeFileSync(AUTOSTART_FILE, content);
  } catch (err) {
    logEvent(`Não foi possível configurar inicialização automática: ${err.message}`, 'error');
  }
}

/* ------------------------------------------------------------------- ipc */

ipcMain.handle('get-state', () => snapshot());
ipcMain.handle('set-config', (_e, patch) => {
  const next = setConfig(patch || {});
  if ('autostart' in (patch || {})) writeAutostart(!!patch.autostart);
  return next;
});
ipcMain.handle('apply', (_e, state) => ({ ...manualApply(state), ...snapshot() }));
ipcMain.handle('list-outputs', () => listOutputs(detectBackend(config.backend)));
ipcMain.handle('refresh', () => { tick(); return snapshot(); });
ipcMain.handle('window-minimize', () => { if (win) win.minimize(); });
ipcMain.handle('window-hide', () => { if (win) win.hide(); });
ipcMain.handle('window-maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
});
ipcMain.handle('quit', () => app.quit());
ipcMain.handle('dev-mode', () => IS_DEV);

/* --------------------------------------------------------- quick self-test */

function collectCheck() {
  const items = [];
  const add = (name, status, detail) => items.push({ name, status, detail });
  const ok = (v) => (v ? 'ok' : 'fail');

  let pretty = os.type();
  try {
    const release = fs.readFileSync('/etc/os-release', 'utf8');
    pretty = (release.match(/^PRETTY_NAME="?([^"\n]+)/m) || [])[1] || pretty;
  } catch { /* usa fallback */ }
  add('Sistema', 'info', `${pretty} · ${process.arch} · kernel ${os.release()}`);
  add('Sessão', 'info', `XDG_SESSION_TYPE=${process.env.XDG_SESSION_TYPE || '-'} · DISPLAY=${process.env.DISPLAY || '-'} · WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY || '-'} · XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR || '-'}`);

  const exe = process.execPath || '';
  const appPath = process.env.APPIMAGE || exe;
  const fuseMode = exe.includes('/tmp/.mount_') ? 'FUSE ativo (montagem normal)'
    : exe.includes('squashfs-root') ? 'modo --appimage-extract-and-run'
      : 'executável direto';
  add('AppImage', 'info', `${appPath} · ${fuseMode}`);

  const ldd = run('ldd', [exe], 8000);
  const missing = ldd.out.split('\n').filter((l) => /not found/.test(l)).map((l) => l.split('=>')[0].trim());
  add('Bibliotecas do sistema', ok(!missing.length), missing.length ? `Faltando: ${missing.join(', ')}` : 'Nenhuma biblioteca ausente no binário Electron');

  const backend = detectBackend(config.backend);
  add('Backend de vídeo', ok(backend !== 'none'), `${backend} (${backendLabel(backend)})${config.backend === 'auto' ? ' · detectado automaticamente' : ' · definido manualmente'}`);

  const outputs = backend === 'none' ? [] : listOutputs(backend);
  add('Saídas detectadas', ok(outputs.length > 0 || backend === 'dpms'), outputs.length
    ? outputs.map((o) => `${o.name}[${o.state}]`).join(', ')
    : 'Nenhuma saída encontrada');

  add('Estado atual da tela', 'info', backend === 'none' ? 'indisponível' : readState());

  const offMin = toMinutes(config.offTime);
  const onMin = toMinutes(config.onTime);
  const valid = offMin !== null && onMin !== null && offMin !== onMin;
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const next = nextChange(offMin, onMin, nowMin);
  add('Agenda', ok(valid), valid
    ? `${config.offTime} apagar → ${config.onTime} acender · alvo agora: ${desiredState(nowMin, offMin, onMin)} · próxima: ${next ? next.atLabel : '-'}`
    : `Configuração inválida: ${config.offTime} / ${config.onTime}`);

  let autostart = 'não configurado';
  let autostartOk = true;
  try {
    const raw = fs.readFileSync(AUTOSTART_FILE, 'utf8');
    const execLine = (raw.match(/^Exec=(.*)$/m) || [])[1] || '';
    autostartOk = /AppImage|nocturne/i.test(execLine);
    autostart = `${AUTOSTART_FILE} → ${execLine || '(vazio)'}`;
  } catch { /* sem autostart */ }
  add('Inicialização automática', autostart === 'não configurado' ? 'info' : ok(autostartOk), autostart);

  const sun = run('pgrep', ['-a', 'sunshine'], 3000);
  add('Sunshine', 'info', sun.ok && sun.out ? sun.out.split('\n')[0].slice(0, 160) : 'processo sunshine não encontrado neste instante');

  if (backend === 'ddcutil') {
    let accessible = 0;
    try {
      for (const f of fs.readdirSync('/dev')) if (/^i2c-\d+$/.test(f)) {
        try { fs.accessSync(path.join('/dev', f), fs.constants.R_OK | fs.constants.W_OK); accessible++; } catch { /* sem permissão */ }
      }
    } catch { /* sem /dev */ }
    add('Permissão i2c (DDC/CI)', ok(accessible > 0), `${accessible} dispositivo(s) /dev/i2c-* acessível(is)`);
  }

  const failures = items.filter((i) => i.status === 'fail').length;
  return { ok: failures === 0, failures, items };
}

function runCheck() {
  const result = collectCheck();
  if (process.argv.includes('--check-json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('====================================================');
    console.log(' NOCTURNE DISPLAY — TESTE RÁPIDO DE COMPATIBILIDADE');
    console.log('====================================================');
    for (const item of result.items) {
      const mark = item.status === 'ok' ? '✅' : item.status === 'fail' ? '❌' : 'ℹ️';
      console.log(`${mark} ${item.name}: ${item.detail}`);
    }
    console.log('----------------------------------------------------');
    console.log(result.ok ? 'RESULTADO: OK — pronto para usar nesta máquina.' : `RESULTADO: ATENÇÃO — ${result.failures} item(ns) precisam de ajuste.`);
  }
  app.exit(result.ok ? 0 : 1);
}

/* -------------------------------------------------------------- lifecycle */

if (process.argv.includes('--check') || process.argv.includes('--check-json')) {
  runCheck();
} else {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => showWindow());

    app.whenReady().then(() => {
      tray = new Tray(trayIcon(appliedState));
      tray.on('click', () => showWindow());

      const startMin = process.argv.includes('--minimized') || config.startMinimized;
      createWindow(startMin);

      appliedState = readState();
      logEvent(`Backend detectado: ${backendLabel(detectBackend(config.backend))}`, 'info');
      tick();
      tickTimer = setInterval(tick, 1000);

      powerMonitor.on('resume', () => {
        logEvent('Sistema retomado da suspensão — reavaliando agenda', 'info');
        tick();
      });

      app.on('activate', () => showWindow());
    });
  }
}

app.on('window-all-closed', () => {
  // O app continua vivo na bandeja para manter a agenda.
});

app.on('before-quit', () => {
  if (tickTimer) clearInterval(tickTimer);
});

process.on('uncaughtException', (err) => {
  logEvent(`Erro interno: ${err.message}`, 'error');
});
