'use strict';

const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Storage } = require('./services/storage');
const { ExportQueue } = require('./services/queue');
const { ensureExportDirectory, existingExportPath, createProjectFolder } = require('./services/exports');
const { normalizeUrl, getBrowserStatus, openWebsitePreview, closeWebsitePreview, closeAllWebsitePreviews } = require('./services/browser');
const { getFfmpegStatus } = require('./services/video');
const { Studio } = require('./services/studio');
const { record, number, integer, id, captureOptions, videoOptions, imageFormat, str } = require('./services/inputs');

const RENDERER = path.join(__dirname, 'renderer', 'index.html');
const RENDERER_URL = pathToFileURL(RENDERER).href;
const BATCH_OPERATIONS = ['desktop', 'laptop', 'tablet', 'mobile', 'fullpage', 'mockup', 'video', 'portfolio'];
const pendingThumbnails = new Map();
let window;
let tempDirectory;
let store;
let studio;
let queue;
let foreground;
let thumbnailTask;
let dependencyCheck;
let quitting = false;
let cleanupComplete = false;

app.setName('Showcase Studio');

function send(name, payload) {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('showcase:event:' + name, payload);
  }
}

function changed() {
  send('DataChanged', true);
}

function getProject(value) {
  const project = store.getProject(id(value));
  if (!project) throw new Error('The project no longer exists.');
  return project;
}

function getExport(value) {
  const entry = store.snapshot().exports.find((candidate) => candidate.id === id(value));
  if (!entry) throw new Error('The export no longer exists.');
  return entry;
}

function projectFor(input) {
  const project = input.projectId ? getProject(input.projectId) : undefined;
  const url = normalizeUrl(input.url || project?.url || '');
  if (project) return { ...project, url };
  const name = new URL(url).hostname;
  return { id: null, name, url, exportFolder: createProjectFolder(name, 'quick-capture') };
}

function taskFor(control, publish = () => {}) {
  return {
    signal: control.signal,
    onProgress(fraction, stage) {
      if (!control.signal.aborted) publish({ stage, progress: Math.round(Math.max(0, Math.min(fraction, 1)) * 100) });
    }
  };
}

function runStudio(label, work, { withProgress = true } = {}) {
  if (quitting) throw new Error('Showcase Studio is closing.');
  if (foreground) throw new Error('Wait for the current studio task to finish or cancel it.');
  if (queue.isActive()) throw new Error('Finish or cancel the batch export before starting a studio task.');
  const control = new AbortController();
  const publish = withProgress ? (value) => send('StudioProgress', value) : () => {};
  const task = taskFor(control, publish);
  const promise = Promise.resolve().then(async () => {
    task.onProgress(0, label);
    try {
      const result = await work(task);
      task.onProgress(1, 'Complete');
      return result;
    } catch (error) {
      if (control.signal.aborted) {
        publish({ stage: 'Cancelled', progress: 0 });
        throw new Error('The studio task was cancelled.');
      }
      publish({ stage: 'Failed', progress: 0 });
      throw error;
    }
  }).finally(() => {
    foreground = null;
    scheduleThumbnail();
  });
  foreground = { control, promise };
  return promise;
}

function scheduleThumbnail() {
  if (quitting || foreground || thumbnailTask || queue?.isActive() || !pendingThumbnails.size) return;
  const project = pendingThumbnails.values().next().value;
  pendingThumbnails.delete(project.id);
  const control = new AbortController();
  const promise = studio.thumbnail(project, store.snapshot().settings, taskFor(control))
    .catch(() => { /* Projects remain usable when an automatic thumbnail cannot be generated. */ })
    .finally(() => {
      thumbnailTask = null;
      scheduleThumbnail();
    });
  thumbnailTask = { control, promise };
}

async function dependencies(force = false) {
  if (!dependencyCheck || force) {
    dependencyCheck = Promise.resolve().then(async () => {
      const [browser, ffmpeg] = await Promise.all([getBrowserStatus(), getFfmpegStatus()]);
      return {
        chromium: {
          available: browser.available,
          message: browser.available ? 'Chromium available' : app.isPackaged
            ? 'Install Node.js, then run npx --yes playwright@1.65.1 install chromium in PowerShell.'
            : 'Install Chromium with npm run setup.'
        },
        ffmpeg: {
          available: ffmpeg.available,
          message: ffmpeg.available ? 'FFmpeg with H.264 available' : process.platform === 'win32'
            ? 'Install with winget install --id Gyan.FFmpeg --exact, then reopen Showcase Studio.'
            : (ffmpeg.error || 'Install FFmpeg with H.264 and reopen Showcase Studio.')
        }
      };
    }).catch((error) => {
      dependencyCheck = null;
      throw error;
    });
  }
  return dependencyCheck;
}

