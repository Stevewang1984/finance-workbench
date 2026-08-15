'use strict';
/**
 * 预加载脚本：通过 contextBridge 暴露最小且安全的 API 给渲染进程。
 * 渲染进程只能调用这些方法，无法直接访问 Node / Electron 内部对象。
 */
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  /** 统一调用主进程能力 */
  call(op, payload) {
    return ipcRenderer.invoke('fw', { op, payload });
  },
  /** 订阅主进程主动推送事件（如收盘复盘就绪） */
  onEvent(handler) {
    const listener = (_e, data) => handler(data);
    ipcRenderer.on('fw:event', listener);
    return () => ipcRenderer.removeListener('fw:event', listener);
  },
  /** 打开外部链接 */
  openExternal(url) {
    ipcRenderer.send('fw:open-external', url);
  }
};

// 主进程监听打开外部链接
ipcRenderer.on('fw:open-external', () => {});

contextBridge.exposeInMainWorld('api', api);
