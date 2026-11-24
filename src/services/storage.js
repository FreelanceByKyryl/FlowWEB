const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createProjectFolder, EXPORT_FOLDERS } = require('./exports');

const DEFAULT_SETTINGS = Object.freeze({
  screenshotWidth: 1920,
  screenshotHeight: 1080,
  imageQuality: 90,
  videoWidth: 1920,
  videoHeight: 1080,
  videoQuality: 23,
  theme: 'dark',
  browserTimeout: 30000,
  maxConcurrentJobs: 1,
  autosave: true,
});

const SETTING_RANGES = {
  screenshotWidth: [160, 4096],
  screenshotHeight: [160, 4096],
  imageQuality: [1, 100],
  videoWidth: [160, 3840],
  videoHeight: [160, 3840],
  videoQuality: [0, 51],
  browserTimeout: [1000, 180000],
  maxConcurrentJobs: [1, 8],
};

function websiteUrl(value) {
  const text = plainText(value, 'Website URL', 4096);
  // Local development URLs commonly omit their scheme.
  const candidate = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?=[:/?#]|$)/i.test(text) ? `http://${text}` : text;
  try {
    const url = new URL(candidate);
    if (['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password) return url.href;
  } catch {
    // Show the same correction for invalid syntax and unsupported schemes.
  }
  throw new Error('Enter an HTTP or HTTPS website URL without embedded credentials.');
}

function plainText(value, label, length) {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed.includes('\0') || trimmed.length > length) throw new Error(`${label} must be at most ${length} characters.`);
  return trimmed;
}

function textList(value, label, separator) {
  const items = typeof value === 'string' ? value.split(separator) : value;
  if (!Array.isArray(items)) throw new Error(`${label} must be a list.`);
  const cleanItems = [...new Set(items.map(item => plainText(item, label, 240)).filter(Boolean))];
  if (cleanItems.length > 40) throw new Error(`${label} can contain up to 40 entries.`);
  return cleanItems;
}

function prepareProject(input, current) {
  const { name = current?.name, url = current?.url, category = current?.category ?? '',
    description = current?.description ?? '', technologies = current?.technologies ?? [],
    features = current?.features ?? [] } = input;
  const label = plainText(name, 'Project name', 160);
  if (!label) throw new Error('Enter a project name.');
  const normalizedUrl = websiteUrl(url);
  const id = current?.id ?? randomUUID();
  const now = new Date().toISOString();
  const project = {
    id,
    name: label,
    url: normalizedUrl,
    category: plainText(category, 'Category', 100),
    description: plainText(description, 'Description', 12000),
    technologies: textList(technologies, 'Technologies', /[,\n]/),
    features: textList(features, 'Features', /\r?\n/),
    exportFolder: current?.exportFolder ?? createProjectFolder(label, id),
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
  if (current?.thumbnail && current.url === normalizedUrl) project.thumbnail = current.thumbnail;
  return project;
}

function validateSettings(partial) {
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) throw new Error('Invalid settings.');
  const settings = {};
  for (const [key, [min, max]] of Object.entries(SETTING_RANGES)) {
    if (!Object.hasOwn(partial, key)) continue;
    const value = partial[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${key} must be a whole number between ${min} and ${max}.`);
    }
    settings[key] = value;
  }
  if (Object.hasOwn(partial, 'theme')) {
    if (!['dark', 'light', 'system'].includes(partial.theme)) throw new Error('Choose a supported theme.');
    settings.theme = partial.theme;
  }
  if (Object.hasOwn(partial, 'exportDirectory')) {
    if (typeof partial.exportDirectory !== 'string' || !path.isAbsolute(partial.exportDirectory) || partial.exportDirectory.includes('\0')) {
      throw new Error('Choose an absolute export directory.');
    }
    settings.exportDirectory = path.resolve(partial.exportDirectory);
  }
  if (Object.hasOwn(partial, 'autosave')) {
    if (typeof partial.autosave !== 'boolean') throw new Error('Automatic project saving must be on or off.');
    settings.autosave = partial.autosave;
  }
  return settings;
}

async function writeJson(filePath, data) {
  const temp = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, filePath);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

class Storage {
  static async open({ directory, defaultExportDirectory }) {
    await fs.mkdir(directory, { recursive: true });
    const filePath = path.join(directory, 'showcase.json');
    const settings = { ...DEFAULT_SETTINGS, ...validateSettings({ exportDirectory: defaultExportDirectory }) };
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return new Storage(filePath, { projects: [], exports: [], settings });
      if (error instanceof SyntaxError) throw new Error('The local Showcase Studio data is invalid JSON.', { cause: error });
      throw error;
    }
    if (!Array.isArray(parsed?.projects) || !Array.isArray(parsed.exports) || !parsed.settings) {
      throw new Error('The local Showcase Studio data has an unsupported format.');
    }
    return new Storage(filePath, {
      projects: parsed.projects,
      exports: parsed.exports,
      settings: { ...settings, ...validateSettings(parsed.settings) },
    });
  }

  constructor(filePath, state) {
    this.filePath = filePath;
    this.state = state;
    this.pending = Promise.resolve();
  }

  snapshot() {
    return structuredClone(this.state);
  }

  getProject(id) {
    const project = this.state.projects.find(item => item.id === id);
    return project ? structuredClone(project) : null;
  }

  mutate(update) {
    const operation = this.pending.then(async () => {
      const next = this.snapshot();
      const result = update(next);
      await writeJson(this.filePath, next);
      this.state = next;
      return structuredClone(result);
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  async saveProject(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid project.');
    return this.mutate(state => {
      const index = state.projects.findIndex(project => project.id === input.id);
      if (input.id != null && index === -1) throw new Error('The project no longer exists.');
      const project = prepareProject(input, state.projects[index]);
      if (index === -1) state.projects.unshift(project);
      else state.projects[index] = project;
      return project;
    });
  }

  duplicateProject(id) {
    return this.mutate(state => {
      const current = state.projects.find(project => project.id === id);
      if (!current) throw new Error('The project no longer exists.');
      const copy = prepareProject({ ...current, name: `${current.name.slice(0, 153)} (copy)` });
      if (current.thumbnail) copy.thumbnail = current.thumbnail;
      state.projects.unshift(copy);
      return copy;
    });
  }

  deleteProject(id) {
    return this.mutate(state => {
      const index = state.projects.findIndex(project => project.id === id);
      if (index === -1) throw new Error('The project no longer exists.');
      const [deleted] = state.projects.splice(index, 1);
      return deleted;
    });
  }

  async setThumbnail(id, dataUrl, expectedUrl) {
    if (typeof dataUrl !== 'string' || dataUrl.length > 2000000 || !/^data:image\/(?:png|jpeg|webp);base64,[a-z\d+/]+={0,2}$/i.test(dataUrl)) {
      throw new Error('Invalid project thumbnail.');
    }
    return this.mutate(state => {
      const project = state.projects.find(item => item.id === id);
      if (!project || (expectedUrl !== undefined && project.url !== expectedUrl)) return null;
      project.thumbnail = dataUrl;
      return project;
    });
  }

  async updateSettings(partial) {
    const settings = validateSettings(partial);
    return this.mutate(state => Object.assign(state.settings, settings));
  }

  async addExport(record) {
    if (!record || !Object.hasOwn(EXPORT_FOLDERS, record.kind) || typeof record.path !== 'string' ||
      !path.isAbsolute(record.path) || record.path.includes('\0')) throw new Error('Invalid export record.');
    const entry = { ...structuredClone(record), id: randomUUID(), createdAt: new Date().toISOString() };
    return this.mutate(state => {
      state.exports.unshift(entry);
      return entry;
    });
  }
}

module.exports = { DEFAULT_SETTINGS, Storage, websiteUrl };
