import { describe, it, expect, vi } from 'vitest';
import {
  SYNC_KEY, VAULT_FILE, loadSyncConfig, saveSyncConfig, clearSyncConfig,
  isConfigured, createVault, pullVault, pushVault, checkToken, SyncError,
} from './remote.js';
import { seedState } from './engine.js';

const memStore = () => {
  const mem = {};
  return {
    mem,
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: (k) => { delete mem[k]; },
  };
};

// fetch simulé : renvoie une réponse contrôlée et enregistre l'appel.
const fakeFetch = (impl) => vi.fn(impl);
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const fail = (status) => ({ ok: false, status, json: async () => ({}), text: async () => '' });

describe('configuration locale', () => {
  it('se lit, s’écrit et s’efface', () => {
    const store = memStore();
    expect(loadSyncConfig(store)).toBeNull();
    saveSyncConfig(store, { token: 't', gistId: 'g', deviceId: 'dev-a' });
    expect(loadSyncConfig(store)).toMatchObject({ token: 't', gistId: 'g' });
    clearSyncConfig(store);
    expect(loadSyncConfig(store)).toBeNull();
  });

  it('vit sous SA PROPRE clé : un export de données ne peut pas divulguer le jeton', () => {
    const store = memStore();
    saveSyncConfig(store, { token: 'secret-token', gistId: 'g' });
    // l'état CADENCE est stocké ailleurs et ne contient jamais le jeton
    const exported = JSON.stringify(seedState());
    expect(exported).not.toContain('secret-token');
    expect(SYNC_KEY).not.toBe('cadence.v2');
    expect(Object.keys(store.mem)).toEqual([SYNC_KEY]);
  });

  it('stockage illisible : pas d’exception, configuration nulle', () => {
    const broken = { getItem: () => '{{{', setItem: () => { throw new Error('plein'); }, removeItem: () => {} };
    expect(loadSyncConfig(broken)).toBeNull();
    expect(saveSyncConfig(broken, { token: 't' })).toBe(false);
  });

  it('isConfigured exige jeton ET coffre', () => {
    expect(isConfigured(null)).toBe(false);
    expect(isConfigured({ token: 't' })).toBe(false);
    expect(isConfigured({ gistId: 'g' })).toBe(false);
    expect(isConfigured({ token: 't', gistId: 'g' })).toBe(true);
  });
});

describe('opérations sur le coffre', () => {
  it('crée un coffre PRIVÉ contenant le fichier CADENCE', async () => {
    const f = fakeFetch(async () => ok({ id: 'gist-1', history: [{ version: 'v1' }] }));
    const res = await createVault('tok', seedState(), f);
    expect(res.gistId).toBe('gist-1');
    const [url, init] = f.mock.calls[0];
    expect(url).toContain('/gists');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.public).toBe(false); // jamais public
    expect(body.files[VAULT_FILE].content).toContain('"version"');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('lit le coffre et renvoie l’état', async () => {
    const state = seedState();
    const f = fakeFetch(async () => ok({
      files: { [VAULT_FILE]: { content: JSON.stringify(state) } },
      history: [{ version: 'v2' }],
    }));
    const { state: pulled, version } = await pullVault({ token: 't', gistId: 'g' }, f);
    expect(pulled.version).toBe(12);
    expect(version).toBe('v2');
  });

  it('coffre vide (pas encore de fichier) : état null, sans erreur', async () => {
    const f = fakeFetch(async () => ok({ files: {}, history: [] }));
    await expect(pullVault({ token: 't', gistId: 'g' }, f)).resolves.toMatchObject({ state: null });
  });

  it('contenu tronqué : relecture du fichier brut', async () => {
    const state = seedState();
    const f = fakeFetch(async (url) => {
      if (String(url).includes('raw')) return { ok: true, status: 200, text: async () => JSON.stringify(state) };
      return ok({ files: { [VAULT_FILE]: { truncated: true, raw_url: 'https://raw/x', content: '' } }, history: [] });
    });
    const { state: pulled } = await pullVault({ token: 't', gistId: 'g' }, f);
    expect(pulled.version).toBe(12);
  });

  it('coffre corrompu : erreur explicite, rien n’est écrasé', async () => {
    const f = fakeFetch(async () => ok({ files: { [VAULT_FILE]: { content: 'pas du json' } }, history: [] }));
    await expect(pullVault({ token: 't', gistId: 'g' }, f)).rejects.toMatchObject({ kind: 'donnees' });
  });

  it('écrit l’état dans le coffre', async () => {
    const f = fakeFetch(async () => ok({ history: [{ version: 'v3' }] }));
    const res = await pushVault({ token: 't', gistId: 'g' }, seedState(), f);
    expect(res.version).toBe('v3');
    const [url, init] = f.mock.calls[0];
    expect(url).toContain('/gists/g');
    expect(init.method).toBe('PATCH');
  });

  it('vérifie un jeton et renvoie le compte', async () => {
    const f = fakeFetch(async () => ok({ login: 'bobodelatess' }));
    await expect(checkToken('t', f)).resolves.toEqual({ login: 'bobodelatess' });
  });
});

describe('erreurs lisibles', () => {
  const cases = [
    [401, 'auth', /jeton/i],
    [403, 'quota', /refus|limite/i],
    [404, 'introuvable', /introuvable/i],
    [422, 'donnees', /refus/i],
  ];
  for (const [status, kind, re] of cases) {
    it(`code ${status} -> ${kind}, message en français`, async () => {
      const f = fakeFetch(async () => fail(status));
      await expect(pullVault({ token: 't', gistId: 'g' }, f)).rejects.toMatchObject({ kind });
      await pullVault({ token: 't', gistId: 'g' }, f).catch((e) => {
        expect(e).toBeInstanceOf(SyncError);
        expect(e.message).toMatch(re);
      });
    });
  }

  it('panne réseau : message rassurant, reprise automatique annoncée', async () => {
    const f = fakeFetch(async () => { throw new TypeError('offline'); });
    await pullVault({ token: 't', gistId: 'g' }, f).catch((e) => {
      expect(e.kind).toBe('reseau');
      expect(e.message).toMatch(/connexion/i);
    });
  });
});
