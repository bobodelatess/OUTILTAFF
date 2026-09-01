import { describe, expect, it } from 'vitest';
import {
  AXIS_MINUTES,
  DEFAULT_SETTINGS,
  addDays,
  allocateSubjectMinutes,
  applySelfAssessment,
  chapterExamFactor,
  courseTestSuggestions,
  emptyDeleted,
  emptyPractice,
  newCourseTest,
  newReviewUnit,
  nextCourseTestDate,
  normalize,
  reviewUnitInfo,
  validateImport,
} from './engine.js';
import { mergeStates, stampState } from './sync.js';

const TODAY = '2026-09-01';
const S = { ...DEFAULT_SETTINGS };
const SUBJECT = {
  id: 's1', name: 'Maths', color: '#7c9cf5', type: 'core',
  dailyMinutes: 120, minimumMinutes: 60,
};
const chapter = (id = 'c1', subjectId = 's1') => ({
  id, subjectId, name: 'Endomorphismes', initialLevel: 'new',
  kind: 'course', axes: ['recall', 'exercise', 'problem'], position: null,
  positionUpdatedAt: TODAY, docs: [],
  recall: { stability: 2, difficulty: 8.5, lastReviewed: null, source: 'seed' },
  exercise: emptyPractice(), problem: emptyPractice(), minutes: { ...AXIS_MINUTES },
});
const state = (over = {}) => ({
  version: 9, subjects: [SUBJECT], chapters: [chapter()], exams: [],
  courseTests: [], courseTestLog: [], settings: S, parallelLog: {}, reviewLog: [],
  archivedReviews: [], skips: {}, capacityOverrides: {}, examDebriefs: {},
  deleted: emptyDeleted(), syncMeta: null, lastExportAt: null, ...over,
});

describe('v9 — cinq niveaux de maîtrise', () => {
  it('les cinq choix produisent cinq prochaines échéances réellement distinctes', () => {
    const parent = chapter();
    const unit = newReviewUnit(parent, 'Ajout du 31/08/2026 — théorème spectral', addDays(TODAY, -1), S);
    const intervals = [0, 1, 2, 3, 4].map((level) => {
      const reviewed = applySelfAssessment(unit, level, TODAY, S).chapter;
      return reviewUnitInfo(reviewed, S, TODAY).interval;
    });
    expect(intervals).toEqual([1, 2, 3, 10, 25]);
  });
});

describe('v9 — pression ciblée et rééquilibrage temporaire', () => {
  it('une section ciblée ne met pas artificiellement tout le chapitre sous pression', () => {
    const parent = chapter();
    const unit = newReviewUnit(parent, 'Ajout du 31/08/2026 — noyau', addDays(TODAY, -1), S);
    const exam = {
      id: 'e1', subjectId: 's1', name: 'CC', date: addDays(TODAY, 3),
      chapterIds: [], portionIds: [unit.id], importance: 'major',
    };
    expect(chapterExamFactor(parent, [exam], S, TODAY).factor).toBe(1);
    expect(chapterExamFactor(unit, [exam], S, TODAY).factor).toBeGreaterThan(1);
    expect(chapterExamFactor(unit, [{ ...exam, chapterIds: [parent.id], portionIds: [] }], S, TODAY).factor)
      .toBeGreaterThan(1);
    const reviewed = applySelfAssessment(unit, 4, TODAY, S).chapter;
    expect(reviewUnitInfo(reviewed, S, TODAY, [exam]).interval)
      .toBeLessThan(reviewUnitInfo(reviewed, S, TODAY).interval);
  });

  it('conserve le total, protège les minimums et revient au régime normal après l’épreuve', () => {
    const subjects = [SUBJECT, { ...SUBJECT, id: 's2', name: 'Physique' }];
    const exam = {
      id: 'e1', subjectId: 's1', name: 'CC', date: addDays(TODAY, 2),
      chapterIds: ['c1'], portionIds: [], importance: 'major',
    };
    const pressured = allocateSubjectMinutes(subjects, [exam], S, TODAY);
    expect(pressured.reduce((sum, row) => sum + row.minutes, 0)).toBe(240);
    expect(pressured.find((row) => row.subject.id === 's1').minutes).toBeGreaterThan(120);
    expect(pressured.find((row) => row.subject.id === 's2').minutes).toBeGreaterThanOrEqual(60);
    const after = allocateSubjectMinutes(subjects, [exam], S, addDays(exam.date, 1));
    expect(after.map((row) => row.minutes)).toEqual([120, 120]);
  });
});

describe('v9 — tests de cours notés', () => {
  it('replanifie selon la note et resserre seulement pour une épreuve au même périmètre', () => {
    const test = newCourseTest('s1', 'Test hebdo', TODAY, ['c1'], [], TODAY);
    expect(nextCourseTestDate(test, 0.4, [], S, TODAY, [chapter()]).interval).toBe(1);
    expect(nextCourseTestDate(test, 0.9, [], S, TODAY, [chapter()]).interval).toBe(24);
    const relevant = {
      id: 'e1', subjectId: 's1', name: 'CC', date: addDays(TODAY, 8),
      chapterIds: ['c1'], portionIds: [], importance: 'major',
    };
    expect(nextCourseTestDate(test, 0.9, [relevant], S, TODAY, [chapter()]).interval).toBeLessThan(24);
    const unrelated = { ...relevant, chapterIds: ['c2'] };
    expect(nextCourseTestDate(test, 0.9, [unrelated], S, TODAY, [chapter(), chapter('c2')]).interval).toBe(24);
  });

  it('suggère un test après cinq nouvelles portions non couvertes, sans créer de faux résultat', () => {
    const parent = chapter();
    const units = Array.from({ length: 5 }, (_, index) => newReviewUnit(
      parent,
      `Ajout du ${String(27 + index).padStart(2, '0')}/08/2026 — portion ${index + 1}`,
      addDays(TODAY, index - 5),
      S,
    ));
    const suggestions = courseTestSuggestions([SUBJECT], [parent, ...units], [], TODAY);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].portionIds).toHaveLength(5);
  });

  it('fusionne deux résultats pris sur des appareils différents', () => {
    const test = { ...newCourseTest('s1', 'Test hebdo', TODAY, ['c1'], [], TODAY), id: 't1' };
    const a = stampState(state({ courseTests: [test], courseTestLog: [{
      id: 'r1', testId: 't1', date: TODAY, score: 12, maxScore: 20, ratio: 0.6,
      closedBook: true, chapterIds: ['c1'], portionIds: [],
    }] }), 'a', 1000);
    const b = stampState(state({ courseTests: [test], courseTestLog: [{
      id: 'r2', testId: 't1', date: addDays(TODAY, 1), score: 16, maxScore: 20, ratio: 0.8,
      closedBook: true, chapterIds: ['c1'], portionIds: [],
    }] }), 'b', 2000);
    expect(mergeStates(a, b).courseTestLog.map((entry) => entry.id)).toEqual(['r1', 'r2']);
  });
});

describe('v8 → v9', () => {
  it('ajoute uniquement les champs neutres et valide ensuite un export v9', () => {
    const old = state();
    old.version = 8;
    delete old.courseTests;
    delete old.courseTestLog;
    delete old.subjects[0].dailyMinutes;
    delete old.subjects[0].minimumMinutes;
    const migrated = normalize(old, TODAY);
    expect(migrated.version).toBe(9);
    expect(migrated.subjects[0]).toMatchObject({ dailyMinutes: 120, minimumMinutes: 60 });
    expect(migrated.courseTests).toEqual([]);
    expect(validateImport(migrated).ok).toBe(true);
  });
});
