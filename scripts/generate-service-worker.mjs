import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REVISION_TOKEN = '__CADENCE_BUILD_REVISION__';
export const PRECACHE_TOKEN = '/* __CADENCE_PRECACHE_ENTRIES__ */ []';

const REQUIRED_FILES = [
  './index.html',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

const digest = (content) => createHash('sha256').update(content).digest('hex');
const toUrl = (root, file) => `./${relative(root, file).split(sep).join('/')}`;

async function listFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, path));
    else if (entry.isFile() && toUrl(root, path) !== './sw.js') files.push(path);
  }
  return files;
}

export async function buildPrecache(distDirectory) {
  const root = resolve(distDirectory);
  const files = await listFiles(root);
  const entries = [];

  for (const file of files) {
    const content = await readFile(file);
    entries.push({ url: toUrl(root, file), revision: digest(content).slice(0, 16) });
  }

  const urls = new Set(entries.map(({ url }) => url));
  for (const required of REQUIRED_FILES) {
    if (!urls.has(required)) throw new Error(`Fichier PWA requis absent du build : ${required}`);
  }
  if (!entries.some(({ url }) => /^\.\/assets\/.+-[A-Za-z0-9_-]{8,}\.js$/.test(url))) {
    throw new Error('Le build ne contient aucun bundle JavaScript hashé dans ./assets/.');
  }

  const indexEntry = entries.find(({ url }) => url === './index.html');
  entries.unshift({ url: './', revision: indexEntry.revision });
  const buildRevision = digest(entries.map(({ url, revision }) => `${url}:${revision}`).join('\n')).slice(0, 16);
  return { entries, buildRevision };
}

export function renderServiceWorker(template, { entries, buildRevision }) {
  if (!template.includes(REVISION_TOKEN) || !template.includes(PRECACHE_TOKEN)) {
    throw new Error('Le gabarit public/sw.js ne contient pas les marqueurs de génération attendus.');
  }
  return template
    .replace(REVISION_TOKEN, buildRevision)
    .replace(PRECACHE_TOKEN, JSON.stringify(entries, null, 2));
}

export async function generateServiceWorker({
  distDirectory = 'dist',
  templatePath = 'public/sw.js',
  outputPath = join(distDirectory, 'sw.js'),
} = {}) {
  const precache = await buildPrecache(distDirectory);
  const template = await readFile(templatePath, 'utf8');
  const worker = renderServiceWorker(template, precache);
  await writeFile(outputPath, worker, 'utf8');
  return { ...precache, outputPath, worker };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  const result = await generateServiceWorker();
  process.stdout.write(`Service worker généré : ${result.entries.length} URLs, révision ${result.buildRevision}\n`);
}
