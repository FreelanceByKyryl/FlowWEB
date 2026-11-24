const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { promisify } = require('node:util');
const { test } = require('node:test');
const sharp = require('sharp');
const { normalizeUrl, withWebsite } = require('../src/services/browser');
const { capturePage, capturePageFrames, captureScreenshot, captureScreenshotFrames } = require('../src/services/screenshot');
const { getFfmpegStatus, recordVideo } = require('../src/services/video');

const fixture = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Capture fixture</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin: 0; }
  section { height: 150vh; }
  .top { background: #e03040; }
  .bottom { background: #2040e0; }
  @media (max-width: 500px) { .top { background: #20b060; } }
</style>
</head><body><section class="top"></section><section class="bottom"></section></body></html>`;

async function localFixture(context, handle = () => fixture) {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(handle(request, response));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const folder = await mkdtemp(join(tmpdir(), 'showcase-test-capture-'));
  context.after(() => rm(folder, { recursive: true, force: true }));
  return { url: `http://127.0.0.1:${server.address().port}`, folder };
}

async function centerPixel(image) {
  const input = sharp(image);
  const { width, height } = await input.metadata();
  return Array.from(await input.extract({ left: Math.floor(width / 2), top: Math.floor(height / 2), width: 1, height: 1 }).removeAlpha().raw().toBuffer());
}

async function pixelAt(image, left, top) {
  return Array.from(await sharp(image).extract({ left, top, width: 1, height: 1 }).removeAlpha().raw().toBuffer());
}

test('normalizes local URLs and rejects file URLs and embedded credentials', () => {
  assert.equal(normalizeUrl('localhost:5173/preview'), 'http://localhost:5173/preview');
  assert.equal(normalizeUrl('[::1]:3000'), 'http://[::1]:3000/');
  assert.throws(() => normalizeUrl('file:///tmp/private'), /HTTP or HTTPS/);
  assert.throws(() => normalizeUrl('https://user:password@example.com'), /credentials/);
});

test('captures real desktop, mobile and full-page screenshots from a responsive site', { timeout: 30000 }, async (context) => {
  const { url, folder } = await localFixture(context);
  const desktopPath = join(folder, 'desktop.png');
  const desktop = await captureScreenshot({ url, device: 'desktop' }, desktopPath);
  const desktopMetadata = await sharp(desktop).metadata();
  assert.equal(desktopMetadata.width, 1920);
  assert.equal(desktopMetadata.height, 1080);
  assert.deepEqual(await centerPixel(desktop), [224, 48, 64]);
  assert.deepEqual(await readFile(desktopPath), desktop);

  const mobilePath = join(folder, 'mobile.jpg');
  const mobile = await captureScreenshot({ url, device: 'mobile', format: 'jpeg', dpr: 2, quality: 92 }, mobilePath);
  const mobileMetadata = await sharp(mobile).metadata();
  assert.equal(mobileMetadata.width, 780);
  assert.equal(mobileMetadata.height, 1688);
  assert.equal(mobileMetadata.format, 'jpeg');
  const [red, green, blue] = await centerPixel(mobile);
  assert.ok(green > 155 && red < 60 && blue < 120, `${red},${green},${blue}`);

  const fullPage = await captureScreenshot({ url, device: 'custom', width: 800, height: 400, fullPage: true }, join(folder, 'fullpage.png'));
  const fullMetadata = await sharp(fullPage).metadata();
  assert.equal(fullMetadata.width, 800);
  assert.equal(fullMetadata.height, 1200);
  assert.deepEqual((await readdir(folder)).sort(), ['desktop.png', 'fullpage.png', 'mobile.jpg']);
});

test('keeps a wide desktop layout while splitting tall responsive content into viewport-sized frames', { timeout: 30000 }, async (context) => {
  const hints = [];
  const { url, folder } = await localFixture(context, (request) => {
    if (request.url === '/') hints.push(request.headers['sec-ch-ua-mobile']);
    return `<!doctype html><meta name="viewport" content="width=390, initial-scale=1">
      <style>
        body { margin: 0; } .hero { display: grid; grid-template-rows: 1fr 1fr; height: 100vh; }
        .copy { background: #de6020; } .art { background: #2040e0; }
        .below { height: 100vh; background: #20b060; } footer { height: 180px; background: #e020a0; }
        @media (min-width: 1400px) and (max-height: 1100px) and (pointer: fine) and (hover: hover) {
          .hero { grid-template-rows: 1fr; grid-template-columns: 1fr 1fr; }
        }
      </style>
      <section class="hero"><div class="copy"></div><div class="art"></div></section>
      <section class="below"></section><footer>End of page</footer>`;
  });

  const mobile = await captureScreenshot({ url, device: 'mobile', waitForAssets: false });
  assert.deepEqual(await pixelAt(mobile, 350, 150), [222, 96, 32]);
  assert.deepEqual(await pixelAt(mobile, 350, 700), [32, 64, 224]);

  const options = { url, device: 'desktop', dpr: 2, waitForAssets: false };
  await withWebsite(options, {}, async (session) => {
    assert.deepEqual(await session.page.evaluate(() => ({
      width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
      screen: [screen.width, screen.height], mobile: navigator.userAgentData?.mobile,
      touch: navigator.maxTouchPoints,
    })), { width: 1920, height: 1080, dpr: 2, screen: [1920, 1080], mobile: false, touch: 0 });

    const full = await capturePage(session, { ...options, fullPage: true }, undefined, {});
    assert.deepEqual(await pixelAt(full, 3500, 500), [32, 64, 224]);
    assert.deepEqual(await pixelAt(full, 3500, 4600), [224, 32, 160]);

    const samples = [];
    const frames = await capturePageFrames(session, options, (index) => join(folder, `frame-${index}.png`), {
      onProgress(fraction) { samples.push(fraction); },
    });
    assert.deepEqual(frames.map(({ frameIndex, frameCount, width, height }) => [frameIndex, frameCount, width, height]),
      [[1, 3, 3840, 2160], [2, 3, 3840, 2160], [3, 3, 3840, 2160]]);
    assert.deepEqual(await pixelAt(frames[0].path, 500, 500), [222, 96, 32]);
    assert.deepEqual(await pixelAt(frames[0].path, 3500, 500), [32, 64, 224]);
    assert.deepEqual(await pixelAt(frames[1].path, 3500, 500), [32, 176, 96]);
    assert.deepEqual(await pixelAt(frames[2].path, 3500, 2120), [224, 32, 160]);
    assert.ok(samples.every((sample, index) => !index || sample >= samples[index - 1]));
    assert.equal(await session.page.evaluate(() => scrollY), 0);
  });
  assert.equal(hints.at(-1), '?0');
});

test('removes partial frame output and preserves existing files when a frame name collides', { timeout: 30000 }, async (context) => {
  const { url, folder } = await localFixture(context);
  const filename = (index) => join(folder, `frame-${index}.png`);
  await writeFile(filename(2), 'existing');
  await assert.rejects(captureScreenshotFrames({
    url, width: 640, height: 360, waitForAssets: false,
  }, filename), { code: 'EEXIST' });
  assert.deepEqual(await readdir(folder), ['frame-2.png']);
  assert.equal(await readFile(filename(2), 'utf8'), 'existing');
});

async function videoPixel(ffmpeg, videoPath, second) {
  const { stdout } = await promisify(execFile)(ffmpeg, [
    '-v', 'error', '-ss', String(second), '-i', videoPath, '-frames:v', '1',
    '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
  ], { encoding: 'buffer', windowsHide: true });
  assert.equal(stdout.length, 3);
  return stdout;
}

test('encodes actual scrolling as H.264 MP4 with an intro', { timeout: 30000 }, async (context) => {
  const { url, folder } = await localFixture(context);
  const status = await getFfmpegStatus();
  assert.equal(status.available, true, status.error);
  const videoPath = join(folder, 'scroll.mp4');
  const output = await recordVideo({
    url, width: 640, height: 360, mode: 'top-to-bottom', duration: 1.2, finalPause: 0.25,
    outputWidth: 640, outputHeight: 360, title: 'Capture fixture', fadeIn: true,
  }, videoPath);
  assert.equal(output.width, 640);
  assert.equal(output.height, 360);
  const info = (await readFile(videoPath));
  assert.equal(info.toString('ascii', 4, 8), 'ftyp');
  assert.ok(info.includes(Buffer.from('avc1')), 'Expected an H.264 video stream');
  const [topRed, , topBlue] = await videoPixel(status.path, videoPath, 2.05);
  const [bottomRed, , bottomBlue] = await videoPixel(status.path, videoPath, 3.3);
  assert.ok(topRed > topBlue + 90, `Expected the top of the page, got ${topRed}, ${topBlue}`);
  assert.ok(bottomBlue > bottomRed + 90, `Expected the bottom of the page, got ${bottomRed}, ${bottomBlue}`);
});

test('cancels live recording before publishing an export', { timeout: 30000 }, async (context) => {
  const { url, folder } = await localFixture(context);
  const controller = new AbortController();
  const reason = new Error('Cancelled by test');
  await assert.rejects(recordVideo({
    url, width: 640, height: 360, mode: 'static', duration: 5,
    outputWidth: 640, outputHeight: 360,
  }, join(folder, 'cancelled.mp4'), {
    signal: controller.signal,
    onProgress(_, stage) {
      if (stage === 'Recording website') controller.abort(reason);
    },
  }), reason);
  assert.deepEqual(await readdir(folder), []);
});

function routeFixture(color, action = '') {
  return `<!doctype html><meta charset="utf-8"><title>Navigation fixture</title>
  <style>body { background: ${color}; }</style><main>${action}</main>`;
}

async function videoRouteColors(ffmpeg, output) {
  const { stdout } = await promisify(execFile)(ffmpeg, [
    '-v', 'error', '-i', output, '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
  ], { encoding: 'buffer', windowsHide: true });
  const changes = [];
  for (let offset = 0; offset < stdout.length; offset += 3) {
    const pixel = [...stdout.subarray(offset, offset + 3)];
    const highest = Math.max(...pixel);
    if (highest < 145 || highest - Math.min(...pixel) < 65) continue;
    const color = ['red', 'green', 'blue'][pixel.indexOf(highest)];
    if (changes.at(-1) !== color) changes.push(color);
  }
  return changes;
}

test('records real clicks and waits for a delayed button redirect and linked destination', { timeout: 30000 }, async (context) => {
  const visited = [];
  const { url, folder } = await localFixture(context, (request) => {
    if (request.url === '/') {
      visited.push('/');
      return routeFixture('#e03040', `
        <button type="button" onclick="setTimeout(() => location.assign('/features'), 1200)">Explore Features</button>
      `);
    }
    if (request.url === '/features') {
      visited.push('/features');
      return routeFixture('#20b060', '<a href="/case-study">Read the Case Study</a>');
    }
    if (request.url === '/case-study') {
      visited.push('/case-study');
      return routeFixture('#2040e0');
    }
    return '';
  });
  const ffmpeg = await getFfmpegStatus();
  assert.equal(ffmpeg.available, true, ffmpeg.error);
  const output = join(folder, 'tour.mp4');
  const info = await recordVideo({
    url, width: 640, height: 360, outputWidth: 640, outputHeight: 360,
    mode: 'navigation', duration: 1, initialPause: 0.25, finalPause: 0.15, timeout: 5000,
    navigationLabels: 'Explore Features\nRead the Case Study', navigationWait: 0.35,
  }, output);
  assert.deepEqual(visited, ['/', '/features', '/case-study']);
  assert.ok(info.duration > 2, `The video must extend to finish navigation, got ${info.duration} seconds`);
  assert.deepEqual(await videoRouteColors(ffmpeg.path, output), ['red', 'green', 'blue']);
});

test('scrolls each route to the bottom before real Next clicks and ends on the final footer', { timeout: 30000 }, async (context) => {
  const pages = [];
  const { url, folder } = await localFixture(context, (request) => {
    const route = new URL(request.url, 'http://fixture');
    if (route.pathname === '/favicon.ico') return '';
    pages.push({ path: route.pathname, y: route.searchParams.get('y'), max: route.searchParams.get('max') });
    const link = (href) => `<a href="${href}" rel="next" onclick="
      this.search = 'y=' + scrollY + '&amp;max=' + (document.documentElement.scrollHeight - innerHeight)
      ">Next</a>`;
    const next = route.pathname === '/' ? link('/second') :
      route.pathname === '/second' ? link('/final') : '<a href="/" rel="next">Back to start</a>';
    return `<!doctype html><style>
      body { margin: 0; } main { height: 660px; background: #e03040; }
      footer { height: 360px; background: ${route.pathname === '/final' ? '#2040e0' : '#20b060'}; }
      </style><main><nav><a class="cta" href="/unrelated">Explore Features</a></nav></main><footer>${next}</footer>`;
  });
  const ffmpeg = await getFfmpegStatus();
  assert.equal(ffmpeg.available, true, ffmpeg.error);
  const output = join(folder, 'scroll-tour.mp4');
  const result = await recordVideo({
    url, width: 640, height: 360, outputWidth: 640, outputHeight: 360,
    mode: 'scroll-navigation', duration: 180, scrollSpeed: 1600, navigationWait: 0.15, finalPause: 0.15,
    timeout: 5000, waitForAssets: false,
  }, output);
  assert.deepEqual(pages.map((page) => page.path), ['/', '/second', '/final']);
  for (const page of pages.slice(1)) {
    assert.equal(Number(page.max), 660);
    assert.ok(Number(page.y) >= 659, `Expected the link to be clicked at page bottom, saw ${page.y}`);
  }
  assert.ok(result.duration < 10, `The fixed-duration option should be ignored, got ${result.duration} seconds`);
  const [red, , blue] = await videoPixel(ffmpeg.path, output, result.duration - 0.08);
  assert.ok(blue > red + 90, `Expected the final footer captured at video end, got ${red}, ${blue}`);
});

test('finishes a scroll tour when the starting page fits the viewport and has no destination', { timeout: 30000 }, async (context) => {
  const { url, folder } = await localFixture(context, () => routeFixture('#2040e0'));
  const output = join(folder, 'only-page.mp4');
  const result = await recordVideo({
    url, width: 480, height: 300, outputWidth: 480, outputHeight: 300, mode: 'scroll-navigation',
    waitForAssets: false, navigationWait: 0, timeout: 5000,
  }, output);
  assert.ok(result.duration > 0 && result.duration < 2);
  assert.equal((await readFile(output)).toString('ascii', 4, 8), 'ftyp');
});

test('suggests same-site links while skipping destructive routes and form submissions', { timeout: 30000 }, async (context) => {
  const requests = [];
  const { url, folder } = await localFixture(context, (request) => {
    requests.push(`${request.method} ${request.url}`);
    return request.url === '/' ? routeFixture('#e03040', `
      <a class="cta" href="/delete">Delete</a>
      <a href="/features">Explore Features</a>
      <form method="post" action="/confirm"><button>Continue</button></form>
    `) : routeFixture('#20b060');
  });
  const options = {
    url, width: 480, height: 300, outputWidth: 480, outputHeight: 300,
    mode: 'navigation', duration: 1, navigationWait: 0.25, timeout: 4000,
  };
  await recordVideo(options, join(folder, 'suggested.mp4'));
  await assert.rejects(recordVideo({ ...options, navigationLabels: ['Continue'] }, join(folder, 'blocked.mp4')),
    /same-site link or a non-form button/);
  assert.ok(requests.includes('GET /features'));
  assert.ok(!requests.includes('GET /delete'));
  assert.ok(!requests.includes('POST /confirm'));
  assert.deepEqual(await readdir(folder), ['suggested.mp4']);
});

test('blocks an off-site redirect during automatic navigation', { timeout: 30000 }, async (context) => {
  let externalRequests = 0;
  const external = await localFixture(context, () => {
    externalRequests++;
    return routeFixture('#2040e0');
  });
  const { url, folder } = await localFixture(context, (request, response) => {
    if (request.url === '/continue') {
      response.writeHead(302, { Location: external.url });
      return '';
    }
    return routeFixture('#e03040', '<a href="/continue">Continue Reading</a>');
  });
  await assert.rejects(recordVideo({
    url, width: 480, height: 300, outputWidth: 480, outputHeight: 300,
    mode: 'navigation', duration: 1, navigationLabels: 'Continue Reading', timeout: 3000,
  }, join(folder, 'blocked.mp4')), /blocked|outside|new route/i);
  assert.equal(externalRequests, 0);
  assert.deepEqual(await readdir(folder), []);
});