async function openPath(candidate) {
  const result = await shell.openPath(await existingExportPath(candidate));
  if (result) throw new Error(result);
}

function batchItems(input) {
  const data = record(input);
  if (!Array.isArray(data.projectIds) || data.projectIds.length < 1 || data.projectIds.length > 500) {
    throw new Error('Select at least one project, up to 500.');
  }
  if (!Array.isArray(data.operations) || !data.operations.length ||
      data.operations.some((operation) => !BATCH_OPERATIONS.includes(operation))) {
    throw new Error('Select at least one supported export format.');
  }
  const settings = store.snapshot().settings;
  const inputSettings = record(data.settings || {});
  const options = {
    operations: [...new Set(data.operations)],
    format: imageFormat(inputSettings.format),
    quality: integer(inputSettings.quality, settings.imageQuality, 1, 100),
    videoDuration: number(inputSettings.videoDuration, 8, 1, 180),
    scrollSpeed: number(inputSettings.scrollSpeed, 350, 10, 10000),
    mockupTemplate: str(inputSettings.mockupTemplate, 32)
  };
  return [...new Set(data.projectIds)].map((projectId) => {
    const project = getProject(projectId);
    return { projectId: project.id, projectName: project.name, options, type: 'project' };
  });
}

function registerHandlers() {
  const jobsAvailable = () => {
    if (foreground) throw new Error('Wait for the current studio task to finish or cancel it.');
  };

  const handlers = {
    async load() {
      const { projects, settings, exports } = store.snapshot();
      return { projects, settings, history: exports, dependencies: await dependencies(), queue: queue.snapshot() };
    },
    async saveProject(value) {
      const input = record(value);
      if (input.id != null) id(input.id);
      const project = await store.saveProject({ ...input, url: input.url == null ? undefined : normalizeUrl(input.url) });
      if (!project.thumbnail) {
        pendingThumbnails.set(project.id, project);
        scheduleThumbnail();
      }
      return project;
    },
    duplicateProject: (projectId) => store.duplicateProject(id(projectId)),
    deleteProject: (projectId) => {
      pendingThumbnails.delete(id(projectId));
      return store.deleteProject(projectId);
    },
    thumbnail: (projectId) => runStudio('Capturing project thumbnail',
      (task) => studio.thumbnail(getProject(projectId), store.snapshot().settings, task)),
    async saveSettings(value) {
      const input = record(value);
      if ([input.videoWidth, input.videoHeight].some((size) => Number.isInteger(size) && size % 2 !== 0)) {
        throw new Error('Use even pixel dimensions for H.264 videos.');
      }
      const settings = await store.updateSettings(input);
      queue.setConcurrency(settings.maxConcurrentJobs);
      return settings;
    },
    async pickDirectory() {
      const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
      return result.canceled ? null : result.filePaths[0];
    },
    async pickImage() {
      const result = await dialog.showOpenDialog(window, {
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] }]
      });
      if (result.canceled) return null;
      return runStudio('Importing image', () => studio.importImage(result.filePaths[0]), { withProgress: false });
    },
    async clearTemporary() {
      jobsAvailable();
      return runStudio('Clearing temporary files', async () => {
        if (thumbnailTask) {
          thumbnailTask.control.abort();
          await thumbnailTask.promise;
        }
        await closeAllWebsitePreviews();
        await studio.clear();
        return true;
      }, { withProgress: false });
    },
    dependencies: () => dependencies(true),
    openWebsite: (projectId) => shell.openExternal(normalizeUrl(getProject(projectId).url)),
    async openProjectFolder(projectId) {
      const project = getProject(projectId);
      const root = store.snapshot().settings.exportDirectory;
      return openPath(await ensureExportDirectory(root, project));
    },
    openExport: (exportId) => openPath(getExport(exportId).path),
    openExportFolder: (exportId) => openPath(path.dirname(getExport(exportId).path)),
    enqueue(value) {
      jobsAvailable();
      return queue.start(batchItems(value));
    },
    queueCancel: () => queue.cancel(),
    queueRetry: (jobId) => {
      jobsAvailable();
      return queue.retry(jobId == null ? undefined : id(jobId));
    },
    queueSkip: (jobId) => queue.skip(id(jobId)),
    previewWebsite(value) {
      const input = record(value);
      const project = projectFor(input);
      return runStudio('Opening live website', (task) =>
        openWebsitePreview(captureOptions(input, store.snapshot().settings, project.url), task));
    },
    closeWebsitePreview: (sessionId) => closeWebsitePreview(id(sessionId)),
    captureScreenshot(value) {
      const input = record(value);
      const project = projectFor(input);
      const options = captureOptions(input, store.snapshot().settings, project.url);
      return runStudio('Capturing website', (task) => studio.capture(project, options, input.manualId, task));
    },
    saveScreenshot: (value) => runStudio('Saving screenshot', () => studio.exportAsset(record(value), 'screenshot')),
    renderMockup(value) {
      const input = record(value);
      const project = input.projectId ? getProject(input.projectId) :
        { id: null, name: 'Untitled mockup', exportFolder: 'Standalone Mockups' };
      return runStudio('Rendering device mockup', (task) => studio.renderMockup(project, input, task));
    },
    saveMockup: (value) => runStudio('Saving device mockup', () => studio.exportAsset(record(value), 'mockup')),
    renderPortfolio(value) {
      const input = record(value);
      return runStudio('Rendering portfolio', (task) => studio.renderPortfolio(getProject(input.projectId), input, task));
    },
    savePortfolio: (value) => runStudio('Saving portfolio', () => studio.exportAsset(record(value), 'portfolio')),
    recordVideo(value) {
      const input = record(value);
      const project = projectFor(input);
      return runStudio('Starting website recording', (task) =>
        studio.record(project, videoOptions(input, store.snapshot().settings, project.url), task));
    },
    cancelStudio() {
      foreground?.control.abort();
      return Boolean(foreground);
    }
  };

  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle('showcase:' + name, (event, ...args) => {
      if (!window || event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== RENDERER_URL) {
        throw new Error('This action is only available inside Showcase Studio.');
      }
      return handler(...args);
    });
  }
}

