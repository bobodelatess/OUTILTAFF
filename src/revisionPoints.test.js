import { describe, expect, it } from 'vitest';
import {
  mergeRevisionPoints, normRevisionPoints, parseRevisionDraft, revisionDraft,
  updateRevisionPoints, validateRevisionPoints, visibleRevisionPoints,
} from './revisionPoints.js';
import {
  DEFAULT_SETTINGS, LEVELS, isReviewUnit, newChapter, normalize,
  reviewUnitInfo, seedState, upsertReviewUnit, validateImport,
} from './engine.js';
import { mergeStates, stampState } from './sync.js';

const TODAY = '2026-09-13';
const point = (id, text, category = 'course', extra = {}) => ({
  id, text, category, order: 0, updatedAt: 100, deleted: false, ...extra,
});
const stateWithUnit = () => {
  const state = seedState();
  const parent = newChapter(state.subjects[0].id, 'Endomorphismes', LEVELS[0], DEFAULT_SETTINGS);
  state.chapters = upsertReviewUnit([parent], parent.id, 'Ajout du 13/09/2026 — diagonalisation', state.settings);
  return normalize(state, TODAY);
};
const withPoints = (state, points) => ({
  ...state, chapters: state.chapters.map((c) => isReviewUnit(c) ? { ...c, revisionPoints: points } : c),
});

describe('trois listes de révision', () => {
  it('transforme les lignes en points, sans puces ni doublons, et garde le LaTeX', () => {
    expect(parseRevisionDraft({ course: ' - $A=PDP^{-1}$\n\n• Hypothèses\nHypothèses', methods: '1. Déterminer les espaces propres' }))
      .toEqual({ course: ['$A=PDP^{-1}$', 'Hypothèses'], methods: ['Déterminer les espaces propres'], proofs: [] });
  });

  it('refuse une ligne trop longue et trop de points de saisie, sans tronquer', () => {
    expect(() => parseRevisionDraft({ course: 'x'.repeat(1001) })).toThrow(/1000/);
    expect(() => parseRevisionDraft({ course: Array.from({ length: 91 }, (_, i) => `point ${i}`).join('\n') })).toThrow(/90/);
  });

  it('ne touche à rien quand le brouillon est inchangé', () => {
    const records = [point('a', 'Une notion'), point('b', 'Une méthode', 'methods')];
    expect(updateRevisionPoints(records, records, revisionDraft(records), 200, () => 'new'))
      .toEqual(normRevisionPoints(records));
  });

  it('ajoute, réordonne et supprime avec des tombstones stables', () => {
    const baseline = [point('a', 'Ancien'), point('b', 'À garder', 'course', { order: 1 }), point('m', 'Méthode', 'methods')];
    const saved = updateRevisionPoints(baseline, baseline,
      { course: 'Nouveau\nÀ garder', methods: 'Méthode', proofs: '' }, 200, () => 'new');
    expect(visibleRevisionPoints(saved).map((p) => p.text)).toEqual(['Méthode', 'Nouveau', 'À garder']);
    expect(saved.find((p) => p.id === 'a')).toMatchObject({ deleted: true, updatedAt: 200 });
    expect(saved.find((p) => p.id === 'm')).toEqual(baseline[2]);
    expect(revisionDraft(saved).course).toBe('Nouveau\nÀ garder');
    expect(validateRevisionPoints(saved)).toEqual([]);
  });

  it('garde un ajout distant arrivé pendant la saisie locale', () => {
    const base = [point('a', 'Notion')];
    const current = [...base, point('remote', 'Ajout du téléphone')];
    const saved = updateRevisionPoints(current, base, { course: 'Notion corrigée' }, 200, () => 'new');
    expect(visibleRevisionPoints(saved).map((p) => p.text).sort()).toEqual(['Ajout du téléphone', 'Notion corrigée']);
  });

  it('n’efface pas une modification distante plus récente qu’un brouillon', () => {
    const base = [point('a', 'Notion')];
    const current = [point('a', 'Correction distante', 'course', { updatedAt: 150 })];
    const saved = updateRevisionPoints(current, base, { course: '' }, 200, () => 'new');
    expect(visibleRevisionPoints(saved)[0].text).toBe('Correction distante');
  });

  it('fusionne sans réintroduire une suppression, même si l’appareil distant est plus récent', () => {
    const original = point('a', 'Notion');
    const deleted = { ...original, deleted: true, updatedAt: 200 };
    expect(visibleRevisionPoints(mergeRevisionPoints([deleted], [original]))).toEqual([]);
    expect(mergeRevisionPoints([deleted], [{ ...original, updatedAt: 200 }])[0].deleted).toBe(true);
  });

  it('converge, est idempotent et masque les doublons sans perdre leur identité', () => {
    const a = [point('a', 'Formule'), point('b', 'Méthode', 'methods')];
    const b = [point('c', 'Formule'), point('d', 'Preuve', 'proofs')];
    const merged = mergeRevisionPoints(a, b);
    expect(merged).toEqual(mergeRevisionPoints(b, a));
    expect(mergeRevisionPoints(merged, merged)).toEqual(merged);
    expect(merged).toHaveLength(4);
    expect(visibleRevisionPoints(merged)).toHaveLength(3);
  });

  it('valide une union de deux grandes listes hors ligne sans couper du contenu', () => {
    const a = Array.from({ length: 90 }, (_, i) => point(`a${i}`, `Cours ${i}`));
    const b = Array.from({ length: 90 }, (_, i) => point(`b${i}`, `Méthode ${i}`, 'methods'));
    const merged = mergeRevisionPoints(a, b);
    expect(validateRevisionPoints(merged)).toEqual([]);
    expect(visibleRevisionPoints(merged)).toHaveLength(180);
  });

  it.each([
    null, [{ ...point('a', 'Notion'), category: 'unknown' }],
    [{ ...point('a', 'Notion'), updatedAt: -1 }],
    [{ ...point('a', 'Notion'), text: '' }],
    [{ ...point('a', 'Notion'), deleted: 'false' }],
    [point('a', 'Notion'), point('a', 'Doublon')],
  ])('refuse les points mal formés (%#)', (records) => {
    expect(validateRevisionPoints(records).length).toBeGreaterThan(0);
  });
});

