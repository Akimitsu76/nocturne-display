'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, powerMonitor, dialog } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const updater = require('./updater');

const IS_DEV = !app.isPackaged || process.argv.includes('--dev');
const CONFIG_DIR = path.join(os.homedir(), '.config', 'nocturne-display');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const AUTOSTART_DIR = path.join(os.homedir(), '.config', 'autostart');
const AUTOSTART_FILE = path.join(AUTOSTART_DIR, 'nocturne-display.desktop');
const ASSETS = path.join(__dirname, '..', 'assets');
const SUNSHINE_CONF = path.join(os.homedir(), '.config', 'sunshine', 'sunshine.conf');
const SUNSHINE_RESTART_COOLDOWN_MS = Number(process.env.NOCTURNE_SUNSHINE_COOLDOWN_MS || 30_000);
const SUNSHINE_MAX_RETRIES = 60; // até ~4 min esperando streaming terminar ou saída voltar

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
  autoUpdate: true,
  scheduleStartsAt: null,
};

let config = loadConfig();
let win = null;
let tray = null;
let appliedState = 'on';
let lastTarget = null;
let tickTimer = null;
let traySupported = true;
let lastUpdateStatus = null;
let lastEvent = { time: null, text: 'Aguardando primeiro ciclo...', kind: 'info' };
let instanceLockFd = null;
let moonlightTimer = null;
let pendingApply = null; // { target: 'on'|'off', reason: 'schedule', ts: number }
let scheduleHoldUntil = null; // novos horários só valem no próximo limite
let sunshineGeneration = 1; // incrementado em cada despertar real (tela/resume)
let sunshineReason = 'startup';
let lastSunshineGeneration = -1;
let lastSunshineRestartAt = 0;
let ensuringSunshinePromise = null;
let sunshineRetryTimer = null;
let lastSunshineNoticeKey = null;
if (config.scheduleStartsAt && Number(config.scheduleStartsAt) > Date.now()) {
  scheduleHoldUntil = Number(config.scheduleStartsAt);
} else if (config.scheduleStartsAt) {
  config.scheduleStartsAt = null;
  saveConfig();
}

function acquireInstanceLock() {
  const lockFile = path.join(CONFIG_DIR, 'instance.lock');
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    instanceLockFd = fs.openSync(lockFile, 'wx');
    fs.writeSync(instanceLockFd, String(process.pid));
    return true;
  } catch (err) {
    try {
      const oldPid = parseInt(fs.readFileSync(lockFile, 'utf8'), 10);
      if (!isNaN(oldPid)) {
        try {
          process.kill(oldPid, 0);
          return false;
        } catch {
          fs.unlinkSync(lockFile);
          instanceLockFd = fs.openSync(lockFile, 'wx');
          fs.writeSync(instanceLockFd, String(process.pid));
          return true;
        }
      }
    } catch {
      try {
        fs.unlinkSync(lockFile);
        instanceLockFd = fs.openSync(lockFile, 'wx');
        fs.writeSync(instanceLockFd, String(process.pid));
        return true;
      } catch { /* falhou de novo */ }
    }
  }
  return false;
}

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

