const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

const EXPORT_FOLDERS = Object.freeze({
  screenshot: 'Screenshots',
  mockup: 'Mockups',
  video: 'Videos',
  portfolio: 'Portfolio',
});

function safeName(value, fallback = 'Export', maxLength = 100, maxBytes = 220) {
  if (typeof value !== 'string') return fallback;
  const cleanName = value.normalize('NFKC')
    .replace(/[<>:"/\\|?*\p{Cc}\p{Cf}]/gu, '-')
    .trim()
    .replace(/^\.+|[. ]+$/g, '');
  let characters = 0;
  let bytes = 0;
  let bounded = '';
  for (const character of cleanName) {
    bytes += Buffer.byteLength(character);
    if (++characters > maxLength || bytes > maxBytes) break;
    bounded += character;
  }
  const name = bounded.replace(/[. ]+$/g, '') || fallback;
  // Windows reserves these names even when followed by an extension.
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name;
}

function requireAbsolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    throw new Error('Choose an absolute export path.');
  }
  return path.resolve(value);
}

function createProjectFolder(name, id) {
  return `${safeName(name, 'Project', 65, 150)} - ${safeName(id, 'project', 12)}`;
}

function projectDirectory(root, project) {
  if (!project || typeof project !== 'object') throw new Error('A project is required for export.');
  return path.join(requireAbsolute(root), safeName(project.exportFolder || createProjectFolder(project.name, project.id)));
}

function resolveExportPath(root, project, kind) {
  const directory = projectDirectory(root, project);
  if (kind === undefined) return directory;
  if (typeof kind !== 'string' || !Object.hasOwn(EXPORT_FOLDERS, kind)) throw new Error('Unknown export type.');
  return path.join(directory, EXPORT_FOLDERS[kind]);
}

async function ensureChildDirectory(parent, name) {
  const directory = path.join(parent, name);
  try {
    await fs.mkdir(directory);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stats = await fs.lstat(directory);
  if (!stats.isDirectory() || path.relative(directory, await fs.realpath(directory)) !== '') {
    throw new Error('The export directory contains a link or an unexpected file.');
  }
  return directory;
}

async function ensureExportDirectory(root, project, kind) {
  const directory = resolveExportPath(root, project, kind);
  await fs.mkdir(requireAbsolute(root), { recursive: true });
  const canonicalRoot = await fs.realpath(root);
  const projectFolder = await ensureChildDirectory(canonicalRoot, path.basename(projectDirectory(root, project)));
  return kind === undefined ? projectFolder : ensureChildDirectory(projectFolder, path.basename(directory));
}

async function reserveName(directory, filename, write) {
  if (typeof filename !== 'string' || !filename.trim()) throw new Error('An export filename is required.');
  const extension = path.extname(filename);
  const validExtension = /^\.[a-z0-9]{1,10}$/i.test(extension) ? extension : '';
  const stem = safeName(validExtension ? filename.slice(0, -validExtension.length) : filename);
  for (let number = 1; number <= 10000; number++) {
    const suffix = number === 1 ? '' : `-${number}`;
    const candidate = path.join(directory, `${stem}${suffix}${validExtension}`);
    try {
      await write(candidate);
      return candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Too many exports have this filename. Choose a different filename or export directory.');
}

async function writeExport(root, project, kind, filename, bytes) {
  const directory = await ensureExportDirectory(root, project, kind);
  return reserveName(directory, filename, async (file) => {
    const handle = await fs.open(file, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.unlink(file).catch(() => {});
      throw error;
    }
  });
}

async function copyExport(root, project, kind, filename, source) {
  const directory = await ensureExportDirectory(root, project, kind);
  return reserveName(directory, filename, file => fs.copyFile(source, file, constants.COPYFILE_EXCL));
}

async function existingExportPath(filepath) {
  const absolute = requireAbsolute(filepath);
  let stats;
  try {
    stats = await fs.lstat(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('This exported file was moved or deleted.');
    throw error;
  }
  if (!(stats.isFile() || stats.isDirectory()) || path.relative(absolute, await fs.realpath(absolute)) !== '') {
    throw new Error('The export path points to a link or an unexpected file.');
  }
  return absolute;
}

module.exports = {
  EXPORT_FOLDERS,
  createProjectFolder,
  projectDirectory,
  resolveExportPath,
  ensureExportDirectory,
  writeExport,
  copyExport,
  existingExportPath,
};
