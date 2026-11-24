const { execFile, spawn } = require('node:child_process');
const { copyFile, mkdtemp, open, rm } = require('node:fs/promises');
const { constants } = require('node:fs');
const { dirname, join } = require('node:path');
const { performance } = require('node:perf_hooks');
const { setTimeout: sleep } = require('node:timers/promises');
const { promisify } = require('node:util');
const sharp = require('sharp');
const { withWebsite, numberOption, progress, evaluateWithDeadline } = require('./browser');
const { navigationLabels, runNavigationTour } = require('./navigation');

const runFile = promisify(execFile);
const framesPerSecond = 30;
const introSeconds = 2;
const modes = ['static', 'smooth', 'top-to-bottom', 'down-up', 'navigation', 'manual'];
const maxTourSeconds = 240;

function getFfmpegPath() {
  return process.env.SHOWCASE_FFMPEG_PATH || 'ffmpeg';
}

async function getFfmpegStatus() {
  const path = getFfmpegPath();
  try {
    const subprocess = { windowsHide: true, timeout: 10000 };
    const { stdout: banner } = await runFile(path, ['-version'], subprocess);
    const { stdout: encoders } = await runFile(path, ['-hide_banner', '-encoders'], subprocess);
    const version = banner.split(/\r?\n/)[0];
    if (!/\blibx264\b/.test(encoders)) {
      return { available: false, path, version, error: 'FFmpeg is missing its libx264 H.264 encoder. Install a full FFmpeg build.' };
    }
    return { available: true, path, version };
  } catch (error) {
    return {
      available: false,
      path,
      error: error.code === 'ENOENT'
        ? 'FFmpeg is missing. Install it and reopen the application, or set SHOWCASE_FFMPEG_PATH.'
        : 'FFmpeg could not start. Check the installation and SHOWCASE_FFMPEG_PATH.',
    };
  }
}

function videoSettings(options) {
  const mode = options.mode || 'smooth';
  if (!modes.includes(mode)) throw new Error('Choose a valid video recording mode.');
  const outputWidth = numberOption(options.outputWidth, 1920, 'Video width', 160, 7680, true);
  const outputHeight = numberOption(options.outputHeight, 1080, 'Video height', 160, 7680, true);
  if (outputWidth % 2 || outputHeight % 2 || outputWidth * outputHeight > 16777216) {
    throw new Error('Use even video dimensions and an output resolution of 16 megapixels or less.');
  }
  const title = typeof options.title === 'string' ? options.title.trim() : '';
  if (title.length > 160) throw new Error('The video title must be at most 160 characters.');
  const duration = numberOption(options.duration, 8, 'Recording duration (seconds)', 1, 180);
  const initialPause = numberOption(options.initialPause, 0, 'Initial pause (seconds)', 0, 30);
  const finalPause = numberOption(options.finalPause, 0, 'Final pause (seconds)', 0, 30);
  return {
    mode, outputWidth, outputHeight, title, duration, initialPause, finalPause,
    totalDuration: Math.ceil((duration + initialPause + finalPause) * framesPerSecond) / framesPerSecond,
    scrollSpeed: numberOption(options.scrollSpeed, 240, 'Scroll speed (pixels per second)', 10, 10000),
    quality: numberOption(options.quality, 23, 'Video quality (CRF)', 0, 51, true),
    ...(mode === 'navigation' && {
      navigationLabels: navigationLabels(options.navigationLabels),
      navigationWait: numberOption(options.navigationWait, 1, 'Wait after navigation (seconds)', 0, 30),
    }),
    fadeIn: Boolean(options.fadeIn),
    fadeOut: Boolean(options.fadeOut),
  };
}

