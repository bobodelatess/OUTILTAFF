import { describe, expect, it } from 'vitest';
import {
  AXIS_MINUTES,
  DEFAULT_SETTINGS,
  REVIEW_UNIT_MINUTES,
  SPACED_REVIEW_MINUTES,
  addDays,
  applyEvidence,
  emptyDeleted,
  emptyPractice,
  forecastReviewUnits,
  isReviewUnit,
  normalize,
  reviewUnitId,
  reviewUnitInfo,
  upsertReviewUnit,
} from './engine.js';

const TODAY = '2026-09-01';
const YESTERDAY = addDays(TODAY, -1);
const S = { ...DEFAULT_SETTINGS };

const parent = (over = {}) => ({
  id: 'c1', subjectId: 's1', name: 'Endomorphismes', initialLevel: 'new',
  kind: 'course', axes: ['recall', 'exercise', 'problem'], position: null,
  positionUpdatedAt: null, docs: [],
  recall: { stability: 2, difficulty: 8.5, lastReviewed: null, source: 'seed' },
  exercise: emptyPractice(), problem: emptyPractice(), minutes: { ...AXIS_MINUTES },
  ...over,
});

describe('portions quotidiennes et courbe d’oubli', () => {
  it('un ajout daté crée une unité interne, sans maîtrise ni échéance le jour même', () => {
    const label = 'Ajout du 01/09/2026 — théorème spectral';
    const chapters = upsertReviewUnit([parent()], 'c1', label, S);
    expect(chapters).toHaveLength(2);
    const unit = chapters.find(isReviewUnit);
    expect(unit).toMatchObject({
      id: reviewUnitId('c1', TODAY), parentChapterId: 'c1', introducedAt: TODAY,
      name: label, axes: ['recall'], kind: 'resource', docs: [],
    });
    expect(unit.minutes.recall).toBe(REVIEW_UNIT_MINUTES);
    expect(reviewUnitInfo(unit, S, TODAY)).toMatchObject({ tested: false, due: false, R: null });
    expect(reviewUnitInfo(unit, S, addDays(TODAY, 1))).toMatchObject({ tested: false, due: true, R: null });
  });

  it('corriger le libellé du même jour conserve une seule unité et son historique', () => {
    let chapters = upsertReviewUnit([parent()], 'c1', 'Ajout du 01/09/2026 — première formulation', S);
    const unit = chapters.find(isReviewUnit);
    const reviewed = applyEvidence(unit, 'recall', 3, addDays(TODAY, 1)).chapter;
    chapters = chapters.map((c) => c.id === reviewed.id ? reviewed : c);
    chapters = upsertReviewUnit(chapters, 'c1', 'Ajout du 01/09/2026 — formulation corrigée', S);
    expect(chapters.filter(isReviewUnit)).toHaveLength(1);
    expect(chapters.find(isReviewUnit).name).toContain('formulation corrigée');
    expect(chapters.find(isReviewUnit).recall.lastReviewed).toBe(addDays(TODAY, 1));
  });

  it('un signet libre ne crée aucune fausse consolidation', () => {
    const chapters = upsertReviewUnit([parent()], 'c1', 'p. 47', S);
    expect(chapters).toHaveLength(1);
    expect(chapters.some(isReviewUnit)).toBe(false);
  });

  it('après la reprise du lendemain, la prochaine date vient de la courbe d’oubli', () => {
    const chapters = upsertReviewUnit([parent()], 'c1', 'Ajout du 31/08/2026 — orthogonalité', S);
    const unit = chapters.find(isReviewUnit);
    expect(reviewUnitInfo(unit, S, TODAY).due).toBe(true);
    const reviewed = applyEvidence(unit, 'recall', 3, TODAY).chapter;
    const info = reviewUnitInfo(reviewed, S, TODAY);
    expect(info.tested).toBe(true);
    expect(info.due).toBe(false);
    expect(info.R).toBe(1);
    expect(info.dueAt.localeCompare(TODAY)).toBeGreaterThan(0);
    expect(forecastReviewUnits([reviewed], S, TODAY, 60)[info.dueAt])
      .toEqual({ count: 1, minutes: SPACED_REVIEW_MINUTES });
  });

  it('la migration v7 reconstruit uniquement la dernière portion réellement connue', () => {
    const v7 = {
      version: 7,
      subjects: [{ id: 's1', name: 'Maths', color: '#7c9cf5', type: 'core' }],
      chapters: [parent({
        position: 'Ajout du 31/08/2026 — matrice de Vandermonde',
        positionUpdatedAt: undefined,
      })],
      exams: [], settings: S, parallelLog: {}, reviewLog: [], archivedReviews: [], skips: {},
      capacityOverrides: {}, examDebriefs: {}, deleted: emptyDeleted(), syncMeta: null,
      lastExportAt: null,
    };
    const out = normalize(v7, TODAY);
    expect(out.version).toBe(11);
    expect(out.chapters.filter(isReviewUnit)).toHaveLength(1);
    expect(out.chapters.find(isReviewUnit)).toMatchObject({
      parentChapterId: 'c1', introducedAt: YESTERDAY,
      name: 'Ajout du 31/08/2026 — matrice de Vandermonde',
      minutes: { recall: REVIEW_UNIT_MINUTES },
    });
    expect(normalize(out, TODAY).chapters).toEqual(out.chapters);
  });
});