describe('v13 : migration, export et synchronisation des listes', () => {
  it('migre v12 sans inventer de contenu ni modifier les dates, documents ou maîtrise', () => {
    const old = stateWithUnit();
    old.version = 12;
    old.chapters.forEach((c) => { delete c.revisionPoints; });
    const migrated = normalize(old, TODAY);
    expect(migrated.version).toBe(13);
    const unit = migrated.chapters.find(isReviewUnit);
    expect(unit.revisionPoints).toEqual([]);
    const { revisionPoints, ...unchanged } = unit;
    expect(unchanged).toEqual(old.chapters.find(isReviewUnit));
    expect(migrated.reviewLog).toEqual(old.reviewLog);
    expect(migrated.courseTestLog).toEqual(old.courseTestLog);
    expect(normalize(migrated, TODAY)).toEqual(migrated);
    expect(validateImport(migrated)).toMatchObject({ ok: true });
  });

  it('conserve les trois catégories et les suppressions à l’export/réimport', () => {
    const state = withPoints(stateWithUnit(), [
      point('c', '$A=PDP^{-1}$'), point('m', 'Méthode', 'methods'),
      point('p', 'Preuve', 'proofs'), point('d', 'Supprimé', 'proofs', { deleted: true }),
    ]);
    expect(validateImport(state)).toMatchObject({ ok: true });
    const roundTrip = normalize(JSON.parse(JSON.stringify(state)), TODAY);
    expect(roundTrip.chapters.find(isReviewUnit).revisionPoints).toEqual(normRevisionPoints(state.chapters.find(isReviewUnit).revisionPoints));
    expect(validateImport(withPoints(state, [point('bad', '')])).ok).toBe(false);
    state.chapters.find((c) => !isReviewUnit(c)).revisionPoints = [];
    expect(validateImport(state).ok).toBe(false);
  });

  it('corriger une portion datée conserve ses listes et ne modifie pas son planning', () => {
    const state = withPoints(stateWithUnit(), [point('c', 'Notion')]);
    const unit = state.chapters.find(isReviewUnit);
    const chapters = upsertReviewUnit(state.chapters, unit.parentChapterId,
      'Ajout du 13/09/2026 — libellé corrigé', state.settings);
    const updated = chapters.find(isReviewUnit);
    expect(chapters.filter(isReviewUnit)).toHaveLength(1);
    expect(updated.revisionPoints).toEqual(unit.revisionPoints);
    expect(reviewUnitInfo(updated, state.settings, TODAY)).toEqual(reviewUnitInfo(unit, state.settings, TODAY));
    expect(updated.recall).toEqual(unit.recall);
  });

  it('fusionne les listes dans l’état complet avec convergence et journaux intacts', () => {
    const base = stateWithUnit();
    const local = stampState(withPoints(base, [point('c', 'Formule'), point('old', 'Retiré', 'course', { deleted: true, updatedAt: 200 })]), 'ordinateur', 300);
    const remote = stampState(withPoints(base, [point('m', 'Méthode', 'methods'), point('old', 'Retiré')]), 'téléphone', 500);
    const merged = normalize(mergeStates(local, remote, TODAY), TODAY);
    expect(merged).toEqual(normalize(mergeStates(remote, local, TODAY), TODAY));
    expect(visibleRevisionPoints(merged.chapters.find(isReviewUnit).revisionPoints).map((p) => p.text).sort()).toEqual(['Formule', 'Méthode']);
    expect(merged.reviewLog).toEqual([]);
    expect(merged.courseTestLog).toEqual([]);
    expect(merged.habitLog).toEqual([]);
    expect(validateImport(merged)).toMatchObject({ ok: true });
  });
});
