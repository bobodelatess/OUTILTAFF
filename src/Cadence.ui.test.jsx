// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, within, fireEvent, cleanup } from '@testing-library/react';
import Cadence from './Cadence.jsx';
import { STORAGE_KEY, AXIS_MINUTES, emptyPractice } from './engine.js';

// Vrais tests d'interaction (jsdom) : on rend l'application complète, on
// clique, et on vérifie l'état PERSISTÉ (localStorage) — pas seulement le DOM.

const SEED_RECALL = { stability: 2, difficulty: 8.5, lastReviewed: null, source: 'seed' };
const baseState = () => ({
  version: 4,
  subjects: [
    { id: 's1', name: 'Maths', color: '#7c9cf5', type: 'core' },
  ],
  chapters: [{
    id: 'c1', subjectId: 's1', name: 'Endomorphismes', initialLevel: 'new',
    recall: { ...SEED_RECALL },
    exercise: emptyPractice(),
    problem: emptyPractice(),
    minutes: { ...AXIS_MINUTES },
  }],
  exams: [],
  settings: {
    requestRetention: 0.9, subjectsPerDay: 3, sessionHours: 2, minutesPerChapter: 30,
    maxExamPressure: 5, pressureHorizon: 35, examModeThreshold: 21,
    minInterval: 2, maxInterval: 30, simpleMode: true,
  },
  parallelLog: {}, reviewLog: [], archivedReviews: [], skips: {},
  capacityOverrides: {}, lastExportAt: null,
});

const readState = () => JSON.parse(window.localStorage.getItem(STORAGE_KEY));
const card = () => screen.getByText('Endomorphismes').closest('.cad-card');

beforeEach(() => {
  cleanup();
  window.localStorage.clear();
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(baseState()));
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('alert', vi.fn());
});

