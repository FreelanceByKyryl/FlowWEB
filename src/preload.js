'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const methods = [
  'load', 'saveProject', 'duplicateProject', 'deleteProject', 'thumbnail', 'saveSettings',
  'pickDirectory', 'pickImage', 'clearTemporary', 'dependencies', 'openWebsite',
  'openProjectFolder', 'openExport', 'openExportFolder', 'enqueue', 'queueCancel',
  'queueRetry', 'queueSkip', 'previewWebsite', 'closeWebsitePreview', 'captureScreenshot',
  'saveScreenshot', 'renderMockup', 'saveMockup', 'renderPortfolio', 'savePortfolio',
  'recordVideo', 'cancelStudio'
];

const api = Object.fromEntries(methods.map((method) => [
  method, (...args) => ipcRenderer.invoke('showcase:' + method, ...args)
]));

for (const event of ['Queue', 'StudioProgress', 'DataChanged']) {
  api['on' + event] = (listener) => {
    if (typeof listener !== 'function') throw new TypeError('A listener is required.');
    const channel = 'showcase:event:' + event;
    const receive = (_event, value) => listener(value);
    ipcRenderer.on(channel, receive);
    return () => ipcRenderer.removeListener(channel, receive);
  };
}

contextBridge.exposeInMainWorld('showcase', Object.freeze(api));
