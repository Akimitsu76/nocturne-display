'use strict';

const $ = (id) => document.getElementById(id);
let current = null;
let updateState = null;
let pendingAlarm = null;
let lastApplied = null;
let lastEventTime = null;
let lastOutputSig = null;
let lastScheduleSig = null;
let lastTimelineSig = null;
let newAction = 'off';
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
const ACTION_LABEL = { off: 'apagar a tela', on: 'acender a tela' };

function openAlarmConfirmation({ time, action, detail, onConfirm, restore }) {
  pendingAlarm = { onConfirm, restore };
  $('confirmTitle').textContent = `Aplicar horário ${time}?`;
  $('confirmDetail').textContent = detail
    || `Adicionar um alarme para ${ACTION_LABEL[action]} às ${time}. O novo ciclo começa no próximo horário — a tela atual não será alterada agora.`;
  $('confirmBackdrop').hidden = false;
  $('btnDeferOff').focus();
}

function closeAlarmConfirmation() {
  const pending = pendingAlarm;
  pendingAlarm = null;
  $('confirmBackdrop').hidden = true;
  return pending;
}

function cancelAlarmConfirmation() {
  const pending = closeAlarmConfirmation();
  if (pending && pending.restore) pending.restore();
}

$('btnDeferOff').addEventListener('click', cancelAlarmConfirmation);
$('btnConfirmOff').addEventListener('click', async () => {
  const pending = closeAlarmConfirmation();
  if (!pending || !pending.onConfirm) return;
  render(await pending.onConfirm());
});
$('confirmBackdrop').addEventListener('click', (e) => {
  if (e.target === $('confirmBackdrop')) cancelAlarmConfirmation();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('confirmBackdrop').hidden) cancelAlarmConfirmation();
});

/* ----------------------------------------------------------- config bind */
$('newAction').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  newAction = btn.dataset.action;
  $('newAction').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.action === newAction);
  });
});
$('newTime').addEventListener('input', (e) => e.target.classList.remove('invalid'));
$('btnAddSchedule').addEventListener('click', () => {
  const input = $('newTime');
  const time = validTime(input.value);
  if (!time) {
    input.classList.add('invalid');
    input.focus();
    return;
  }
  input.classList.remove('invalid');
  openAlarmConfirmation({
    time,
    action: newAction,
    detail: `Adicionar um alarme para ${ACTION_LABEL[newAction]} às ${time}. O novo ciclo começa no próximo horário — a tela atual não será alterada agora.`,
    onConfirm: () => window.api.setSchedules([
      ...((current && current.config.schedules) || []),
      { id: makeId(), time, action: newAction, enabled: true },
    ]),
    restore: () => { input.value = ''; },
  });
});

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

function validTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function parseMin(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

function makeId() {
  return `alarm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function updateSchedule(id, patch) {
  const list = ((current && current.config.schedules) || [])
    .map((s) => (s.id === id ? { ...s, ...patch } : s));
  return window.api.setSchedules(list);
}

function renderSchedules(data) {
  const list = (data.config.schedules || []).slice().sort((a, b) => parseMin(a.time) - parseMin(b.time));
  const sig = JSON.stringify(list.map((a) => `${a.id}:${a.time}:${a.action}:${a.enabled}`));
  if (sig === lastScheduleSig) return;
  lastScheduleSig = sig;

  const box = $('alarmList');
  box.innerHTML = '';
  $('emptyAlarms').hidden = list.length > 0;
  $('scheduleCount').textContent = `${list.length} ${list.length === 1 ? 'agendamento' : 'agendamentos'}`;

  for (const alarm of list) {
    const row = document.createElement('div');
    row.className = `alarm-row ${alarm.enabled ? '' : 'disabled'} ${alarm.action}`;
    row.innerHTML = `
      <label class="switch alarm-switch" title="${alarm.enabled ? 'Desligar' : 'Ligar'} este agendamento">
        <input type="checkbox" ${alarm.enabled ? 'checked' : ''} aria-label="Ativar agendamento às ${alarm.time}" />
        <span class="slider"></span>
      </label>
      <div class="alarm-time-wrap">
        <input type="time" class="alarm-time" value="${escapeHtml(alarm.time)}" aria-label="Horário do agendamento" />
        <span class="alarm-caption">${alarm.action === 'off' ? 'A tela apaga' : 'A tela acende'}</span>
      </div>
      <div class="segmented alarm-action" role="group" aria-label="Ação do agendamento">
        <button type="button" data-action="off" class="${alarm.action === 'off' ? 'active' : ''}">☾ Apagar</button>
        <button type="button" data-action="on" class="${alarm.action === 'on' ? 'active' : ''}">☀ Acender</button>
      </div>
      <span class="alarm-state ${alarm.enabled ? 'on' : 'off'}">${alarm.enabled ? 'ativo' : 'desligado'}</span>
      <button type="button" class="icon-btn alarm-delete" title="Apagar agendamento" aria-label="Apagar agendamento">✕</button>
      <span class="alarm-runes" aria-hidden="true">ᚠ ᛟ ᚦ</span>
    `;
    row.dataset.id = alarm.id;

    const timeInput = row.querySelector('.alarm-time');
    timeInput.addEventListener('input', () => timeInput.classList.remove('invalid'));
    timeInput.addEventListener('change', () => {
      const value = validTime(timeInput.value);
      if (!value) {
        timeInput.value = alarm.time;
        timeInput.classList.add('invalid');
        return;
      }
      openAlarmConfirmation({
        time: value,
        action: alarm.action,
        detail: `Alterar este alarme para ${ACTION_LABEL[alarm.action]} às ${value}. O novo horário só entra em vigor no próximo limite.`,
        onConfirm: () => updateSchedule(alarm.id, { time: value }),
        restore: () => { timeInput.value = alarm.time; },
      });
    });

    row.querySelector('.alarm-switch input').addEventListener('change', async (e) => {
      render(await updateSchedule(alarm.id, { enabled: e.target.checked }));
    });

    row.querySelectorAll('.alarm-action button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === alarm.action) return;
        openAlarmConfirmation({
          time: alarm.time,
          action,
          detail: `Alterar este alarme para ${ACTION_LABEL[action]} às ${alarm.time}. A mudança só entra em vigor no próximo limite.`,
          onConfirm: () => updateSchedule(alarm.id, { action }),
        });
      });
    });

    row.querySelector('.alarm-delete').addEventListener('click', async () => {
      render(await window.api.setSchedules(list.filter((s) => s.id !== alarm.id)));
    });

    box.appendChild(row);
  }
}

function renderTimeline(data) {
  const list = data.config.schedules || [];
  const sig = JSON.stringify(list.map((a) => `${a.id}:${a.time}:${a.action}:${a.enabled}`));
  if (sig === lastTimelineSig) return;
  lastTimelineSig = sig;

  const box = $('timelineMarkers');
  box.innerHTML = '';
  for (const alarm of list) {
    const min = parseMin(alarm.time);
    if (min === null) continue;
    const marker = document.createElement('div');
    marker.className = `tl-marker ${alarm.action === 'off' ? 'off-marker' : 'on-marker'} ${alarm.enabled ? '' : 'muted'}`;
    marker.style.left = `${(min / 1440) * 100}%`;
    marker.innerHTML = `<span>${escapeHtml(alarm.time)}</span>`;
    marker.title = `${alarm.time} · ${alarm.action === 'off' ? 'apagar' : 'acender'} · ${alarm.enabled ? 'ativo' : 'desligado'}`;
    box.appendChild(marker);
  }
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

  const total = data.scheduleCount || 0;
  const active = data.activeCount || 0;
  let desc;
  if (!total) desc = 'Nenhum agendamento — a tela permanece como você a deixou.';
  else if (!active) desc = 'Todos os agendamentos estão desligados — controle manual disponível.';
  else if (cfg.manualOverride) desc = 'Override manual até o próximo agendamento.';
  else if (isOff && data.next && data.next.state === 'on') desc = `Repouso até às ${data.next.atLabel}. O computador segue ligado.`;
  else if (!isOff && data.next && data.next.state === 'off') desc = `Próximo apagamento às ${data.next.atLabel}.`;
  else desc = `${active} agendamento(s) ativo(s).`;
  $('statusDesc').textContent = desc;

  $('nextTime').textContent = data.next ? data.next.atLabel : '--:--';
  $('nextLabel').textContent = data.next
    ? `Tela ${data.next.state === 'off' ? 'apaga' : 'acende'}`
    : (total ? 'sem agendamentos ativos' : 'sem agendamentos');
  $('nextCountdown').textContent = data.next ? `em ${data.next.label}` : '—';

  $('setAutostart').checked = !!cfg.autostart;
  $('setMinimized').checked = !!cfg.startMinimized;
  $('setSound').checked = !!cfg.sound;
  $('backendSelect').value = cfg.backend || 'auto';
  $('backendBadge').textContent = data.backendLabel;

  const holdNote = $('scheduleHoldNote');
  holdNote.hidden = !data.scheduleHold;
  if (data.scheduleHold) {
    const start = data.scheduleStartsAt
      ? new Date(data.scheduleStartsAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      : (data.next ? data.next.atLabel : null);
    holdNote.textContent = start
      ? `⏳ Agendamento salvo. O novo ciclo começa às ${start} — a tela atual não será alterada até lá.`
      : '⏳ Agendamento salvo. O novo ciclo começa no próximo horário — a tela atual não será alterada agora.';
  }
  renderSchedules(data);
  renderTimeline(data);
  renderOutputs(data);
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
