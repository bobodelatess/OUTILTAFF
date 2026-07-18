// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, within, fireEvent, cleanup, waitFor } from '@testing-library/react';
import Cadence from './Cadence.jsx';
import { STORAGE_KEY, AXIS_MINUTES, emptyPractice, todayISO, addDays } from './engine.js';

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
    fireEvent.click(screen.getByRole('button', { name: /Déplier Maths/i }));
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

  it('les raccourcis 1–4 fonctionnent avec les touches physiques d’un clavier AZERTY', () => {
    render(<Cadence />);
    fireEvent.keyDown(card(), { key: '&', code: 'Digit1' });
    expect(readState().reviewLog[0]).toMatchObject({ grade: 1, axis: 'recall' });
  });

  it('n’annonce pas « tout est à jour » quand un bloc dû ne tient pas dans la séance', () => {
    const st = baseState();
    st.settings.sessionHours = 1;
    st.capacityOverrides = { [todayISO()]: 120 };
    st.chapters[0] = {
      ...st.chapters[0],
      recall: { stability: 30, difficulty: 8.5, lastReviewed: todayISO(), source: 'seed' },
      exercise: { score: 1, attempts: 1, lastTested: todayISO(), recentFails: 0 },
      problem: emptyPractice(),
      minutes: { recall: 15, exercise: 30, problem: 90 },
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(st));

    render(<Cadence />);

    expect(screen.getByText(/Du travail est dû, mais aucun bloc ne tient/)).toBeTruthy();
    expect(screen.queryByText(/tout est à jour/)).toBeNull();
  });

  it('ne remplace jamais silencieusement un stockage local corrompu', () => {
    const broken = '{"version":4,';
    window.localStorage.setItem(STORAGE_KEY, broken);

    render(<Cadence />);

    expect(screen.getByRole('alert').textContent).toMatch(/données locales sont illisibles/i);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(broken);
  });

  it('détecte une modification provenant d’un autre onglet avant tout écrasement', () => {
    render(<Cadence />);
    const other = baseState();
    other.subjects[0] = { ...other.subjects[0], name: 'Maths — autre onglet' };

    fireEvent(window, new StorageEvent('storage', {
      key: STORAGE_KEY,
      newValue: JSON.stringify(other),
    }));

    expect(screen.getByText(/Une autre fenêtre a modifié CADENCE/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Charger l’autre version/ }));
    expect(readState().subjects[0].name).toBe('Maths — autre onglet');
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

  it('clavier : r/e/p change l’axe de la carte sélectionnée', () => {
    render(<Cadence />);
    const c = card();
    fireEvent.keyDown(c, { key: 'e' });
    expect(within(card()).getByText('Autonome et propre')).toBeTruthy();
    fireEvent.keyDown(card(), { key: 'p' });
    expect(within(card()).getByText('Résolu proprement dans le temps')).toBeTruthy();
    fireEvent.keyDown(card(), { key: 'r' });
    expect(within(card()).getByText('Immédiat')).toBeTruthy();
  });

  it('la durée de l’axe est ajustable depuis les détails de la carte', () => {
    render(<Cadence />);
    const c = card();
    fireEvent.click(within(c).getByRole('button', { name: /détails/ }));
    fireEvent.change(within(card()).getByLabelText('durée rappel du cours'), { target: { value: '45' } });
    expect(readState().chapters[0].minutes.recall).toBe(45);
    expect(readState().chapters[0].minutes.exercise).toBe(30); // les autres axes ne bougent pas
  });

  it('le démarrage rapide mène directement au champ d’ajout de chapitre', async () => {
    const st = baseState();
    st.chapters = [];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(st));

    render(<Cadence />);

    expect(screen.getByRole('heading', { name: /plan devient précis en trois étapes/i })).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: /progression de la configuration/i }).getAttribute('aria-valuenow')).toBe('0');
    fireEvent.click(screen.getByRole('button', { name: /Ajouter mes chapitres/i }));

    const chapterInput = await screen.findByLabelText(/Nouveau chapitre/i);
    await waitFor(() => expect(document.activeElement).toBe(chapterInput));
    expect(screen.getByRole('heading', { name: /Matières \(UE\)/i })).toBeTruthy();
  });

  it('la recherche rapide est insensible aux accents et ouvre le chapitre exact', async () => {
    const st = baseState();
    st.chapters[0].name = 'Électromagnétisme';
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(st));

    render(<Cadence />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

    const input = screen.getByRole('searchbox', { name: /Rechercher un chapitre/i });
    fireEvent.change(input, { target: { value: 'electromagnetisme' } });
    expect(screen.getByRole('status').textContent).toBe('1 résultat');
    fireEvent.click(screen.getByRole('button', { name: /Électromagnétisme.*Maths/i }));

    const chapterName = await screen.findByLabelText('Nom du chapitre Électromagnétisme');
    await waitFor(() => expect(document.activeElement).toBe(chapterName));
    expect(screen.queryByRole('dialog', { name: /Trouver un chapitre/i })).toBeNull();
  });

  it('le raccourci / ne vole pas le clavier pendant la saisie', () => {
    render(<Cadence />);
    fireEvent.click(screen.getByRole('button', { name: /Matières/i }));
    fireEvent.click(screen.getByRole('button', { name: /Déplier Maths/i }));
    const chapterName = screen.getByLabelText('Nom du chapitre Endomorphismes');
    chapterName.focus();
    fireEvent.keyDown(chapterName, { key: '/' });
    expect(screen.queryByRole('dialog', { name: /Trouver un chapitre/i })).toBeNull();
  });

  it('le mode focus n’affiche qu’un chapitre, réinitialise son état local et rend le focus à la sortie', async () => {
    const st = baseState();
    st.chapters.push({
      id: 'c2', subjectId: 's1', name: 'Espaces vectoriels', initialLevel: 'new',
      recall: { ...SEED_RECALL }, exercise: emptyPractice(), problem: emptyPractice(),
      minutes: { ...AXIS_MINUTES },
    });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(st));

    render(<Cadence />);
    const toggle = screen.getByRole('button', { name: 'Mode focus' });
    fireEvent.click(toggle);

    let currentCard = screen.getByText('Endomorphismes').closest('.cad-card');
    expect(screen.queryByText('Espaces vectoriels')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Rechercher/ }));
    const searchInput = screen.getByRole('searchbox', { name: /Rechercher un chapitre/i });
    fireEvent.keyDown(searchInput, { key: 'ArrowRight', altKey: true });
    const focusPanel = document.getElementById('cad-focus-panel');
    expect(within(focusPanel).getByText('Endomorphismes')).toBeTruthy();
    expect(within(focusPanel).queryByText('Espaces vectoriels')).toBeNull();
    fireEvent.keyDown(searchInput, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /Trouver un chapitre/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Quitter le focus' })).toBeTruthy();

    fireEvent.click(within(currentCard).getByRole('button', { name: /^Exercice/ }));
    expect(within(currentCard).getByText('Autonome et propre')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Suivant' }));

    currentCard = screen.getByText('Espaces vectoriels').closest('.cad-card');
    expect(screen.queryByText('Endomorphismes')).toBeNull();
    expect(within(currentCard).getByText('Immédiat')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(toggle));
    expect(screen.getByText('Endomorphismes')).toBeTruthy();
    expect(screen.getByText('Espaces vectoriels')).toBeTruthy();
  });

  it('entrer en focus depuis le classement complet rend immédiatement la carte', () => {
    render(<Cadence />);
    fireEvent.click(screen.getByRole('button', { name: /voir tout le classement/i }));
    expect(screen.queryByRole('group', { name: /Endomorphismes — rappel du cours/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Commencer mon plan/i }));

    expect(screen.getByRole('region', { name: 'Maths' })).toBeTruthy();
    expect(screen.getByRole('group', { name: /Endomorphismes — rappel du cours/i })).toBeTruthy();
  });
});