describe('Cadence — interactions réelles (jsdom)', () => {
  it('la carte du plan propose l’axe dominant (rappel jamais testé) et sa raison', () => {
    render(<Cadence />);
    const c = card();
    expect(within(c).getByText('cours jamais testé')).toBeTruthy();
    // étiquette de l'axe prioritaire + notation adaptée au rappel
    expect(within(c).getByTitle(/axe prioritaire : rappel du cours/)).toBeTruthy();
    expect(within(c).getByText('Oublié')).toBeTruthy();
    expect(within(c).getByText('Immédiat')).toBeTruthy();
    // plus AUCUN sélecteur global de preuve
    expect(screen.queryByLabelText('Type de preuve')).toBeNull();
  });

  it('changer l’axe sur la carte, noter un exercice : SEUL l’axe exercice change', () => {
    render(<Cadence />);
    const c = card();
    fireEvent.click(within(c).getByRole('button', { name: /^Exercice/ }));
    // les 4 issues passent au vocabulaire exercice
    expect(within(c).getByText('Autonome et propre')).toBeTruthy();
    fireEvent.click(within(c).getByText('Autonome')); // note 3
    const st = readState();
    const ch = st.chapters[0];
    // axe exercice avancé…
    expect(ch.exercise.attempts).toBe(1);
    expect(ch.exercise.score).toBeCloseTo(0.8);
    // …rappel et problème STRICTEMENT intacts
    expect(ch.recall).toEqual(SEED_RECALL);
    expect(ch.problem.attempts).toBe(0);
    // journal : une entrée typée, avec instantanés avant/après de l'axe
    expect(st.reviewLog.length).toBe(1);
    expect(st.reviewLog[0]).toMatchObject({ chapterId: 'c1', evidenceType: 'exercise', axis: 'exercise', grade: 3 });
    expect(st.reviewLog[0].before.attempts).toBe(0);
    // retour visuel
    expect(screen.getByRole('status').textContent).toContain('Exercice : « Autonome »');
  });

  it('trois preuves le même jour sur la même carte : trois entrées, trois axes', () => {
    render(<Cadence />);
    let c = card();
    // 1. exercice
    fireEvent.click(within(c).getByRole('button', { name: /^Exercice/ }));
    fireEvent.click(within(c).getByText('Autonome'));
    // 2. l'axe re-proposé est un axe restant (rappel) — on note le rappel
    c = card();
    fireEvent.click(within(c).getByText('Correct'));
    // 3. puis le problème
    c = card();
    fireEvent.click(within(c).getByText('Résolu'));
    const st = readState();
    expect(st.reviewLog.length).toBe(3);
    expect(new Set(st.reviewLog.map((r) => r.axis))).toEqual(new Set(['recall', 'exercise', 'problem']));
    const ch = st.chapters[0];
    expect(ch.recall.lastReviewed).toBeTruthy();
    expect(ch.exercise.attempts).toBe(1);
    expect(ch.problem.attempts).toBe(1);
    // la carte montre les trois axes faits
    c = card();
    expect(within(c).getAllByTitle('Annuler ce test').length).toBe(3);
  });

  it('un axe déjà noté aujourd’hui est bloqué sur la carte (pas de double note)', () => {
    render(<Cadence />);
    let c = card();
    fireEvent.click(within(c).getByRole('button', { name: /^Exercice/ }));
    fireEvent.click(within(c).getByText('Autonome'));
    c = card();
    // re-sélectionner l'axe exercice : ses boutons de note n'apparaissent plus
    fireEvent.click(within(c).getByRole('button', { name: /^Exercice/ }));
    expect(within(card()).queryByText('Autonome et propre')).toBeNull();
    expect(readState().reviewLog.length).toBe(1);
  });

  it('annuler une note restaure exactement l’état de l’axe', () => {
    render(<Cadence />);
    const c = card();
    fireEvent.click(within(c).getByRole('button', { name: /^Exercice/ }));
    fireEvent.click(within(c).getByText('Autonome'));
    expect(readState().chapters[0].exercise.attempts).toBe(1);
    fireEvent.click(within(card()).getByTitle('Annuler ce test'));
    const st = readState();
    expect(st.reviewLog.length).toBe(0);
    expect(st.chapters[0].exercise).toEqual(emptyPractice());
    expect(st.chapters[0].recall).toEqual(SEED_RECALL);
  });

  it('ajout de chapitres en lot : un par ligne, niveaux et durées par défaut', () => {
    render(<Cadence />);
    fireEvent.click(screen.getByRole('button', { name: /Matières/ }));
    fireEvent.click(screen.getByLabelText('déplier'));
    fireEvent.click(screen.getByRole('button', { name: /en lot/ }));
    fireEvent.change(screen.getByLabelText('chapitres en lot (un par ligne)'), {
      target: { value: 'Espaces vectoriels\n  Déterminants  \n\nRéduction\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Ajouter 3 chapitres/ }));
    const st = readState();
    expect(st.chapters.length).toBe(4);
    const names = st.chapters.map((c) => c.name);
    expect(names).toContain('Espaces vectoriels');
    expect(names).toContain('Déterminants'); // espaces nettoyés, lignes vides ignorées
    const added = st.chapters.find((c) => c.name === 'Réduction');
    expect(added.initialLevel).toBe('new');
    expect(added.minutes).toEqual({ recall: 15, exercise: 30, problem: 60 });
    expect(added.exercise.attempts).toBe(0);
  });

  it('0 h disponible : pas de faux plan, échéances intactes', () => {
    render(<Cadence />);
    fireEvent.click(screen.getByRole('button', { name: '0 h' }));
    expect(screen.getByText(/Pas de séance prévue aujourd’hui/)).toBeTruthy();
    expect(readState().capacityOverrides[Object.keys(readState().capacityOverrides)[0]]).toBe(0);
    expect(screen.queryByText('Oublié')).toBeNull(); // plus de carte à noter
  });

  it('les indicateurs de Progrès séparent les trois axes et affichent « non testé »', () => {
    render(<Cadence />);
    fireEvent.click(screen.getByRole('button', { name: /Progrès/ }));
    expect(screen.getByText('Rappel du cours')).toBeTruthy();
    expect(screen.getByText('Exercices — autonomie')).toBeTruthy();
    expect(screen.getByText('Problèmes / annales — transfert')).toBeTruthy();
    // 1 chapitre, rien de testé : chaque axe annonce son « jamais testé »
    expect(screen.getAllByText(/1 jamais testé sur cet axe/).length).toBe(3);
    // pas de « série » (streak) qui pousse à tester facile tous les jours
    expect(screen.queryByText(/d’affilée/)).toBeNull();
  });
});
