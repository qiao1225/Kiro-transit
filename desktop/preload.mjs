import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktopRelay", {
  getStatus: () => ipcRenderer.invoke("status:get"),
  getLogs: () => ipcRenderer.invoke("logs:get"),
  startServices: () => ipcRenderer.invoke("services:start"),
  restartServices: () => ipcRenderer.invoke("services:restart"),
  stopServices: () => ipcRenderer.invoke("services:stop"),
  startRelay: () => ipcRenderer.invoke("services:relay:start"),
  restartRelay: () => ipcRenderer.invoke("services:relay:restart"),
  stopRelay: () => ipcRenderer.invoke("services:relay:stop"),
  startGateway: () => ipcRenderer.invoke("services:gateway:start"),
  restartGateway: () => ipcRenderer.invoke("services:gateway:restart"),
  stopGateway: () => ipcRenderer.invoke("services:gateway:stop"),
  applyTargets: (targets) => ipcRenderer.invoke("targets:apply", targets),
  getModelConfig: () => ipcRenderer.invoke("models:get"),
  refreshModels: () => ipcRenderer.invoke("models:refresh"),
  saveModelConfig: (modelConfig) => ipcRenderer.invoke("models:save", modelConfig),
  installClaude: () => ipcRenderer.invoke("claude:install"),
  disableClaude: () => ipcRenderer.invoke("claude:disable"),
  restoreClaude: () => ipcRenderer.invoke("claude:restore"),
  clearClaudeModelPin: () => ipcRenderer.invoke("claude:clearModelPin"),
  repairClaudeModelSwitching: () => ipcRenderer.invoke("claude:repairModelSwitching"),
  testClaude: () => ipcRenderer.invoke("claude:test"),
  runDiagnostics: () => ipcRenderer.invoke("diagnostics:run"),
  chooseAccountsFile: () => ipcRenderer.invoke("accounts:choose"),
  setCredentialMode: (mode) => ipcRenderer.invoke("credentials:setMode", mode),
  refreshCredentials: () => ipcRenderer.invoke("credentials:refresh"),
  openPath: (targetPath) => ipcRenderer.invoke("shell:openPath", targetPath),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  onStatusUpdate: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("status:update", listener);
    return () => ipcRenderer.removeListener("status:update", listener);
  },
});
