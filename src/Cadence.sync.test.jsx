// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, within, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import Cadence from './Cadence.jsx';
import {
  STORAGE_KEY, AXIS_MINUTES, DEFAULT_SETTINGS, addDays, emptyPractice,
  emptyDeleted, newReviewUnit, todayISO,
} from './engine.js';
import { SYNC_KEY, DEVICE_KEY, VAULT_FILE } from './remote.js';

/*
 * Le test qui compte vraiment : téléphone et ordinateur voient les mêmes
 * données. On simule DEUX navigateurs (deux stockages distincts) partageant
 * un même coffre en mémoire, et on vérifie la convergence de bout en bout.
 */

const VAULT_ID = 'vault-1';

// Un stockage isolé par « appareil ». makeStore() préfère window.storage.
const makeDevice = (deviceId) => {
  const mem = {};
  return {
    mem, deviceId,
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: (k) => { delete mem[k]; },
  };
};

const seedRecall = { stability: 2, difficulty: 8.5, lastReviewed: null, source: 'seed' };
const chapterOn = (id, name) => ({
  id, subjectId: 's1', name, initialLevel: 'new',
  recall: { ...seedRecall }, exercise: emptyPractice(), problem: emptyPractice(),
  minutes: { ...AXIS_MINUTES },
});

const stateWith = (chapters) => ({
  version: 5,
  subjects: [{ id: 's1', name: 'Maths', color: '#7c9cf5', type: 'core' }],
  chapters,
  exams: [],
  settings: {
    requestRetention: 0.9, subjectsPerDay: 3, sessionHours: 2, minutesPerChapter: 30,
    maxExamPressure: 5, pressureHorizon: 35, examModeThreshold: 21,
    minInterval: 2, maxInterval: 30, simpleMode: true,
  },
  parallelLog: {}, reviewLog: [], archivedReviews: [], skips: {},
  capacityOverrides: {}, examDebriefs: {}, deleted: emptyDeleted(),
  syncMeta: null, lastExportAt: null,
});

const withDueReview = (chapters) => {
  const state = stateWith(chapters);
  const parent = state.chapters[0];
  const introducedAt = addDays(todayISO(), -1);
  const label = `Ajout du ${introducedAt.split('-').reverse().join('/')} — ${parent.name}`;
  parent.position = label;
  parent.positionUpdatedAt = introducedAt;
  state.version = 8;
  state.chapters.push(newReviewUnit(parent, label, introducedAt, DEFAULT_SETTINGS));
  return state;
};

// Coffre distant partagé, en mémoire.
let vault;
const jsonRes = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

const installFetch = () => {
  vault = { content: null, writes: 0 };
  global.fetch = vi.fn(async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.endsWith('/gists') && init.method === 'POST') {
      vault.content = body.files[VAULT_FILE].content;
      vault.writes += 1;
      return jsonRes({ id: VAULT_ID, history: [{ version: `v${vault.writes}` }] });
    }
    if (u.includes(`/gists/${VAULT_ID}`) && init.method === 'PATCH') {
      vault.content = body.files[VAULT_FILE].content;
      vault.writes += 1;
      return jsonRes({ history: [{ version: `v${vault.writes}` }] });
    }
    if (u.includes(`/gists/${VAULT_ID}`)) {
      return jsonRes({
        files: vault.content ? { [VAULT_FILE]: { content: vault.content } } : {},
        history: [{ version: `v${vault.writes}` }],
      });
    }
    if (u.endsWith('/user')) return jsonRes({ login: 'testeur' });
    return { ok: false, status: 404, json: async () => ({}) };
  });
};

// Monte l'application « sur » un appareil donné.
const boot = async (device, { synced = true } = {}) => {
  window.storage = device;
  device.setItem(DEVICE_KEY, device.deviceId);
  if (synced) device.setItem(SYNC_KEY, JSON.stringify({ token: 'tok', gistId: VAULT_ID, deviceId: device.deviceId }));
  const view = render(<Cadence />);
  await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  return view;
};

const vaultState = () => (vault.content ? JSON.parse(vault.content) : null);
const localState = (device) => JSON.parse(device.getItem(STORAGE_KEY));
const card = (name) => screen.getByText(name).closest('.cad-card');
const reviewCard = () => screen.getByRole('group', { name: /— consolidation/ });