function sunshineActive() {
  const r = run('pgrep', ['-x', 'sunshine'], 2000);
  return r.ok && !!r.out;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SUNSHINE_RESTART_LOGS = {
  startup: 'Sunshine reiniciado na inicialização com a tela ligada; captura pronta.',
  schedule: 'Horário de acender chegou — Sunshine reiniciado com a tela ligada; captura pronta.',
  moonlight: 'Moonlight pediu para acordar — Sunshine reiniciado com a tela ligada; captura pronta.',
  manual: 'Tela ligada manualmente — Sunshine reiniciado com a tela ligada; captura pronta.',
  resume: 'PC acordou — Sunshine reiniciado com a tela ligada; captura pronta.',
};

function noticeOnce(key, text, kind = 'info') {
  if (lastSunshineNoticeKey === key) return;
  lastSunshineNoticeKey = key;
  logEvent(text, kind);
}

// No Niri o backend wlroots do Sunshine precisa de capture=wlr. Ajusta apenas
// essa chave, preservando comentários, seções e todas as outras opções.
function ensureSunshineCaptureConfig() {
  if (detectBackend(config.backend) !== 'niri') return;
  try {
    if (!fs.existsSync(SUNSHINE_CONF)) return;
    const raw = fs.readFileSync(SUNSHINE_CONF, 'utf8');
    const lines = raw.split(/\r?\n/);
    let found = false;

    for (let i = 0; i < lines.length; i++) {
      if (/^\s*[;#]/.test(lines[i])) continue;
      const m = lines[i].match(/^(\s*capture\s*=\s*)(.*?)(\s*(?:#.*)?)$/i);
      if (!m) continue;
      found = true;
      if (m[2].trim().toLowerCase() !== 'wlr') {
        lines[i] = `${m[1]}wlr${m[3] || ''}`;
        fs.writeFileSync(SUNSHINE_CONF, lines.join('\n'));
        logEvent('sunshine.conf: capture ajustado para wlr (backend Niri).', 'info');
      }
      break;
    }

    if (!found) {
      const inputIdx = lines.findIndex((l) => /^\s*\[input\]\s*$/i.test(l));
      if (inputIdx >= 0) lines.splice(inputIdx + 1, 0, 'capture = wlr');
      else {
        if (lines.length && lines[lines.length - 1] !== '') lines.push('');
        lines.push('capture = wlr', '');
      }
      fs.writeFileSync(SUNSHINE_CONF, lines.join('\n'));
      logEvent('sunshine.conf: capture = wlr adicionado para o backend Niri.', 'info');
    }
  } catch (err) {
    logEvent(`Não foi possível ajustar capture=wlr no sunshine.conf: ${err.message}`, 'warn');
  }
}

// O Niri só tem captura útil quando a saída tem modo atual e região lógica.
// Verificamos isso no JSON do IPC antes de reiniciar o Sunshine.
function niriReadyFromJson(text, cfg) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ready: false, detail: 'JSON inválido do niri' };
  }
  if (!data || Array.isArray(data) || typeof data !== 'object') {
    return { ready: false, detail: 'resposta inesperada do niri' };
  }

  const entries = Object.entries(data).filter(([, v]) => v && typeof v === 'object');
  const wantedId = cfg.output && cfg.output !== 'auto' && cfg.output !== 'all'
    ? String(cfg.output) : null;
  const candidates = wantedId
    ? entries.filter(([key, v]) => String(v.name || key) === wantedId)
    : entries;

  const ready = candidates.some(([, v]) => {
    const idx = v.current_mode;
    const mode = Array.isArray(v.modes) && Number.isInteger(idx) ? v.modes[idx] : null;
    const hasMode = !!mode && Number(mode.width) > 0 && Number(mode.height) > 0;
    const logical = v.logical;
    const lw = Array.isArray(logical) ? logical[2] : logical && logical.width;
    const lh = Array.isArray(logical) ? logical[3] : logical && logical.height;
    const hasLogical = Number(lw) > 0 && Number(lh) > 0;
    const enabled = typeof v.enabled === 'boolean' ? v.enabled : (hasMode && hasLogical);
    return enabled && hasMode && hasLogical;
  });

  return {
    ready,
    detail: ready
      ? 'saída com current_mode e logical válidos'
      : `current_mode/logical inválidos${wantedId ? ` em ${wantedId}` : ''}`,
  };
}

function videoReadyInfo() {
  const backend = detectBackend(config.backend);
  if (backend === 'none') return { ready: false, detail: 'sem backend de vídeo' };

  if (backend === 'niri') {
    const r = run('niri', ['msg', '--json', 'outputs'], 3000);
    if (!r.ok || !r.out) return { ready: false, detail: r.err || 'niri sem resposta' };
    return niriReadyFromJson(r.out, config);
  }

  const list = targets(config, backend);
  const chosen = list.filter((id) => config.output === 'auto' || config.output === 'all'
    || !config.output || id === config.output);
  if (!chosen.length) return { ready: false, detail: 'nenhuma saída selecionada' };
  const outs = listOutputs(backend).filter((o) => chosen.includes(o.id) || chosen.includes(o.name));
  const ready = outs.some((o) => o.state === 'on');
  return {
    ready,
    detail: ready ? `saída ${outs.find((o) => o.state === 'on').name} ligada` : 'saída selecionada apagada',
  };
}

// Uma sessão de streaming em andamento não deve ser interrompida por restart.
function streamingSessionActive() {
  const r = run('ss', ['-tn', 'state', 'established', '( dport = :47984 or dport = :47989 or dport = :47990 )'], 2000);
  if (!r.ok || !r.out) return false;
  return r.out.split('\n').slice(1).some((line) => {
    const cols = line.trim().split(/\s+/);
    const peer = cols[4] || '';
    const host = peer.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return !!host && !['127.0.0.1', '::1', 'localhost'].includes(host);
  });
}

async function restartSunshine() {
  const r = run('systemctl', ['--user', 'restart', 'sunshine'], 12000);
  if (r.ok) return true;

  // Fallback para sistemas sem o serviço de usuário: encerra o processo antigo
  // e inicia um único Sunshine destacado do app.
  run('pkill', ['-x', 'sunshine'], 3000);
  try {
    const child = spawn('sunshine', [], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.on('error', (err) => logEvent(`Falha ao iniciar o Sunshine: ${err.message}`, 'error'));
    child.unref();
    await delay(500);
    return sunshineActive();
  } catch (err) {
    logEvent(`Falha ao iniciar o Sunshine: ${err.message}`, 'error');
    return false;
  }
}

function scheduleSunshineRetry(reason, force, retry) {
  if (sunshineRetryTimer || retry > SUNSHINE_MAX_RETRIES) return;
  sunshineRetryTimer = setTimeout(() => {
    sunshineRetryTimer = null;
    ensureSunshineReady({ reason, force, retry });
  }, 4000);
}

// Único ponto de entrada para garantir captura do Sunshine. Chamado no startup,
// ao acender pelo agendador/Moonlight/ação manual e no resume do powerMonitor.
async function ensureSunshineReady({ reason = 'screen', force = false, retry = 0 } = {}) {
  // Chamadas disparadas por um evento (retry=0) atualizam o motivo vigente;
  // reintentos apenas consomem o motivo mais recente.
  if (retry === 0) sunshineReason = reason;
  ensureSunshineCaptureConfig();
  if (ensuringSunshinePromise) return ensuringSunshinePromise;

  const generation = sunshineGeneration;
  if (!force && lastSunshineGeneration === generation) return false;

  ensuringSunshinePromise = (async () => {
    // Garante que a atribuição de ensuringSunshinePromise aconteça antes de
    // qualquer retorno síncrono do corpo da função.
    await Promise.resolve();
    try {
      if (streamingSessionActive()) {
        noticeOnce(`stream:${generation}:${sunshineReason}`, 'Streaming ativo — restart do Sunshine adiado para não interromper a sessão.', 'info');
        scheduleSunshineRetry(sunshineReason, force, retry + 1);
        return false;
      }

      if (!force && Date.now() - lastSunshineRestartAt < SUNSHINE_RESTART_COOLDOWN_MS) {
        lastSunshineGeneration = sunshineGeneration;
        return false;
      }

      let info = { ready: false, detail: '' };
      const attempts = sunshineReason === 'startup' ? 2 : 4;
      for (let i = 0; i < attempts; i++) {
        info = videoReadyInfo();
        if (info.ready) break;
        if (i < attempts - 1) await delay(700);
      }

      if (!info.ready) {
        noticeOnce(`novideo:${generation}:${sunshineReason}`, `Sunshine não reiniciado: ${info.detail}.`, 'warn');
        scheduleSunshineRetry(sunshineReason, force, retry + 1);
        return false;
      }

      const restarted = await restartSunshine();
      if (!restarted) {
        noticeOnce(`falha:${generation}:${sunshineReason}`, 'Não foi possível reiniciar o Sunshine com a tela ligada.', 'warn');
        return false;
      }

      // Consome também gerações criadas enquanto esta chamada estava em voo:
      // o restart recém-feito já cobre qualquer despertar seguinte próximo.
      lastSunshineGeneration = sunshineGeneration;
      lastSunshineRestartAt = Date.now();
      lastSunshineNoticeKey = null;
      logEvent(SUNSHINE_RESTART_LOGS[sunshineReason] || 'Sunshine reiniciado com a tela ligada; captura pronta.', 'info');
      broadcast();
      return true;
    } catch (err) {
      logEvent(`Erro ao garantir Sunshine: ${err.message}`, 'error');
      broadcast();
      return false;
    } finally {
      ensuringSunshinePromise = null;
    }
  })();

  return ensuringSunshinePromise;
}

// O Moonlight "Acordar PC" envia Wake-on-LAN (sem efeito enquanto o PC já está
// ligado) e em seguida abre conexões com o Sunshine. Detectar essas conexões
// permite acender o monitor também quando o pedido veio do Moonlight.
function moonlightClientActive() {
  const r = run('ss', ['-tn', '( dport = :47984 or dport = :47989 or dport = :47990 )'], 2000);
  if (!r.ok || !r.out) return false;
  return r.out.split('\n').slice(1).some((line) => {
    const cols = line.trim().split(/\s+/);
    const peer = cols[4] || '';
    const host = peer.replace(/:.*$/, '').replace(/^\[|\]$/g, '');
    return !!host && !['127.0.0.1', '::1', 'localhost'].includes(host);
  });
}

function checkMoonlightWake() {
  if (!config.enabled || appliedState !== 'off' || !sunshineActive()) return;
  if (!moonlightClientActive()) return;
  const res = applyState('on', config, 'moonlight');
  if (!res.ok) return;
  appliedState = 'on';
  // Mantém a tela ligada até o próximo horário de acender programado.
  config.manualOverride = true;
  saveConfig();
  logEvent('Moonlight pediu para acordar o PC — tela ligada e Sunshine ativo.', 'on');
  broadcast();
}

function detectBackend(preferred) {
  if (preferred && preferred !== 'auto') return preferred;

  // O Niri não é wlroots: wlr-randr consegue ligar, mas falha ao desligar.
  // O IPC nativo dele deve sempre ter prioridade quando a sessão é Niri.
  if (hasCmd('niri')) {
    const running = !!process.env.NIRI_SOCKET || run('pgrep', ['-x', 'niri'], 2000).ok;
    if (running) return 'niri';
  }

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
    niri: 'Niri (IPC nativo)',
    kscreen: 'KDE / KScreen (Wayland)',
    wlr: 'wlroots / sway / Hyprland',
    xrandr: 'X11 / xrandr',
    ddcutil: 'DDC/CI (físico)',
    dpms: 'DPMS (X11, mantém saída)',
    none: 'Nenhum backend detectado',
  }[backend] || backend;
}

/* --------------------------------------------------------------- outputs */

function niriOutputsFromJson(text) {
  const data = JSON.parse(text);
  const entries = data && !Array.isArray(data) && typeof data === 'object' ? Object.entries(data) : [];
  return entries
    .filter(([, v]) => v && typeof v === 'object')
    .map(([key, v]) => {
      const name = v.name || key;
      const mode = (v.modes || [])[v.current_mode] || {};
      const enabled = typeof v.enabled === 'boolean'
        ? v.enabled
        : (v.current_mode !== null && v.current_mode !== undefined) || v.logical !== null && v.logical !== undefined;
      const label = [v.make, v.model].filter(Boolean).join(' ').trim();
      const modeLabel = mode.width ? `${mode.width}x${mode.height}${mode.refresh_rate ? `@${(mode.refresh_rate / 1000).toFixed(3)}Hz` : ''}` : 'acesa';
      return {
        id: name,
        name,
        connected: true,
        state: enabled ? 'on' : 'off',
        detail: label ? `${label} · ${enabled ? modeLabel : 'desligada'}` : `${name} · ${enabled ? modeLabel : 'desligada'}`,
      };
    });
}

function niriOutputsFromText(text) {
  return text.split(/^Output:\s*/m).slice(1).map((block) => {
    const first = block.split('\n')[0].trim();
    const name = first.split(/\s+\(/)[0].split(/\s+/)[0];
    const label = (first.match(/\("([^"]+)"/) || [])[1] || '';
    const enabled = !/^\s*Disabled\b/im.test(block) && !/\bDisabled\b/im.test(block.split('\n').slice(0, 4).join('\n'));
    return {
      id: name,
      name,
      connected: true,
      state: enabled ? 'on' : 'off',
      detail: label ? `${label} · ${enabled ? 'acesa' : 'desligada'}` : `${name} · ${enabled ? 'acesa' : 'desligada'}`,
    };
  }).filter((o) => o.name);
}

function niriListOutputs() {
  const r = run('niri', ['msg', '--json', 'outputs']);
  if (r.ok && r.out) {
    try {
      const parsed = niriOutputsFromJson(r.out);
      if (parsed.length) return parsed;
    } catch { /* tenta formato legível abaixo */ }
  }
  const text = run('niri', ['msg', 'outputs']);
  return niriOutputsFromText(text.ok ? text.out : r.err);
}

function listOutputs(backend) {
  switch (backend) {
    case 'niri':
      return niriListOutputs();
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

function applyState(state, cfg = config, reason = 'screen') {
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
      case 'niri':
        r = run('niri', ['msg', 'output', String(id), state === 'off' ? 'off' : 'on']);
        break;
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

  // Toda transição para "on" é um novo despertar: a captura do Sunshine precisa
  // ser recriada com a saída já disponível. ensureSunshineReady é idempotente.
  if (state === 'on' && ok) {
    sunshineGeneration += 1;
    ensureSunshineReady({ reason });
  }

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
  if (backend === 'niri' || backend === 'kscreen' || backend === 'xrandr' || backend === 'wlr') {
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

// Confirmação antes de salvar: o ciclo só entra em vigor no próximo limite,
// nunca de forma retroativa no momento em que o horário é ajustado.
function armSchedule() {
  const d = new Date();
  const nowMinutes = d.getHours() * 60 + d.getMinutes();
  const offMin = toMinutes(config.offTime);
  const onMin = toMinutes(config.onTime);
  const next = nextChange(offMin, onMin, nowMinutes);

  if (!next || offMin === null || onMin === null || offMin === onMin) {
    scheduleHoldUntil = null;
    config.scheduleStartsAt = null;
    saveConfig();
    return;
  }

  const restMs = next.minutes * 60000 - d.getSeconds() * 1000 - d.getMilliseconds();
  scheduleHoldUntil = Date.now() + Math.max(1000, restMs);
  config.scheduleStartsAt = scheduleHoldUntil;
  saveConfig();
  lastTarget = desiredState(nowMinutes, offMin, onMin);
  logEvent(`Horários confirmados · próximo ciclo às ${next.atLabel}`, 'info');
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
    version: app.getVersion(),
    state: appliedState,
    target: desiredState(nowMinutes, offMin, onMin),
    backend,
    backendLabel: backendLabel(backend),
    outputs: listOutputs(backend),
    next: next ? { ...next, label: fmtTime(next.minutes), state: next.at === offMin ? 'off' : 'on' } : null,
    lastEvent,
    now: d.toISOString(),
    validSchedule: offMin !== null && onMin !== null && offMin !== onMin,
    scheduleHold: !!scheduleHoldUntil,
    scheduleStartsAt: scheduleHoldUntil ? new Date(scheduleHoldUntil).toISOString() : null,
    pending: !!pendingApply,
    pendingTarget: pendingApply ? pendingApply.target : null,
    sunshineRestartAt: lastSunshineRestartAt ? new Date(lastSunshineRestartAt).toISOString() : null,
    sunshinePending: lastSunshineGeneration !== sunshineGeneration,
  };
}

function broadcast() {
  const data = snapshot();
  if (win && !win.isDestroyed()) win.webContents.send('state-changed', data);
  updateTray(data);
  return data;
}

const UPDATE_LOG = {
  available: (s) => `Atualização ${s.latestVersion} disponível`,
  downloading: (s) => s.message,
  installed: (s) => `${s.message} · reinicie quando quiser`,
  error: (s) => s.message,
};

updater.onChange((update) => {
  if (win && !win.isDestroyed()) win.webContents.send('update-changed', update);
  if (update.status !== lastUpdateStatus) {
    lastUpdateStatus = update.status;
    const make = UPDATE_LOG[update.status];
    if (make) logEvent(make(update), update.status === 'error' ? 'error' : 'info');
  }
});

function tick() {
  try {
    const d = new Date();
    const nowMinutes = d.getHours() * 60 + d.getMinutes();
    const target = desiredState(nowMinutes, toMinutes(config.offTime), toMinutes(config.onTime));

    if (scheduleHoldUntil && Date.now() >= scheduleHoldUntil) {
      scheduleHoldUntil = null;
      config.scheduleStartsAt = null;
      config.manualOverride = false;
      saveConfig();
      lastTarget = null;
      logEvent('Ciclo confirmado iniciado — aplicando os novos horários', 'info');
    }

    if (scheduleHoldUntil) {
      // Aguarda o próximo limite sem aplicar o horário de forma retroativa.
      lastTarget = target;
      pendingApply = null;
      broadcast();
      return;
    }

    if (target !== lastTarget) {
      lastTarget = target;
      if (config.manualOverride) {
        config.manualOverride = false;
        saveConfig();
      }
    }

    // Confirmação legada (quando a configuração é alterada fora da aba Altar).
    if (pendingApply && target === 'off') {
      broadcast();
      return;
    }

    if (config.enabled && !config.manualOverride && target !== appliedState) {
      const res = applyState(target, config, 'schedule');
      if (res.ok) {
        logEvent(`Ação automática: tela ${target === 'off' ? 'apagada' : 'ligada'} · ${res.message}`, target === 'off' ? 'off' : 'on');
        appliedState = target;
        pendingApply = null;
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

function hasTrayHost() {
  const r = run('gdbus', [
    'call', '--session',
    '--dest', 'org.freedesktop.DBus',
    '--object-path', '/org/freedesktop/DBus',
    '--method', 'org.freedesktop.DBus.ListNames',
  ], 3000);
  return /StatusNotifierWatcher/i.test(r.out);
}

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
  const res = applyState(state, config, 'manual');
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
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();

  config = { ...config, ...patch };
  saveConfig();

  // Horários vêm da confirmação "Aplicar horário HH:MM?" da interface. A partir
  // daí o ciclo só começa no próximo limite, sem desligar retroativamente.
  if ('offTime' in patch || 'onTime' in patch) {
    armSchedule();
    pendingApply = null;
    tick();
    return { ...snapshot(), pending: false };
  }

  // Recalcula o alvo desejado com a nova config.
  const target = desiredState(nowMinutes, toMinutes(config.offTime), toMinutes(config.onTime));
  lastTarget = target;

  // Configurações alteradas fora da aba Altar ainda usam a confirmação legada.
  if (target !== appliedState && target === 'off' && config.enabled && !config.manualOverride) {
    pendingApply = { target, reason: 'schedule', ts: Date.now() };
    return { ...snapshot(), pending: true };
  }

  pendingApply = null;
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
      // Sem OnlyShowIn: o Niri (e outros compositores) também devem iniciar o app.
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
  if ('autoUpdate' in (patch || {})) {
    updater.setAutoUpdateGetter(() => !!config.autoUpdate);
    // Não instala automaticamente: apenas grava a preferência. O usuário instala
    // manualmente quando quiser, sem interromper a vigília nem a transmissão.
  }
  return next;
});
// Usuário confirmou: aplica o desligamento/acionamento pendente agora.
ipcMain.handle('confirmApply', (_e) => {
  if (!pendingApply) return { ...snapshot(), pending: false };
  const { target } = pendingApply;
  const res = applyState(target, config, 'manual');
  if (res.ok) {
    appliedState = target;
    pendingApply = null;
    logEvent(`Confirmação do usuário: tela ${target === 'off' ? 'apagada' : 'ligada'} agora.`, target === 'off' ? 'off' : 'on');
  } else {
    logEvent(`Falha ao aplicar confirmação: ${res.message}`, 'error');
  }
  return { ...res, ...snapshot(), pending: false };
});
// Usuário escolheu adiar: limpa o pending e deixa o agendamento normal seguir
// (desligará no offTime do próximo dia).
ipcMain.handle('deferApply', (_e) => {
  if (!pendingApply) return { ...snapshot(), pending: false };
  pendingApply = null;
  // Mantém o override manual até a próxima troca de alvo (horário de acender).
  // Sem isso, o tick seguinte aplicaria o desligamento imediatamente.
  config.manualOverride = true;
  saveConfig();
  lastTarget = desiredState(
    new Date().getHours() * 60 + new Date().getMinutes(),
    toMinutes(config.offTime),
    toMinutes(config.onTime),
  );
  logEvent('Usuário adiou a ação; o desligamento ficou para o próximo dia.', 'info');
  return { ...snapshot(), pending: false };
});
ipcMain.handle('apply', (_e, state) => ({ ...manualApply(state), ...snapshot() }));
ipcMain.handle('list-outputs', () => listOutputs(detectBackend(config.backend)));
ipcMain.handle('refresh', () => { tick(); return snapshot(); });
ipcMain.handle('window-minimize', () => { if (win) win.minimize(); });
ipcMain.handle('window-hide', () => {
  if (!win) return;
  // Sem host de bandeja (comum no Niri), minimizar é mais seguro que esconder:
  // a janela continua acessível pela lista de janelas do compositor.
  if (traySupported) win.hide(); else win.minimize();
});
ipcMain.handle('window-maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
});
ipcMain.handle('quit', () => app.quit());
ipcMain.handle('dev-mode', () => IS_DEV);
// Disponível apenas em desenvolvimento: permite testar o caminho de resume sem
// precisar suspender a máquina.
if (IS_DEV) {
  ipcMain.handle('dev-resume', () => {
    powerMonitor.emit('resume');
    return snapshot();
  });
}

/* --------------------------------------------------------------- updates */

ipcMain.handle('get-update-state', () => updater.getState());
ipcMain.handle('check-updates', () => updater.check({ manual: true }));
ipcMain.handle('install-update', () => updater.install());
ipcMain.handle('restart-app', () => updater.restart());
ipcMain.handle('open-release', () => updater.openRelease());

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

  const upd = updater.getState();
  add('Atualizações', 'info', `v${app.getVersion()} · automática ${config.autoUpdate ? 'ativada' : 'desativada'} · ${upd.supported ? 'AppImage (instalação disponível)' : 'executável direto (somente aviso)'}`);

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
  // Single Instance fixo entre versões: um arquivo de lock em ~/.config/nocturne-display/instance.lock
  // impede que v1.0.0 e v1.2.0 (ou qualquer AppImage diferente) rodem juntas.
  if (!acquireInstanceLock()) {
    app.quit();
  } else {
    const gotLock = app.requestSingleInstanceLock();
    if (!gotLock) {
      try { if (instanceLockFd !== null) fs.closeSync(instanceLockFd); } catch {}
      app.quit();
    } else {
    app.on('second-instance', () => showWindow());

    app.whenReady().then(() => {
      traySupported = detectBackend(config.backend) !== 'niri' || hasTrayHost();
      if (traySupported) {
        tray = new Tray(trayIcon(appliedState));
        tray.on('click', () => showWindow());
      }

      const startMin = process.argv.includes('--minimized') || config.startMinimized;
      createWindow(startMin && traySupported);

      appliedState = readState();
      logEvent(`Backend detectado: ${backendLabel(detectBackend(config.backend))}`, 'info');
      // Garante que o Sunshine seja reiniciado com o estado real do monitor:
      // se ele tiver começado com a tela apagada, a captura falha.
      ensureSunshineReady({ reason: 'startup' });
      tick();
      tickTimer = setInterval(tick, 1000);
      moonlightTimer = setInterval(checkMoonlightWake, 1000);

      updater.setAutoUpdateGetter(() => !!config.autoUpdate);
      updater.start();

      powerMonitor.on('resume', () => {
        logEvent('Sistema retomado da suspensão — reavaliando agenda', 'info');
        sunshineGeneration += 1;
        ensureSunshineReady({ reason: 'resume' });
        tick();
      });

      app.on('activate', () => showWindow());
    });
    }
  }
}

app.on('window-all-closed', () => {
  // O app continua vivo na bandeja para manter a agenda.
});

app.on('before-quit', () => {
  if (tickTimer) clearInterval(tickTimer);
  if (moonlightTimer) clearInterval(moonlightTimer);
  if (sunshineRetryTimer) clearTimeout(sunshineRetryTimer);
  updater.stop();
});

process.on('uncaughtException', (err) => {
  logEvent(`Erro interno: ${err.message}`, 'error');
});
