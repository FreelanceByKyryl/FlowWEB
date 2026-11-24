'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, readFile, readdir, rm } = require('node:fs/promises');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const sharp = require('sharp');
const { captureSite } = require('../src/services/site');

async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function outputDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'showcase-site-capture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function html(response, title, content, status = 200) {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><title>${title}</title><style>body{margin:0}</style>${content}`);
}

test('captures reachable pages breadth first and waits for delayed lazy images', { timeout: 30000 }, async (t) => {
  let externalRequests = 0;
  const external = await serve(t, (_, response) => {
    externalRequests += 1;
    html(response, 'External', 'This origin must not be visited');
  });
  const requested = [];
  const origin = await serve(t, (request, response) => {
    requested.push(request.url);
    if (request.url === '/start') return response.writeHead(302, { Location: '/' }).end();
    if (request.url === '/alias') return response.writeHead(301, { Location: '/about' }).end();
    if (request.url === '/offsite') return response.writeHead(302, { Location: '/redirect-again' }).end();
    if (request.url === '/redirect-again') return response.writeHead(302, { Location: external }).end();
    if (request.url === '/data.json') return response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    if (request.url === '/missing') return html(response, 'Missing', '404', 404);
    if (request.url === '/explicit') return html(response, 'Explicit', '<a href="/about#another">Deduplicated</a>');
    if (request.url === '/about') return html(response, 'About', '<a href="/deep">Deep</a><a href="/">Home</a>');
    if (request.url === '/lazy.svg') {
      return setTimeout(() => response.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><path fill="#22aa44" d="M0 0h64v64H0z"/></svg>'
      ), 350);
    }
    html(response, 'Home', `
      <div style="height:800px">
        <a href="/about">About</a><a href="/about#section">About again</a>
        <a href="/alias">Alias</a><a href="/missing">Missing</a>
        <a href="/offsite">Redirect</a><a href="/data.json">Data</a>
        <a href="${external}">External</a><a href="/download" download>Download</a>
        <form action="/submission"><button>Submit</button></form>
      </div>
      <img id="late" width="64" height="64" style="display:block">
      <script>
        const image = document.querySelector('#late');
        const observer = new IntersectionObserver(entries => {
          if (entries.some(entry => entry.isIntersecting)) {
            observer.disconnect();
            setTimeout(() => { image.src = '/lazy.svg'; }, 350);
          }
        });
        observer.observe(image);
      </script>`);
  });
  const directory = await outputDirectory(t);
  const notified = [];
  const progress = [];
  const result = await captureSite({
    url: origin + '/start', paths: ['/explicit', external + '/explicit'], maxPages: 12, maxDepth: 1,
    width: 400, height: 300, fullPage: true, lazy: true,
  }, directory, {
    onPage: async (item) => {
      assert.ok((await readFile(item.path)).length > 0);
      notified.push(item.url);
    },
    onProgress: (value) => progress.push(value),
  });
  assert.deepEqual(result.pages.map(({ url, title }) => [new URL(url).pathname, title]), [
    ['/', 'Home'], ['/explicit', 'Explicit'], ['/about', 'About'],
  ]);
  assert.deepEqual(notified, result.pages.map(({ url }) => url));
  assert.deepEqual((await readdir(directory)).sort(), result.pages.map(({ filename }) => filename).sort());
  assert.deepEqual(result.failed, [{ url: origin + '/missing', error: 'The website returned HTTP 404.' }]);
  assert.deepEqual(result.skipped.map(({ url }) => url), [external + '/explicit', origin + '/alias', origin + '/offsite', origin + '/data.json']);
  assert.equal(result.limited, 1);
  assert.equal(externalRequests, 0);
  assert.equal(requested.filter((url) => url === '/about').length, 2); // One direct visit and one redirected request.
  assert.ok(requested.includes('/lazy.svg'));
  for (const path of ['/deep', '/download', '/submission']) assert.ok(!requested.includes(path), path);
  assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]));
  assert.equal(progress.at(-1), 1);
  const pixel = await sharp(result.pages[0].path).extract({ left: 32, top: 832, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  assert.deepEqual(Array.from(pixel), [34, 170, 68]);
});

test('limits site visits and cancels before requesting remaining pages', { timeout: 30000 }, async (t) => {
  const requested = [];
  const origin = await serve(t, (request, response) => {
    requested.push(request.url);
    html(response, 'Pages', '<a href="/one">One</a><a href="/two">Two</a>');
  });
  const options = { url: origin, maxPages: 2, width: 200, height: 160, waitForAssets: false };
  const result = await captureSite(options, await outputDirectory(t));
  assert.deepEqual(result.pages.map(({ url }) => new URL(url).pathname), ['/', '/one']);
  assert.equal(result.limited, 1);
  assert.ok(!requested.includes('/two'));

  requested.length = 0;
  const controller = new AbortController();
  const directory = await outputDirectory(t);
  const reason = new Error('Site capture cancelled');
  await assert.rejects(captureSite(options, directory, {
    signal: controller.signal,
    onPage: () => controller.abort(reason),
  }), reason);
  assert.equal((await readdir(directory)).length, 1);
  assert.ok(!requested.includes('/one'));
});

test('captures an explicit script-routed page at link depth zero', { timeout: 30000 }, async (t) => {
  const origin = await serve(t, (_, response) => {
    html(response, 'Overview', `<a href="/extra">Extra page</a><script>
      addEventListener('hashchange', () => {
        if (location.hash === '#/reports') document.title = 'Reports';
      });
    </script>`);
  });
  const result = await captureSite({
    url: origin, paths: ['#/reports'], maxDepth: 0, width: 200, height: 160,
  }, await outputDirectory(t));
  assert.deepEqual(result.pages.map(({ title }) => title), ['Overview', 'Reports']);
  assert.deepEqual(result.pages.map(({ url }) => new URL(url).hash), ['', '#/reports']);
  assert.equal(result.limited, 1);
});