// Attend que le coffre satisfasse une condition (le pilote enchaîne
// lecture -> fusion -> écriture de façon asynchrone).
const untilVault = (predicate) => waitFor(() => {
  const st = vaultState();
  expect(st).not.toBeNull();
  expect(predicate(st)).toBe(true);
});

beforeEach(() => {
  installFetch();
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('alert', vi.fn());
});
afterEach(() => { cleanup(); delete window.storage; vi.unstubAllGlobals(); });

describe('synchronisation multi-appareils — bout en bout', () => {
  it('l’ordinateur dépose ses données, le téléphone les retrouve', async () => {
    const pc = makeDevice('dev-pc');
    pc.setItem(STORAGE_KEY, JSON.stringify(stateWith([chapterOn('c1', 'Diagonalisation')])));
    await boot(pc);
    await untilVault((st) => st.chapters.some((c) => c.name === 'Diagonalisation'));
    cleanup();

    // Deuxième appareil, stockage vierge, même coffre.
    const phone = makeDevice('dev-phone');
    await boot(phone);
    await waitFor(() => expect(screen.getAllByText('Diagonalisation').length).toBeGreaterThan(0));
    expect(localState(phone).chapters.map((c) => c.name)).toContain('Diagonalisation');
  });

  it('un appareil neuf ADOPTE le coffre : ses matières par défaut ne polluent rien', async () => {
    const pc = makeDevice('dev-pc');
    pc.setItem(STORAGE_KEY, JSON.stringify(stateWith([chapterOn('c1', 'Diagonalisation')])));
    await boot(pc);
    await untilVault((st) => st.chapters.length === 1);
    cleanup();

    // Téléphone vierge : il démarre sur les matières proposées par défaut.
    const phone = makeDevice('dev-phone');
    await boot(phone);
    await waitFor(() => expect(screen.getAllByText('Diagonalisation').length).toBeGreaterThan(0));
    // Il a adopté l'état distant : une seule matière, pas les 8 du départ.
    expect(localState(phone).subjects.map((s) => s.name)).toEqual(['Maths']);
    expect(vaultState().subjects.map((s) => s.name)).toEqual(['Maths']);
  });

  it('une note prise sur le téléphone remonte sur l’ordinateur', async () => {
    const pc = makeDevice('dev-pc');
    pc.setItem(STORAGE_KEY, JSON.stringify(withDueReview([chapterOn('c1', 'Diagonalisation')])));
    await boot(pc);
    await untilVault((st) => st.chapters.length === 2);
    cleanup();

    // Le téléphone classe une portion réellement reprise.
    const phone = makeDevice('dev-phone');
    await boot(phone);
    await waitFor(() => expect(screen.getAllByText('Diagonalisation').length).toBeGreaterThan(0));
    fireEvent.click(within(reviewCard()).getByRole('button', { name: 'Maîtrisé' }));
    fireEvent.click(screen.getByRole('button', { name: /Synchronisation/i }));
    await untilVault((st) => st.reviewLog.length === 1);
    cleanup();

    // L'ordinateur retrouve la note ET l'état d'axe correspondant.
    const pc2 = makeDevice('dev-pc');
    pc2.setItem(STORAGE_KEY, pc.getItem(STORAGE_KEY));
    await boot(pc2);
    await waitFor(() => {
      const st = localState(pc2);
      expect(st.reviewLog).toHaveLength(1);
      expect(st.chapters.find((c) => c.reviewUnit).recall.lastReviewed).toBe(todayISO());
      expect(st.chapters.find((c) => !c.reviewUnit).recall.lastReviewed).toBeNull();
    });
  });

  it('deux appareils modifiés hors ligne fusionnent sans rien perdre', async () => {
    // État commun déposé dans le coffre.
    const pc = makeDevice('dev-pc');
    pc.setItem(STORAGE_KEY, JSON.stringify(withDueReview([chapterOn('c1', 'Diagonalisation')])));
    await boot(pc);
    await untilVault((st) => st.chapters.length === 2);
    const shared = pc.getItem(STORAGE_KEY);
    cleanup();

    // Le téléphone classe une portion pendant que l'ordinateur ajoute un chapitre.
    const phone = makeDevice('dev-phone');
    phone.setItem(STORAGE_KEY, shared);
    await boot(phone);
    await waitFor(() => expect(screen.getAllByText('Diagonalisation').length).toBeGreaterThan(0));
    fireEvent.click(within(reviewCard()).getByRole('button', { name: 'Maîtrisé' }));
    fireEvent.click(screen.getByRole('button', { name: /Synchronisation/i }));
    await untilVault((st) => st.reviewLog.length === 1);
    cleanup();

    const pc2 = makeDevice('dev-pc');
    // L'ordinateur part de l'état commun (il n'a pas vu la note) et ajoute un chapitre.
    const offline = JSON.parse(shared);
    offline.chapters.push(chapterOn('c2', 'Espaces euclidiens'));
    offline.syncMeta = { deviceId: 'dev-pc', updatedAt: Date.now() + 5000, rev: 9 };
    pc2.setItem(STORAGE_KEY, JSON.stringify(offline));
    await boot(pc2);

    // Les deux contributions coexistent.
    await waitFor(() => {
      const st = localState(pc2);
      expect(st.chapters.filter((c) => !c.reviewUnit).map((c) => c.name).sort())
        .toEqual(['Diagonalisation', 'Espaces euclidiens']);
      expect(st.reviewLog).toHaveLength(1);
      expect(st.chapters.find((c) => c.reviewUnit).recall.lastReviewed).toBe(todayISO());
    });
    await untilVault((st) => st.chapters.length === 3 && st.reviewLog.length === 1);
  });

  it('un chapitre supprimé sur un appareil ne revient pas depuis l’autre', async () => {
    const pc = makeDevice('dev-pc');
    pc.setItem(STORAGE_KEY, JSON.stringify(stateWith([chapterOn('c1', 'Diagonalisation'), chapterOn('c2', 'Espaces euclidiens')])));
    await boot(pc);
    await untilVault((st) => st.chapters.length === 2);
    cleanup();

    // Le téléphone en supprime un.
    const phone = makeDevice('dev-phone');
    await boot(phone);
    await waitFor(() => expect(localState(phone).chapters).toHaveLength(2));
    await waitFor(() => expect(screen.getByText('Espaces euclidiens')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Rechercher/ }));
    fireEvent.change(screen.getByRole('searchbox', { name: /Rechercher un chapitre/ }), {
      target: { value: 'Diagonalisation' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Diagonalisation.*Maths/ }));
    fireEvent.click(await screen.findByTitle('Supprimer le chapitre Diagonalisation'));
    fireEvent.click(screen.getByRole('button', { name: /Synchronisation/i }));
    await untilVault((st) => st.chapters.length === 1);
    cleanup();

    // L'ordinateur, qui a encore les deux, ne le ressuscite pas.
    const pc2 = makeDevice('dev-pc');
    pc2.setItem(STORAGE_KEY, pc.getItem(STORAGE_KEY));
    await boot(pc2);
    await waitFor(() => expect(localState(pc2).chapters).toHaveLength(1));
    await untilVault((st) => st.chapters.length === 1);
  });

  it('coffre distant corrompu : rien n’est écrasé localement, l’erreur est visible', async () => {
    const pc = makeDevice('dev-pc');
    pc.setItem(STORAGE_KEY, JSON.stringify(stateWith([chapterOn('c1', 'Diagonalisation')])));
    vault = { content: '{ ceci n est pas du json', writes: 0 };
    global.fetch = vi.fn(async (url) => (String(url).includes(`/gists/${VAULT_ID}`)
      ? jsonRes({ files: { [VAULT_FILE]: { content: vault.content } }, history: [] })
      : { ok: false, status: 404, json: async () => ({}) }));
    await boot(pc);
    // Les données locales sont intactes et l'application reste utilisable.
    await waitFor(() => expect(screen.getByText('Diagonalisation')).toBeTruthy());
    expect(localState(pc).chapters).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Réglages/ }));
    await waitFor(() => expect(screen.getByText(/coffre distant/i)).toBeTruthy());
  });

  it('jeton refusé : message clair, données intactes', async () => {
    const pc = makeDevice('dev-pc');
    pc.setItem(STORAGE_KEY, JSON.stringify(stateWith([chapterOn('c1', 'Diagonalisation')])));
    global.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    await boot(pc);
    await waitFor(() => expect(screen.getByText('Diagonalisation')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Réglages/ }));
    await waitFor(() => expect(screen.getByText(/Jeton refusé/i)).toBeTruthy());
    expect(localState(pc).chapters).toHaveLength(1);
  });
});