describe('Bilan d’épreuve (épreuve passée hier)', () => {
  const withPastExam = () => {
    const st = baseState();
    st.chapters.push({
      id: 'c2', subjectId: 's1', name: 'Espaces euclidiens', initialLevel: 'new',
      recall: { ...SEED_RECALL }, exercise: emptyPractice(), problem: emptyPractice(),
      minutes: { ...AXIS_MINUTES },
    });
    st.exams = [{
      id: 'e1', subjectId: 's1', name: 'Partiel A', date: addDays(todayISO(), -1),
      chapterIds: ['c1', 'c2'], importance: 'normal',
    }];
    return st;
  };
  beforeEach(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(withPastExam()));
  });

  it('propose de noter le constat (axe problème) ; noter ne touche que cet axe', () => {
    render(<Cadence />);
    expect(screen.getByText(/passée hier/)).toBeTruthy();
    const banner = screen.getByText(/passée hier/).closest('.cad-card');
    // noter le constat du 1er chapitre : Résolu (note 3)
    const row = within(banner).getByText('Endomorphismes').closest('div');
    fireEvent.click(within(row).getByText('Résolu'));
    const st = readState();
    const c1 = st.chapters.find((c) => c.id === 'c1');
    expect(c1.problem.attempts).toBe(1);
    expect(c1.recall).toEqual(SEED_RECALL);       // rappel intact
    expect(c1.exercise.attempts).toBe(0);          // exercice intact
    // la ligne passe en « constat noté », l'autre chapitre reste à noter
    expect(within(screen.getByText(/passée hier/).closest('.cad-card')).getByText('constat noté')).toBeTruthy();
    expect(st.reviewLog[0]).toMatchObject({
      evidenceType: 'problem', axis: 'problem', source: 'exam-debrief', examId: 'e1',
      date: addDays(todayISO(), -1), recordedAt: todayISO(),
    });
  });

  it('tout noter fait disparaître le bilan ; « masquer » le range définitivement', () => {
    render(<Cadence />);
    let banner = screen.getByText(/passée hier/).closest('.cad-card');
    fireEvent.click(within(within(banner).getByText('Endomorphismes').closest('div')).getByText('Résolu'));
    banner = screen.getByText(/passée hier/).closest('.cad-card');
    fireEvent.click(within(within(banner).getByText('Espaces euclidiens').closest('div')).getByText('Bloqué'));
    expect(screen.queryByText(/passée hier/)).toBeNull(); // tout constaté
  });

  it('« masquer » stocke le choix et retire la bannière', () => {
    render(<Cadence />);
    fireEvent.click(screen.getByRole('button', { name: 'masquer' }));
    expect(screen.queryByText(/passée hier/)).toBeNull();
    expect(readState().examDebriefs.e1).toBe(todayISO());
  });
});

