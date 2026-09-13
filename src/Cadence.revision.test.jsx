// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import Cadence from './Cadence.jsx';
import { DEFAULT_SETTINGS, LEVELS, STORAGE_KEY, addDays, isReviewUnit, newChapter, newCourseTest, normalize, seedState, todayISO, upsertReviewUnit } from './engine.js';
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
const point = (category, text) => ({ id: category, category, text, order: 0, updatedAt: 100, deleted: false });
const openNotes = () => {
  fireEvent.click(screen.getByRole('button', { name: /^Matières/ }));
  fireEvent.click(screen.getByRole('button', { name: /^Déplier / }));
  fireEvent.click(screen.getByRole('button', { name: 'Notes enregistrées' }));
};

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('alert', vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('accueil léger et conservation des notes existantes', () => {
  it('garde les notes dans Matières, derrière un bouton, sans les imposer à l’accueil', async () => {
    const original = setupState(todayISO());
    original.chapters.find(isReviewUnit).revisionPoints = [
      point('course', 'Diagonalisation : $A=PDP^{-1}$.'),
      point('methods', 'Calculer chaque espace propre.'),
      point('proofs', 'Liberté des vecteurs propres de valeurs distinctes.'),
    ];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(original));
    const { unmount } = render(<Cadence />);
    const card = screen.getByRole('group', { name: 'Endomorphismes — continuité' });
    expect(within(card).queryByRole('listitem')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Renseigner les listes' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Matières/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Déplier / }));
    expect(screen.queryByRole('heading', { name: 'Cours' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Notes enregistrées' }));
    fireEvent.click(screen.getByRole('button', { name: 'Modifier les listes' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Cours' }), { target: { value: 'Diagonalisation : $A=PDP^{-1}$. Blocage : sens du changement de base.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer les listes' }));
    await waitFor(() => expect(visibleRevisionPoints(readState().chapters.find(isReviewUnit).revisionPoints).some((p) => p.text.includes('Blocage'))).toBe(true));
    const saved = readState();
    expect(saved.chapters.find(isReviewUnit).recall).toEqual(original.chapters.find(isReviewUnit).recall);
    expect(saved.chapters.find(isReviewUnit).introducedAt).toBe(todayISO());
    expect(saved.reviewLog).toEqual([]);
    expect(saved.courseTestLog).toEqual([]);
    expect(saved.habitLog).toEqual([]);
    unmount();
    render(<Cadence />);
    const restored = screen.getByRole('group', { name: 'Endomorphismes — continuité' });
    expect(within(restored).queryByRole('listitem')).toBeNull();
    openNotes();
    expect(screen.getByRole('heading', { name: 'Méthodes d’exercices' })).toBeTruthy();
    expect(screen.getByText('Calculer chaque espace propre.')).toBeTruthy();
    expect(document.querySelector('.katex')).toBeTruthy();
  });

  it('la consolidation garde son auto-évaluation, sans listes ni nouvelle révision fictive', () => {
    const state = setupState(addDays(todayISO(), -1));
    state.chapters.find(isReviewUnit).revisionPoints = [{ id: 'p1', category: 'proofs', text: 'Démonstration à restituer.', order: 0, updatedAt: 100, deleted: false }];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    render(<Cadence />);
    const card = screen.getByRole('group', { name: /diagonalisation — consolidation/ });
    expect(within(card).queryByText('Démonstration à restituer.')).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Modifier les listes' })).toBeNull();
    expect(within(card).getByRole('group', { name: 'Maîtrise après reprise' })).toBeTruthy();
    expect(readState().reviewLog).toEqual([]);
  });

  it('ne demande pas de notes pour une portion nouvelle', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(setupState(todayISO())));
    render(<Cadence />);
    fireEvent.click(screen.getByRole('button', { name: /^Matières/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Déplier / }));
    expect(screen.queryByText('Notes enregistrées')).toBeNull();
    expect(screen.queryByText('Renseigner les listes')).toBeNull();
    expect(readState().reviewLog).toEqual([]);
  });

  it('charge l’accueil et le calendrier lorsqu’une portion intégrée est couverte par un test', () => {
    const state = setupState(addDays(todayISO(), -40));
    const unit = state.chapters.find(isReviewUnit);
    unit.integratedAt = addDays(todayISO(), -20);
    unit.recall.lastReviewed = unit.integratedAt;
    unit.reviewSuccessStreak = 2;
    state.courseTests = [newCourseTest(unit.subjectId, 'Test cumulatif', addDays(todayISO(), 2), [unit.parentChapterId], [], todayISO())];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    render(<Cadence />);
    expect(screen.getByRole('group', { name: 'Endomorphismes — continuité' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: /— consolidation/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Calendrier', exact: true }));
    expect(screen.getByRole('main').textContent).toContain('Test cumulatif');
    expect(readState().chapters.find(isReviewUnit).integratedAt).toBe(unit.integratedAt);
    expect(readState().reviewLog).toEqual([]);
  });
});
