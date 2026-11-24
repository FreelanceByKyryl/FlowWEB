'use strict';

const { createHash } = require('node:crypto');
const { rm } = require('node:fs/promises');
const { join } = require('node:path');
const { evaluateWithDeadline, normalizeUrl, numberOption, preparePage, progress, withWebsite } = require('./browser');
const { capturePage, screenshotFormat } = require('./screenshot');

const MAX_DISCOVERED_ROUTES = 5000;

function routeUrl(value, base, keepFragment = false) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) return null;
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (!keepFragment && !/^#!?\//.test(url.hash)) url.hash = '';
    return url.href.length <= 4096 ? url : null;
  } catch {
    return null;
  }
}

function canonicalSeedRedirect(seed, destination) {
  return seed.hostname.replace(/^www\./, '') === destination.hostname.replace(/^www\./, '')
    && seed.port === destination.port
    && (seed.protocol === destination.protocol || (seed.protocol === 'http:' && destination.protocol === 'https:'));
}

async function restrictNavigation({ context, page }, seed) {
  const session = await context.newCDPSession(page);
  const { frameTree } = await session.send('Page.getFrameTree');
  let origin = null;
  let blocked;
  context.on('page', (popup) => { void popup.close().catch(() => {}); });
  session.on('Fetch.requestPaused', (event) => {
    const { requestId, frameId, request, responseStatusCode, responseHeaders } = event;
    const params = { requestId };
    let command = 'Fetch.continueRequest';
    if (frameId === frameTree.frame.id) {
      const target = routeUrl(request.url);
      if (!target || (origin ? origin !== target.origin : !canonicalSeedRedirect(seed, target))) {
        blocked = 'The page redirected outside the website origin.';
      } else if (request.method !== 'GET') {
        blocked = 'The navigation requested a form submission.';
      } else if (responseStatusCode >= 200 && responseStatusCode < 300) {
        const header = (name) => responseHeaders?.find((item) => item.name.toLowerCase() === name)?.value;
        const mime = header('content-type')?.split(';')[0].trim().toLowerCase();
        if ((mime && !['text/html', 'application/xhtml+xml'].includes(mime))
          || /^attachment\b/i.test(header('content-disposition') || '') || responseStatusCode === 204) {
          blocked = 'The URL does not return a web page.';
        }
      }
      if (blocked) {
        command = 'Fetch.failRequest';
        params.errorReason = 'Aborted';
      }
    }
    void session.send(command, params).catch(() => {});
  });
  // Request interception applies to each hop, including redirects and script-driven navigation.
  await session.send('Fetch.enable', { patterns: [
    { resourceType: 'Document', requestStage: 'Request' },
    { resourceType: 'Document', requestStage: 'Response' },
  ] });
  return {
    lockOrigin(value) { origin = value; },
    reset() { blocked = undefined; },
    get blocked() { return blocked; },
  };
}

