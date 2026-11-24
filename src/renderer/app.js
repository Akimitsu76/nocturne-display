'use strict';

const $ = (id) => document.getElementById(id);
let current = null;
let updateState = null;
let lastApplied = null;
let lastEventTime = null;
let lastOutputSig = null;
const logs = [];
let audioCtx = null;

/* --------------------------------------------------------- ambience vars */
function buildParticles() {
  const box = $('particles');
  const total = 34;
  for (let i = 0; i < total; i++) {
    const p = document.createElement('div');
    p.className = 'particle' + (i % 3 === 0 ? ' violet' : '');
    const size = 2 + Math.random() * 6;
    p.style.width = `${size}px`;
    p.style.height = `${size}px`;
    p.style.left = `${Math.random() * 100}%`;
    p.style.animationDuration = `${16 + Math.random() * 22}s`;
    p.style.animationDelay = `-${Math.random() * 36}s`;
    p.style.opacity = String(0.35 + Math.random() * 0.5);
    box.appendChild(p);
  }
}

function tickClock() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  $('clock').textContent = `${hh}:${mm}:${ss}`;
  const nowMin = d.getHours() * 60 + d.getMinutes();
  $('tlNow').style.left = `${(nowMin / 1440) * 100}%`;
}

/* ------------------------------------------------------------------ nav */
function switchView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $('crumb').textContent = { altar: 'Altar', saidas: 'Saídas', rituais: 'Rituais', atualizacoes: 'Atualizações' }[name] || name;

  if (name === 'atualizacoes' && updateState && !updateState.busy) {
    const stale = !updateState.lastCheck || Date.now() - updateState.lastCheck > 10 * 60 * 1000;
    if (stale) window.api.checkUpdates().then(renderUpdate);
  }
}

document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));

/* --------------------------------------------------------------- actions */
$('btnMin').addEventListener('click', () => window.api.minimize());
$('btnMax').addEventListener('click', () => window.api.maximize());
$('btnClose').addEventListener('click', () => window.api.hide());

$('btnOff').addEventListener('click', () => window.api.apply('off'));
$('btnOn').addEventListener('click', () => window.api.apply('on'));
$('btnSync').addEventListener('click', async () => {
  await window.api.refresh();
  flash($('btnSync'));
});
$('btnRescan').addEventListener('click', async () => {
  await window.api.refresh();
  flash($('btnRescan'));
});

/* ------------------------------------------------------------- updates */
$('btnCheckUpdate').addEventListener('click', async () => {
  renderUpdate(await window.api.checkUpdates());
});
$('btnInstallUpdate').addEventListener('click', async () => {
  renderUpdate(await window.api.installUpdate());
});
$('btnRestart').addEventListener('click', () => window.api.restartApp());
$('btnRelease').addEventListener('click', () => window.api.openRelease());
$('autoUpdate').addEventListener('change', async (e) => {
  await window.api.setConfig({ autoUpdate: e.target.checked });
});

function flash(el) {
  const old = el.style.filter;
  el.style.filter = 'brightness(1.6)';
  setTimeout(() => { el.style.filter = old; }, 280);
}

/* ------------------------------------------------ confirmação de horário */
function renderPending(data) {
  const pending = !!data.pending;
  $('confirmBackdrop').hidden = !pending;
  if (pending) {
    $('confirmDetail').textContent = data.config && data.config.offTime
      ? `O horário ${data.config.offTime} já está vigente agora.`
      : 'O horário escolhido já está dentro da janela atual.';
  }
}

$('btnConfirmOff').addEventListener('click', async () => {
  const data = await window.api.confirmApply();
  render(data);
  renderPending(data);
});
$('btnDeferOff').addEventListener('click', async () => {
  const data = await window.api.deferApply();
  render(data);
  renderPending(data);
});

/* ----------------------------------------------------------- config bind */
const timeInputs = { offTime: $('offTime'), onTime: $('onTime') };

for (const [key, el] of Object.entries(timeInputs)) {
  el.addEventListener('change', async () => {
    const patch = {};
    patch[key] = el.value;
    render(await window.api.setConfig(patch));
  });
}

$('enabled').addEventListener('change', async (e) => render(await window.api.setConfig({ enabled: e.target.checked })));
$('setEnabled').addEventListener('change', async (e) => render(await window.api.setConfig({ enabled: e.target.checked })));
$('setAutostart').addEventListener('change', async (e) => render(await window.api.setConfig({ autostart: e.target.checked })));
$('setMinimized').addEventListener('change', async (e) => render(await window.api.setConfig({ startMinimized: e.target.checked })));
$('setSound').addEventListener('change', async (e) => {
  render(await window.api.setConfig({ sound: e.target.checked }));
  if (e.target.checked) ensureAudio();
});

$('backendSelect').addEventListener('change', async (e) => {
  render(await window.api.setConfig({ backend: e.target.value }));
  render(await window.api.refresh());
});

