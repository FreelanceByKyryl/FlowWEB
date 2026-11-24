const { open, rm, writeFile } = require('node:fs/promises');
const { extname } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const sharp = require('sharp');
const {
  withWebsite,
  progress,
  evaluateWithDeadline,
  numberOption,
  resolveViewport,
  preparePage,
  waitForAssets,
  openWebsitePreview,
  closeWebsitePreview,
  getWebsitePreview,
} = require('./browser');

const maxFrames = 30;

function screenshotFormat(options, outputPath) {
  const suffix = extname(outputPath || '').toLowerCase();
  const format = String(options.format || (suffix === '.jpg' || suffix === '.jpeg' ? 'jpeg' : 'png')).toLowerCase();
  if (format === 'jpeg' || format === 'jpg') return 'jpeg';
  if (format === 'png') return 'png';
  throw new Error('Choose PNG or JPEG for your screenshot.');
}

async function capturePage(session, options, outputPath, task) {
  const { page, timeout } = session;
  const type = screenshotFormat(options, outputPath);
  const fullPage = Boolean(options.fullPage);
  const resolution = await evaluateWithDeadline(page, (captureEntirePage) => {
    const root = document.documentElement;
    const body = document.body;
    return {
      width: (captureEntirePage ? Math.max(root.scrollWidth, body?.scrollWidth || 0, innerWidth) : innerWidth) * devicePixelRatio,
      height: (captureEntirePage ? Math.max(root.scrollHeight, body?.scrollHeight || 0, innerHeight) : innerHeight) * devicePixelRatio,
    };
  }, fullPage, timeout, 'The webpage stopped responding while measuring the screenshot.');
  if (resolution.width > 32767 || resolution.height > 32767 || resolution.width * resolution.height > 100000000) {
    throw new Error('The screenshot is too large for Chromium. Reduce the device pixel ratio or use viewport capture.');
  }
  progress(task, 0.5, fullPage ? 'Capturing the full page' : 'Capturing the viewport');
  const image = await page.screenshot({
    type,
    fullPage,
    timeout,
    ...(type === 'jpeg' && { quality: numberOption(options.quality, 90, 'JPEG quality', 1, 100, true) }),
  });
  if (outputPath) {
    progress(task, 0.85, 'Saving screenshot');
    await writeFile(outputPath, image, { flag: 'wx' });
  }
  task.signal?.throwIfAborted();
  return image;
}

async function captureScreenshot(options, outputPath, task = {}) {
  return withWebsite(options, task, (session) => capturePage(session, options, outputPath, task));
}

