const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createServer } = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const sharp = require('sharp');
const { projectDirectory } = require('../src/services/exports');
const { ExportQueue } = require('../src/services/queue');
const { Storage } = require('../src/services/storage');
const { Studio } = require('../src/services/studio');

test('batch exports real project screenshots, mockups and portfolio metadata', { timeout: 60000 }, async t => {
  const requests = new Set();
  const server = createServer((request, response) => {
    requests.add(request.url);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body{margin:0;height:100vh;background:#26a269}</style></head><body><h1>Local fixture</h1></body></html>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => server.close(resolve)));

  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'showcase-test-batch-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const defaultExportDirectory = path.join(directory, 'Exports');
  const temp = path.join(directory, 'Temp');
  await fs.mkdir(temp);
  const storageOptions = { directory: path.join(directory, 'Data'), defaultExportDirectory };
  const store = await Storage.open(storageOptions);
  const first = await store.saveProject({ name: 'Studio One', url: `${baseUrl}/studio`, technologies: ['CSS'] });
  const second = await store.saveProject({ name: 'Portfolio Two', url: `${baseUrl}/portfolio`, features: ['Image gallery'] });
  const studio = new Studio(store, temp, () => {});
  const queue = new ExportQueue((item, task) => studio.batch(item, task));
  queue.start([
    { projectId: first.id, options: { operations: ['desktop', 'mockup'], format: 'png' } },
    { projectId: second.id, options: { operations: ['mobile', 'portfolio'], format: 'png' } },
  ]);

  const done = await queue.waitForIdle();
  assert.equal(done.status, 'completed', done.jobs.map(job => job.error).filter(Boolean).join('\n'));
  assert.equal(done.overallProgress, 100);
  assert.ok(requests.has('/studio') && requests.has('/portfolio'));
  const firstFolder = projectDirectory(defaultExportDirectory, first);
  const secondFolder = projectDirectory(defaultExportDirectory, second);
  const desktop = path.join(firstFolder, 'Screenshots', 'desktop.png');
  const mobile = path.join(secondFolder, 'Screenshots', 'mobile.png');
  const mockup = path.join(firstFolder, 'Mockups', 'showcase.png');
  const screenshotMetadata = await sharp(desktop).metadata();
  assert.equal(screenshotMetadata.width, 1920);
  const pixel = await sharp(desktop).extract({ left: 500, top: 500, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  assert.deepEqual([...pixel], [38, 162, 105]);
  assert.equal((await sharp(mobile).metadata()).width, 390);
  assert.equal((await sharp(mockup).metadata()).format, 'png');
  const description = await fs.readFile(path.join(secondFolder, 'Portfolio', 'description.txt'), 'utf8');
  assert.match(description, /Image gallery/);
  const info = JSON.parse(await fs.readFile(path.join(secondFolder, 'Portfolio', 'project-info.json'), 'utf8'));
  assert.equal(info.url, second.url);

  const reloaded = await Storage.open(storageOptions);
  assert.equal(reloaded.snapshot().exports.length, 5);
  assert.deepEqual(await fs.readdir(temp), []);
});
