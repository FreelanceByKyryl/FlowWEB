const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Storage } = require('../src/services/storage');
const { copyExport, existingExportPath, projectDirectory, writeExport } = require('../src/services/exports');
const { ExportQueue } = require('../src/services/queue');

async function workspace(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'showcase-test-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('project metadata, export history and settings survive reopening', async t => {
  const directory = await workspace(t);
  const defaults = { directory, defaultExportDirectory: path.join(directory, 'Showcase Exports') };
  let store = await Storage.open(defaults);
  await assert.rejects(store.saveProject({ name: 'Unsafe', url: 'file:///test' }), /HTTP or HTTPS/);
  await assert.rejects(store.saveProject({ name: 'Unsafe', url: 'https://user:password@example.com' }), /without embedded credentials/);

  const [site, other] = await Promise.all([
    store.saveProject({ name: 'Studio', url: 'localhost:4321', technologies: 'Node.js, CSS', features: ['Responsive navigation'] }),
    store.saveProject({ name: 'Portfolio', url: 'https://example.com' }),
    store.updateSettings({ maxConcurrentJobs: 2, theme: 'light' }),
  ]);
  const thumbnail = 'data:image/png;base64,iVBORw0KGgo=';
  await store.setThumbnail(site.id, thumbnail, site.url);
  const updated = await store.saveProject({ id: site.id, name: 'Studio Website' });
  assert.equal(updated.exportFolder, site.exportFolder);
  assert.equal(updated.thumbnail, thumbnail);
  const copy = await store.duplicateProject(site.id);
  assert.notEqual(copy.id, site.id);
  assert.notEqual(copy.exportFolder, site.exportFolder);
  assert.equal(copy.thumbnail, thumbnail);

  const saved = await store.addExport({
    projectId: site.id,
    projectName: updated.name,
    kind: 'screenshot',
    path: path.join(directory, 'desktop.png'),
  });
  await store.deleteProject(other.id);
  await store.saveProject({ id: site.id, url: 'https://example.com/changed' });
  assert.equal(await store.setThumbnail(site.id, thumbnail, site.url), null);

  store = await Storage.open(defaults);
  const state = store.snapshot();
  assert.equal(state.settings.theme, 'light');
  assert.equal(state.settings.maxConcurrentJobs, 2);
  assert.equal(state.projects.length, 2);
  assert.equal(store.getProject(site.id).thumbnail, undefined);
  assert.deepEqual(store.getProject(site.id).technologies, ['Node.js', 'CSS']);
  assert.deepEqual(store.getProject(site.id).features, ['Responsive navigation']);
  assert.equal(store.getProject(copy.id).url, 'http://localhost:4321/');
  assert.deepEqual(state.exports, [saved]);
});

test('concurrent exports use exclusive filenames in organized project folders', async t => {
  const directory = await workspace(t);
  const project = { name: 'Website', id: 'a1' };
  const [first, second] = await Promise.all([
    writeExport(directory, project, 'screenshot', 'desktop.png', Buffer.from('first image')),
    writeExport(directory, project, 'screenshot', 'desktop.png', Buffer.from('second image')),
  ]);
  assert.notEqual(first, second);
  assert.deepEqual(new Set([path.basename(first), path.basename(second)]), new Set(['desktop.png', 'desktop-2.png']));
  assert.equal(path.dirname(first), path.join(projectDirectory(directory, project), 'Screenshots'));
  assert.equal(await fs.readFile(first, 'utf8'), 'first image');
  assert.equal(await fs.readFile(second, 'utf8'), 'second image');

  const copied = await copyExport(directory, project, 'mockup', 'showcase.png', first);
  assert.equal(await existingExportPath(copied), copied);
  assert.equal(await fs.readFile(copied, 'utf8'), 'first image');

  const commonName = '🌟'.repeat(100);
  const firstFolder = projectDirectory(directory, { name: commonName, id: 'c1' });
  const nextFolder = projectDirectory(directory, { name: commonName, id: 'c2' });
  assert.notEqual(firstFolder, nextFolder);
});

test('export paths sanitize file components and reject linked subfolders', async t => {
  const directory = await workspace(t);
  const root = path.join(directory, 'Exports');
  const outside = path.join(directory, 'Outside');
  const project = { name: '../../Project', id: 'b1' };
  await fs.mkdir(outside);

  const file = await writeExport(root, project, 'portfolio', '../../description.txt', Buffer.from('safe content'));
  assert.equal(path.dirname(file), path.join(projectDirectory(root, project), 'Portfolio'));
  assert.equal(path.extname(file), '.txt');
  assert.equal(await fs.readFile(file, 'utf8'), 'safe content');

  const target = path.join(projectDirectory(root, project), 'Videos');
  await fs.symlink(outside, target, 'junction');
  await assert.rejects(writeExport(root, project, 'video', 'escape.mp4', Buffer.from('escape')), /link or an unexpected file/);
  await assert.rejects(existingExportPath(target), /link or an unexpected file/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('the export queue runs sequentially by default and can retry a failed item', async () => {
  const events = [];
  let secondAttempt = false;
  let active = 0;
  let peak = 0;
  const queue = new ExportQueue(async (item, { report }) => {
    active++;
    peak = Math.max(peak, active);
    try {
      report('Capturing screenshot', 50);
      await new Promise(resolve => setImmediate(resolve));
      if (item.id === 'retry' && !secondAttempt) {
        secondAttempt = true;
        throw new Error('Website unavailable');
      }
      return { projectId: item.id };
    } finally {
      active--;
    }
  }, { onUpdate: state => events.push(state) });

  queue.start([{ id: 'retry' }, { id: 'next' }]);
  const failed = await queue.waitForIdle();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.jobs[0].error, 'Website unavailable');
  assert.equal(failed.jobs[1].status, 'completed');
  assert.equal(peak, 1);
  assert.ok(events.some(state => state.jobs[0].stage === 'Capturing screenshot' && state.overallProgress === 25));

  queue.retry('retry');
  const completed = await queue.waitForIdle();
  assert.equal(completed.status, 'completed');
  assert.equal(completed.overallProgress, 100);
  assert.deepEqual(completed.jobs[0].result, { projectId: 'retry' });
});

test('skipping an active item and cancelling a batch abort in-progress work', { timeout: 5000 }, async () => {
  const started = [];
  const aborted = [];
  const queue = new ExportQueue(async (item, { signal }) => {
    started.push(item.id);
    await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted.push(item.id);
        reject(signal.reason);
      }, { once: true });
    });
  });
  queue.start([{ id: 'skip' }, { id: 'cancel' }, { id: 'pending' }]);
  await new Promise(resolve => setImmediate(resolve));
  queue.skip('skip');
  await new Promise(resolve => setImmediate(resolve));
  queue.cancel();
  const cancelled = await queue.waitForIdle();
  assert.deepEqual(started, ['skip', 'cancel']);
  assert.deepEqual(aborted, ['skip', 'cancel']);
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.jobs.map(job => job.status), ['skipped', 'cancelled', 'cancelled']);
});
