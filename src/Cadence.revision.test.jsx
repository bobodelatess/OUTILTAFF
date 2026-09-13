// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import Cadence from './Cadence.jsx';
import { DEFAULT_SETTINGS, LEVELS, STORAGE_KEY, addDays, isReviewUnit, newChapter, normalize, seedState, todayISO, upsertReviewUnit } from './engine.js';
import { visibleRevisionPoints } from './revisionPoints.js';

const setupState = (date) => {
  const state = seedState();
  state.subjects = [state.subjects[0]];
  const parent = newChapter(state.subjects[0].id, 'Endomorphismes', LEVELS[0], DEFAULT_SETTINGS);
  parent.status = 'current';
  parent.position = `Ajout du ${date.split('-').reverse().join('/')} — diagonalisation`;
  parent.positionUpdatedAt = date;
  state.chapters = upsertReviewUnit([parent], parent.id, parent.position, state.settings);
  return normalize(state, todayISO());
};
const readState = () => JSON.parse(window.localStorage.getItem(STORAGE_KEY));

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('alert', vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('listes dans CADENCE', () => {
  it('enregistre depuis la continuité, persiste au rechargement et reste dans la matière', async () => {
    const original = setupState(todayISO());
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(original));
    const { unmount } = render(<Cadence />);
    const card = screen.getByRole('group', { name: 'Endomorphismes — continuité' });
    fireEvent.click(within(card).getByRole('button', { name: 'Renseigner les listes' }));
    fireEvent.change(within(card).getByRole('textbox', { name: 'Cours' }), { target: { value: 'Diagonalisation : $A=PDP^{-1}$. Blocage : sens du changement de base.' } });
    fireEvent.change(within(card).getByRole('textbox', { name: 'Méthodes d’exercices' }), { target: { value: 'Calculer chaque espace propre.' } });
    fireEvent.change(within(card).getByRole('textbox', { name: 'Démonstrations' }), { target: { value: 'Liberté des vecteurs propres de valeurs distinctes.' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Enregistrer les listes' }));
    await waitFor(() => expect(visibleRevisionPoints(readState().chapters.find(isReviewUnit).revisionPoints)).toHaveLength(3));
    const saved = readState();
    expect(saved.chapters.find(isReviewUnit).recall).toEqual(original.chapters.find(isReviewUnit).recall);
    expect(saved.chapters.find(isReviewUnit).introducedAt).toBe(todayISO());
    expect(saved.reviewLog).toEqual([]);
    expect(saved.courseTestLog).toEqual([]);
    expect(saved.habitLog).toEqual([]);
    unmount();
    render(<Cadence />);
    const restored = screen.getByRole('group', { name: 'Endomorphismes — continuité' });
    expect(within(restored).getAllByRole('listitem')).toHaveLength(3);
    expect(restored.querySelector('.katex')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Matières/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Déplier / }));
    expect(screen.getByRole('heading', { name: 'Méthodes d’exercices' })).toBeTruthy();
    expect(screen.getByText('Calculer chaque espace propre.')).toBeTruthy();
  });

  it('montre la liste correspondant à la portion due, sans nouvelle révision fictive', () => {
    const state = setupState(addDays(todayISO(), -1));
    state.chapters.find(isReviewUnit).revisionPoints = [{ id: 'p1', category: 'proofs', text: 'Démonstration à restituer.', order: 0, updatedAt: 100, deleted: false }];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    render(<Cadence />);
    const card = screen.getByRole('group', { name: /diagonalisation — consolidation/ });
    expect(within(card).getByText('Démonstration à restituer.')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Masquer pour me tester' }));
    expect(within(card).queryByText('Démonstration à restituer.')).toBeNull();
    expect(within(card).getByRole('group', { name: 'Maîtrise après reprise' })).toBeTruthy();
    expect(readState().reviewLog).toEqual([]);
  });
});
