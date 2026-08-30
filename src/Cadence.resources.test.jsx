// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, within, fireEvent, cleanup, waitFor } from '@testing-library/react';
import Cadence from './Cadence.jsx';
import { STORAGE_KEY, AXIS_MINUTES, emptyPractice, emptyDeleted, todayISO } from './engine.js';

/*
 * Parcours réel : ajouter une ressource qui n'est pas un cours, la travailler,
 * et noter où on s'arrête.
 */

const seedRecall = { stability: 2, difficulty: 8.5, lastReviewed: null, source: 'seed' };
const chapterOn = (id, name, over = {}) => ({
  id, subjectId: 's1', name, initialLevel: 'new', kind: 'course',
  axes: ['recall', 'exercise', 'problem'], position: null,
  recall: { ...seedRecall }, exercise: emptyPractice(), problem: emptyPractice(),
  minutes: { ...AXIS_MINUTES }, ...over,
});

const stateWith = (chapters) => ({
  version: 6,
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

const store = () => {
  const mem = {};
  return {
    mem,
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: (k) => { delete mem[k]; },
  };
};

const read = (st) => JSON.parse(st.getItem(STORAGE_KEY));
const card = (name) => screen.getByText(name).closest('.cad-card');
// L'onglet, pas les boutons de la page qui portent le même mot.
const tab = (name) => within(screen.getByRole('navigation')).getByRole('button', { name });

let st;
beforeEach(() => {
  st = store();
  window.storage = st;
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('alert', vi.fn());
});
afterEach(() => { cleanup(); delete window.storage; vi.unstubAllGlobals(); });

describe('ressources — ajouter ce qui n’est pas un cours', () => {
  beforeEach(() => { st.setItem(STORAGE_KEY, JSON.stringify(stateWith([]))); });

  it('ajoute une ressource « à mémoriser » avec le seul axe rappel', () => {
    render(<Cadence />);
    fireEvent.click(tab(/Matières/));
    fireEvent.click(screen.getByLabelText(/^Déplier /));
    fireEvent.click(screen.getByRole('button', { name: /ressource/i }));
    fireEvent.change(screen.getByLabelText('nom de la ressource'), { target: { value: 'Vocabulaire TOEIC' } });
    fireEvent.click(screen.getByRole('button', { name: /Ajouter la ressource/ }));

    const saved = read(st).chapters[0];
    expect(saved.name).toBe('Vocabulaire TOEIC');
    expect(saved.kind).toBe('resource');
    expect(saved.axes).toEqual(['recall']);
    expect(saved.position).toBeNull();
  });

  it('le profil choisi détermine les axes (annales -> problème seul)', () => {
    render(<Cadence />);
    fireEvent.click(tab(/Matières/));
    fireEvent.click(screen.getByLabelText(/^Déplier /));
    fireEvent.click(screen.getByRole('button', { name: /ressource/i }));
    fireEvent.change(screen.getByLabelText('nom de la ressource'), { target: { value: 'Annales 2024' } });
    fireEvent.click(screen.getByRole('button', { name: 'Annales' }));
    fireEvent.click(screen.getByRole('button', { name: /Ajouter la ressource/ }));
    expect(read(st).chapters[0].axes).toEqual(['problem']);
  });
});

describe('matière non planifiée — on explique pourquoi rien ne s’ouvre', () => {
  it('affiche la raison et propose la bascule, qui débloque l’ajout', async () => {
    const base = stateWith([]);
    base.subjects = [{ id: 's1', name: 'Anglais / TOEIC', color: '#5eead4', type: 'parallel', weeklyFloor: 4 }];
    st.setItem(STORAGE_KEY, JSON.stringify(base));
    render(<Cadence />);
    fireEvent.click(tab(/Matières/));

    // Pas de flèche pour déplier : sans explication, l'utilisateur est bloqué.
    expect(screen.queryByLabelText(/^Déplier /)).toBeNull();
    expect(screen.getByText(/minimum hebdomadaire/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Passer en planifiée/ }));
    await waitFor(() => expect(read(st).subjects[0].type).toBe('core'));

    // Elle se déplie et accepte désormais chapitres et ressources.
    fireEvent.click(screen.getByLabelText(/^Déplier /));
    expect(screen.getByRole('button', { name: /ressource/i })).toBeTruthy();
  });
});

describe('ressources — dans le plan du jour', () => {
  it('une ressource « à mémoriser » ne propose QUE le rappel', () => {
    st.setItem(STORAGE_KEY, JSON.stringify(stateWith([
      chapterOn('r1', 'Vocabulaire TOEIC', { kind: 'resource', axes: ['recall'] }),
    ])));
    render(<Cadence />);
    const c = card('Vocabulaire TOEIC');
    // vocabulaire du rappel présent…
    expect(within(c).getByText('Immédiat')).toBeTruthy();
    // …et aucun sélecteur d'axe, puisqu'il n'y en a qu'un
    expect(within(c).queryByRole('group', { name: 'Axe à travailler' })).toBeNull();
    expect(within(c).queryByRole('button', { name: /^Problème/ })).toBeNull();
  });

  it('noter une ressource ne touche que son axe', () => {
    st.setItem(STORAGE_KEY, JSON.stringify(stateWith([
      chapterOn('r1', 'Vocabulaire TOEIC', { kind: 'resource', axes: ['recall'] }),
    ])));
    render(<Cadence />);
    fireEvent.click(within(card('Vocabulaire TOEIC')).getByText('Correct'));
    const saved = read(st).chapters[0];
    expect(saved.recall.lastReviewed).toBeTruthy();
    expect(saved.exercise.attempts).toBe(0);
    expect(saved.problem.attempts).toBe(0);
    expect(read(st).reviewLog[0].axis).toBe('recall');
  });

  it('une ressource « à pratiquer » propose le vocabulaire exercice, pas le rappel', () => {
    st.setItem(STORAGE_KEY, JSON.stringify(stateWith([
      chapterOn('r1', 'Recueil d’exos', { kind: 'resource', axes: ['exercise'] }),
    ])));
    render(<Cadence />);
    const c = card('Recueil d’exos');
    expect(within(c).getByText('Autonome et propre')).toBeTruthy();
    expect(within(c).queryByText('Immédiat')).toBeNull();
  });

  it('le clavier ne peut pas basculer vers un axe non applicable', () => {
    st.setItem(STORAGE_KEY, JSON.stringify(stateWith([
      chapterOn('r1', 'Vocabulaire TOEIC', { kind: 'resource', axes: ['recall'] }),
    ])));
    render(<Cadence />);
    fireEvent.keyDown(card('Vocabulaire TOEIC'), { key: 'p' });
    // toujours le vocabulaire du rappel
    expect(within(card('Vocabulaire TOEIC')).getByText('Immédiat')).toBeTruthy();
  });
});

describe('point de reprise — « où j’en suis »', () => {
  beforeEach(() => {
    st.setItem(STORAGE_KEY, JSON.stringify(stateWith([
      chapterOn('r1', 'Vocabulaire TOEIC', { kind: 'resource', axes: ['recall'] }),
    ])));
  });

  it('se saisit depuis la carte et se conserve', async () => {
    render(<Cadence />);
    fireEvent.click(within(card('Vocabulaire TOEIC')).getByRole('button', { name: /où j’en suis/ }));
    const input = screen.getByLabelText('point de reprise');
    fireEvent.change(input, { target: { value: '  unité 5  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(read(st).chapters[0].position).toBe('unité 5'));
    // il est ensuite affiché sur la carte
    expect(within(card('Vocabulaire TOEIC')).getByText('unité 5')).toBeTruthy();
  });

  it('Échap annule sans rien enregistrer', async () => {
    render(<Cadence />);
    fireEvent.click(within(card('Vocabulaire TOEIC')).getByRole('button', { name: /où j’en suis/ }));
    const input = screen.getByLabelText('point de reprise');
    fireEvent.change(input, { target: { value: 'p. 99' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('point de reprise')).toBeNull());
    expect(read(st).chapters[0].position).toBeNull();
  });

  it('n’influence pas la notation : noter n’efface pas le repère', async () => {
    render(<Cadence />);
    fireEvent.click(within(card('Vocabulaire TOEIC')).getByRole('button', { name: /où j’en suis/ }));
    const input = screen.getByLabelText('point de reprise');
    fireEvent.change(input, { target: { value: 'p. 47' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(read(st).chapters[0].position).toBe('p. 47'));
    fireEvent.click(within(card('Vocabulaire TOEIC')).getByText('Correct'));
    expect(read(st).chapters[0].position).toBe('p. 47');
    expect(read(st).chapters[0].recall.lastReviewed).toBeTruthy();
  });
});

describe('documents — retrouver ce qui a été vu', () => {
  beforeEach(() => {
    st.setItem(STORAGE_KEY, JSON.stringify(stateWith([chapterOn('c1', 'Diagonalisation')])));
  });

  const dataTransfer = ({ uri, file } = {}) => ({
    getData: (type) => (type === 'text/uri-list' || type === 'text/plain' ? (uri || '') : ''),
    files: file ? [file] : [],
  });

  it('ajoute un lien depuis la carte, et il réapparaît ensuite', async () => {
    render(<Cadence />);
    fireEvent.click(within(card('Diagonalisation')).getByRole('button', { name: /document/i }));
    fireEvent.change(screen.getByLabelText('lien du document'), { target: { value: 'https://drive.exemple.org/td3.pdf' } });
    fireEvent.change(screen.getByLabelText('nom du document'), { target: { value: 'TD 3' } });
    fireEvent.click(screen.getByRole('button', { name: 'ajouter' }));

    await waitFor(() => expect(read(st).chapters[0].docs).toHaveLength(1));
    expect(read(st).chapters[0].docs[0]).toMatchObject({ label: 'TD 3', url: 'https://drive.exemple.org/td3.pdf' });
    // visible sur la carte, prêt pour la session suivante
    const link = within(card('Diagonalisation')).getByText('TD 3').closest('a');
    expect(link.getAttribute('href')).toBe('https://drive.exemple.org/td3.pdf');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('un lien piégé est refusé et rien n’est enregistré', async () => {
    render(<Cadence />);
    fireEvent.click(within(card('Diagonalisation')).getByRole('button', { name: /document/i }));
    fireEvent.change(screen.getByLabelText('lien du document'), { target: { value: 'javascript:alert(1)' } });
    fireEvent.click(screen.getByRole('button', { name: 'ajouter' }));
    await waitFor(() => expect(screen.getByText(/Lien non valide/i)).toBeTruthy());
    expect(read(st).chapters[0].docs).toHaveLength(0);
  });

  it('ouvrir un document le marque utilisé aujourd’hui', async () => {
    const base = stateWith([chapterOn('c1', 'Diagonalisation', {
      docs: [{ id: 'd1', label: 'Annale', url: 'https://exemple.org/a.pdf', addedAt: '2026-01-01', lastUsedAt: null }],
    })]);
    st.setItem(STORAGE_KEY, JSON.stringify(base));
    render(<Cadence />);
    fireEvent.click(within(card('Diagonalisation')).getByText('Annale'));
    await waitFor(() => expect(read(st).chapters[0].docs[0].lastUsedAt).toBe(todayISO()));
    expect(within(card('Diagonalisation')).getByText('auj.')).toBeTruthy();
  });

  it('déposer un lien sur la carte l’attache directement', async () => {
    render(<Cadence />);
    const zone = within(card('Diagonalisation')).getByRole('button', { name: /document/i }).parentElement;
    fireEvent.drop(zone, { dataTransfer: dataTransfer({ uri: 'https://exemple.org/annale.pdf' }) });
    await waitFor(() => expect(read(st).chapters[0].docs).toHaveLength(1));
    expect(read(st).chapters[0].docs[0].url).toBe('https://exemple.org/annale.pdf');
  });

  it('déposer un FICHIER garde son nom comme repère et le dit clairement', async () => {
    render(<Cadence />);
    const zone = within(card('Diagonalisation')).getByRole('button', { name: /document/i }).parentElement;
    fireEvent.drop(zone, { dataTransfer: dataTransfer({ file: { name: 'TD3_optique.pdf' } }) });
    await waitFor(() => expect(read(st).chapters[0].docs).toHaveLength(1));
    const saved = read(st).chapters[0].docs[0];
    expect(saved.label).toBe('TD3_optique.pdf');
    expect(saved.url).toBeNull(); // le contenu n'est pas stocké
    expect(screen.getByText(/Fichier non stocké/i)).toBeTruthy();
  });

  it('retirer un document', async () => {
    const base = stateWith([chapterOn('c1', 'Diagonalisation', {
      docs: [{ id: 'd1', label: 'Annale', url: 'https://exemple.org/a.pdf', addedAt: '2026-01-01', lastUsedAt: null }],
    })]);
    st.setItem(STORAGE_KEY, JSON.stringify(base));
    render(<Cadence />);
    fireEvent.click(within(card('Diagonalisation')).getByRole('button', { name: /Retirer le document Annale/ }));
    await waitFor(() => expect(read(st).chapters[0].docs).toHaveLength(0));
  });

  it('noter le chapitre ne touche pas ses documents', async () => {
    const base = stateWith([chapterOn('c1', 'Diagonalisation', {
      docs: [{ id: 'd1', label: 'Annale', url: 'https://exemple.org/a.pdf', addedAt: '2026-01-01', lastUsedAt: '2026-01-05' }],
    })]);
    st.setItem(STORAGE_KEY, JSON.stringify(base));
    render(<Cadence />);
    fireEvent.click(within(card('Diagonalisation')).getByText('Correct'));
    await waitFor(() => expect(read(st).chapters[0].recall.lastReviewed).toBeTruthy());
    expect(read(st).chapters[0].docs).toHaveLength(1);
    expect(read(st).chapters[0].docs[0].lastUsedAt).toBe('2026-01-05');
  });
});

describe('axes modifiables depuis Matières', () => {
  it('décocher un axe le retire du plan ; le dernier axe ne peut pas être retiré', async () => {
    st.setItem(STORAGE_KEY, JSON.stringify(stateWith([chapterOn('c1', 'Diagonalisation')])));
    render(<Cadence />);
    fireEvent.click(tab(/Matières/));
    fireEvent.click(screen.getByLabelText(/^Déplier /));

    const row = document.getElementById('chapter-c1');
    fireEvent.click(within(row).getByRole('button', { name: /Retirer problème ou annale/ }));
    await waitFor(() => expect(read(st).chapters[0].axes).toEqual(['recall', 'exercise']));

    fireEvent.click(within(document.getElementById('chapter-c1')).getByRole('button', { name: /Retirer exercice standard/ }));
    await waitFor(() => expect(read(st).chapters[0].axes).toEqual(['recall']));

    // dernier axe : bouton désactivé
    const last = within(document.getElementById('chapter-c1')).getByRole('button', { name: /au moins un axe doit rester actif/ });
    expect(last.disabled).toBe(true);
  });
});
