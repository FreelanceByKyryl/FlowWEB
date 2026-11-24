(() => {
  'use strict';

  const api = window.showcase;
  const view = document.querySelector('#view');
  const dialog = document.querySelector('#dialog');
  const toasts = document.querySelector('#toasts');
  const navigation = [...document.querySelectorAll('button[data-view]')];
  const pages = {
    dashboard: 'Dashboard', projects: 'Projects', screenshots: 'Screenshot Studio',
    mockups: 'Mockup Studio', videos: 'Video Studio', batch: 'Batch Export',
    history: 'Export History', settings: 'Settings',
  };
  const operations = {
    desktop: 'Desktop screenshot', laptop: 'Laptop screenshot', tablet: 'Tablet screenshot',
    mobile: 'Mobile screenshot', fullpage: 'Full-page screenshot', mockup: 'Device mockup',
    video: 'Scrolling video', portfolio: 'Portfolio description',
  };
  const exportTypes = {
    screenshot: ['camera', 'Screenshot'], mockup: ['layers-3', 'Mockup'],
    video: ['film', 'Video'], portfolio: ['file-text', 'Portfolio'],
  };
  const categories = ['Business', 'E-commerce', 'Landing page', 'Portfolio', 'Web app', 'Other'];
  const defaults = {
    exportDirectory: '', screenshotWidth: 1920, screenshotHeight: 1080, imageQuality: 90,
    videoWidth: 1920, videoHeight: 1080, videoQuality: 23, theme: 'dark',
    browserTimeout: 30000, maxConcurrentJobs: 1, autosave: true,
  };
  const state = {
    page: 'dashboard', projects: [], history: [], settings: { ...defaults },
    dependencies: {}, queue: { status: 'idle', overallProgress: 0, jobs: [] },
    selectedProjectId: '', query: '', category: '', historyType: '', historyProject: '',
    batchProjects: new Set(), batchOperations: new Set(['desktop', 'mobile', 'mockup']),
  };

  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const icon = (name, className = '') => `<i data-lucide="${name}" class="${className}" aria-hidden="true"></i>`;
  const icons = () => window.lucide?.createIcons({ attrs: { 'stroke-width': 1.65 } });
  const checked = (condition) => condition ? 'checked' : '';
  const selected = (condition) => condition ? 'selected' : '';
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
  const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const date = (value, withTime = false) => {
    const timestamp = new Date(value);
    return value && Number.isFinite(timestamp.getTime()) ? (withTime ? timeFormat : dateFormat).format(timestamp) : '—';
  };
  const newest = (array, property) => [...array].sort((a, b) => String(b[property] ?? '').localeCompare(String(a[property] ?? '')));
  const projectName = (id) => state.projects.find((project) => project.id === id)?.name ?? 'Deleted project';
  const fileName = (path) => String(path ?? '').split(/[\\/]/).pop() || 'Export file';
  const systemTheme = window.matchMedia('(prefers-color-scheme: light)');

  function siteHost(project) {
    try {
      return new URL(project.url).host;
    } catch {
      return project.url;
    }
  }

  function notify(message, type = 'success') {
    const node = document.createElement('div');
    const symbol = type === 'error' ? 'circle-alert' : type === 'info' ? 'info' : 'circle-check';
    node.className = `toast ${type}`;
    node.setAttribute('role', type === 'error' ? 'alert' : 'status');
    node.innerHTML = `${icon(symbol)}<span>${escape(message)}</span><button type="button" class="icon-button" aria-label="Dismiss notification">${icon('x')}</button>`;
    toasts.append(node);
    node.querySelector('button').addEventListener('click', () => node.remove());
    icons();
    window.setTimeout(() => node.remove(), type === 'error' ? 12000 : 5500);
  }

  function failure(error) {
    notify(error?.message?.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || 'Something went wrong. Try again.', 'error');
  }

  async function run(button, action) {
    if (button?.disabled) return;
    if (button) button.disabled = true;
    try {
      await action();
    } catch (error) {
      failure(error);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function actionButton(label, symbol, attributes, variant = 'secondary') {
    return `<button type="button" class="button ${variant}" ${attributes}>${icon(symbol)}<span>${label}</span></button>`;
  }

  function smallButton(label, symbol, action, id) {
    const attributes = `data-action="${action}" data-id="${escape(id)}"`;
    return `<button type="button" class="button ghost icon-button" ${attributes} aria-label="${label}" title="${label}">${icon(symbol)}</button>`;
  }

  function heading(title, subtitle = '', actions = '', eyebrow = '') {
    return `<header class="page-heading"><div class="heading-copy">
      ${eyebrow ? `<span class="eyebrow">${escape(eyebrow)}</span>` : ''}
      <h1>${escape(title)}</h1>${subtitle ? `<p class="description">${escape(subtitle)}</p>` : ''}
      </div>${actions ? `<div class="heading-actions">${actions}</div>` : ''}</header>`;
  }

  function empty(title, description, symbol = 'folder-open', actions = '') {
    return `<div class="empty-state"><div class="empty-icon">${icon(symbol)}</div>
      <h3>${escape(title)}</h3><p>${escape(description)}</p>${actions}</div>`;
  }

  function panelHeading(title, action = '') {
    return `<header class="panel-heading"><h2>${title}</h2>${action}</header>`;
  }

  function setTheme(theme) {
    const light = theme === 'light' || (theme === 'system' && systemTheme.matches);
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    const button = document.querySelector('#theme-toggle');
    if (!button) return;
    const next = light ? 'dark' : 'light';
    button.innerHTML = icon(light ? 'moon' : 'sun');
    button.setAttribute('aria-label', `Switch to ${next} theme`);
    button.title = `Switch to ${next} theme`;
  }

  let loadGeneration = 0;
  let queueGeneration = 0;

  async function load() {
    const current = ++loadGeneration;
    const queueAtStart = queueGeneration;
    const data = await api.load();
    if (current !== loadGeneration) return;
    state.projects = Array.isArray(data.projects) ? data.projects : [];
    state.history = Array.isArray(data.history) ? data.history : [];
    state.settings = { ...defaults, ...data.settings };
    state.dependencies = data.dependencies ?? {};
    if (data.queue && queueAtStart === queueGeneration) state.queue = data.queue;
    if (!state.projects.some((project) => project.id === state.selectedProjectId)) state.selectedProjectId = '';
    for (const id of state.batchProjects) {
      if (!state.projects.some((project) => project.id === id)) state.batchProjects.delete(id);
    }
    setTheme(state.settings.theme);
  }

  function go(page, projectId = undefined) {
    if (!Object.prototype.hasOwnProperty.call(pages, page)) return;
    if (projectId !== undefined) state.selectedProjectId = projectId;
    state.page = page;
    render();
    view.scrollTop = 0;
    document.querySelector('#main')?.scrollTo?.(0, 0);
  }

  function render() {
    view.setAttribute('aria-busy', 'false');
    for (const button of navigation) {
      const active = button.dataset.view === state.page;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    const label = document.querySelector('#page-label');
    if (label) label.textContent = pages[state.page];

    const renderers = { dashboard, projects, batch, history, settings };
    if (Object.hasOwn(renderers, state.page)) view.innerHTML = renderers[state.page]();
    else if (window.studios?.[state.page]) {
      window.studios[state.page]({ view, state, api, notify, failure, escape, icon, icons, heading, empty, load, go });
    } else {
      view.innerHTML = heading(pages[state.page]) + empty('Studio unavailable', 'Reload the application to try again.', 'circle-alert');
    }
    icons();
  }

  function projectVisual(project) {
    const thumbnail = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(project.thumbnail ?? '')
      ? `<img src="${escape(project.thumbnail)}" alt="" loading="lazy">` : '';
    return `<div class="project-visual">${thumbnail || `<div class="project-symbol">${icon('panels-top-left')}</div>`}
      ${project.category ? `<span class="badge">${escape(project.category)}</span>` : ''}</div>`;
  }

  function projectCard(project) {
    return `<article class="project-card">${projectVisual(project)}
      <div class="project-body">
        <div class="project-meta">
          <div><h3>${escape(project.name)}</h3><p class="project-url">${escape(siteHost(project))}</p></div>
          ${smallButton('Edit project', 'pencil', 'edit-project', project.id)}
        </div>
        ${project.description ? `<p class="project-description">${escape(project.description)}</p>` : ''}
        <div class="badges">${(project.technologies ?? []).slice(0, 4).map((item) => `<span class="badge">${escape(item)}</span>`).join('')}</div>
        <div class="row-actions">
          ${actionButton('Capture', 'camera', `data-go="screenshots" data-id="${escape(project.id)}"`, 'secondary')}
          ${smallButton('Open website', 'external-link', 'open-website', project.id)}
          ${smallButton('Open export folder', 'folder-open', 'open-project-folder', project.id)}
          ${smallButton('Duplicate project', 'copy', 'duplicate-project', project.id)}
          ${smallButton('Delete project', 'trash-2', 'delete-project', project.id)}
        </div>
      </div></article>`;
  }

  function recentProject(project) {
    return `<li class="recent-project">
      <button type="button" data-action="edit-project" data-id="${escape(project.id)}">
        ${projectVisual(project)}
        <span class="recent-copy"><strong>${escape(project.name)}</strong><span>${escape(siteHost(project))}</span></span>
        ${icon('chevron-right')}
      </button>
    </li>`;
  }

  function stat(label, value, symbol, tone) {
    return `<article class="stat-card ${tone}"><div class="stat-icon">${icon(symbol)}</div><span class="stat-label">${label}</span><strong class="stat-value">${value}</strong></article>`;
  }

  function quickAction(title, description, symbol, page) {
    return `<button type="button" class="action-card" data-go="${page}"><span class="action-icon">${icon(symbol)}</span>
      <span><strong>${title}</strong><small>${description}</small></span>${icon('arrow-up-right', 'action-arrow')}</button>`;
  }

  function recentExport(entry) {
    const [symbol, kind] = exportTypes[entry.kind] ?? ['file', 'File'];
    return `<li class="recent-export"><button type="button" data-action="open-export" data-id="${escape(entry.id)}">
      <span class="export-icon">${icon(symbol)}</span><span class="recent-copy"><strong>${escape(entry.projectName ?? projectName(entry.projectId))}</strong>
      <span>${kind} · ${escape(date(entry.createdAt))}</span></span>${icon('arrow-up-right')}</button></li>`;
  }

  function dashboard() {
    const projects = newest(state.projects, 'updatedAt').slice(0, 5);
    const history = newest(state.history, 'createdAt').slice(0, 5);
    const count = (kind) => state.history.filter((entry) => entry.kind === kind).length;
    const create = actionButton('New project', 'plus', 'data-action="new-project"', 'primary');
    return `${heading('Dashboard', 'Create and organize presentation assets for your websites.', create)}
      <div class="stats-grid">
        ${stat('Projects', state.projects.length, 'folder-kanban', 'tone-violet')}
        ${stat('Screenshots', count('screenshot'), 'camera', 'tone-blue')}
        ${stat('Mockups', count('mockup'), 'layers-3', 'tone-rose')}
        ${stat('Videos', count('video'), 'film', 'tone-cyan')}
      </div>
      <section class="quick-section" aria-labelledby="quick-heading">
        <div class="section-heading"><h2 id="quick-heading">Quick actions</h2></div>
        <div class="quick-actions">
          ${quickAction('Capture screenshot', 'Desktop, mobile, or full page', 'camera', 'screenshots')}
          ${quickAction('Create mockup', 'Present a site in a device frame', 'layers-3', 'mockups')}
          ${quickAction('Record website', 'Capture live scrolling and animation', 'film', 'videos')}
          ${quickAction('Batch export', 'Generate assets across projects', 'list-ordered', 'batch')}
        </div>
      </section>
      <div class="dashboard-grid">
        <section class="panel">
          ${panelHeading('Recent projects', actionButton('View projects', 'arrow-right', 'data-go="projects"', 'ghost'))}
          <div class="panel-body">${projects.length
            ? `<ul class="recent-list">${projects.map(recentProject).join('')}</ul>`
            : empty('No projects yet', 'Add a website to start capturing presentation assets.', 'folder-plus',
                actionButton('Create project', 'plus', 'data-action="new-project"', 'secondary'))}</div>
        </section>
        <section class="panel">
          ${panelHeading('Recent exports', actionButton('View history', 'arrow-right', 'data-go="history"', 'ghost'))}
          <div class="panel-body">${history.length
            ? `<ul class="recent-list">${history.map(recentExport).join('')}</ul>`
            : empty('No exports yet', 'Screenshots, mockups, and videos will appear here.', 'archive')}</div>
        </section>
      </div>`;
  }

  function matchingProjects() {
    const query = state.query.trim().toLowerCase();
    return newest(state.projects, 'updatedAt').filter((project) => {
      if (state.category && project.category !== state.category) return false;
      const searchable = [project.name, project.url, project.category, project.description, ...(project.technologies ?? [])];
      return !query || searchable.some((value) => String(value ?? '').toLowerCase().includes(query));
    });
  }

  function projectResults() {
    const items = matchingProjects();
    if (items.length) return `<div class="project-grid">${items.map(projectCard).join('')}</div>`;
    return state.projects.length
      ? empty('No matching projects', 'Try another search or category.', 'search-x')
      : empty('No projects yet', 'Create a project using a website or local development URL.', 'folder-plus',
          actionButton('Create project', 'plus', 'data-action="new-project"', 'secondary'));
  }

  function projects() {
    const existing = [...new Set(state.projects.map((project) => project.category).filter(Boolean))].sort();
    return `${heading('Projects', 'Manage websites and their presentation assets.',
        actionButton('New project', 'plus', 'data-action="new-project"', 'primary'))}
      <div class="toolbar">
        <label class="search-field">${icon('search')}<input id="project-query" type="search" placeholder="Search projects…" aria-label="Search projects" value="${escape(state.query)}"></label>
        <select id="project-category" aria-label="Filter by category"><option value="">All categories</option>
          ${existing.map((category) => `<option value="${escape(category)}" ${selected(state.category === category)}>${escape(category)}</option>`).join('')}
        </select>
      </div><div id="project-results">${projectResults()}</div>`;
  }

  function showDialog(title, content) {
    if (dialog.open) dialog.close();
    dialog.innerHTML = `<div class="modal">
      <header class="modal-header"><h2 id="active-dialog-title">${escape(title)}</h2>
      <button type="button" class="button ghost icon-button" data-close-dialog aria-label="Close dialog">${icon('x')}</button></header>
      ${content}</div>`;
    dialog.setAttribute('aria-labelledby', 'active-dialog-title');
    dialog.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => dialog.close()));
    dialog.showModal();
    icons();
  }

  function draftRead(key) {
    if (!state.settings.autosave) return null;
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  }

  function draftWrite(key, value) {
    try {
      if (value) localStorage.setItem(key, JSON.stringify(value));
      else localStorage.removeItem(key);
    } catch {
      // Project storage still works when browser storage is unavailable.
    }
  }

  function editProject(project = null) {
    const key = `showcase.project-draft.${project?.id ?? 'new'}`;
    const draft = draftRead(key);
    const fields = draft ?? {
      name: project?.name, url: project?.url, description: project?.description, category: project?.category,
      technologies: project?.technologies?.join(', '), features: project?.features?.join('\n'), capture: false,
    };
    showDialog(project ? 'Edit project' : 'New project', `
      <form id="project-form" class="stack">
        <div class="form-grid">
          <label class="field"><span>Project name</span><input name="name" autofocus required maxlength="160" value="${escape(fields.name)}" placeholder="Studio portfolio"></label>
          <label class="field"><span>Category</span><input name="category" list="project-categories" maxlength="100" value="${escape(fields.category)}" placeholder="Choose or enter a category">
            <datalist id="project-categories">${categories.map((category) => `<option value="${category}"></option>`).join('')}</datalist></label>
        </div>
        <label class="field"><span>Website URL</span><input inputmode="url" name="url" required maxlength="4096" value="${escape(fields.url)}" placeholder="https://example.com"></label>
        <label class="field"><span>Description</span><textarea name="description" rows="3" maxlength="12000" placeholder="Describe the project">${escape(fields.description)}</textarea></label>
        <label class="field"><span>Technologies</span><input name="technologies" maxlength="1000" value="${escape(fields.technologies)}" placeholder="React, Tailwind, Node.js"></label>
        <label class="field"><span>Main features</span><textarea name="features" rows="3" placeholder="Enter one feature per line">${escape(fields.features)}</textarea></label>
        ${project?.thumbnail ? `<label class="check-field"><input name="capture" type="checkbox" ${checked(fields.capture)}><span>Refresh website thumbnail</span></label>` : ''}
        <div class="form-actions">
          <button type="button" class="button ghost" data-close-dialog>Cancel</button>
          <button type="submit" class="button primary">${icon(project ? 'save' : 'plus')}<span>${project ? 'Save changes' : 'Create project'}</span></button>
        </div>
      </form>`);
    const form = dialog.querySelector('form');
    const read = () => ({ ...Object.fromEntries(new FormData(form)), capture: Boolean(form.elements.capture?.checked) });
    form.addEventListener('input', () => {
      if (state.settings.autosave) draftWrite(key, read());
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      run(event.submitter, async () => {
        const { capture, name, url, description, category, technologies, features } = read();
        const saved = await api.saveProject({
          ...(project ? { id: project.id } : {}), name, url, description, category,
          technologies: technologies.split(',').map((value) => value.trim()).filter(Boolean),
          features: features.split('\n').map((value) => value.trim()).filter(Boolean),
        });
        draftWrite(key, null);
        if (dialog.contains(form)) dialog.close();
        notify(project ? 'Project updated' : 'Project created');
        await load();
        if (saved?.id) state.selectedProjectId = saved.id;
        render();
        if (capture && saved?.thumbnail) captureThumbnail(saved.id);
      });
    });
  }

  async function captureThumbnail(id) {
    try {
      const updated = await api.thumbnail(id);
      if (!updated?.id) return;
      const index = state.projects.findIndex((project) => project.id === updated.id);
      if (index >= 0) state.projects[index] = updated;
      if (state.page === 'dashboard' || state.page === 'projects') render();
      notify('Website thumbnail captured');
    } catch (error) {
      notify(`Thumbnail capture failed. ${error?.message?.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') ?? 'Website could not be loaded.'}`, 'error');
    }
  }

  function deleteProject(project) {
    showDialog('Delete project?', `<p class="modal-copy">Remove <strong>${escape(project.name)}</strong> from your projects?</p>
      <div class="form-actions"><button type="button" class="button ghost" data-close-dialog>Cancel</button>
      <button type="button" id="confirm-delete" class="button danger">${icon('trash-2')}<span>Delete project</span></button></div>`);
    const button = dialog.querySelector('#confirm-delete');
    button.addEventListener('click', () => run(button, async () => {
      await api.deleteProject(project.id);
      draftWrite(`showcase.project-draft.${project.id}`, null);
      if (dialog.contains(button)) dialog.close();
      notify('Project deleted');
      await load();
      render();
    }));
  }

  const queueLabels = {
    idle: 'Ready', running: 'Running', queued: 'Queued', completed: 'Completed',
    failed: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped',
  };

  function progressValue(value) {
    return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  }

  function progress(value, label) {
    const percentage = progressValue(value);
    return `<progress class="progress" value="${percentage}" max="100" aria-label="${escape(label)}">${percentage}%</progress>`;
  }

  function queueRow(job) {
    const item = job.item ?? {};
    const status = queueLabels[job.status] ?? 'Queued';
    const detail = job.error || job.stage || status;
    const controls = job.status === 'failed' || job.status === 'cancelled'
      ? smallButton('Retry job', 'rotate-ccw', 'retry-job', job.id) : '';
    const skip = ['failed', 'queued', 'running'].includes(job.status)
      ? smallButton('Skip job', 'skip-forward', 'skip-job', job.id) : '';
    const project = item.projectName ?? projectName(item.projectId);
    const materials = (item.options?.operations ?? [item.type]).map((type) => operations[type]).filter(Boolean);
    const operation = materials.length > 1 ? `${materials.length} materials` : materials[0] ?? 'Export';
    return `<li class="queue-job">
      <div class="queue-job-copy"><strong>${escape(operation)}</strong><small>${escape(detail)}</small></div>
      <div class="queue-job-progress">${progress(job.progress, `${project}: ${operation}`)}<span>${progressValue(job.progress)}%</span></div>
      <span class="badge status-${escape(job.status)}">${status}</span>
      <div class="row-actions">${controls}${skip}</div>
      </li>`;
  }

  function batchQueue() {
    const queue = state.queue;
    const jobs = queue.jobs ?? [];
    if (!jobs.length) return empty('Queue is empty', 'Select projects and materials to start an export.', 'list-ordered');
    const groups = new Map();
    for (const job of jobs) {
      const key = job.item?.projectId ?? '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(job);
    }
    const status = queueLabels[queue.status] ?? 'Ready';
    return `<div class="queue-overview">
        <div><strong>Overall progress</strong><span class="badge status-${escape(queue.status)}">${status}</span></div>
        <div class="queue-job-progress">${progress(queue.overallProgress, 'Overall batch progress')}<strong>${progressValue(queue.overallProgress)}%</strong></div>
        ${queue.status === 'running' ? actionButton('Cancel batch', 'square', 'data-action="cancel-batch"', 'danger') : ''}
      </div>${[...groups].map(([id, group]) => {
        const title = group[0].item?.projectName ?? projectName(id);
        const average = group.reduce((sum, job) => sum + progressValue(job.progress), 0) / group.length;
        const canSkip = group.some((job) => job.status === 'failed');
        return `<section class="queue-project"><header class="queue-project-heading"><h3>${escape(title)}</h3>
          <div class="row-actions"><span>${progressValue(average)}%</span>
          ${canSkip ? smallButton('Skip failed project', 'skip-forward', 'skip-project', id) : ''}</div></header>
          ${progress(average, `${title} progress`)}
          <ul class="queue-job-list">${group.map(queueRow).join('')}</ul></section>`;
      }).join('')}`;
  }

  function batch() {
    const items = newest(state.projects, 'updatedAt');
    return `${heading('Batch Export', 'Generate presentation assets for multiple projects in a single queue.')}
      <div class="batch-grid">
        <section class="panel">
          ${panelHeading('Export setup', items.length ? `<button type="button" id="batch-select-all" class="button ghost" data-action="batch-all">${state.batchProjects.size === items.length ? 'Clear selection' : 'Select all projects'}</button>` : '')}
          <div class="panel-body">
            ${items.length ? `<form id="batch-form" class="stack">
              <fieldset><legend>Projects</legend><div class="batch-options batch-projects">
                ${items.map((project) => `<label class="check-field"><input type="checkbox" name="project" value="${escape(project.id)}" ${checked(state.batchProjects.has(project.id))}>
                  <span>${escape(project.name)}</span></label>`).join('')}
              </div></fieldset>
              <fieldset><legend>Materials</legend><div class="batch-options">
                ${Object.entries(operations).map(([key, label]) => `<label class="check-field"><input type="checkbox" name="operation" value="${key}" ${checked(state.batchOperations.has(key))}><span>${label}</span></label>`).join('')}
              </div></fieldset>
              <div class="form-actions"><button type="submit" id="start-batch" class="button primary" ${batchStartDisabled() ? 'disabled' : ''}>${icon('play')}<span>Start export</span></button></div>
              </form>` : empty('No projects to export', 'Add a website project before starting a batch.', 'folder-plus',
                actionButton('Create project', 'plus', 'data-action="new-project"', 'primary'))}
          </div>
        </section>
        <section class="panel">${panelHeading('Export queue')}<div class="panel-body" id="queue-panel">${batchQueue()}</div></section>
      </div>`;
  }

  function batchStartDisabled() {
    return state.queue.status === 'running' || !state.batchProjects.size || !state.batchOperations.size;
  }

  function updateBatchControls() {
    if (state.page !== 'batch') return;
    const button = document.querySelector('#start-batch');
    if (button) button.disabled = batchStartDisabled();
    const all = document.querySelector('#batch-select-all');
    if (all) all.textContent = state.batchProjects.size === state.projects.length ? 'Clear selection' : 'Select all projects';
  }

  function queueUpdate(next, announce = false) {
    if (!next) return;
    const previous = state.queue.status;
    queueGeneration += 1;
    state.queue = next;
    if (state.page === 'batch') {
      const target = document.querySelector('#queue-panel');
      if (target) {
        const focused = target.contains(document.activeElement) ? document.activeElement.dataset : null;
        target.innerHTML = batchQueue();
        if (focused) {
          [...target.querySelectorAll('button[data-action]')]
            .find((button) => button.dataset.action === focused.action && button.dataset.id === focused.id)
            ?.focus({ preventScroll: true });
        }
      }
      updateBatchControls();
      icons();
    }
    if (announce && previous === 'running') {
      if (next.status === 'completed') notify('Batch export completed');
      if (next.status === 'failed') notify('Some exports failed. Retry or skip them in Batch Export.', 'error');
      if (next.status === 'cancelled') notify('Batch export cancelled', 'info');
    }
  }

  function historyRows() {
    const records = newest(state.history, 'createdAt').filter((entry) =>
      (!state.historyType || entry.kind === state.historyType) &&
      (!state.historyProject || entry.projectId === state.historyProject));
    if (!records.length) {
      return state.history.length
        ? empty('No matching exports', 'Choose another project or file type.', 'search-x')
        : empty('No exports yet', 'Saved files will appear here as you create them.', 'archive',
            actionButton('Capture a screenshot', 'camera', 'data-go="screenshots"', 'secondary'));
    }
    return `<div class="table-scroll"><table class="data-table"><thead><tr><th scope="col">File</th><th scope="col">Project</th>
      <th scope="col">Type</th><th scope="col">Created</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${records.map((entry) => {
        const [symbol, type] = exportTypes[entry.kind] ?? ['file', 'File'];
        return `<tr><td><button type="button" class="button ghost table-file" data-action="open-export" data-id="${escape(entry.id)}">${icon(symbol)}<span>${escape(entry.fileName ?? fileName(entry.path))}</span></button></td>
          <td>${escape(entry.projectName ?? projectName(entry.projectId))}</td><td><span class="badge">${type}</span></td>
          <td>${escape(date(entry.createdAt, true))}</td><td><div class="row-actions">
          ${smallButton('Open file', 'external-link', 'open-export', entry.id)}
          ${smallButton('Open folder', 'folder-open', 'open-export-folder', entry.id)}</div></td></tr>`;
      }).join('')}</tbody></table></div>`;
  }

  function history() {
    const names = new Map(state.history.map((entry) => [entry.projectId, entry.projectName ?? projectName(entry.projectId)]));
    return `${heading('Export History', 'Find and open assets you have saved from Showcase Studio.')}
      <div class="toolbar">
        <select id="history-type" aria-label="Filter by asset type"><option value="">All file types</option>
          ${Object.entries(exportTypes).map(([key, [, type]]) => `<option value="${key}" ${selected(state.historyType === key)}>${type}</option>`).join('')}
        </select>
        <select id="history-project" aria-label="Filter by project"><option value="">All projects</option>
          ${[...names].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => `<option value="${escape(id)}" ${selected(state.historyProject === id)}>${escape(name)}</option>`).join('')}
        </select>
      </div>
      <section class="panel" id="history-results">${historyRows()}</section>`;
  }

  function numberField(name, label, settings, min, max, unit = '') {
    return `<label class="field"><span>${label}</span><span class="input-unit"><input type="number" name="${name}" value="${escape(settings[name])}" min="${min}" max="${max}" required>${unit ? `<span>${unit}</span>` : ''}</span></label>`;
  }

  function dependency(label, packageName, value) {
    const detail = typeof value === 'string' ? value : value?.message;
    const available = value?.available ?? value === true;
    return `<div class="dependency-row"><div><strong>${label}</strong>
      <small>${escape(detail || (available ? 'Available' : 'Run npm run setup from the project folder.'))}</small></div>
      <span class="badge ${available ? 'status-completed' : 'status-failed'}" title="${packageName}">${available ? 'Available' : 'Unavailable'}</span></div>`;
  }

  function dependencies() {
    return `${dependency('Playwright Chromium', 'chromium', state.dependencies.chromium)}
      ${dependency('FFmpeg', 'ffmpeg', state.dependencies.ffmpeg)}`;
  }

  function settings() {
    const values = state.settings;
    return `${heading('Settings', 'Set export defaults and manage local dependencies.')}
      <form id="settings-form" class="settings-grid">
        <section class="panel">
          ${panelHeading('Output preferences')}
          <div class="panel-body stack">
            <div class="field"><label for="export-directory">Default export directory</label><span class="field-inline">
              <input id="export-directory" name="exportDirectory" value="${escape(values.exportDirectory)}" readonly>
              ${actionButton('Browse', 'folder-open', 'data-action="pick-directory"')}</span></div>
            <div class="form-grid">
              ${numberField('screenshotWidth', 'Default screenshot width', values, 160, 4096, 'px')}
              ${numberField('screenshotHeight', 'Default screenshot height', values, 160, 4096, 'px')}
              ${numberField('imageQuality', 'Default image quality', values, 1, 100, '%')}
              ${numberField('videoQuality', 'Default video quality (CRF)', values, 0, 51)}
              ${numberField('videoWidth', 'Default video width', values, 160, 3840, 'px')}
              ${numberField('videoHeight', 'Default video height', values, 160, 3840, 'px')}
            </div>
          </div>
        </section>
        <section class="panel">
          ${panelHeading('Workspace')}
          <div class="panel-body stack">
            <label class="field"><span>Default theme</span><select name="theme">
              <option value="dark" ${selected(values.theme === 'dark')}>Dark</option><option value="light" ${selected(values.theme === 'light')}>Light</option>
              <option value="system" ${selected(values.theme === 'system')}>System</option></select></label>
            ${numberField('browserTimeout', 'Browser load timeout', values, 1000, 180000, 'ms')}
            ${numberField('maxConcurrentJobs', 'Maximum concurrent jobs', values, 1, 8)}
            <label class="check-field"><input name="autosave" type="checkbox" ${checked(values.autosave)}><span>Automatically save project form drafts</span></label>
          </div>
        </section>
        <section class="panel">
          ${panelHeading('Dependencies', actionButton('Check status', 'refresh-cw', 'data-action="dependencies"', 'ghost'))}
          <div class="panel-body" id="dependency-status">${dependencies()}</div>
        </section>
        <section class="panel">
          ${panelHeading('Temporary files')}
          <div class="panel-body stack">
            <p class="muted">Clear cached previews and temporary recording files.</p>
            <div>${actionButton('Clear temporary files', 'trash-2', 'data-action="clear-temp"')}</div>
          </div>
        </section>
        <div class="form-actions settings-actions"><button type="submit" class="button primary">${icon('save')}<span>Save settings</span></button></div>
      </form>`;
  }

  async function setSettings(values) {
    const saved = await api.saveSettings(values);
    state.settings = { ...state.settings, ...values, ...saved };
    setTheme(state.settings.theme);
    icons();
  }

  function chooseAllProjects() {
    if (state.batchProjects.size === state.projects.length) state.batchProjects.clear();
    else state.batchProjects = new Set(state.projects.map((project) => project.id));
    for (const input of view.querySelectorAll('#batch-form input[name=project]')) {
      input.checked = state.batchProjects.has(input.value);
    }
    updateBatchControls();
  }

  function refreshProjects() {
    const target = document.querySelector('#project-results');
    if (!target) return;
    target.innerHTML = projectResults();
    icons();
  }

  function refreshHistory() {
    const target = document.querySelector('#history-results');
    if (!target) return;
    target.innerHTML = historyRows();
    icons();
  }

  async function queueCommand(operation) {
    const generation = queueGeneration;
    const result = await operation();
    if (queueGeneration === generation && Array.isArray(result?.jobs)) queueUpdate(result, true);
  }

  async function skipProject(id) {
    const jobs = state.queue.jobs.filter((job) => job.item?.projectId === id &&
      ['failed', 'queued', 'running'].includes(job.status));
    // Process queued jobs first so cancelling an active job cannot start more work for this project.
    const ordered = [...jobs.filter((job) => job.status !== 'running'), ...jobs.filter((job) => job.status === 'running')];
    for (const job of ordered) {
      const latest = state.queue.jobs.find((current) => current.id === job.id);
      if (latest && ['failed', 'queued', 'running'].includes(latest.status)) {
        await queueCommand(() => api.queueSkip(job.id));
      }
    }
  }

  function handleAction(button) {
    const id = button.dataset.id;
    const action = button.dataset.action;
    const project = state.projects.find((entry) => entry.id === id);
    switch (action) {
      case 'new-project':
        editProject();
        break;
      case 'edit-project':
        if (project) editProject(project);
        break;
      case 'delete-project':
        if (project) deleteProject(project);
        break;
      case 'duplicate-project':
        run(button, async () => {
          await api.duplicateProject(id);
          notify('Project duplicated');
          await load();
          render();
        });
        break;
      case 'open-website':
        run(button, () => api.openWebsite(id));
        break;
      case 'open-project-folder':
        run(button, () => api.openProjectFolder(id));
        break;
      case 'open-export':
        run(button, () => api.openExport(id));
        break;
      case 'open-export-folder':
        run(button, () => api.openExportFolder(id));
        break;
      case 'batch-all':
        chooseAllProjects();
        break;
      case 'cancel-batch':
        run(button, () => queueCommand(() => api.queueCancel()));
        break;
      case 'retry-job':
        run(button, () => queueCommand(() => api.queueRetry(id)));
        break;
      case 'skip-job':
        run(button, () => queueCommand(() => api.queueSkip(id)));
        break;
      case 'skip-project':
        run(button, () => skipProject(id));
        break;
      case 'pick-directory':
        run(button, async () => {
          const directory = await api.pickDirectory();
          const input = button.closest('form')?.elements.exportDirectory;
          if (input && directory) input.value = directory;
        });
        break;
      case 'dependencies':
        run(button, async () => {
          state.dependencies = await api.dependencies();
          const target = document.querySelector('#dependency-status');
          if (target) target.innerHTML = dependencies();
        });
        break;
      case 'clear-temp':
        run(button, async () => {
          await api.clearTemporary();
          notify('Temporary files cleared');
        });
        break;
    }
  }

  for (const button of navigation) {
    button.addEventListener('click', () => go(button.dataset.view));
  }

  const themeToggle = document.querySelector('#theme-toggle');
  themeToggle?.addEventListener('click', () => run(themeToggle, async () => {
    const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    await setSettings({ theme });
    const themeField = document.querySelector('#settings-form select[name=theme]');
    if (themeField) themeField.value = theme;
  }));
  systemTheme.addEventListener('change', () => {
    if (state.settings.theme !== 'system') return;
    setTheme('system');
    icons();
  });

  view.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.go) go(button.dataset.go, button.dataset.id);
    if (button.dataset.action) handleAction(button);
  });

  view.addEventListener('input', (event) => {
    if (event.target.id === 'project-query') {
      state.query = event.target.value;
      refreshProjects();
    }
  });

  view.addEventListener('change', (event) => {
    const input = event.target;
    if (input.id === 'project-category') {
      state.category = input.value;
      refreshProjects();
    }
    if (input.id === 'history-type' || input.id === 'history-project') {
      if (input.id === 'history-type') state.historyType = input.value;
      else state.historyProject = input.value;
      refreshHistory();
    }
    if (input.closest('#batch-form')) {
      const set = input.name === 'project' ? state.batchProjects : state.batchOperations;
      if (input.checked) set.add(input.value);
      else set.delete(input.value);
      updateBatchControls();
    }
  });

  view.addEventListener('submit', (event) => {
    const form = event.target;
    if (form.id === 'settings-form') {
      event.preventDefault();
      run(event.submitter, async () => {
        const values = Object.fromEntries(new FormData(form));
        for (const input of form.querySelectorAll('input[type=number]')) values[input.name] = input.valueAsNumber;
        values.autosave = form.elements.autosave.checked;
        await setSettings(values);
        notify('Settings saved');
      });
    }
    if (form.id === 'batch-form') {
      event.preventDefault();
      if (batchStartDisabled()) return;
      run(event.submitter, () => queueCommand(() => api.enqueue({
          projectIds: [...state.batchProjects], operations: [...state.batchOperations],
      }))).finally(updateBatchControls);
    }
  });

  let refreshTimer;

  function refreshData() {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => run(null, async () => {
      await load();
      if (state.page === 'dashboard') render();
      if (state.page === 'projects') refreshProjects();
      if (state.page === 'history') refreshHistory();
      icons();
    }), 110);
  }

  async function initialize() {
    setTheme(state.settings.theme);
    view.innerHTML = `<div class="empty-state loading-state" role="status">${icon('loader-circle', 'spinner')}<p>Loading workspace…</p></div>`;
    icons();
    api?.onQueue?.((queue) => {
      queueUpdate(queue, true);
      if (queue.status !== 'running') refreshData();
    });
    api?.onDataChanged?.(refreshData);
    try {
      await load();
      render();
    } catch (error) {
      view.setAttribute('aria-busy', 'false');
      view.innerHTML = heading('Dashboard') + empty('Workspace could not be loaded', 'Restart Showcase Studio to try again.', 'circle-alert');
      icons();
      failure(error);
    }
  }

  initialize();
})();
