const { constants, accessSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { chromium, devices } = require('playwright');

const devicePresets = Object.freeze({
  desktop: Object.freeze({ width: 1920, height: 1080 }),
  laptop: Object.freeze({ width: 1440, height: 900 }),
  tablet: Object.freeze({ width: 768, height: 1024 }),
  mobile: Object.freeze({ width: 390, height: 844 }),
});

const previews = new Map();

function normalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
    throw new Error('Enter a website URL.');
  }
  const address = value.trim();
  if (/[\x00-\x20\x7f\\]/u.test(address)) {
    throw new Error('Enter a valid website URL with no spaces or backslashes.');
  }

  let url;
  try {
    const hasProtocol = /^[a-z][a-z\d+.-]*:/i.test(address);
    const hostWithPort = /^(?:localhost|[\w.-]+\.[\w.-]+):\d+(?:[/?#]|$)/i.test(address);
    const loopback = /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])(?:[:/?#]|$)/i.test(address);
    const prefix = hasProtocol && !hostWithPort ? '' : loopback ? 'http://' : 'https://';
    url = new URL(prefix + address);
  } catch {
    throw new Error('Enter a valid HTTP or HTTPS website URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an HTTP or HTTPS URL without embedded credentials.');
  }
  return url.href;
}

function numberOption(value, fallback, label, minimum, maximum, integer = false) {
  if (value === '' || value === undefined || value === null) return fallback;
  const number = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < minimum || number > maximum || (integer && !Number.isInteger(number))) {
    throw new Error(`${label} must be ${integer ? 'a whole number' : 'a number'} from ${minimum} to ${maximum}.`);
  }
  return number;
}

