'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { captureScreenshot, captureManualScreenshot, captureScreenshotFrames, captureManualScreenshotFrames } = require('./screenshot');
const { resolveViewport } = require('./browser');
const { captureSite: captureSitePages } = require('./site');
const { recordVideo } = require('./video');
const { renderMockup } = require('./mockup');
const { renderPortfolio, portfolioDescription, portfolioInfo, PORTFOLIO_PRESETS } = require('./portfolio');
const { writeExport, copyExport, existingExportPath } = require('./exports');
const { captureOptions, videoOptions, mockupOptions, imageOptions, str, id, extension } = require('./inputs');

const MAX_TEMP_ASSETS = 240;
const MAX_IMPORTED_BYTES = 35 * 1024 * 1024;
const INPUT_IMAGE_TYPES = new Set(['png', 'jpeg', 'webp', 'gif', 'heif', 'avif']);

function imageFilename(base, format) {
  return base + '.' + extension(format);
}

function screenshotProfile(options) {
  const { width, height } = resolveViewport(options);
  return {
    device: options.fullPage ? 'fullpage' : options.device,
    viewportDevice: options.device,
    viewportWidth: width,
    viewportHeight: height,
    dpr: options.dpr,
    framing: options.framing,
    fullPage: options.fullPage,
    sourceUrl: options.url
  };
}

async function imagePreview(source, width = 1440, height = 1100) {
  const bytes = await sharp(source, { limitInputPixels: 100_000_000 })
    .resize({ width, height, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 86 }).toBuffer();
  return 'data:image/webp;base64,' + bytes.toString('base64');
}

class Studio {
  constructor(store, tempDirectory, onChange) {
    this.store = store;
    this.tempDirectory = tempDirectory;
    this.onChange = onChange;
    this.assets = new Map();
  }

  async createWorkDirectory() {
    return fs.mkdtemp(path.join(this.tempDirectory, 'work-'));
  }

  async clear() {
    this.assets.clear();
    for (const entry of await fs.readdir(this.tempDirectory)) {
      await fs.rm(path.join(this.tempDirectory, entry), { recursive: true, force: true });
    }
  }

  async cache(source, metadata) {
    const assetId = randomUUID();
    const file = path.join(this.tempDirectory, assetId + '.' + extension(metadata.format));
    if (Buffer.isBuffer(source)) await fs.writeFile(file, source);
    else await fs.copyFile(source, file);
    try {
      const size = await sharp(file).metadata();
      const preview = await imagePreview(file);
      this.assets.set(assetId, { ...metadata, file, width: size.width, height: size.height });
      if (this.assets.size > MAX_TEMP_ASSETS) {
        const first = this.assets.keys().next().value;
        const expired = this.assets.get(first);
        this.assets.delete(first);
        await fs.rm(expired.file, { force: true });
      }
      return { id: assetId, preview, width: size.width, height: size.height };
    } catch (error) {
      await fs.rm(file, { force: true });
      throw error;
    }
  }

