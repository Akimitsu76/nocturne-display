'use strict';

/* ------------------------------------------------------------------ *
 * Nocturne Display — atualizador de AppImage via GitHub Releases.
 * Rodano processo principal: busca a release mais recente, compara com
 * a versão instalada, baixa o .AppImage e substitui o arquivo em uso.
 * ------------------------------------------------------------------ */

const { app, shell } = require('electron');
const { spawn } = require('child_process');
const { once } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const REPO = 'Akimitsu76/nocturne-display';
const API_URL = process.env.NOCTURNE_RELEASES_API || `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const CHECK_TIMEOUT_MS = 15 * 1000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

function appImagePath() {
  const candidate = process.env.APPIMAGE;
  if (!candidate) return null;
  try {
    return fs.existsSync(candidate) ? path.resolve(candidate) : null;
  } catch {
    return null;
  }
}

function parseVersion(value) {
  const clean = String(value || '').trim().replace(/^v/i, '');
  const parts = clean.split(/[.\-_+]/).map((n) => {
    const num = parseInt(n, 10);
    return Number.isFinite(num) ? num : 0;
  });
  return parts.length ? parts : [0];
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function pickAsset(release) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const appImages = assets.filter((a) => a && typeof a.name === 'string' && /\.appimage$/i.test(a.name));
  const arch = process.arch === 'arm64' ? /aarch64|arm64/i : /x86_?64|x64|amd64/i;
  return appImages.find((a) => arch.test(a.name)) || appImages[0] || null;
}

function parseRelease(data) {
  const tag = String(data.tag_name || data.name || '');
  const asset = pickAsset(data);
  return {
    tag,
    version: tag.replace(/^v/i, ''),
    name: String(data.name || tag || 'Nova versão'),
    notes: String(data.body || '').trim(),
    url: String(data.html_url || `${RELEASES_URL}/tag/${encodeURIComponent(tag)}`),
    publishedAt: data.published_at || null,
    assetName: asset ? asset.name : null,
    downloadUrl: asset ? asset.browser_download_url : null,
    size: asset && Number(asset.size) > 0 ? Number(asset.size) : 0,
    digest: asset && asset.digest ? String(asset.digest) : null,
  };
}

function headers() {
  return {
    'Accept': 'application/vnd.github+json',
    'User-Agent': `Nocturne-Display/${app.getVersion()}`,
  };
}

async function fetchJson(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { headers: headers(), signal: controller.signal });
    if (!res.ok) throw new Error(`GitHub respondeu HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

let state = {
  status: 'idle', // idle | checking | up-to-date | available | downloading | installed | error | unsupported
  version: app.getVersion(),
  latestVersion: null,
  release: null,
  progress: 0,
  message: '',
  error: null,
  lastCheck: null,
  busy: false,
  appImage: appImagePath(),
};

let timer = null;
let listeners = new Set();
let getAutoUpdate = () => true;
let checking = false;
let installing = false;

function snapshot() {
  return {
    ...state,
    autoUpdate: !!getAutoUpdate(),
    supported: !!state.appImage,
    appImagePath: state.appImage,
    checkIntervalMinutes: CHECK_INTERVAL_MS / 60000,
    releasesUrl: RELEASES_URL,
  };
}

function emit() {
  const value = snapshot();
  for (const cb of listeners) {
    try { cb(value); } catch { /* listener quebrado não derruba o updater */ }
  }
}

function patch(partial) {
  state = { ...state, ...partial };
  emit();
}

function setStatus(status, message, extra = {}) {
  patch({ status, message, ...extra });
}

function onChange(cb) {
  listeners.add(cb);
  cb(snapshot());
  return () => listeners.delete(cb);
}

function setAutoUpdateGetter(fn) {
  if (typeof fn === 'function') getAutoUpdate = fn;
  emit();
}

async function check(options = {}) {
  if (checking || installing) return snapshot();
  checking = true;
  const manual = !!options.manual;
  setStatus('checking', manual ? 'Consultando o GitHub...' : 'Verificando atualizações em segundo plano...', { busy: true });

  try {
    const data = await fetchJson(API_URL, CHECK_TIMEOUT_MS);
    if (!data || typeof data !== 'object') throw new Error('Resposta inválida do GitHub');
    const release = parseRelease(data);
    if (!release.version) throw new Error('Release sem versão identificável');

    const isNewer = compareVersions(release.version, app.getVersion()) > 0;
    patch({
      lastCheck: Date.now(),
      latestVersion: release.version,
      release,
      error: null,
    });

    if (!isNewer) {
      setStatus('up-to-date', `Você já está na versão mais recente (${app.getVersion()}).`, {
        progress: 0,
        busy: false,
      });
      checking = false;
      return snapshot();
    }

    if (!state.appImage) {
      setStatus('unsupported', `Versão ${release.version} disponível, mas a atualização automática requer AppImage.`, {
        progress: 0,
        busy: false,
      });
      checking = false;
      return snapshot();
    }

    if (!release.downloadUrl) {
      setStatus('available', `Versão ${release.version} disponível, sem AppImage anexado ao release.`, {
        progress: 0,
        busy: false,
      });
      checking = false;
      return snapshot();
    }

    setStatus('available', `Nova versão ${release.version} encontrada.`, { progress: 0, busy: false });
    checking = false;

    if (getAutoUpdate() && !manual) {
      // Instala diretamente pelo próprio app: baixa, substitui o AppImage em uso
      // e reinicia o processo para encerrar a sessão antiga. Após o reinício,
      // permanece apenas a nova versão instalada.
      await install();
      restart();
    }
    return snapshot();
  } catch (err) {
    checking = false;
    setStatus('error', `Falha ao verificar: ${err.message}`, { busy: false });
    return snapshot();
  }
}