function resolveViewport(options = {}) {
  const preset = Object.hasOwn(devicePresets, options.device) ? devicePresets[options.device] : devicePresets.desktop;
  return {
    width: numberOption(options.width, preset.width, 'Viewport width', 160, 7680, true),
    height: numberOption(options.height, preset.height, 'Viewport height', 160, 7680, true),
  };
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getBrowserStatus() {
  const override = process.env.SHOWCASE_CHROMIUM_PATH;
  if (override) {
    return { available: isExecutable(override), path: override, source: 'custom' };
  }
  const managed = chromium.executablePath();
  if (isExecutable(managed)) return { available: true, path: managed, source: 'playwright' };
  if (process.platform === 'linux') {
    const system = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(isExecutable);
    if (system) return { available: true, path: system, source: 'system' };
  }
  return { available: false, path: managed, source: 'playwright' };
}

function progress(task, fraction, stage) {
  task.signal?.throwIfAborted();
  task.onProgress?.(fraction, stage);
}

async function evaluateWithDeadline(page, evaluator, argument, timeout, message) {
  let timer;
  try {
    return await Promise.race([
      page.evaluate(evaluator, argument),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function openBrowser(options, task = {}, headed = false) {
  const url = normalizeUrl(options.url);
  const viewport = resolveViewport(options);
  const dpr = numberOption(options.dpr, 1, 'Device pixel ratio', 0.5, 3);
  const timeout = numberOption(options.timeout, 30000, 'Browser timeout (ms)', 1000, 180000, true);
  const mobileProfile = options.device === 'mobile' ? devices['iPhone 13'] : null;
  const tabletProfile = options.device === 'tablet' ? devices['iPad (gen 7)'] : null;
  const profile = mobileProfile || tabletProfile;
  const status = getBrowserStatus();
  if (!status.available) {
    throw new Error(status.source === 'custom'
      ? 'The configured Chromium executable is unavailable. Check SHOWCASE_CHROMIUM_PATH.'
      : 'Playwright Chromium is missing. Run npm run setup to install the browser.');
  }

  progress(task, 0.03, 'Starting Chromium');
  let browser;
  let removeAbort = () => {};
  try {
    browser = await chromium.launch({
      executablePath: status.path,
      headless: !headed,
      chromiumSandbox: process.platform === 'win32',
      timeout,
      args: headed ? [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ] : [],
    });
    const abort = () => { void browser.close().catch(() => {}); };
    task.signal?.addEventListener('abort', abort, { once: true });
    removeAbort = () => task.signal?.removeEventListener('abort', abort);
    task.signal?.throwIfAborted();

    const context = await browser.newContext({
      acceptDownloads: false,
      viewport,
      screen: viewport,
      deviceScaleFactor: dpr,
      ...(profile && {
        isMobile: profile.isMobile,
        hasTouch: profile.hasTouch,
      }),
    });
    context.setDefaultTimeout(timeout);
    const page = await context.newPage();
    progress(task, 0.09, 'Loading website');

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    if (!/^https?:/.test(page.url())) {
      throw new Error('The page redirected outside HTTP or HTTPS.');
    }
    if (response?.status() >= 400) {
      throw new Error(`The website returned HTTP ${response.status()}. Confirm the URL and website availability.`);
    }
    await preparePage(page, options, task, timeout);
    return { browser, context, page, viewport, timeout, removeAbort };
  } catch (error) {
    removeAbort();
    await browser?.close().catch(() => {});
    task.signal?.throwIfAborted();
    if (error.name === 'TimeoutError') {
      throw new Error('Chromium or the website took too long to load. Check the URL or increase the browser timeout.', { cause: error });
    }
    if (/net::ERR_/i.test(error.message)) {
      const reason = error.message.match(/net::ERR_[A-Z_]+/i)?.[0] || 'network error';
      throw new Error(`Chromium could not load the website (${reason}). Verify that the address and server are reachable.`, { cause: error });
    }
    if (headed && /display|xserver|missing x/i.test(error.message)) {
      throw new Error('This mode requires an interactive desktop to display the Chromium window.', { cause: error });
    }
    throw error;
  }
}

async function waitForAssets(page, timeout) {
  const assetTimeout = Math.min(timeout, 8000);
  await evaluateWithDeadline(page, (limit) => {
    const waitForImages = () => {
      const images = Array.from(document.images).filter((image) => image.loading !== 'lazy' || image.complete);
      return Promise.allSettled(images.map((image) => image.decode()));
    };
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, limit);
      Promise.allSettled([document.fonts?.ready, waitForImages()]).then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }, assetTimeout, assetTimeout + 1500, 'The webpage stopped responding while loading fonts and images.');
}

async function activateLazyContent(page, timeout) {
  const scrollTimeout = Math.min(timeout, 8000);
  await evaluateWithDeadline(page, async (limit) => {
    const start = performance.now();
    const originalX = window.scrollX;
    const originalY = window.scrollY;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 90));
    try {
      window.scrollTo({ top: 0, behavior: 'instant' });
      while (performance.now() - start < limit) {
        const current = window.scrollY;
        window.scrollBy({ top: Math.max(100, innerHeight * 0.85), behavior: 'instant' });
        await settle();
        if (window.scrollY === current) break;
      }
    } finally {
      window.scrollTo({ top: originalY, left: originalX, behavior: 'instant' });
      await settle();
    }
  }, scrollTimeout, scrollTimeout + 1500, 'The webpage stopped responding while loading off-screen content.');
}

async function dismissKnownConsent(page) {
  const selectors = [
    '#onetrust-accept-btn-handler',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    '#didomi-notice-agree-button',
    '#truste-consent-button',
    '[data-testid="uc-accept-all-button"]',
  ];
  for (const selector of selectors) {
    const button = page.locator(selector).first();
    if (await button.isVisible()) {
      await button.click({ timeout: 1500 }).catch((error) => {
        if (error.name !== 'TimeoutError') throw error;
      });
      break;
    }
  }
}

async function preparePage(page, options, task, timeout) {
  const delay = numberOption(options.delay, 0, 'Loading delay (ms)', 0, 120000, true);
  if (delay) {
    progress(task, 0.13, 'Waiting for the loading delay');
    await sleep(delay, undefined, { signal: task.signal });
  }
  if (options.dismissCookies) await dismissKnownConsent(page);
  if (options.lazy || options.waitForAssets !== false) {
    progress(task, 0.17, 'Loading fonts and images');
    if (options.lazy) await activateLazyContent(page, timeout);
    if (options.waitForAssets !== false) await waitForAssets(page, timeout);
  }
}

async function withWebsite(options, task, handler, headed = false) {
  const session = await openBrowser(options, task, headed);
  try {
    return await handler(session);
  } catch (error) {
    task.signal?.throwIfAborted();
    throw error;
  } finally {
    session.removeAbort();
    await session.browser.close().catch(() => {});
  }
}

async function openWebsitePreview(options, task = {}) {
  const session = await openBrowser(options, task, true);
  session.removeAbort();
  const id = randomUUID();
  previews.set(id, session);
  const dispose = () => { void closeWebsitePreview(id); };
  session.page.once('close', dispose);
  session.browser.once('disconnected', dispose);
  return { id };
}

function getWebsitePreview(id) {
  const session = previews.get(id);
  if (!session || session.page.isClosed()) {
    throw new Error('The preview browser is closed. Open a new preview to continue.');
  }
  return session;
}

async function closeWebsitePreview(id) {
  const session = previews.get(id);
  previews.delete(id);
  if (session) await session.browser.close().catch(() => {});
}

async function closeAllWebsitePreviews() {
  await Promise.all(Array.from(previews.keys(), closeWebsitePreview));
}

module.exports = {
  normalizeUrl,
  devicePresets,
  resolveViewport,
  getBrowserStatus,
  numberOption,
  withWebsite,
  progress,
  evaluateWithDeadline,
  openWebsitePreview,
  closeWebsitePreview,
  closeAllWebsitePreviews,
  getWebsitePreview,
};
