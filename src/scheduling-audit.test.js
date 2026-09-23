import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS, addDays, applyRecall, applySelfAssessment, emptyDeleted,
  forecastReviewUnits, newChapter, newReviewUnit, nextCourseTestDate,
  optimalInterval, retrievability, reviewUnitInfo,
} from './engine.js';
import { rebuildAxes, mergeStates, stampState } from './sync.js';

const TODAY = '2026-09-18';
const S = { ...DEFAULT_SETTINGS };
const parent = { ...newChapter('s1', 'Chapitre', null, S), id: 'c1' };
const fresh = () => newReviewUnit(parent, 'Ajout du 17/09/2026 — notion', '2026-09-17', S);
const event = (unit, result, date, id = 'r1') => ({
  id, chapterId: unit.id, date, grade: result.grade, masteryLevel: result.masteryLevel,
  evidenceType: 'recall', axis: 'recall', source: 'self-review',
  before: result.before, after: result.after,
  lifecycleBefore: { reviewSuccessStreak: unit.reviewSuccessStreak, integratedAt: unit.integratedAt, lastMasteryLevel: unit.lastMasteryLevel },
});
const state = (unit, events) => ({
  version: 13, subjects: [{ id: 's1', name: 'Maths', type: 'core' }],
  chapters: [parent, unit], reviewLog: events, archivedReviews: [],
  settings: S, exams: [], courseTests: [], courseTestLog: [], deleted: emptyDeleted(),
});

describe('audit du calcul de mémoire', () => {
  // Valeurs de référence : open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm, FSRS-4.5.
  it.each([[1, 0.4872, 7.6214], [2, 1.4003, 6.3916], [3, 3.7145, 5.1618], [4, 13.8206, 3.932]])(
    'initialise la première note %i avec les paramètres publiés, sans délai fictif', (grade, stability, difficulty) => {
      const actual = applyRecall(fresh().recall, 'new', grade, TODAY);
      expect(actual.stability).toBe(stability);
      expect(actual.difficulty).toBeCloseTo(difficulty, 6);
      expect(actual.lastReviewed).toBe(TODAY);
    },
  );

  it.each([0.7, 0.81, 0.9, 0.95, 0.99])('l’intervalle inverse réellement la courbe au seuil %f', (retention) => {
    for (const stability of [0.2, 2, 10, 100, 730]) {
      expect(retrievability(optimalInterval(stability, retention), stability)).toBeCloseTo(retention, 10);
    }
  });

  it('une première restitution maîtrisée revient à 8 jours au seuil actuel de 81 %, pas à 16', () => {
    const settings = { ...S, requestRetention: 0.81 };
    const result = applySelfAssessment(fresh(), 3, TODAY, settings);
    expect(reviewUnitInfo(result.chapter, settings, TODAY).interval).toBe(8);
  });

  it('deux validations le même jour ne remplacent pas deux restitutions espacées', () => {
    const first = applySelfAssessment(fresh(), 3, TODAY, S).chapter;
    const again = applySelfAssessment(first, 4, TODAY, S).chapter;
    expect(again.reviewSuccessStreak).toBe(1);
    expect(again.integratedAt).toBeNull();
    expect(again.recall.stability).toBe(first.recall.stability);
    expect(applySelfAssessment(again, 3, addDays(TODAY, 4), S).chapter.reviewSuccessStreak).toBe(2);
  });

  it('des tests répétés le même jour ne donnent pas artificiellement J+30 puis J+60', () => {
    const test = { subjectId: 's1', chapterIds: ['c1'], strongStreak: 1, lastCompletedAt: TODAY };
    expect(nextCourseTestDate(test, 0.95, [], S, TODAY).interval).toBe(14);
    expect(nextCourseTestDate(test, 0.95, [], S, addDays(TODAY, 14)).interval).toBe(30);
  });
});

describe('audit du calendrier et des épreuves', () => {
  const stable = () => ({ ...fresh(), recall: { stability: 100, difficulty: 5, lastReviewed: TODAY } });
  const exam = (days, over = {}) => ({ id: 'exam', subjectId: 's1', name: 'Partiel', date: addDays(TODAY, days), chapterIds: ['c1'], importance: 'normal', ...over });

  it('rappelle même une portion très stable avant une épreuve proche', () => {
    expect(reviewUnitInfo(stable(), S, TODAY, [exam(5)]).dueAt).toBe(addDays(TODAY, 3));
    expect(reviewUnitInfo(stable(), S, TODAY, [exam(1)]).dueAt).toBe(addDays(TODAY, 1));
  });

  it('prend en compte aussi l’épreuve la plus proche quand une autre a plus de poids', () => {
    expect(reviewUnitInfo(stable(), S, TODAY, [exam(5, { importance: 'minor' }), exam(7, { importance: 'major' })]).dueAt)
      .toBe(addDays(TODAY, 3));
  });

  it('ne resserre pas une autre matière ou un périmètre non couvert', () => {
    const plain = reviewUnitInfo(stable(), S, TODAY).dueAt;
    expect(reviewUnitInfo(stable(), S, TODAY, [exam(5, { subjectId: 's2' })]).dueAt).toBe(plain);
    expect(reviewUnitInfo(stable(), S, TODAY, [exam(5, { chapterIds: ['c2'] })]).dueAt).toBe(plain);
  });

  it('annonce le jour où le rappel sera réellement dû avec une pression qui augmente', () => {
    const unit = { ...stable(), recall: { stability: 20, difficulty: 5, lastReviewed: addDays(TODAY, -5) } };
    const exams = [exam(20)];
    const expected = Array.from({ length: 36 }, (_, i) => addDays(TODAY, i))
      .find(date => reviewUnitInfo(unit, S, date, exams).due);
    expect(Object.keys(forecastReviewUnits([unit], S, TODAY, 35, exams))).toEqual([expected]);
  });
});

describe('audit de la fusion des résultats', () => {
  it('ne recalcule pas une ancienne mesure lorsque le seuil ou le moteur a changé', () => {
    const unit = fresh();
    const result = applySelfAssessment(unit, 3, TODAY, S);
    // Exemple historique volontairement différent du moteur courant.
    result.after = { stability: 7.125, difficulty: 7.321, lastReviewed: TODAY, source: 'self-assessed' };
    const old = event(unit, result, TODAY);
    const replayed = rebuildAxes(unit, [old], { ...S, requestRetention: 0.99 });
    expect(replayed.recall.stability).toBe(7.125);
    expect(replayed.recall.difficulty).toBe(7.321);
  });

  it('deux appareils évaluant la même portion le même jour n’intègrent pas artificiellement le chapitre', () => {
    const unit = fresh();
    const result = applySelfAssessment(unit, 3, TODAY, S);
    const a = stampState(state(result.chapter, [event(unit, result, TODAY, 'a')]), 'a', 100);
    const b = stampState(state(result.chapter, [event(unit, result, TODAY, 'b')]), 'b', 200);
    const merged = mergeStates(a, b);
    expect(merged.reviewLog).toHaveLength(2);
    expect(merged.chapters.find(c => c.id === unit.id)).toMatchObject({ reviewSuccessStreak: 1, integratedAt: null });
    expect(mergeStates(b, a)).toEqual(merged);
  });
});
