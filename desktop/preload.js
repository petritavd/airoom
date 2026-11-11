// Minimal, explicit bridge between the airoom web UI and the desktop shell.
// Only what the UI genuinely needs from the OS — nothing generic.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('airoomNative', {
  /** 'darwin' | 'win32' | 'linux' — the UI reserves title-bar room per OS. */
  platform: process.platform,

  /** Open the native folder picker; resolves to an absolute path or null. */
  pickFolder: () => ipcRenderer.invoke('airoom:pick-folder'),

  /**
   * Hand a session off to Claude Code: opens a terminal in the room's folder
   * and resumes that session. Resolves {ok, cmd?, error?}.
   */
  openInClaudeCode: (cwd, sessionId) =>
    ipcRenderer.invoke('airoom:open-claude', { cwd, sessionId }),
});
