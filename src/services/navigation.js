const { setTimeout: sleep } = require('node:timers/promises');
const { waitForAssets } = require('./browser');

const autoStepLimit = 6;
const explicitStepLimit = 12;
const destructiveWords = /(?:^|[^\p{L}\p{N}])(?:delete|remove|destroy|logout|log[ -]+out|sign[ -]+out|unsubscribe|checkout|purchase|buy|pay|submit|reset|confirm|send|subscribe|изтрий|изтриване|купи|плати|изпрати|потвърди|изход)(?:$|[^\p{L}\p{N}])/iu;
const callToActionWords = /\b(?:explore|learn more|see how|view|discover|get started|features|demo|work)\b|разгледай|научи повече|започни/iu;
const automaticLinks = 'nav a[href], header a[href], main a[href], [role="navigation"] a[href], [role="main"] a[href]';

function navigationLabels(value) {
  if (value === undefined || value === null) return [];
  if (typeof value !== 'string' && !Array.isArray(value)) {
    throw new Error('Enter the accessible names of navigation links or buttons, one per line.');
  }

  const lines = typeof value === 'string' ? value.split(/\r\n|\n|\r/) : value;
  if (lines.some((line) => typeof line !== 'string' || line.length > 160)) {
    throw new Error('Each navigation label must have at most 160 characters.');
  }
  const labels = lines.map((line) => line.trim().replace(/\s+/gu, ' ')).filter(Boolean);
  if (labels.length > explicitStepLimit) {
    throw new Error(`Enter at most ${explicitStepLimit} navigation labels.`);
  }
  return labels;
}

function readControl(element) {
  const anchor = element.closest('a');
  const button = element.closest('button, input, [role="button"], [role="link"]');
  const control = anchor || button;
  if (!control) return null;
  const type = control instanceof HTMLButtonElement || control instanceof HTMLInputElement ? control.type : '';
  return {
    label: (control.getAttribute('aria-label') || control.textContent || control.value || '').trim().replace(/\s+/gu, ' ').slice(0, 160),
    link: Boolean(anchor),
    href: anchor?.href || '',
    target: anchor?.getAttribute('target') || '',
    downloads: anchor?.hasAttribute('download') || false,
    submits: Boolean(button?.closest('form') || (button?.form && ['submit', 'reset', 'image'].includes(type))),
    enabled: !control.matches(':disabled, [aria-disabled="true"]'),
    prominent: control.matches('[role="button"], [class*="btn" i], [class*="button" i], [class*="cta" i]'),
  };
}

function permittedControl(control, origin, label = control?.label || '') {
  if (!control?.enabled || control.downloads || control.submits ||
      destructiveWords.test(label) || destructiveWords.test(control.label)) return false;
  if (!control.link) return true;

  try {
    const url = new URL(control.href);
    const decoded = decodeURIComponent(url.pathname + url.search);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === origin && !url.username && !url.password &&
      (!control.target || control.target.toLowerCase() === '_self') && !destructiveWords.test(decoded);
  } catch {
    return false;
  }
}

async function labeledControl(page, label, origin, timeout) {
  const matches = page.getByRole('link', { name: label, exact: true })
    .or(page.getByRole('button', { name: label, exact: true }))
    .filter({ visible: true });
  try {
    await matches.first().waitFor({ state: 'visible', timeout });
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
    throw new Error(`Navigation could not find a visible link or button named “${label}”. Use the exact visible label on the current page.`);
  }
  if (await matches.count() > 1) {
    throw new Error(`More than one visible link or button is named “${label}”. Use a unique navigation label or record manually.`);
  }
  const handle = await matches.elementHandle({ timeout });
  try {
    const control = await handle.evaluate(readControl);
    if (!permittedControl(control, origin, label)) {
      throw new Error(`“${label}” cannot be used for automatic navigation. Choose a same-site link or a non-form button.`);
    }
    return { handle, control, label };
  } catch (error) {
    await handle.dispose().catch(() => {});
    throw error;
  }
}

