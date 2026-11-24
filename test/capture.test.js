const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { mkdtemp, readFile, readdir, rm } = require('node:fs/promises');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { promisify } = require('node:util');
const { test } = require('node:test');
const sharp = require('sharp');
const { normalizeUrl } = require('../src/services/browser');
const { captureScreenshot } = require('../src/services/screenshot');
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

async function localFixture(context) {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(fixture);
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
