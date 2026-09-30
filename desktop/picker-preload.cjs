const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('picker', {
  list: () => ipcRenderer.invoke('picker:list'),
  onPictures: (fn) => ipcRenderer.on('picker:pictures', (_ev, pictures) => fn(pictures)),
  choose: (id, audio) => ipcRenderer.send('picker:choose', id ? { id, audio } : null),
})
