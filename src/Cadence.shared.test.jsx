// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, cleanup, renderHook } from '@testing-library/react';
import Cadence from './Cadence.jsx';
import { seedState, normalize, STORAGE_KEY } from './engine.js';
import { SYNC_KEY, pushVault } from './remote.js';
import { useSync, useSyncTriggers, SYNC_POLL_MS } from './useSync.js';

const shared = { gistId: 'shared-vault', owner: 'owner', updatesUrl: './study-updates.json' };
const makeStore = () => {
  const mem = {};
  return { mem, getItem: (k) => mem[k] ?? null, setItem: (k, v) => { mem[k] = v; }, removeItem: (k) => { delete mem[k]; } };
};
function setup() {
  const state = normalize(seedState());
  const feed = { version: 1, gistId: shared.gistId, updates: [{
    id: 'update1', date: '2026-09-15', subjectId: state.subjects[0].id,
    chapterId: 'matrix', chapterName: 'Matrices', label: 'Ajout du 15/09/2026 — noyau',
    docs: [{ id: 'pdf', label: 'PDF du cours', url: 'https://drive.google.com/file/d/example/view' }],
  }] };
  let remote = state;
  const fetchImpl = vi.fn(async (url, init = {}) => {
    if (url === shared.updatesUrl) return { ok: true, json: async () => feed };
    if (url.startsWith('https://gist.githubusercontent.com/')) return { ok: true, json: async () => remote };
    if (init.method === 'PATCH') remote = JSON.parse(JSON.parse(init.body).files['cadence-sync.json'].content);
    return { ok: true, json: async () => ({ owner: { login: shared.owner }, files: { 'cadence-sync.json': { content: JSON.stringify(remote) } } }) };
  });
  return { state, feed, fetchImpl, remote: () => remote };
}
afterEach(() => { cleanup(); delete window.storage; vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('consultation et mises à jour protégées', () => {
  it('charge le vrai suivi sans jeton, montre les ajouts et bloque les mutations', async () => {
    const { fetchImpl } = setup();
    const store = makeStore();
    window.storage = store;
    vi.stubGlobal('fetch', fetchImpl);
    vi.stubGlobal('confirm', vi.fn(() => true));
    render(<Cadence sharedVault={shared} />);
    await waitFor(() => expect(JSON.parse(store.getItem(STORAGE_KEY)).appliedStudyUpdates).toEqual(['update1']));
    expect(screen.getByText(/Consultation — ton suivi/)).toBeTruthy();
    expect(screen.getAllByText('Matrices').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Passer en édition' }));
    fireEvent.click(screen.getByRole('button', { name: 'Réinitialiser', exact: true }));
    expect(global.confirm).not.toHaveBeenCalled();
    expect(JSON.parse(store.getItem(STORAGE_KEY)).chapters).toHaveLength(2);
    expect(fetchImpl.mock.calls.every(([, init = {}]) => init.method !== 'PATCH' && !init.headers?.Authorization)).toBe(true);
    expect(JSON.parse(store.getItem(STORAGE_KEY)).reviewLog).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Activer les modifications' }));
    expect(screen.getByLabelText('jeton GitHub')).toBeTruthy();
    expect(screen.queryByLabelText('identifiant du coffre')).toBeNull();
  });

  it('un appareil déjà autorisé enregistre les ajouts dans le coffre et ne les rejoue pas', async () => {
    const { state, fetchImpl, remote } = setup();
    const store = makeStore();
    store.setItem(SYNC_KEY, JSON.stringify({ token: 'owner-token', gistId: shared.gistId }));
    let local = state;
    const { result } = renderHook(() => useSync({ store, sharedVault: shared, getState: () => local, applyMerged: (s) => { local = s; }, fetchImpl }));
    await act(() => result.current.syncNow());
    expect(remote().appliedStudyUpdates).toEqual(['update1']);
    expect(remote().chapters).toHaveLength(2);
    expect(remote().reviewLog).toEqual([]);
    await act(() => result.current.syncNow());
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
    expect(JSON.stringify(remote())).not.toContain('owner-token');
  });

  it('la lecture seule ne peut jamais envoyer de données, même avec un jeton résiduel', async () => {
    const fetchImpl = vi.fn();
    await expect(pushVault({ token: 't', gistId: shared.gistId, readOnly: true }, {}, fetchImpl)).rejects.toThrow();
    await expect(pushVault({ gistId: shared.gistId }, {}, fetchImpl)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('actualise périodiquement un onglet visible et cesse à la fermeture', () => {
    vi.useFakeTimers();
    const syncNow = vi.fn();
    const markPending = vi.fn();
    const { unmount } = renderHook(() => useSyncTriggers({ configured: true, signature: 'same', syncNow, markPending }));
    expect(syncNow).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(SYNC_POLL_MS));
    expect(syncNow).toHaveBeenCalledTimes(2);
    unmount();
    act(() => vi.advanceTimersByTime(SYNC_POLL_MS));
    expect(syncNow).toHaveBeenCalledTimes(2);
  });
});
