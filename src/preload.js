'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('get-state'),
  setConfig: (patch) => ipcRenderer.invoke('set-config', patch),
  confirmApply: () => ipcRenderer.invoke('confirmApply'),
  deferApply: () => ipcRenderer.invoke('deferApply'),
  apply: (state) => ipcRenderer.invoke('apply', state),
  listOutputs: () => ipcRenderer.invoke('list-outputs'),
  refresh: () => ipcRenderer.invoke('refresh'),
  minimize: () => ipcRenderer.invoke('window-minimize'),
  hide: () => ipcRenderer.invoke('window-hide'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  quit: () => ipcRenderer.invoke('quit'),
  isDev: () => ipcRenderer.invoke('dev-mode'),
  devResume: () => ipcRenderer.invoke('dev-resume'),
  getUpdateState: () => ipcRenderer.invoke('get-update-state'),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  restartApp: () => ipcRenderer.invoke('restart-app'),
  openRelease: () => ipcRenderer.invoke('open-release'),
  onUpdate: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('update-changed', listener);
    return () => ipcRenderer.removeListener('update-changed', listener);
  },
  onState: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('state-changed', listener);
    return () => ipcRenderer.removeListener('state-changed', listener);
  },
});
