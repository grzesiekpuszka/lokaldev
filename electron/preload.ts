import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("lokal", {
  invoke: (cmd: string, args?: unknown) => ipcRenderer.invoke("invoke", cmd, args),
  on: (event: string, cb: (payload: unknown) => void) => {
    const listener = (_: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
