'use strict';

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request.');
  return value;
}

function number(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!['string', 'number'].includes(typeof value)) throw new Error('Invalid numeric setting.');
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) {
    throw new Error('Enter a value between ' + min + ' and ' + max + '.');
  }
  return result;
}

function integer(value, fallback, min, max) {
  return Math.round(number(value, fallback, min, max));
}

function choice(value, fallback, options) {
  if (value === undefined || value === '') return fallback;
  if (!options.includes(value)) throw new Error('Choose a supported option.');
  return value;
}

function str(value, max = 1000) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) throw new Error('Invalid text value.');
  return value;
}

function lines(value, label, limit, maxLength) {
  const entries = Array.isArray(value) ? value : str(value, limit * (maxLength + 2)).split(/\r?\n/u);
  const result = entries.map((entry) => str(entry, maxLength).trim()).filter(Boolean);
  if (result.length > limit || result.some((entry) => /[\0\r\n]/u.test(entry))) {
    throw new Error(`Enter at most ${limit} ${label}, one per line.`);
  }
  return result;
}

function id(value) {
  if (typeof value !== 'string' || !/^[0-9a-z-]{1,64}$/i.test(value)) {
    throw new Error('Select a valid saved item.');
  }
  return value;
}

function imageFormat(value) {
  return choice(value === 'jpg' ? 'jpeg' : value, 'png', ['png', 'jpeg']);
}

function captureOptions(input, settings, url) {
  const hasDimensions = input.width != null || input.height != null;
  const device = choice(input.device ?? input.preset, hasDimensions ? 'custom' : 'desktop',
    ['desktop', 'laptop', 'tablet', 'mobile', 'custom']);
  const framing = choice(input.framing, input.fullPage === true ? 'full' : 'viewport',
    ['screens', 'viewport', 'full']);
  const options = {
    url,
    device,
    framing,
    dpr: number(input.dpr ?? input.deviceScaleFactor, 1, 0.5, 3),
    delay: integer(input.delay, 0, 0, 30000),
    timeout: settings.browserTimeout,
    fullPage: framing === 'full',
    waitForAssets: input.waitForAssets !== false,
    lazy: input.lazy === true,
    dismissCookies: input.dismissCookies === true,
    format: imageFormat(input.format),
    quality: integer(input.quality, settings.imageQuality, 1, 100)
  };
  if (device === 'custom') {
    options.width = integer(input.width, settings.screenshotWidth, 160, 4096);
    options.height = integer(input.height, settings.screenshotHeight, 160, 4096);
  }
  return options;
}

function siteOptions(input, settings, url) {
  return {
    ...captureOptions({
      ...input,
      framing: input.framing ?? (input.fullPage == null ? 'screens' : undefined),
      lazy: input.lazy !== false
    }, settings, url),
    maxPages: integer(input.maxPages, 20, 1, 100),
    maxDepth: integer(input.maxDepth, 3, 0, 10),
    paths: lines(input.pageUrls, 'page URLs', 100, 4096)
  };
}

function videoOptions(input, settings, url) {
  const viewport = captureOptions({ ...input, quality: undefined, dpr: 1 }, settings, url);
  if (input.width != null || input.height != null) {
    viewport.width = integer(input.width, settings.screenshotWidth, 160, 4096);
    viewport.height = integer(input.height, settings.screenshotHeight, 160, 4096);
  }
  return {
    ...viewport,
    mode: choice(input.mode, 'smooth',
      ['static', 'smooth', 'top-to-bottom', 'down-up', 'manual', 'navigation', 'scroll-navigation']),
    duration: number(input.duration, 8, 1, 180),
    initialPause: number(input.initialPause, 1, 0, 30),
    finalPause: number(input.finalPause, 1, 0, 30),
    scrollSpeed: number(input.scrollSpeed, 350, 10, 10000),
    navigationLabels: lines(input.navigationLabels, 'button or link labels', 12, 160),
    navigationWait: number(input.navigationWait, 1.5, 0, 30),
    outputWidth: integer(input.outputWidth, settings.videoWidth, 160, 3840),
    outputHeight: integer(input.outputHeight, settings.videoHeight, 160, 3840),
    quality: integer(input.quality, settings.videoQuality, 0, 51),
    title: str(input.title, 160),
    fadeIn: input.fadeIn === true,
    fadeOut: input.fadeOut === true
  };
}

function imageOptions(input, settings, dimensions = [1920, 1080]) {
  return {
    width: integer(input.width, dimensions[0], 160, 4096),
    height: integer(input.height, dimensions[1], 160, 4096),
    format: imageFormat(input.format),
    quality: integer(input.quality, settings.imageQuality, 1, 100)
  };
}

function mockupOptions(input, settings) {
  return {
    ...imageOptions(input, settings),
    device: str(input.device, 32) || undefined,
    template: str(input.template, 32) || undefined,
    background: str(input.background, 16) || undefined,
    gradient: input.gradient === false ? false : str(input.gradient, 16) || undefined,
    positionX: number(input.positionX, undefined, -100, 100),
    positionY: number(input.positionY, undefined, -100, 100),
    scale: number(input.scale, undefined, 20, 180),
    rotation: number(input.rotation, undefined, -45, 45),
    perspective: number(input.perspective, undefined, -65, 65),
    shadow: number(input.shadow, undefined, 0, 100),
    radius: number(input.radius, undefined, 0, 300),
    padding: number(input.padding, undefined, 0, 700),
    title: str(input.title, 160),
    subtitle: str(input.subtitle, 240),
    text: str(input.text, 500),
    align: choice(input.align, undefined, ['left', 'center', 'right'])
  };
}

function extension(format) {
  return format === 'jpeg' ? 'jpg' : 'png';
}

module.exports = { record, number, integer, choice, str, id, captureOptions, siteOptions, videoOptions, imageOptions,
  mockupOptions, extension, imageFormat };