function createWindow() {
  window = new BrowserWindow({
    title: 'Showcase Studio', width: 1440, height: 940, minWidth: 720, minHeight: 560,
    backgroundColor: '#111118', autoHideMenuBar: true, show: false,
    icon: path.join(__dirname, 'renderer', 'brand.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => { if (target !== RENDERER_URL) event.preventDefault(); });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { window = null; });
  void window.loadFile(RENDERER);
}

async function start() {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  store = await Storage.open({
    directory: app.getPath('userData'),
    defaultExportDirectory: path.join(app.getPath('documents'), 'Showcase Exports')
  });
  const cache = path.join(app.getPath('userData'), 'capture-cache');
  await fs.mkdir(cache, { recursive: true });
  for (const entry of await fs.readdir(cache, { withFileTypes: true })) {
    if (entry.isDirectory() && /^session-[A-Za-z0-9]{6}$/.test(entry.name)) {
      await fs.rm(path.join(cache, entry.name), { recursive: true, force: true, maxRetries: 3 });
    }
  }
  tempDirectory = await fs.mkdtemp(path.join(cache, 'session-'));
  studio = new Studio(store, tempDirectory, changed);
  queue = new ExportQueue((item, task) => studio.batch(item, task), {
    concurrency: store.snapshot().settings.maxConcurrentJobs,
    onUpdate: (state) => {
      send('Queue', state);
      if (state.status !== 'running') scheduleThumbnail();
    }
  });
  registerHandlers();
  createWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });

  app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox('Showcase Studio could not start', error.message);
    app.quit();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (cleanupComplete || !tempDirectory) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    foreground?.control.abort();
    thumbnailTask?.control.abort();
    queue?.cancel();
    void Promise.allSettled([foreground?.promise, thumbnailTask?.promise, queue?.waitForIdle(), closeAllWebsitePreviews()])
      .then(() => fs.rm(tempDirectory, { recursive: true, force: true }))
      .catch((error) => console.error('Temporary file cleanup failed:', error.message))
      .finally(() => {
        cleanupComplete = true;
        app.quit();
      });
  });
}
