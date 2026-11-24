'use strict';

/* Regras puras dos agendamentos — sem Electron, sem I/O.
 * Cada agendamento é um "alarme": { id, time: 'HH:MM', action: 'off'|'on', enabled }.
 */

const TIME_RE = /^(\d{1,2}):(\d{2})$/;
let idCounter = 0;

function normalizeTime(value) {
  const m = TIME_RE.exec(String(value || ''));
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function toMinutes(value) {
  const normalized = normalizeTime(value);
  if (!normalized) return null;
  const [h, m] = normalized.split(':').map(Number);
  return h * 60 + m;
}

function fmtClock(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function fmtTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return `${h}h ${String(m).padStart(2, '0')}min`;
}

function sanitizeSchedules(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const time = normalizeTime(item.time);
    if (!time) continue;
    let id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : null;
    if (!id || seen.has(id)) {
      idCounter += 1;
      id = `alarm-${Date.now().toString(36)}-${idCounter}`;
    }
    seen.add(id);
    out.push({
      id,
      time,
      action: item.action === 'on' ? 'on' : 'off',
      enabled: item.enabled !== false,
    });
  }
  return out;
}

function enabledAlarms(cfg) {
  return sanitizeSchedules(cfg && cfg.schedules).filter((a) => a.enabled);
}

// Estado desejado = ação do alarme habilitado mais recente antes de "agora".
// Sem alarmes habilitados não existe alvo automático (null): o app não mexe na tela.
function desiredState(nowMinutes, alarms) {
  const list = (Array.isArray(alarms) ? alarms : enabledAlarms(alarms))
    .filter((a) => a && a.enabled !== false);
  let best = null;
  for (const alarm of list) {
    const t = toMinutes(alarm.time);
    if (t === null) continue;
    const delta = (nowMinutes - t + 1440) % 1440;
    if (
      !best || delta < best.delta
      || (delta === best.delta && alarm.action === 'on' && best.action !== 'on')
    ) {
      best = { delta, action: alarm.action, at: t, id: alarm.id };
    }
  }
  return best ? best.action : null;
}

// Próximo alarme no sentido horário. Um alarme exatamente agora já foi consumido.
function nextChange(alarms, nowMinutes) {
  const list = (Array.isArray(alarms) ? alarms : enabledAlarms(alarms))
    .filter((a) => a && a.enabled !== false);
  let best = null;
  for (const alarm of list) {
    const t = toMinutes(alarm.time);
    if (t === null) continue;
    const raw = (t - nowMinutes + 1440) % 1440;
    const minutes = raw === 0 ? 1440 : raw;
    if (
      !best || minutes < best.minutes
      || (minutes === best.minutes && alarm.action === 'on' && best.state !== 'on')
    ) {
      best = {
        at: t,
        minutes,
        atLabel: fmtClock(t),
        state: alarm.action,
        id: alarm.id,
      };
    }
  }
  return best;
}

module.exports = {
  normalizeTime,
  toMinutes,
  fmtClock,
  fmtTime,
  sanitizeSchedules,
  enabledAlarms,
  desiredState,
  nextChange,
};