  async importImage(filename) {
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size > MAX_IMPORTED_BYTES) throw new Error('Choose an image under 35 MB.');
    const bytes = await fs.readFile(filename);
    const image = sharp(bytes, { limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    if (!INPUT_IMAGE_TYPES.has(metadata.format)) throw new Error('Choose a PNG, JPEG, WebP, GIF or AVIF image.');
    const normalized = await image.rotate()
      .resize({ width: 6000, height: 6000, fit: 'inside', withoutEnlargement: true })
      .png().toBuffer();
    return { ...await this.cache(normalized, { kind: 'import', format: 'png' }), name: path.basename(filename) };
  }

  async imageFor(assetId) {
    const key = id(assetId);
    const local = this.assets.get(key);
    if (local) {
      this.assets.delete(key);
      this.assets.set(key, local);
      return local.file;
    }
    const saved = this.store.snapshot().exports.find((entry) => entry.id === key);
    if (!saved || !['screenshot', 'mockup'].includes(saved.kind)) {
      throw new Error('This image is unavailable. Capture or import it again.');
    }
    return existingExportPath(saved.path);
  }

  screenshotPath(assetId) {
    const asset = this.assets.get(id(assetId));
    if (asset?.kind !== 'screenshot') throw new Error('This screenshot is unavailable. Capture it again.');
    return asset.file;
  }

  async logExport(project, kind, file, details = {}) {
    const fileName = path.basename(file);
    const entry = await this.store.addExport({
      projectId: project.id, projectName: project.name, kind, path: file, fileName, name: fileName, ...details
    });
    this.onChange();
    return { ...entry, fileName, name: fileName };
  }

  async exportFile(root, project, kind, filename, source, details) {
    const file = Buffer.isBuffer(source)
      ? await writeExport(root, project, kind, filename, source)
      : await copyExport(root, project, kind, filename, source);
    return this.logExport(project, kind, file, details);
  }

  async capture(project, options, manualId, task) {
    const dir = await this.createWorkDirectory();
    const profile = screenshotProfile(options);
    const metadata = { project, kind: 'screenshot', format: options.format, ...profile };
    try {
      if (options.framing === 'screens') {
        const filename = (index) => path.join(dir, imageFilename(`${profile.device}-${index}`, options.format));
        const captureTask = {
          ...task,
          onProgress: (value, stage) => task.onProgress(0.9 * value, stage)
        };
        const frames = manualId
          ? await captureManualScreenshotFrames(id(manualId), options, filename, captureTask)
          : await captureScreenshotFrames(options, filename, captureTask);
        task.signal.throwIfAborted();
        const cached = [];
        for (const { path: file, frameIndex, frameCount } of frames) {
          task.signal.throwIfAborted();
          task.onProgress(0.9 + 0.1 * cached.length / frames.length, 'Preparing image previews');
          const frame = { ...profile, frameIndex, frameCount };
          cached.push({ ...await this.cache(file, { ...metadata, ...frame }), ...frame });
        }
        return { frames: cached };
      }
      const file = path.join(dir, imageFilename(profile.device, options.format));
      if (manualId) await captureManualScreenshot(id(manualId), options, file, task);
      else await captureScreenshot(options, file, task);
      task.signal.throwIfAborted();
      task.onProgress(0.95, 'Preparing image preview');
      return { ...await this.cache(file, metadata), ...profile };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  async captureSite(project, options, task) {
    const dir = await this.createWorkDirectory();
    const root = this.store.snapshot().settings.exportDirectory;
    const profile = screenshotProfile(options);
    const exports = new Map();
    try {
      const report = await captureSitePages(options, dir, {
        ...task,
        onPage: async (page) => {
          const entries = [];
          exports.set(page.url, entries);
          for (const frame of page.frames || [page]) {
            task.signal.throwIfAborted();
            const { width, height } = frame.width && frame.height ? frame : await sharp(frame.path).metadata();
            entries.push(await this.exportFile(root, project, 'screenshot', frame.filename, frame.path, {
              ...profile, width, height, frameIndex: frame.frameIndex, frameCount: frame.frameCount,
              sitePage: true, sourceUrl: page.url, pageTitle: page.title
            }));
            await fs.rm(frame.path, { force: true });
          }
        }
      });
      return {
        exports: [...exports.values()].flat(),
        pages: [
          ...report.pages.map(({ url, title }) => {
            const frames = exports.get(url).map(({ id, width, height, frameIndex, frameCount }) =>
              ({ exportId: id, width, height, frameIndex, frameCount }));
            return { url, title, status: 'completed', ...frames[0], frames };
          }),
          ...report.failed.map(({ url, error }) => ({ url, error, status: 'failed' })),
          ...report.skipped.map(({ url, reason }) => ({ url, error: reason, status: 'skipped' }))
        ],
        limited: report.limited
      };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  async renderMockup(project, input, task) {
    const settings = this.store.snapshot().settings;
    const options = mockupOptions(input, settings);
    const primary = input.imageAssetId || input.sourceId || input.screenshotId;
    const mobile = input.mobileAssetId || input.mobileSourceId;
    const background = input.backgroundAssetId;
    task.onProgress(0.3, 'Composing device mockup');
    const bytes = await renderMockup({
      ...options,
      image: await this.imageFor(primary),
      mobileImage: mobile ? await this.imageFor(mobile) : undefined,
      backgroundImage: background ? await this.imageFor(background) : undefined
    });
    task.signal.throwIfAborted();
    return this.cache(bytes, { project, kind: 'mockup', format: options.format });
  }

  async renderPortfolio(project, input, task) {
    const settings = this.store.snapshot().settings;
    const preset = str(input.preset, 32) || 'github';
    const defaults = Object.hasOwn(PORTFOLIO_PRESETS, preset) && PORTFOLIO_PRESETS[preset];
    if (!defaults) throw new Error('Choose a portfolio preset.');
    const options = imageOptions(input, settings, [defaults.width, defaults.height]);
    const description = str(input.description, 16000);
    const dir = await this.createWorkDirectory();
    try {
      const assets = {};
      for (const [device, min, max] of [['desktop', 0, 0.35], ['mobile', 0.35, 0.70]]) {
        task.signal.throwIfAborted();
        const existing = this.store.snapshot().exports
          .find((entry) => entry.projectId === project.id && entry.kind === 'screenshot' && entry.device === device &&
            (!entry.sourceUrl || entry.sourceUrl === project.url) && (!entry.frameIndex || entry.frameIndex === 1));
        if (existing) {
          try { assets[device] = await existingExportPath(existing.path); } catch { /* Recapture unavailable assets. */ }
        }
        if (!assets[device]) {
          assets[device] = path.join(dir, device + '.png');
          await captureScreenshot(captureOptions({ device, lazy: true }, settings, project.url), assets[device], {
            signal: task.signal,
            onProgress: (value, stage) => task.onProgress(min + (max - min) * value, device + ' · ' + stage)
          });
        }
      }
      task.signal.throwIfAborted();
      task.onProgress(0.75, 'Composing portfolio');
      const bytes = await renderPortfolio({
        ...options, preset, project,
        desktopImage: assets.desktop, mobileImage: assets.mobile
      });
      task.signal.throwIfAborted();
      return this.cache(bytes, { project, kind: 'portfolio', format: options.format, description });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  async exportAsset(input, kind) {
    const asset = this.assets.get(id(input.id));
    if (!asset || asset.kind !== kind) throw new Error('The preview expired. Generate it again.');
    const root = this.store.snapshot().settings.exportDirectory;
    const project = asset.project.id ? this.store.getProject(asset.project.id) : asset.project;
    if (!project) throw new Error('The project no longer exists.');
    const { project: _project, kind: _kind, format, file, ...details } = asset;
    let base = kind === 'screenshot' ? asset.device : kind === 'mockup' ? 'showcase' : 'portfolio';
    if (kind === 'screenshot' && asset.frameCount > 1) {
      base += '-' + String(asset.frameIndex).padStart(3, '0');
    }
    const entry = await this.exportFile(root, project, kind, imageFilename(base, format), file,
      kind === 'screenshot' ? details : {});
    if (kind === 'portfolio') {
      await this.exportPortfolioText(root, project, str(input.description, 16000) || asset.description);
    }
    return entry;
  }

  async exportPortfolioText(root, project, description) {
    const text = description || portfolioDescription(project);
    const info = portfolioInfo(project);
    const descriptionEntry = await this.exportFile(root, project, 'portfolio', 'description.txt', Buffer.from(text, 'utf8'));
    const infoEntry = await this.exportFile(root, project, 'portfolio', 'project-info.json',
      Buffer.from(JSON.stringify(info, null, 2) + '\n', 'utf8'));
    return [descriptionEntry, infoEntry];
  }

  async record(project, options, task) {
    const dir = await this.createWorkDirectory();
    try {
      const output = path.join(dir, 'presentation.mp4');
      await recordVideo(options, output, task);
      task.signal.throwIfAborted();
      return await this.exportFile(this.store.snapshot().settings.exportDirectory, project, 'video',
        'presentation.mp4', output);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  async thumbnail(project, settings, task) {
    const dir = await this.createWorkDirectory();
    try {
      const file = path.join(dir, 'thumbnail.jpg');
      await captureScreenshot(captureOptions({
        device: 'custom', width: 960, height: 540, format: 'jpeg', quality: 75
      }, settings, project.url), file, task);
      task.signal.throwIfAborted();
      const projectWithThumbnail = await this.store.setThumbnail(project.id, await imagePreview(file, 640, 360), project.url);
      if (!projectWithThumbnail) throw new Error('The project changed before the thumbnail was ready.');
      this.onChange();
      return projectWithThumbnail;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  async batch(item, { signal, report }) {
    const project = this.store.getProject(item.projectId);
    if (!project) throw new Error('The project no longer exists.');
    const settings = this.store.snapshot().settings;
    const root = settings.exportDirectory;
    const { operations, format, quality, videoDuration, scrollSpeed, mockupTemplate } = item.options;
    const dir = await this.createWorkDirectory();
    const saved = [];
    const captured = new Map();
    let index = 0;

    async function getScreenshot(device, task) {
      if (!captured.has(device)) {
        const target = path.join(dir, imageFilename(device, format));
        const options = captureOptions({
          device: device === 'fullpage' ? 'desktop' : device, fullPage: device === 'fullpage',
          format, quality, lazy: true
        }, settings, project.url);
        await captureScreenshot(options, target, task);
        captured.set(device, target);
      }
      return captured.get(device);
    }

    try {
      for (const operation of operations) {
        signal.throwIfAborted();
        const label = operation.charAt(0).toUpperCase() + operation.slice(1);
        const task = { signal, onProgress: (value, stage) =>
          report(label + ' · ' + stage, (index + value) * 100 / operations.length) };
        task.onProgress(0, 'Starting');
        if (operation === 'video') {
          const target = path.join(dir, 'presentation.mp4');
          const options = videoOptions({ duration: videoDuration, scrollSpeed }, settings, project.url);
          await recordVideo(options, target, task);
          signal.throwIfAborted();
          saved.push(await this.exportFile(root, project, 'video', 'presentation.mp4', target));
        } else if (operation === 'mockup') {
          const image = await getScreenshot('desktop', task);
          signal.throwIfAborted();
          const bytes = await renderMockup({
            image, template: mockupTemplate || 'premium-studio', title: project.name, subtitle: project.category,
            format, quality
          });
          signal.throwIfAborted();
          saved.push(await this.exportFile(root, project, 'mockup', imageFilename('showcase', format), bytes));
        } else if (operation === 'portfolio') {
          saved.push(...await this.exportPortfolioText(root, project));
        } else {
          const image = await getScreenshot(operation, task);
          signal.throwIfAborted();
          saved.push(await this.exportFile(root, project, 'screenshot', path.basename(image), image, { device: operation }));
        }
        index += 1;
        report(label + ' · Saved', index * 100 / operations.length);
      }
      return { files: saved.length };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}

module.exports = { Studio };