async function schedulePageScroll(page, { mode, duration, initialPause, scrollSpeed }, timeout) {
  if (mode === 'static' || mode === 'manual' || mode === 'navigation') return;
  await evaluateWithDeadline(page, ({ mode, duration, initialPause, scrollSpeed }) => {
    const scroll = (top) => window.scrollTo({ top, behavior: 'instant' });
    scroll(0);
    const start = performance.now() + initialPause * 1000;
    const ease = (value) => value * value * (3 - 2 * value);
    const tick = (now) => {
      const elapsed = Math.max(0, (now - start) / 1000);
      const fraction = Math.min(1, elapsed / duration);
      const maxScroll = Math.max(0, (document.scrollingElement?.scrollHeight || innerHeight) - innerHeight);
      if (mode === 'smooth') scroll(Math.min(maxScroll, elapsed * scrollSpeed));
      if (mode === 'top-to-bottom') scroll(maxScroll * ease(fraction));
      if (mode === 'down-up') scroll(maxScroll * ease(1 - Math.abs(2 * fraction - 1)));
      if (fraction < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { mode, duration, initialPause, scrollSpeed }, timeout, 'The webpage stopped responding before scrolling could start.');
}

async function recordFrames(session, settings, options, rawFile, task) {
  const { page, context, viewport, timeout } = session;
  const cdp = await context.newCDPSession(page);
  const capture = await open(rawFile, 'wx');
  const stopTour = new AbortController();
  let latestFrame;
  cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
    latestFrame = Buffer.from(data, 'base64');
    void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  try {
    progress(task, 0.21, settings.mode === 'manual' ? 'Starting the interactive recording' : 'Preparing the recording');
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 90,
      maxWidth: viewport.width,
      maxHeight: viewport.height,
      everyNthFrame: 1,
    });
    const waitUntil = performance.now() + Math.min(timeout, 10000);
    while (!latestFrame && performance.now() < waitUntil && !page.isClosed()) {
      await sleep(25, undefined, { signal: task.signal });
    }
    if (!latestFrame) throw new Error('Chromium did not provide a video frame. Retry with a smaller viewport.');

    await schedulePageScroll(page, settings, timeout);
    let recordingStage = settings.mode === 'manual' ? 'Recording the interactive Chromium window' : 'Recording website';
    const minimumFrames = Math.round(settings.totalDuration * framesPerSecond);
    const touring = settings.mode === 'navigation';
    const start = performance.now();
    let tourCompletedAt;
    let tourError;
    if (touring) {
      const signal = task.signal ? AbortSignal.any([task.signal, stopTour.signal]) : stopTour.signal;
      runNavigationTour(session, cdp, settings, options, signal, (stage) => { recordingStage = stage; }).then(
        () => { tourCompletedAt = performance.now(); },
        (error) => { tourError = error; },
      );
    }

    let capturedFrames = 0;
    while (true) {
      task.signal?.throwIfAborted();
      if (tourError) throw tourError;
      const afterTourFrames = tourCompletedAt === undefined
        ? minimumFrames
        : Math.ceil((tourCompletedAt - start + settings.finalPause * 1000) / 1000 * framesPerSecond);
      const frameCount = Math.max(minimumFrames, afterTourFrames);
      if ((!touring || tourCompletedAt !== undefined) && capturedFrames >= frameCount) break;
      if (touring && capturedFrames >= maxTourSeconds * framesPerSecond) {
        throw new Error('The navigation tour exceeded four minutes. Use fewer labels or shorter waits.');
      }
      if (page.isClosed()) throw new Error('The recording browser was closed before the video finished.');
      if (!/^https?:/.test(page.url())) throw new Error('The recording was interrupted by navigation outside HTTP or HTTPS.');
      const remaining = start + capturedFrames * 1000 / framesPerSecond - performance.now();
      if (remaining > 0) await sleep(remaining, undefined, { signal: task.signal });
      await capture.writeFile(latestFrame);
      capturedFrames++;
      if (capturedFrames % 3 === 1) {
        progress(task, 0.24 + 0.48 * Math.min(1, capturedFrames / minimumFrames), recordingStage);
      }
    }
    return capturedFrames / framesPerSecond;
  } finally {
    stopTour.abort();
    await capture.close();
    await cdp.send('Page.stopScreencast').catch(() => {});
    await cdp.detach().catch(() => {});
  }
}

function xmlEscape(text) {
  return text.replace(/[^\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, ' ').replace(/[&<>]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
  })[character]);
}

function titleLines(title, width, height) {
  const maxCharacters = Math.max(12, Math.floor(width * 0.82 / Math.round(Math.min(width, height) * 0.065) / 0.65));
  const lines = [];
  for (const word of title.split(/\s+/u)) {
    const segments = Array.from(word);
    while (segments.length > maxCharacters) lines.push(segments.splice(0, maxCharacters).join(''));
    const segment = segments.join('');
    const previous = lines[lines.length - 1];
    if (previous && Array.from(previous).length + segments.length + 1 <= maxCharacters) {
      lines[lines.length - 1] = `${previous} ${segment}`;
    } else {
      lines.push(segment);
    }
  }
  return lines;
}

