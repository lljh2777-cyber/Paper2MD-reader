import { contextBridge, ipcRenderer } from "electron";
import { ConversionTask, DESKTOP_CHANNELS, Paper2MDDesktopApi, StartConversionRequest } from "../shared/desktop-api";

const api: Paper2MDDesktopApi = {
  choosePackage: () => ipcRenderer.invoke(DESKTOP_CHANNELS.choosePackage),
  choosePdf: () => ipcRenderer.invoke(DESKTOP_CHANNELS.choosePdf),
  chooseOutputParent: () => ipcRenderer.invoke(DESKTOP_CHANNELS.chooseOutputParent),
  fileExists: (rootId, path) => ipcRenderer.invoke(DESKTOP_CHANNELS.fileExists, rootId, path),
  fileInfo: (rootId, path) => ipcRenderer.invoke(DESKTOP_CHANNELS.fileInfo, rootId, path),
  readText: (rootId, path) => ipcRenderer.invoke(DESKTOP_CHANNELS.readText, rootId, path),
  readBinary: async (rootId, path) => new Uint8Array(await ipcRenderer.invoke(DESKTOP_CHANNELS.readBinary, rootId, path)),
  listFiles: (rootId, directory) => ipcRenderer.invoke(DESKTOP_CHANNELS.listFiles, rootId, directory),
  readPdf: async (pdfId) => new Uint8Array(await ipcRenderer.invoke(DESKTOP_CHANNELS.readPdf, pdfId)),
  startConversion: (request: StartConversionRequest) => ipcRenderer.invoke(DESKTOP_CHANNELS.startConversion, request),
  listTasks: () => ipcRenderer.invoke(DESKTOP_CHANNELS.listTasks),
  cancelTask: (taskId) => ipcRenderer.invoke(DESKTOP_CHANNELS.cancelTask, taskId),
  onTaskUpdate: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, task: ConversionTask) => callback(task);
    ipcRenderer.on(DESKTOP_CHANNELS.taskUpdate, listener);
    return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.taskUpdate, listener);
  }
};

contextBridge.exposeInMainWorld("paper2mdDesktop", api);
