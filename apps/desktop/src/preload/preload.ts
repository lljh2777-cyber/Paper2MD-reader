import { contextBridge, ipcRenderer } from "electron";
import {
  ConversionTask,
  DESKTOP_CHANNELS,
  Paper2MDDesktopApi,
  StartConversionRequest,
  StartReviewedLayoutRequest
} from "../shared/desktop-api";

const api: Paper2MDDesktopApi = {
  getLibrarySnapshot: () => ipcRenderer.invoke(DESKTOP_CHANNELS.getLibrarySnapshot),
  chooseLibrary: () => ipcRenderer.invoke(DESKTOP_CHANNELS.chooseLibrary),
  openLibraryDocument: (packageId) => ipcRenderer.invoke(DESKTOP_CHANNELS.openLibraryDocument, packageId),
  setLibraryFavorite: (packageId, favorite) => ipcRenderer.invoke(DESKTOP_CHANNELS.setLibraryFavorite, packageId, favorite),
  revealLibrary: () => ipcRenderer.invoke(DESKTOP_CHANNELS.revealLibrary),
  getMineruCredentialStatus: () => ipcRenderer.invoke(DESKTOP_CHANNELS.getMineruCredentialStatus),
  saveMineruCredential: (token) => ipcRenderer.invoke(DESKTOP_CHANNELS.saveMineruCredential, token),
  clearMineruCredential: () => ipcRenderer.invoke(DESKTOP_CHANNELS.clearMineruCredential),
  openMineruTokenPage: () => ipcRenderer.invoke(DESKTOP_CHANNELS.openMineruTokenPage),
  choosePackage: () => ipcRenderer.invoke(DESKTOP_CHANNELS.choosePackage),
  choosePdf: () => ipcRenderer.invoke(DESKTOP_CHANNELS.choosePdf),
  chooseOutputParent: () => ipcRenderer.invoke(DESKTOP_CHANNELS.chooseOutputParent),
  fileExists: (rootId, path) => ipcRenderer.invoke(DESKTOP_CHANNELS.fileExists, rootId, path),
  fileInfo: (rootId, path) => ipcRenderer.invoke(DESKTOP_CHANNELS.fileInfo, rootId, path),
  readText: (rootId, path) => ipcRenderer.invoke(DESKTOP_CHANNELS.readText, rootId, path),
  readBinary: async (rootId, path) => new Uint8Array(await ipcRenderer.invoke(DESKTOP_CHANNELS.readBinary, rootId, path)),
  listFiles: (rootId, directory) => ipcRenderer.invoke(DESKTOP_CHANNELS.listFiles, rootId, directory),
  readPackagePdf: async (rootId, path) => new Uint8Array(await ipcRenderer.invoke(DESKTOP_CHANNELS.readPackagePdf, rootId, path)),
  readPdf: async (pdfId) => new Uint8Array(await ipcRenderer.invoke(DESKTOP_CHANNELS.readPdf, pdfId)),
  startConversion: (request: StartConversionRequest) => ipcRenderer.invoke(DESKTOP_CHANNELS.startConversion, request),
  startReviewedLayout: (request: StartReviewedLayoutRequest) => ipcRenderer.invoke(DESKTOP_CHANNELS.startReviewedLayout, request),
  importConfirmedRoi: (taskId) => ipcRenderer.invoke(DESKTOP_CHANNELS.importConfirmedRoi, taskId),
  revealTaskArtifacts: (taskId) => ipcRenderer.invoke(DESKTOP_CHANNELS.revealTaskArtifacts, taskId),
  validateAndApplyLayout: (taskId) => ipcRenderer.invoke(DESKTOP_CHANNELS.validateAndApplyLayout, taskId),
  listTasks: () => ipcRenderer.invoke(DESKTOP_CHANNELS.listTasks),
  cancelTask: (taskId) => ipcRenderer.invoke(DESKTOP_CHANNELS.cancelTask, taskId),
  removeTask: (taskId) => ipcRenderer.invoke(DESKTOP_CHANNELS.removeTask, taskId),
  resumeTask: (taskId) => ipcRenderer.invoke(DESKTOP_CHANNELS.resumeTask, taskId),
  onTaskUpdate: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, task: ConversionTask) => callback(task);
    ipcRenderer.on(DESKTOP_CHANNELS.taskUpdate, listener);
    return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.taskUpdate, listener);
  }
};

contextBridge.exposeInMainWorld("paper2mdDesktop", api);