describe('Import par collage (Réglages)', () => {
  it('texte non-JSON ou état invalide : refus, aucune donnée modifiée', () => {
    render(<Cadence />);
    fireEvent.click(screen.getByRole('button', { name: /Réglages/ }));
    fireEvent.click(screen.getByRole('button', { name: /Importer par collage/ }));
    const area = screen.getByLabelText('export JSON à coller');
    fireEvent.change(area, { target: { value: 'pas du json' } });
    fireEvent.click(screen.getByRole('button', { name: /Valider l’import/ }));
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('JSON'));
    expect(readState().chapters.length).toBe(1);
    fireEvent.change(area, { target: { value: '{"subjects":"nope"}' } });
    fireEvent.click(screen.getByRole('button', { name: /Valider l’import/ }));
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Import refusé'));
    expect(readState().chapters.length).toBe(1); // rien n'a bougé
  });

  it('état valide : confirmation puis remplacement complet', () => {
    render(<Cadence />);
    fireEvent.click(screen.getByRole('button', { name: /Réglages/ }));
    fireEvent.click(screen.getByRole('button', { name: /Importer par collage/ }));
    fireEvent.change(screen.getByLabelText('export JSON à coller'),
      { target: { value: '{"subjects":[]}' } });
    fireEvent.click(screen.getByRole('button', { name: /Valider l’import/ }));
    const st = readState();
    expect(st.version).toBe(4);
    expect(st.subjects.length).toBe(0);
    expect(st.chapters.length).toBe(0);
  });
});
