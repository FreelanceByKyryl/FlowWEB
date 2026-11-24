const { writeFile } = require('node:fs/promises');
const { extname } = require('node:path');
const {
  withWebsite,
  progress,
  evaluateWithDeadline,
  numberOption,
  openWebsitePreview,
  closeWebsitePreview,
  getWebsitePreview,
} = require('./browser');

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

async function captureManualScreenshot(id, options, outputPath, task = {}) {
  const session = getWebsitePreview(id);
  if (session.capturing) throw new Error('A screenshot is already being taken from this browser.');
  if (!/^https?:/.test(session.page.url())) {
    throw new Error('Open an HTTP or HTTPS webpage in the Chromium window before taking a screenshot.');
  }
  const abort = () => { void closeWebsitePreview(id); };
  session.capturing = true;
  task.signal?.addEventListener('abort', abort, { once: true });
  try {
    task.signal?.throwIfAborted();
    return await capturePage(session, options, outputPath, task);
  } catch (error) {
    task.signal?.throwIfAborted();
    throw error;
  } finally {
    task.signal?.removeEventListener('abort', abort);
    session.capturing = false;
  }
}

module.exports = {
  captureScreenshot,
  openManualCapture: openWebsitePreview,
  captureManualScreenshot,
  closeManualCapture: closeWebsitePreview,
};
