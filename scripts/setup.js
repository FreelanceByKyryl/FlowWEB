const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { getBrowserStatus } = require('../src/services/browser');
const { getFfmpegStatus } = require('../src/services/video');

async function setup() {
  const before = getBrowserStatus();
  if (before.source === 'playwright' && !before.available) {
    const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
    const result = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) {
      console.error('Playwright Chromium installation failed. On a restricted network, allow the Playwright download host shown above or set SHOWCASE_CHROMIUM_PATH to an installed Chromium executable.');
    }
  }

  const browser = getBrowserStatus();
  if (browser.available) {
    console.log(`Chromium (${browser.source}): ${browser.path}`);
  } else {
    console.error(`Chromium could not be found: ${browser.path}`);
    process.exitCode = 1;
  }

  const ffmpeg = await getFfmpegStatus();
  if (ffmpeg.available) {
    console.log(ffmpeg.version);
  } else {
    console.error(ffmpeg.error);
    if (process.platform === 'win32') console.error('PowerShell: winget install --id Gyan.FFmpeg --exact');
    process.exitCode = 1;
  }
}

setup().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