describe('synchronisation — activation et confidentialité', () => {
  it('hors activation, aucun appel réseau n’est fait', async () => {
    const pc = makeDevice('dev-pc');
    pc.setItem(STORAGE_KEY, JSON.stringify(stateWith([chapterOn('c1', 'Diagonalisation')])));
    window.storage = pc;
    render(<Cadence />);
    await act(async () => { await Promise.resolve(); });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Synchronisation/i })).toBeNull();
  });

  it('l’activation crée un coffre PRIVÉ et y dépose l’état', async () => {
    const pc = makeDevice('dev-pc');
    pc.setItem(STORAGE_KEY, JSON.stringify(stateWith([chapterOn('c1', 'Diagonalisation')])));
    window.storage = pc;
    render(<Cadence />);
    fireEvent.click(screen.getByRole('button', { name: /Réglages/ }));
    fireEvent.click(screen.getByRole('button', { name: /Activer la synchronisation/ }));
    fireEvent.change(screen.getByLabelText('jeton GitHub'), { target: { value: 'ghp_test' } });
    fireEvent.click(screen.getByRole('button', { name: /Créer mon coffre privé/ }));
    await waitFor(() => expect(vaultState()?.chapters).toHaveLength(1));
    const [, init] = global.fetch.mock.calls[0];
    expect(JSON.parse(init.body).public).toBe(false);
    await waitFor(() => expect(JSON.parse(pc.getItem(SYNC_KEY)).gistId).toBe(VAULT_ID));
  });

  it('le jeton n’est JAMAIS écrit dans les données ni envoyé dans le coffre', async () => {
    const pc = makeDevice('dev-pc');
    pc.setItem(STORAGE_KEY, JSON.stringify(stateWith([chapterOn('c1', 'Diagonalisation')])));
    pc.setItem(SYNC_KEY, JSON.stringify({ token: 'ghp_ultra_secret', gistId: VAULT_ID, deviceId: 'dev-pc' }));
    await boot(pc, { synced: false });
    await untilVault((st) => st.chapters.length === 1);
    // ni dans le coffre distant, ni dans l'état local exportable
    expect(vault.content).not.toContain('ghp_ultra_secret');
    expect(pc.getItem(STORAGE_KEY)).not.toContain('ghp_ultra_secret');
  });

  it('pas d’emballement : le nombre d’échanges reste borné après une note', async () => {
    const pc = makeDevice('dev-pc');
    pc.setItem(STORAGE_KEY, JSON.stringify(withDueReview([chapterOn('c1', 'Diagonalisation')])));
    await boot(pc);
    await untilVault((st) => st.chapters.length === 2);

    const before = global.fetch.mock.calls.length;
    fireEvent.click(within(reviewCard()).getByRole('button', { name: 'Maîtrisé' }));
    fireEvent.click(screen.getByRole('button', { name: /Synchronisation/i }));
    await untilVault((st) => st.reviewLog.length === 1);

    // Laisser le temps à d'éventuelles boucles de se manifester.
    await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
    // Une note = une poignée d'appels (lecture + écriture, plus une lecture de
    // contrôle), certainement pas une boucle.
    expect(global.fetch.mock.calls.length - before).toBeLessThan(8);
  });

  it('détacher un appareil coupe le lien sans toucher aux données', async () => {
    const pc = makeDevice('dev-pc');
    pc.setItem(STORAGE_KEY, JSON.stringify(stateWith([chapterOn('c1', 'Diagonalisation')])));
    await boot(pc);
    await untilVault((st) => st.chapters.length === 1);
    fireEvent.click(screen.getByRole('button', { name: /Réglages/ }));
    fireEvent.click(screen.getByRole('button', { name: /Détacher cet appareil/ }));
    await waitFor(() => expect(pc.getItem(SYNC_KEY)).toBeNull());
    expect(localState(pc).chapters).toHaveLength(1);
    expect(vaultState().chapters).toHaveLength(1); // le coffre reste intact
  });

  it('l’identifiant de coffre est proposé pour l’appareil suivant', async () => {
    const pc = makeDevice('dev-pc');
    pc.setItem(STORAGE_KEY, JSON.stringify(stateWith([])));
    await boot(pc);
    fireEvent.click(screen.getByRole('button', { name: /Réglages/ }));
    await waitFor(() => expect(screen.getByText(VAULT_ID)).toBeTruthy());
    expect(screen.getByText(/J’ai déjà un coffre/i)).toBeTruthy();
  });
});