/* ------------------------------------------------------------- rendering */
function renderTimeline(data) {
  const off = parseMin(data.config.offTime);
  const on = parseMin(data.config.onTime);
  if (off === null || on === null || off === on) return;

  const pct = (m) => (m / 1440) * 100;
  const seg1 = $('tlOff1');
  const seg2 = $('tlOff2');
  if (off < on) {
    seg1.hidden = false;
    seg1.style.left = `${pct(off)}%`;
    seg1.style.width = `${pct(on - off)}%`;
    seg2.hidden = true;
  } else {
    seg1.hidden = false;
    seg1.style.left = `${pct(off)}%`;
    seg1.style.width = `${pct(1440 - off)}%`;
    seg2.hidden = false;
    seg2.style.left = '0%';
    seg2.style.width = `${pct(on)}%`;
  }
  $('tlOffMarker').style.left = `${pct(off)}%`;
  $('tlOnMarker').style.left = `${pct(on)}%`;
}

function parseMin(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v || '');
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

function renderOutputs(data) {
  const list = data.outputs || [];
  const sig = JSON.stringify([data.config.output, data.config.backend, data.state, list.map((o) => `${o.id}:${o.state}`)]);
  if (sig === lastOutputSig && $('backendBadge').textContent === data.backendLabel) return;
  lastOutputSig = sig;
  const box = $('outputList');
  box.innerHTML = '';

  const mk = (id, name, detail, state, selected, extraClass = '') => {
    const el = document.createElement('div');
    el.className = `output-item ${selected ? 'selected' : ''} ${extraClass}`;
    el.dataset.id = id;
    el.innerHTML = `
      <span class="output-radio"></span>
      <div><div class="output-name">${escapeHtml(name)}</div><div class="output-detail">${escapeHtml(detail)}</div></div>
      <span class="output-state ${state}">${state === 'off' ? 'apagada' : 'acesa'}</span>`;
    el.addEventListener('click', async () => {
      await window.api.setConfig({ output: id });
      renderOutputs(current);
    });
    box.appendChild(el);
  };

  const autoSelected = data.config.output === 'auto' || !data.config.output;
  mk('auto', 'Detecção automática', 'Controla todas as saídas ativas', data.state, autoSelected, 'output-all');
  if (list.length > 1) {
    mk('all', 'Todas as saídas', 'Aplica o comando a todos os monitores', data.state, data.config.output === 'all');
  }
  for (const o of list) {
    mk(o.id, o.name, o.detail || '', o.state, String(data.config.output) === String(o.id));
  }
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-outputs';
    empty.innerHTML = 'Nenhuma saída detectada.<br>Instale <b>kscreen-doctor</b>, <b>wlr-randr</b> ou <b>xrandr</b> e clique em “Procurar telas”.';
    box.appendChild(empty);
  }
  $('outputCount').textContent = `${list.length} ${list.length === 1 ? 'saída' : 'saídas'}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function appendLog(event) {
  if (!event || !event.time) return;
  if (event.time === lastEventTime) return;
  lastEventTime = event.time;
  logs.unshift(event);
  if (logs.length > 12) logs.pop();
  const box = $('logList');
  box.innerHTML = '';
  for (const e of logs) {
    const d = new Date(e.time);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const row = document.createElement('div');
    row.className = `log-entry ${e.kind || 'info'}`;
    row.innerHTML = `<span class="log-dot"></span><span class="log-time">${hh}:${mm}:${ss}</span><span class="log-text">${escapeHtml(e.text)}</span>`;
    box.appendChild(row);
  }
}

/* -------------------------------------------------------- update rendering */
const UPDATE_LABELS = {
  idle: 'Aguardando verificação...',
  checking: 'Verificando...',
  'up-to-date': 'Atualizado',
  available: 'Nova versão disponível',
  downloading: 'Baixando atualização',
  installing: 'Aplicando atualização',
  installed: 'Atualização instalada',
  unsupported: 'Instalação indisponível',
  error: 'Falha na verificação',
};

function renderUpdate(state) {
  if (!state) return;
  updateState = state;

  $('updateCurrent').textContent = `v${state.version}`;
  $('updateInterval').textContent = String(state.checkIntervalMinutes || 30);
  $('updateBadge').textContent = state.latestVersion ? `v${state.latestVersion}` : '—';
  $('autoUpdate').checked = !!state.autoUpdate;

  const hero = document.querySelector('.update-hero');
  hero.classList.toggle('has-update', state.status === 'available' || state.status === 'downloading');
  hero.classList.toggle('is-installed', state.status === 'installed');
  hero.classList.toggle('is-error', state.status === 'error');
  $('updateNavMark').classList.toggle('update-dot', state.status === 'available');

  $('updateStatus').textContent = UPDATE_LABELS[state.status] || state.status;
  $('updateStatusDetail').textContent = state.message || '—';

  const busy = !!state.busy;
  $('btnCheckUpdate').disabled = busy;
  $('btnInstallUpdate').hidden = !(state.status === 'available' && state.supported && state.release && state.release.downloadUrl) || busy;
  $('btnRestart').hidden = state.status !== 'installed';
  $('btnRelease').hidden = !(state.release && state.release.url);

  const inProgress = state.status === 'downloading' || state.status === 'installing';
  $('updateProgressWrap').hidden = !inProgress;
  $('updateProgressFill').style.width = `${Math.max(0, Math.min(100, state.progress || 0))}%`;
  $('updateProgressLabel').textContent = `${Math.max(0, Math.min(100, state.progress || 0))}%`;

  const notes = !!(state.release && state.release.notes);
  $('releaseNotesPanel').hidden = !notes;
  if (notes) {
    $('releaseVersion').textContent = `v${state.release.version}`;
    $('releaseAsset').textContent = state.release.assetName || 'sem artefato';
    const when = state.release.publishedAt ? new Date(state.release.publishedAt).toLocaleDateString('pt-BR') : '';
    $('releaseDate').textContent = when ? `publicado em ${when}` : 'release do GitHub';
    $('releaseNotes').textContent = state.release.notes;
  }

  const hint = $('updateHint');
  if (state.supported) {
    hint.textContent = `AppImage: ${state.appImagePath}. A substituição é atômica: a versão em uso continua funcionando até o reinício.`;
  } else {
    hint.textContent = 'Executável direto detectado: a verificação funciona, mas a instalação automática requer o AppImage. Baixe o arquivo na release do GitHub.';
  }
}

function render(data) {
  current = data;
  const cfg = data.config;
  const isOff = data.state === 'off';

  if (data.version) $('footVersion').textContent = `v${data.version}`;
  document.querySelector('.status-card').classList.toggle('is-off', isOff);
  $('statusTitle').textContent = isOff ? 'Tela apagada' : 'Tela acesa';
  $('sideState').textContent = isOff ? 'Tela apagada' : 'Tela acesa';
  $('sideDot').classList.toggle('off', isOff);

  let desc;
  if (!cfg.enabled) desc = 'Agendamento pausado — controle manual disponível.';
  else if (cfg.manualOverride) desc = 'Override manual ativo até o próximo horário programado.';
  else if (isOff) desc = `Repouso até às ${cfg.onTime}. O computador segue ligado.`;
  else desc = `Despertar automático às ${cfg.offTime}.`;
  $('statusDesc').textContent = desc;

  $('nextTime').textContent = data.next ? data.next.atLabel : '--:--';
  $('nextLabel').textContent = data.next
    ? `Tela ${data.next.state === 'off' ? 'apaga' : 'acende'}`
    : 'sem ciclo válido';
  $('nextCountdown').textContent = data.next ? `em ${data.next.label}` : '—';

  if (document.activeElement !== timeInputs.offTime) timeInputs.offTime.value = cfg.offTime;
  if (document.activeElement !== timeInputs.onTime) timeInputs.onTime.value = cfg.onTime;
  $('enabled').checked = !!cfg.enabled;
  $('setEnabled').checked = !!cfg.enabled;
  $('setAutostart').checked = !!cfg.autostart;
  $('setMinimized').checked = !!cfg.startMinimized;
  $('setSound').checked = !!cfg.sound;
  $('backendSelect').value = cfg.backend || 'auto';
  $('backendBadge').textContent = data.backendLabel;

  $('scheduleWarning').hidden = !!data.validSchedule;
  renderTimeline(data);
  renderOutputs(data);
  renderPending(data);
  appendLog(data.lastEvent);

  if (data.state !== lastApplied && lastApplied !== null) {
    chime(data.state === 'off' ? 'off' : 'on', true);
  }
  lastApplied = data.state;
}

/* ------------------------------------------------------------------ sound */
function ensureAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* áudio opcional */ }
}
document.addEventListener('click', ensureAudio, { once: true });

function chime(kind, automatic = false) {
  if (!current || !current.config.sound) return;
  if (!automatic && !current.config.sound) return;
  ensureAudio();
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  const freqs = kind === 'off' ? [392, 293.66, 220] : [261.63, 392, 523.25];

  freqs.forEach((f, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = f;
    const start = now + i * 0.16;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.075, start + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.5);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(start);
    osc.stop(start + 1.6);
  });
}

/* ------------------------------------------------------------------- boot */
buildParticles();
tickClock();
setInterval(tickClock, 500);

window.api.onState(render);
window.api.getState().then((data) => { render(data); });
window.api.onUpdate(renderUpdate);
window.api.getUpdateState().then(renderUpdate);
window.api.isDev().then((dev) => { $('devNote').hidden = !dev; });
