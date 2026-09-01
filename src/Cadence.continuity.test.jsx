// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import Cadence from './Cadence.jsx';
import {
  AXIS_MINUTES,
  DEFAULT_SETTINGS,
  STORAGE_KEY,
  addDays,
  emptyDeleted,
  emptyPractice,
  newReviewUnit,
  todayISO,
} from './engine.js';

const parent = (position, date) => ({
  id: 'c1', subjectId: 's1', name: 'Endomorphismes', initialLevel: 'new',
  kind: 'course', axes: ['recall', 'exercise', 'problem'], position,
  positionUpdatedAt: date,
  docs: [{ id: 'd1', label: 'Suivi cumulatif', url: 'https://drive.google.com/file/d/pdf/view', addedAt: date, lastUsedAt: null }],
  recall: { stability: 2, difficulty: 8.5, lastReviewed: null, source: 'seed' },
  exercise: emptyPractice(), problem: emptyPractice(), minutes: { ...AXIS_MINUTES },
});

const stateWith = ({ introducedAt = todayISO(), includeUnit = true } = {}) => {
  const label = `Ajout du ${introducedAt.split('-').reverse().join('/')} — théorème spectral`;
  const chapter = parent(label, introducedAt);
  return {
    version: 8,
    subjects: [{ id: 's1', name: 'Maths', color: '#7c9cf5', type: 'core' }],
    chapters: [chapter, ...(includeUnit ? [newReviewUnit(chapter, label, introducedAt, DEFAULT_SETTINGS)] : [])],
    exams: [], settings: { ...DEFAULT_SETTINGS }, parallelLog: {}, reviewLog: [], archivedReviews: [],
    skips: {}, capacityOverrides: {}, examDebriefs: {}, deleted: emptyDeleted(), syncMeta: null,
    lastExportAt: null,
  };
};

const readState = () => JSON.parse(window.localStorage.getItem(STORAGE_KEY));

beforeEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('alert', vi.fn());
});

describe('accueil simplifié — continuité et consolidations', () => {
  it('un contenu ajouté aujourd’hui ouvre le document sans demander de maîtrise', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stateWith()));
    render(<Cadence />);

    const card = screen.getByRole('group', { name: 'Endomorphismes — continuité' });
    expect(within(card).getByText('ajout du jour')).toBeTruthy();
    expect(within(card).getByRole('link', { name: /Suivi cumulatif/ }).getAttribute('href'))
      .toBe('https://drive.google.com/file/d/pdf/view');
    expect(screen.getByText('Rien à consolider aujourd’hui.')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Maîtrise après reprise' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Progrès/ })).toBeNull();
    expect(screen.queryByText(/Temps disponible aujourd’hui/)).toBeNull();
  });

  it('la portion vue hier est due, puis sa catégorisation est enregistrée et la retire de la file', async () => {
    const yesterday = addDays(todayISO(), -1);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stateWith({ introducedAt: yesterday })));
    render(<Cadence />);

    const review = screen.getByRole('group', { name: /théorème spectral — consolidation/ });
    expect(within(review).getByText('consolidation du lendemain')).toBeTruthy();
    expect(within(review).getByRole('link', { name: /Suivi cumulatif/ })).toBeTruthy();
    expect(within(review).getByRole('group', { name: 'Maîtrise après reprise' })
      .querySelectorAll('button')).toHaveLength(5);
    fireEvent.click(within(review).getByRole('button', { name: 'Maîtrisé' }));

    await waitFor(() => expect(screen.queryByRole('group', { name: /— consolidation/ })).toBeNull());
    const saved = readState();
    const unit = saved.chapters.find((c) => c.reviewUnit);
    const main = saved.chapters.find((c) => !c.reviewUnit);
    expect(unit.recall.lastReviewed).toBe(todayISO());
    expect(main.recall.lastReviewed).toBeNull();
    expect(saved.reviewLog).toHaveLength(1);
    expect(saved.reviewLog[0]).toMatchObject({
      chapterId: unit.id, grade: 3, masteryLevel: 3,
      evidenceType: 'recall', axis: 'recall', source: 'self-review',
    });
    expect(screen.getByRole('status').textContent).toContain('Consolidation : « Maîtrisé »');
  });

  it('un point libre reste un simple signet ; un ajout daté crée une seule portion interne', async () => {
    const st = stateWith({ includeUnit: false });
    st.chapters[0].position = null;
    st.chapters[0].positionUpdatedAt = null;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
    render(<Cadence />);

    const card = screen.getByRole('group', { name: 'Endomorphismes — continuité' });
    fireEvent.click(within(card).getByRole('button', { name: /où j’en suis/ }));
    let input = screen.getByLabelText('point de reprise');
    fireEvent.change(input, { target: { value: 'p. 47' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(readState().chapters).toHaveLength(1));

    fireEvent.click(within(card).getByRole('button', { name: /p\. 47/ }));
    input = screen.getByLabelText('point de reprise');
    const dated = `Ajout du ${todayISO().split('-').reverse().join('/')} — diagonalisation`;
    fireEvent.change(input, { target: { value: dated } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(readState().chapters.filter((c) => c.reviewUnit)).toHaveLength(1));
    expect(readState().chapters.find((c) => c.reviewUnit).name).toBe(dated);
    expect(screen.queryByRole('group', { name: /— consolidation/ })).toBeNull();
  });

  it('enregistre une note sur 20 et reprogramme le même périmètre sans modifier les portions', async () => {
    const yesterday = addDays(todayISO(), -1);
    const st = stateWith({ introducedAt: yesterday });
    st.version = 9;
    st.courseTests = [{
      id: 't1', subjectId: 's1', name: 'Test hebdo', scheduledFor: todayISO(),
      createdAt: yesterday, chapterIds: ['c1'], portionIds: [],
    }];
    st.courseTestLog = [];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
    render(<Cadence />);

    const card = screen.getByRole('group', { name: 'Test hebdo — test de cours' });
    fireEvent.change(within(card).getByLabelText('note obtenue pour Test hebdo'), { target: { value: '14' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Enregistrer la note' }));

    await waitFor(() => expect(screen.queryByRole('group', { name: 'Test hebdo — test de cours' })).toBeNull());
    const saved = readState();
    expect(saved.courseTestLog).toHaveLength(1);
    expect(saved.courseTestLog[0]).toMatchObject({
      testId: 't1', score: 14, maxScore: 20, ratio: 0.7, closedBook: true,
    });
    expect(saved.courseTests[0].scheduledFor).toBe(addDays(todayISO(), 3));
    expect(saved.reviewLog).toHaveLength(0);
  });
});
