import { describe, expect, it } from 'vitest';
import { BACKUP_KEY, STORAGE_KEY, seedState } from './engine.js';
import {
  QUARANTINE_KEY,
  deserializeCadenceState,
  loadCadenceState,
  saveCadenceState,
  saveDailyBackup,
} from './storage.js';

function memoryStore(initial = {}, persistent = true) {
  const data = { ...initial };
  return {
    persistent,
    getItem: (key) => (Object.hasOwn(data, key) ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: (key) => { delete data[key]; },
    dump: () => ({ ...data }),
  };
}

describe('persistance sûre', () => {
  it('refuse un schéma futur au lieu de le migrer comme un ancien schéma', () => {
    expect(() => deserializeCadenceState(JSON.stringify({ ...seedState(), version: 99 }), '2026-07-15'))
      .toThrow(/Version de données inconnue/);
  });

  it('restaure le dernier instantané valide sans écraser le contenu corrompu', () => {
    const valid = seedState();
    const futureRaw = JSON.stringify({ ...valid, version: 99 });
    const store = memoryStore({
      [STORAGE_KEY]: futureRaw,
      [BACKUP_KEY]: JSON.stringify({ '2026-07-14': valid }),
    });

    const loaded = loadCadenceState(store, '2026-07-15');

    expect(loaded.writeBlocked).toBe(false);
    expect(loaded.notice.code).toBe('recovered');
    expect(loaded.state.version).toBe(6);
    expect(store.getItem(STORAGE_KEY)).toBe(futureRaw);
    expect(JSON.parse(store.getItem(QUARANTINE_KEY)).raw).toBe(futureRaw);
  });

  it('bloque toute réécriture lorsqu’il n’existe aucune récupération valide', () => {
    const broken = '{"version":4,';
    const store = memoryStore({ [STORAGE_KEY]: broken });

    const loaded = loadCadenceState(store, '2026-07-15');

    expect(loaded.writeBlocked).toBe(true);
    expect(loaded.notice.code).toBe('corrupt');
    expect(store.getItem(STORAGE_KEY)).toBe(broken);
  });

  it('signale une écriture refusée au lieu de prétendre avoir sauvegardé', () => {
    const store = {
      persistent: true,
      getItem: () => null,
      setItem: () => { throw new Error('quota dépassé'); },
      removeItem: () => {},
    };
    expect(saveCadenceState(store, seedState())).toEqual({ ok: false, error: 'quota dépassé' });
  });

  it('rend visible le repli en mémoire volatile', () => {
    const loaded = loadCadenceState(memoryStore({}, false), '2026-07-15');
    expect(loaded.writeBlocked).toBe(false);
    expect(loaded.notice).toMatchObject({ code: 'volatile', kind: 'error' });
  });

  it('conserve le premier état de la journée comme instantané pré-changement', () => {
    const store = memoryStore();
    const first = seedState();
    const second = { ...first, subjects: [] };
    expect(saveDailyBackup(store, first, '2026-07-15')).toMatchObject({ ok: true, created: true });
    expect(saveDailyBackup(store, second, '2026-07-15')).toMatchObject({ ok: true, created: false });
    expect(JSON.parse(store.getItem(BACKUP_KEY))['2026-07-15'].subjects).toHaveLength(first.subjects.length);
  });
});

