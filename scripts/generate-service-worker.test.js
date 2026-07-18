import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import {
  PRECACHE_TOKEN,
  REVISION_TOKEN,
  buildPrecache,
  generateServiceWorker,
} from './generate-service-worker.mjs';

const temporaryDirectories = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cadence-sw-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'assets'), { recursive: true });
  await mkdir(join(root, 'icons'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'index.html'), '<script src="./assets/index-AbCd1234.js"></script>'),
    writeFile(join(root, 'manifest.webmanifest'), '{"name":"CADENCE"}'),
    writeFile(join(root, 'assets', 'index-AbCd1234.js'), 'console.log("cadence")'),
    writeFile(join(root, 'icons', 'icon-180.png'), '180'),
    writeFile(join(root, 'icons', 'icon-192.png'), '192'),
    writeFile(join(root, 'icons', 'icon-512.png'), '512'),
    writeFile(join(root, 'sw.js'), 'ancien worker à exclure'),
  ]);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('générateur du service worker', () => {
  it('révisionne et précache le shell, le bundle, le manifeste et les icônes', async () => {
    const root = await fixture();
    const first = await buildPrecache(root);
    const urls = first.entries.map(({ url }) => url);

    expect(urls).toEqual(expect.arrayContaining([
      './', './index.html', './assets/index-AbCd1234.js', './manifest.webmanifest',
      './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
    ]));
    expect(urls).not.toContain('./sw.js');
    expect(first.entries.every(({ revision }) => /^[a-f0-9]{16}$/.test(revision))).toBe(true);

    await writeFile(join(root, 'assets', 'index-AbCd1234.js'), 'console.log("nouvelle révision")');
    const second = await buildPrecache(root);
    expect(second.buildRevision).not.toBe(first.buildRevision);
  });

  it('injecte le manifeste et conserve un nettoyage strictement préfixé', async () => {
    const root = await fixture();
    const templatePath = join(process.cwd(), 'public', 'sw.js');
    const outputPath = join(root, 'generated-sw.js');
    const result = await generateServiceWorker({ distDirectory: root, templatePath, outputPath });
    const worker = await readFile(outputPath, 'utf8');

    expect(worker).not.toContain(REVISION_TOKEN);
    expect(worker).not.toContain(PRECACHE_TOKEN);
    expect(worker).toContain(`const BUILD_REVISION = '${result.buildRevision}'`);
    expect(worker).toContain('index-AbCd1234.js');
    expect(worker).toContain('key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME');
    expect(worker).toContain('await cache.put');
  });

  it('ne supprime pas les caches étrangères lors de son activation', async () => {
    const root = await fixture();
    const result = await generateServiceWorker({
      distDirectory: root,
      templatePath: join(process.cwd(), 'public', 'sw.js'),
      outputPath: join(root, 'generated-sw.js'),
    });
    const listeners = {};
    const deleted = [];
    const claim = vi.fn(async () => undefined);

    runInNewContext(result.worker, {
      URL,
      Request,
      Response,
      fetch: vi.fn(),
      caches: {
        keys: vi.fn(async () => ['autre-pwa-cache', 'cadence-ancienne', `cadence-precache-${result.buildRevision}`]),
        delete: vi.fn(async (key) => { deleted.push(key); return true; }),
      },
      self: {
        registration: { scope: 'https://example.test/OUTILTAFF/' },
        location: { origin: 'https://example.test' },
        clients: { claim },
        skipWaiting: vi.fn(async () => undefined),
        addEventListener: (type, listener) => { listeners[type] = listener; },
      },
    });

    let activation;
    listeners.activate({ waitUntil: (promise) => { activation = promise; } });
    await activation;

    expect(deleted).toEqual(['cadence-ancienne']);
    expect(claim).toHaveBeenCalledOnce();
  });

  it('échoue si un artefact PWA obligatoire manque', async () => {
    const root = await fixture();
    await rm(join(root, 'manifest.webmanifest'));
    await expect(buildPrecache(root)).rejects.toThrow('manifest.webmanifest');
  });
});