async function makeTitleImage(settings, path) {
  const { outputWidth: width, outputHeight: height, title } = settings;
  const lines = titleLines(title, width, height);
  const fontSize = Math.round(Math.min(width, height / Math.max(1, lines.length / 4)) * 0.065);
  const lineHeight = Math.round(fontSize * 1.16);
  const firstLine = height / 2 - (lines.length - 1) * lineHeight / 2;
  const text = lines.map((line, index) => `<text x="${width / 2}" y="${firstLine + lineHeight * index}">${xmlEscape(line)}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#13172c"/><stop offset="1" stop-color="#412766"/></linearGradient></defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <g fill="#f7f3ff" text-anchor="middle" dominant-baseline="middle" font-family="Segoe UI, sans-serif" font-size="${fontSize}" font-weight="600">${text}</g>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path);
}

function encoderArguments(settings, rawFile, titleFile, tempOutput) {
  const { outputWidth: width, outputHeight: height, totalDuration, quality } = settings;
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostats', '-nostdin',
    '-progress', 'pipe:2', '-stats_period', '0.25', '-filter_complex_threads', '2',
    '-framerate', String(framesPerSecond), '-f', 'image2pipe', '-vcodec', 'mjpeg', '-i', rawFile,
  ];
  let filter = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x101018,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[site]`;
  if (titleFile) {
    args.push('-framerate', String(framesPerSecond), '-loop', '1', '-t', String(introSeconds), '-i', titleFile);
    filter += ';[1:v]setsar=1,format=yuv420p,setpts=PTS-STARTPTS[intro];[intro][site]concat=n=2:v=1:a=0[combined]';
  }
  const finalDuration = totalDuration + (titleFile ? introSeconds : 0);
  const fadeDuration = Math.min(0.65, finalDuration * 0.4);
  const finalFilters = [`trim=duration=${finalDuration}`];
  if (settings.fadeIn) finalFilters.push(`fade=t=in:st=0:d=${fadeDuration}`);
  if (settings.fadeOut) finalFilters.push(`fade=t=out:st=${finalDuration - fadeDuration}:d=${fadeDuration}`);
  filter += `;[${titleFile ? 'combined' : 'site'}]${finalFilters.join(',')}[final]`;
  return args.concat([
    '-filter_complex', filter, '-map', '[final]', '-an', '-r', String(framesPerSecond),
    '-c:v', 'libx264', '-crf', String(quality),
    '-preset', 'veryfast', '-threads', '2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-n', tempOutput,
  ]);
}

function encodeVideo(path, args, duration, task) {
  return new Promise((resolve, reject) => {
    const encoder = spawn(path, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      signal: task.signal,
    });
    let processError;
    let pendingLine = '';
    const diagnostics = [];
    encoder.once('error', (error) => { processError = error; });
    encoder.stderr.setEncoding('utf8');
    encoder.stderr.on('data', (chunk) => {
      const lines = (pendingLine + chunk).split(/\r?\n/);
      pendingLine = lines.pop();
      for (const line of lines) {
        const time = line.match(/^out_time_us=(\d+)$/);
        if (time && !task.signal?.aborted) {
          progress(task, 0.75 + 0.22 * Math.min(1, Number(time[1]) / 1000000 / duration), 'Encoding H.264 video');
        } else if (line && !/^[\w_]+=/.test(line)) {
          diagnostics.push(line);
          if (diagnostics.length > 8) diagnostics.shift();
        }
      }
    });
    encoder.once('close', (code) => {
      if (task.signal?.aborted) {
        reject(task.signal.reason);
      } else if (processError || code !== 0) {
        const reason = diagnostics.join(' ').slice(0, 750) || processError?.message || `exit code ${code}`;
        reject(new Error(`FFmpeg could not encode the video (${reason}). Try a smaller output resolution and retry.`));
      } else {
        resolve();
      }
    });
  });
}

async function recordVideo(options, outputPath, task = {}) {
  const settings = videoSettings(options);
  const viewportOptions = { ...options, dpr: 1 };
  const ffmpeg = await getFfmpegStatus();
  if (!ffmpeg.available) throw new Error(ffmpeg.error);
  task.signal?.throwIfAborted();
  const temporary = await mkdtemp(join(dirname(outputPath), '.showcase-video-'));
  try {
    const rawFile = join(temporary, 'capture.mjpeg');
    const tempOutput = join(temporary, 'encoded.mp4');
    settings.totalDuration = await withWebsite(
      viewportOptions, task,
      (session) => recordFrames(session, settings, options, rawFile, task),
      settings.mode === 'manual',
      settings.mode === 'navigation' ? { serviceWorkers: 'block' } : undefined,
    );
    const titleFile = settings.title ? join(temporary, 'title.png') : null;
    if (titleFile) await makeTitleImage(settings, titleFile);
    progress(task, 0.75, 'Encoding H.264 video');
    const args = encoderArguments(settings, rawFile, titleFile, tempOutput);
    await encodeVideo(ffmpeg.path, args, settings.totalDuration + (titleFile ? introSeconds : 0), task);
    progress(task, 0.98, 'Saving video');
    await copyFile(tempOutput, outputPath, constants.COPYFILE_EXCL);
    return { duration: settings.totalDuration + (titleFile ? introSeconds : 0), width: settings.outputWidth, height: settings.outputHeight };
  } catch (error) {
    if (error.code === 'ENOSPC') throw new Error('There is insufficient disk space to finish the video. Free space or reduce its resolution or duration.', { cause: error });
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}

module.exports = { recordVideo, getFfmpegStatus };