async function downloadAsset(release, destination) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let output = null;

  try {
    const res = await fetch(release.downloadUrl, {
      headers: headers(),
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`Download respondeu HTTP ${res.status}`);

    output = fs.createWriteStream(destination, { flags: 'w' });
    const hash = release.digest ? crypto.createHash('sha256') : null;
    let received = 0;
    const stream = Readable.fromWeb(res.body);

    for await (const chunk of stream) {
      received += chunk.length;
      if (hash) hash.update(chunk);
      if (!output.write(chunk)) await once(output, 'drain');
      const pct = release.size
        ? Math.min(99, Math.round((received / release.size) * 100))
        : Math.min(99, Math.round(received / (1024 * 1024)));
      patch({
        progress: pct,
        message: `Baixando ${release.assetName} · ${(received / 1024 / 1024).toFixed(1)} MiB`,
      });
    }

    output.end();
    await once(output, 'finish');
    output = null;

    if (hash) {
      const expected = String(release.digest).replace(/^sha256:/i, '').trim().toLowerCase();
      if (/^[0-9a-f]{64}$/.test(expected) && hash.digest('hex') !== expected) {
        throw new Error('Checksum SHA-256 do AppImage divergente');
      }
    }
    return received;
  } finally {
    clearTimeout(timer);
    if (output && !output.destroyed) output.destroy();
  }
}

function updateAutostart(exe) {
  try {
    const file = path.join(app.getPath('home'), '.config', 'autostart', 'nocturne-display.desktop');
    if (!fs.existsSync(file)) return;
    const content = fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !/^OnlyShowIn=/i.test(line))
      .map((line) => (/^Exec=/i.test(line) ? `Exec="${exe}" --minimized` : line))
      .join('\n');
    fs.writeFileSync(file, content);
  } catch { /* autostart é opcional */ }
}

async function install() {
  if (installing || checking) return snapshot();
  if (!state.appImage) {
    setStatus('unsupported', 'Atualização automática disponível apenas para AppImage.');
    return snapshot();
  }
  if (!state.release || !state.release.downloadUrl) {
    await check({ manual: true });
    if (!state.release || !state.release.downloadUrl) return snapshot();
  }

  installing = true;
  const current = state.appImage;
  const release = state.release;
  const dir = path.dirname(current);
  const assetName = path.basename(release.assetName || `Nocturne-Display-${release.version}-x86_64.AppImage`);
  const target = path.join(dir, assetName);
  const temp = path.join(dir, `.${assetName}.update-${process.pid}-${Date.now()}`);

  setStatus('downloading', `Baixando ${release.assetName}...`, { progress: 0, busy: true });

  try {
    const bytes = await downloadAsset(release, temp);
    if (!bytes) throw new Error('AppImage baixado está vazio');
    fs.chmodSync(temp, 0o755);
    patch({ status: 'installing', message: 'Aplicando atualização...', progress: 100 });
    fs.renameSync(temp, target);
    if (path.resolve(target) !== path.resolve(current)) {
      // Remove a versão antiga e aponta o updater/reinício para o novo arquivo.
      try { if (fs.existsSync(current)) fs.unlinkSync(current); } catch { /* montagem FUSE pode segurar o inode */ }
      patch({ appImage: target });
    }
    updateAutostart(target);
    installing = false;
    setStatus('installed', `Versão ${release.version} instalada. Reinicie para utilizá-la.`, {
      progress: 100,
      busy: false,
      version: release.version,
    });
  } catch (err) {
    installing = false;
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* ignora */ }
    setStatus('error', `Falha ao instalar: ${err.message}`, { progress: 0, busy: false });
  }
  return snapshot();
}

function restart() {
  const target = state.appImage;
  if (!target || !fs.existsSync(target)) {
    app.relaunch();
    app.exit(0);
    return snapshot();
  }
  try {
    const quoted = `'${path.resolve(target).replace(/'/g, `'\\''`)}'`;
    const pid = process.pid;
    // Espera o processo atual sair para liberar o lock de instância única.
    const script = `while kill -0 ${pid} 2>/dev/null; do sleep 0.2; done; exec ${quoted}`;
    const child = spawn('/bin/sh', ['-c', script], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
    app.exit(0);
  } catch (err) {
    setStatus('error', `Falha ao reiniciar: ${err.message}`);
  }
  return snapshot();
}

function openRelease() {
  const url = state.release && state.release.url ? state.release.url : RELEASES_URL;
  shell.openExternal(url).catch(() => shell.openExternal(RELEASES_URL).catch(() => {}));
  return snapshot();
}

function maybeAutoInstall() {
  if (state.status === 'available' && getAutoUpdate() && state.release && state.release.downloadUrl && state.appImage) {
    return install();
  }
  return Promise.resolve(snapshot());
}

function start() {
  state.appImage = appImagePath();
  emit();
  if (timer) clearInterval(timer);
  // Aguarda a janela e o agendador estarem prontos antes de exigir rede.
  setTimeout(() => { check(); }, 5000);
  timer = setInterval(() => { check(); }, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  start,
  stop,
  check,
  install,
  restart,
  openRelease,
  onChange,
  getState: snapshot,
  setAutoUpdateGetter,
  maybeAutoInstall,
  compareVersions,
};
