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
  const device = choice(input.device ?? input.preset, 'desktop', ['desktop', 'laptop', 'tablet', 'mobile', 'custom']);
  const options = {
    url,
    device,
    dpr: number(input.dpr ?? input.deviceScaleFactor, 1, 0.5, 3),
    delay: integer(input.delay, 0, 0, 30000),
    timeout: settings.browserTimeout,
    fullPage: input.fullPage === true,
    waitForAssets: input.waitForAssets !== false,
    lazy: input.lazy === true,
    dismissCookies: input.dismissCookies === true,
    format: imageFormat(input.format),
    quality: integer(input.quality, settings.imageQuality, 1, 100)
  };
  if (device === 'custom' || input.width != null || input.height != null) {
    options.width = integer(input.width, settings.screenshotWidth, 160, 4096);
    options.height = integer(input.height, settings.screenshotHeight, 160, 4096);
  }
  return options;
}

function videoOptions(input, settings, url) {
  const viewport = captureOptions({ ...input, quality: undefined, dpr: 1 }, settings, url);
  return {
    ...viewport,
    mode: choice(input.mode, 'smooth', ['static', 'smooth', 'top-to-bottom', 'down-up', 'manual']),
    duration: number(input.duration, 8, 1, 180),
    initialPause: number(input.initialPause, 1, 0, 30),
    finalPause: number(input.finalPause, 1, 0, 30),
    scrollSpeed: number(input.scrollSpeed, 350, 10, 10000),
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

module.exports = { record, number, integer, choice, str, id, captureOptions, videoOptions, imageOptions,
  mockupOptions, extension, imageFormat };