function screenshotName(url, format) {
  const label = `${url.pathname}${url.hash}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const suffix = createHash('sha256').update(url.href).digest('hex').slice(0, 16);
  return `${label.slice(0, 80) || 'home'}-${suffix}.${format === 'jpeg' ? 'jpg' : 'png'}`;
}

async function pageDetails(page, timeout) {
  return evaluateWithDeadline(page, (maxRoutes) => {
    const links = new Set();
    for (const link of document.querySelectorAll('a[href]:not([download]), area[href]:not([download])')) {
      try {
        const url = new URL(link.getAttribute('href'), document.baseURI);
        if (url.origin !== location.origin || url.username || url.password || url.href.length > 4096) continue;
        if (!/^#!?\//.test(url.hash)) url.hash = '';
        links.add(url.href);
        if (links.size >= maxRoutes) break;
      } catch { /* Invalid href. */ }
    }
    return { title: document.title.trim().slice(0, 180), links: Array.from(links) };
  }, MAX_DISCOVERED_ROUTES, timeout, 'The webpage stopped responding while finding links.');
}

function navigationError(error) {
  if (error.name === 'TimeoutError') return 'The webpage took too long to load.';
  const networkError = error.message.match(/net::ERR_[A-Z_]+/i);
  return networkError ? `Chromium could not load the webpage (${networkError[0]}).` : error.message;
}

async function captureSite(options, directory, task = {}) {
  const seed = routeUrl(normalizeUrl(options.url), undefined, true);
  if (!seed) throw new Error('Enter a website URL of up to 4096 characters.');
  const maxPages = numberOption(options.maxPages, 20, 'Maximum pages', 1, 100, true);
  const maxDepth = numberOption(options.maxDepth, 3, 'Link depth', 0, 10, true);
  const paths = options.paths ?? [];
  const format = screenshotFormat(options);
  if (!Array.isArray(paths) || paths.length > 100 || paths.some((path) => !routeUrl(path, seed, true))) {
    throw new Error('Enter up to 100 valid HTTP or HTTPS page paths.');
  }

  return withWebsite(options, task, async (session) => {
    const { page, timeout } = session;
    const guard = await restrictNavigation(session, seed);
    const routes = [{ url: seed, depth: 0 }];
    const seen = new Set([seed.href]);
    const beyondDepth = new Set();
    const captured = new Set();
    const pages = [];
    const skipped = [];
    const failed = [];

    function enqueue(url, depth) {
      if (seen.has(url.href)) return;
      if (depth > maxDepth || seen.size >= MAX_DISCOVERED_ROUTES) {
        if (beyondDepth.size < MAX_DISCOVERED_ROUTES) beyondDepth.add(url.href);
        return;
      }
      beyondDepth.delete(url.href);
      seen.add(url.href);
      routes.push({ url, depth });
    }

    let canonical = seed;
    let attempted = 0;
    let index = 0;
    for (; index < routes.length && attempted < maxPages; index += 1) {
      task.signal?.throwIfAborted();
      const { url, depth } = routes[index];
      if (captured.has(url.href)) {
        skipped.push({ url: url.href, reason: 'This page was already captured.' });
        continue;
      }
      const attempt = attempted++;
      const pageTask = {
        signal: task.signal,
        onProgress: (fraction, stage) => progress(task, 0.05 + (0.9 * (attempt + fraction) / maxPages),
          `Page ${attempt + 1} · ${stage} · ${(url.pathname + url.search + url.hash).slice(0, 160)}`),
      };

      let result;
      let links = [];
      let outputPath;
      let capturedFile = false;
      guard.reset();
      try {
        progress(pageTask, 0.01, 'Loading website');
        const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout });
        if (response?.status() >= 400) throw new Error(`The website returned HTTP ${response.status()}.`);
        await preparePage(page, options, pageTask, timeout);
        const finalUrl = routeUrl(page.url(), undefined, Boolean(url.hash));
        if (index === 0 && finalUrl && canonicalSeedRedirect(seed, finalUrl)) canonical = finalUrl;
        if (guard.blocked || !finalUrl || finalUrl.origin !== canonical.origin) {
          skipped.push({ url: url.href, reason: guard.blocked || 'The page redirected outside the website origin.' });
        } else if (captured.has(finalUrl.href)) {
          skipped.push({ url: url.href, reason: 'The URL redirected to a page already captured.' });
        } else {
          const details = await pageDetails(page, timeout);
          links = details.links;
          const filename = screenshotName(finalUrl, format);
          outputPath = join(directory, filename);
          await capturePage(session, options, outputPath, pageTask);
          capturedFile = true;
          if (guard.blocked) throw new Error(guard.blocked);
          if (routeUrl(page.url(), undefined, Boolean(url.hash))?.href !== finalUrl.href) {
            throw new Error('The webpage changed address during capture. Try a longer loading delay.');
          }
          result = { url: finalUrl.href, title: details.title, filename, path: outputPath };
        }
      } catch (error) {
        task.signal?.throwIfAborted();
        if (capturedFile) await rm(outputPath, { force: true });
        if (guard.blocked) skipped.push({ url: url.href, reason: guard.blocked });
        else failed.push({ url: url.href, error: navigationError(error) });
      }

      if (index === 0) {
        guard.lockOrigin(canonical.origin);
        for (const value of paths) {
          let explicit = routeUrl(value, canonical, true);
          if (!explicit) {
            skipped.push({ url: value, reason: 'The path is too long when resolved against the website URL.' });
            continue;
          }
          if (explicit.origin === seed.origin && explicit.origin !== canonical.origin) {
            explicit.protocol = canonical.protocol;
            explicit.hostname = canonical.hostname;
            explicit.port = canonical.port;
          }
          if (explicit.origin === canonical.origin) enqueue(explicit, 0);
          else skipped.push({ url: explicit.href, reason: 'The path belongs to a different website origin.' });
        }
      }
      if (result) {
        captured.add(result.url);
        pages.push(result);
        await task.onPage?.(result);
      }
      for (const link of links) enqueue(new URL(link), depth + 1);
    }

    const pending = routes.slice(index).map(({ url }) => url.href).concat(Array.from(beyondDepth));
    const limited = pending.filter((url) => !captured.has(url)).length;
    progress(task, 1, 'Site capture complete');
    return { pages, skipped, failed, limited };
  }, false, { deferNavigation: true, serviceWorkers: 'block' });
}

module.exports = { captureSite };