function isRoute(href, current) {
  const destination = new URL(href);
  return destination.pathname !== current.pathname || destination.search !== current.search ||
    (/^#!?\//.test(destination.hash) && destination.hash !== current.hash);
}

async function suggestedControl(page, origin, visited, timeout) {
  const current = new URL(page.url());
  const candidates = page.locator(automaticLinks).filter({ visible: true });
  const count = Math.min(await candidates.count(), 100);
  let best;
  try {
    for (let index = 0; index < count; index++) {
      const handle = await candidates.nth(index).elementHandle({ timeout: Math.min(timeout, 1000) }).catch(() => null);
      if (!handle) continue;
      const control = await handle.evaluate(readControl).catch(() => null);
      if (!permittedControl(control, origin) || !isRoute(control.href, current) || visited.has(control.href)) {
        await handle.dispose().catch(() => {});
        continue;
      }
      const rank = Number(control.prominent) * 2 + Number(callToActionWords.test(control.label));
      if (best && rank <= best.rank) {
        await handle.dispose().catch(() => {});
        continue;
      }
      await best?.handle.dispose().catch(() => {});
      best = { handle, control, rank, label: control.label || new URL(control.href).pathname };
      if (rank === 3) break;
    }
    return best;
  } catch (error) {
    await best?.handle.dispose().catch(() => {});
    throw error;
  }
}

async function installRequestGuard(cdp, origin) {
  const { frameTree } = await cdp.send('Page.getFrameTree');
  cdp.on('Fetch.requestPaused', ({ request, requestId, frameId, resourceType }) => {
    const topDocument = frameId === frameTree.frame.id && resourceType === 'Document';
    const outsideSite = topDocument && new URL(request.url).origin !== origin;
    const readOnly = ['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    const result = outsideSite || !readOnly
      ? cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
      : cdp.send('Fetch.continueRequest', { requestId });
    void result.catch(() => {});
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
}

async function clickStep(page, step, origin, timeout, signal) {
  const startUrl = page.url();
  const change = page.waitForURL((url) => url.href !== startUrl, {
    waitUntil: 'domcontentloaded', timeout,
  }).then(() => true, (error) => {
    if (error.name === 'TimeoutError') return false;
    throw error;
  });
  try {
    const [changed] = await Promise.all([change, step.handle.click({ timeout })]);
    signal.throwIfAborted();
    if (new URL(page.url()).origin !== origin) {
      throw new Error(`“${step.label}” led outside the starting website.`);
    }
    if (!changed) {
      throw new Error(`“${step.label}” did not load a new route within the browser timeout. Use Manual recording for controls that keep the same URL.`);
    }
    await page.waitForLoadState('domcontentloaded', { timeout });
  } finally {
    await step.handle.dispose().catch(() => {});
  }
}

async function runNavigationTour(session, cdp, settings, options, signal, stage) {
  const { page, timeout } = session;
  const origin = new URL(page.url()).origin;
  const visited = new Set([page.url()]);
  await installRequestGuard(cdp, origin);
  await sleep(settings.initialPause * 1000, undefined, { signal });

  const labels = settings.navigationLabels;
  const steps = labels.length || autoStepLimit;
  let failedStatus = null;
  let openedPopup = false;
  const closePopup = (popup) => {
    openedPopup = true;
    void popup.close().catch(() => {});
  };
  const detectFailedRoute = (response) => {
    if (response.status() >= 400 && response.request().isNavigationRequest()) {
      const request = response.request();
      try {
        if (request.frame() === page.mainFrame()) failedStatus = response.status();
      } catch { /* An early response from a popup can precede frame creation. */ }
    }
  };
  page.on('popup', closePopup);
  page.on('response', detectFailedRoute);
  try {
    for (let index = 0; index < steps; index++) {
      signal.throwIfAborted();
      const step = labels.length
        ? await labeledControl(page, labels[index], origin, timeout)
        : await suggestedControl(page, origin, visited, timeout);
      if (!step) {
        if (index) break;
        throw new Error('No visible same-site navigation links were found. Enter exact button labels or use Manual recording.');
      }
      failedStatus = null;
      stage(`Clicking ${step.label}`);
      await clickStep(page, step, origin, timeout, signal);
      if (step.control.link) visited.add(step.control.href);
      visited.add(page.url());
      stage(`Recording ${step.label}`);
      if (options.waitForAssets !== false) await waitForAssets(page, timeout, signal);
      await sleep(settings.navigationWait * 1000, undefined, { signal });
      if (openedPopup) {
        throw new Error(`“${step.label}” opened a separate window. Use Manual recording for this interaction.`);
      }
      if (failedStatus !== null) {
        throw new Error(`“${step.label}” returned HTTP ${failedStatus}.`);
      }
      if (new URL(page.url()).origin !== origin) {
        throw new Error(`“${step.label}” led outside the starting website.`);
      }
    }
  } finally {
    page.off('popup', closePopup);
    page.off('response', detectFailedRoute);
  }
}

module.exports = { navigationLabels, runNavigationTour };