async function scrollMetrics(page, position, timeout) {
  return evaluateWithDeadline(page, async (point) => {
    if (point) {
      window.scrollTo({ ...point, behavior: 'instant' });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    const root = document.scrollingElement || document.documentElement;
    return {
      left: window.scrollX,
      top: window.scrollY,
      maximum: Math.max(0, root.scrollHeight - root.clientHeight),
      step: Math.max(1, Math.floor(Math.min(root.clientHeight, window.visualViewport?.height || window.innerHeight))),
    };
  }, position, timeout, 'The webpage stopped responding while scrolling to the next frame.');
}

async function capturePageFrames(session, options, filenameForFrame, task = {}) {
  const { page, timeout } = session;
  task.signal?.throwIfAborted();
  const original = await evaluateWithDeadline(page, () => {
    const style = (document.scrollingElement || document.documentElement).style;
    const previous = {
      left: window.scrollX,
      top: window.scrollY,
      snap: style.getPropertyValue('scroll-snap-type'),
      priority: style.getPropertyPriority('scroll-snap-type'),
    };
    style.setProperty('scroll-snap-type', 'none', 'important');
    return previous;
  }, undefined, timeout, 'The webpage stopped responding while preparing screenshot frames.');
  const frames = [];
  const ownedFiles = [];
  let position = 0;
  let previous;
  let reported = 0.2;
  try {
    while (frames.length < maxFrames) {
      task.signal?.throwIfAborted();
      const frameIndex = frames.length + 1;
      const before = await scrollMetrics(page, { left: 0, top: position }, timeout);
      progress(task, reported, `Preparing frame ${frameIndex}`);
      if (options.waitForAssets !== false) await waitForAssets(page, timeout, task.signal);
      else await sleep(120, undefined, { signal: task.signal });
      const area = await scrollMetrics(page, null, timeout);
      const remaining = Math.ceil(Math.max(0, area.maximum - area.top) / area.step);
      const frameCount = frameIndex + remaining;
      if (frameCount > maxFrames) {
        throw new Error(`This page requires more than ${maxFrames} frames. Increase the viewport height or capture individual sections manually.`);
      }
      if ((previous && (area.top <= previous.top || area.top - previous.top > previous.step + 1)) ||
          (!previous && Math.abs(area.top) > 1) ||
          (Math.abs(area.top - before.top) > 1 && Math.abs(area.top - position) > 1)) {
        throw new Error('The website changed its scroll position and left a gap between frames. Try manual capture for this page.');
      }

      reported = Math.max(reported, 0.2 + 0.7 * frames.length / frameCount);
      progress(task, reported, `Capturing frame ${frameIndex} of ${frameCount}`);
      const path = filenameForFrame(frameIndex);
      const format = screenshotFormat(options, path);
      const image = await capturePage(session, { ...options, format, fullPage: false }, undefined, { signal: task.signal });
      const { width, height } = await sharp(image).metadata();
      task.signal?.throwIfAborted();
      const file = await open(path, 'wx');
      ownedFiles.push(path);
      try {
        await file.writeFile(image);
      } finally {
        await file.close();
      }
      frames.push({ path, frameIndex, width, height });
      if (!remaining) {
        progress(task, 0.95, 'Preparing screenshot frames');
        task.signal?.throwIfAborted();
        return frames.map((frame) => ({ ...frame, frameCount: frames.length }));
      }
      previous = area;
      position = Math.min(area.maximum, area.top + area.step);
    }
    throw new Error(`This page continued past ${maxFrames} frames. Capture a shorter section manually.`);
  } catch (error) {
    await Promise.all(ownedFiles.map((path) => rm(path, { force: true })));
    throw error;
  } finally {
    if (!page.isClosed()) {
      await evaluateWithDeadline(page, ({ left, top, snap, priority }) => {
        const style = (document.scrollingElement || document.documentElement).style;
        window.scrollTo({ left, top, behavior: 'instant' });
        if (snap) style.setProperty('scroll-snap-type', snap, priority);
        else style.removeProperty('scroll-snap-type');
      }, original, Math.min(1500, timeout), 'The webpage stopped responding while restoring its scroll position.').catch(() => {});
    }
  }
}

async function captureScreenshotFrames(options, filenameForFrame, task = {}) {
  return withWebsite(options, task, (session) => capturePageFrames(session, options, filenameForFrame, task));
}

async function withManualCapture(id, options, task, capture) {
  const session = getWebsitePreview(id);
  if (session.capturing) throw new Error('A screenshot is already being taken from this browser.');
  const viewport = resolveViewport({
    width: options.width ?? session.viewport.width,
    height: options.height ?? session.viewport.height,
  });
  const dpr = numberOption(options.dpr, session.dpr, 'Device pixel ratio', 0.5, 3);
  if ((options.device && options.device !== session.device) || dpr !== session.dpr ||
      viewport.width !== session.viewport.width || viewport.height !== session.viewport.height) {
    throw new Error('The live preview uses a different device, viewport size, or pixel ratio. Close it and open a new preview with your current settings.');
  }
  if (!/^https?:/.test(session.page.url())) {
    throw new Error('Open an HTTP or HTTPS webpage in the Chromium window before taking a screenshot.');
  }
  const abort = () => { void closeWebsitePreview(id); };
  session.capturing = true;
  task.signal?.addEventListener('abort', abort, { once: true });
  try {
    task.signal?.throwIfAborted();
    await preparePage(session.page, options, task, session.timeout);
    return await capture(session);
  } catch (error) {
    task.signal?.throwIfAborted();
    throw error;
  } finally {
    task.signal?.removeEventListener('abort', abort);
    session.capturing = false;
  }
}

async function captureManualScreenshot(id, options, outputPath, task = {}) {
  return withManualCapture(id, options, task, (session) => capturePage(session, options, outputPath, task));
}

async function captureManualScreenshotFrames(id, options, filenameForFrame, task = {}) {
  return withManualCapture(id, options, task, (session) => capturePageFrames(session, options, filenameForFrame, task));
}

module.exports = {
  captureScreenshot,
  captureScreenshotFrames,
  capturePage,
  capturePageFrames,
  screenshotFormat,
  openManualCapture: openWebsitePreview,
  captureManualScreenshot,
  captureManualScreenshotFrames,
  closeManualCapture: closeWebsitePreview,
};
