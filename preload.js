const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('native', {
  onMedia: fn => ipcRenderer.on('media', (_e, msg) => fn(msg)),
  snapshot: () => ipcRenderer.invoke('media:snapshot'),
  command: (cmd, arg) => ipcRenderer.send('media:cmd', cmd, arg),
  close: () => ipcRenderer.send('win:close'),
  minimize: () => ipcRenderer.send('win:minimize'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: patch => ipcRenderer.invoke('settings:set', patch),
  onSettings: fn => ipcRenderer.on('settings', (_e, s) => fn(s))
})
