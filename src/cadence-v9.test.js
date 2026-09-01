import { describe, expect, it } from 'vitest';
import {
  AXIS_MINUTES,
  DEFAULT_SETTINGS,
  REVIEW_UNIT_MINUTES,
  SPACED_REVIEW_MINUTES,
  addDays,
  allocateSubjectMinutes,
  subjectDailyLoads,
  applySelfAssessment,
  chapterExamFactor,
  courseTestSuggestions,
  dueCourseTests,
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
  kind: 'course', status: 'current', axes: ['recall', 'exercise', 'problem'], position: null,
  positionUpdatedAt: TODAY, docs: [],
  recall: { stability: 2, difficulty: 8.5, lastReviewed: null, source: 'seed' },
  exercise: emptyPractice(), problem: emptyPractice(), minutes: { ...AXIS_MINUTES },
});
const state = (over = {}) => ({
  version: 12, subjects: [SUBJECT], chapters: [chapter()], exams: [],
  courseTests: [], courseTestLog: [], settings: S, parallelLog: {}, reviewLog: [],
  archivedReviews: [], skips: {}, capacityOverrides: {}, examDebriefs: {},
  deleted: emptyDeleted(), syncMeta: null, lastExportAt: null, ...over,
});

describe('v10 — cycle de consolidation', () => {
  it('les cinq choix produisent cinq prochaines échéances réellement distinctes', () => {
    const parent = chapter();
    const unit = newReviewUnit(parent, 'Ajout du 31/08/2026 — théorème spectral', addDays(TODAY, -1), S);
    const intervals = [0, 1, 2, 3, 4].map((level) => {
      const reviewed = applySelfAssessment(unit, level, TODAY, S).chapter;
      return reviewUnitInfo(reviewed, S, TODAY).interval;
    });
    expect(intervals).toEqual([1, 2, 3, 10, 25]);
  });

  it('réserve 17 minutes à J+1 puis 7 minutes aux rappels espacés', () => {
    const unit = newReviewUnit(chapter(), 'Ajout du 31/08/2026 — noyau', addDays(TODAY, -1), S);
    expect(REVIEW_UNIT_MINUTES).toBe(17);
    expect(unit.minutes.recall).toBe(17);
    expect(reviewUnitInfo(unit, S, TODAY).minutes).toBe(17);
    const reviewed = applySelfAssessment(unit, 3, TODAY, S).chapter;
    expect(reviewUnitInfo(reviewed, S, TODAY).minutes).toBe(SPACED_REVIEW_MINUTES);
  });

  it('intègre la portion après deux restitutions satisfaisantes successives', () => {
    const unit = newReviewUnit(chapter(), 'Ajout du 31/08/2026 — noyau', addDays(TODAY, -1), S);
    const first = applySelfAssessment(unit, 3, TODAY, S).chapter;
    expect(first.reviewSuccessStreak).toBe(1);
    expect(first.integratedAt).toBeNull();
    const secondDate = addDays(TODAY, 10);
    const second = applySelfAssessment(first, 3, secondDate, S).chapter;
    expect(second.reviewSuccessStreak).toBe(2);
    expect(second.integratedAt).toBe(secondDate);
    expect(reviewUnitInfo(second, S, secondDate)).toMatchObject({ integrated: true, due: false, minutes: 0 });
  });

  it('rouvre un bloc de 17 minutes après un oubli', () => {
    const unit = newReviewUnit(chapter(), 'Ajout du 31/08/2026 — noyau', addDays(TODAY, -1), S);
    const forgotten = applySelfAssessment(unit, 0, TODAY, S).chapter;
    expect(reviewUnitInfo(forgotten, S, TODAY).minutes).toBe(17);
  });
});

describe('v10 — pression ciblée et budget réel', () => {
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

  it('déduit consolidations et test de l’enveloppe de deux heures', () => {
    const allocation = allocateSubjectMinutes([SUBJECT], [], S, TODAY);
    const unit = newReviewUnit(chapter(), 'Ajout du 31/08/2026 — noyau', addDays(TODAY, -1), S);
    const item = { unit, info: reviewUnitInfo(unit, S, TODAY) };
    const test = newCourseTest('s1', 'Test du chapitre', TODAY, ['c1'], [], TODAY, 20);
    expect(subjectDailyLoads(allocation, [item], [test])[0]).toMatchObject({
      maintenanceMinutes: 37, remainingMinutes: 83, overloadMinutes: 0,
    });
  });
});

describe('v10 — rappels de tests composés par l’utilisateur', () => {
  it('replanifie selon la note et resserre seulement pour une épreuve au même périmètre', () => {
    const test = newCourseTest('s1', 'Test hebdo', TODAY, ['c1'], [], TODAY);
    expect(nextCourseTestDate(test, 0.4, [], S, TODAY, [chapter()]).interval).toBe(1);
    expect(nextCourseTestDate(test, 0.5, [], S, TODAY, [chapter()]).interval).toBe(2);
    expect(nextCourseTestDate(test, 0.7, [], S, TODAY, [chapter()]).interval).toBe(4);
    expect(nextCourseTestDate(test, 0.8, [], S, TODAY, [chapter()]).interval).toBe(7);
    expect(nextCourseTestDate(test, 0.9, [], S, TODAY, [chapter()]).interval).toBe(14);
    const relevant = {
      id: 'e1', subjectId: 's1', name: 'CC', date: addDays(TODAY, 8),
      chapterIds: ['c1'], portionIds: [], importance: 'major',
    };
    expect(nextCourseTestDate(test, 0.9, [relevant], S, TODAY, [chapter()]).interval).toBeLessThan(14);
    const unrelated = { ...relevant, chapterIds: ['c2'] };
    expect(nextCourseTestDate(test, 0.9, [unrelated], S, TODAY, [chapter(), chapter('c2')]).interval).toBe(14);
  });

  it('écarte à J+30 puis J+60 après des résultats excellents répétés', () => {
    const test = newCourseTest('s1', 'Test du chapitre', TODAY, ['c1'], [], TODAY);
    const first = nextCourseTestDate(test, 0.9, [], S, TODAY, [chapter()]);
    const second = nextCourseTestDate({ ...test, strongStreak: first.strongStreak }, 0.95, [], S, TODAY, [chapter()]);
    const third = nextCourseTestDate({ ...test, strongStreak: second.strongStreak }, 1, [], S, TODAY, [chapter()]);
    expect([first.interval, second.interval, third.interval]).toEqual([14, 30, 60]);
  });

  it('n’affiche qu’un rappel de test dû par matière et laisse les autres en attente', () => {
    const first = { ...newCourseTest('s1', 'Premier', TODAY, ['c1'], [], TODAY), id: 't1' };
    const second = { ...newCourseTest('s1', 'Second', TODAY, ['c1'], [], TODAY), id: 't2' };
    expect(dueCourseTests([first, second], TODAY)).toHaveLength(1);
    expect(dueCourseTests([first, second], TODAY, false)).toHaveLength(2);
  });

  it('suggère un rappel après trois nouvelles portions sans générer de test ni de résultat', () => {
    const parent = chapter();
    const units = Array.from({ length: 3 }, (_, index) => newReviewUnit(
      parent,
      `Ajout du ${String(27 + index).padStart(2, '0')}/08/2026 — portion ${index + 1}`,
      addDays(TODAY, index - 5),
      S,
    ));
    const suggestions = courseTestSuggestions([SUBJECT], [parent, ...units], [], TODAY);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].portionIds).toHaveLength(3);
    expect(suggestions[0].action).toBe('create');

    const evolving = newCourseTest('s1', 'Test du chapitre', TODAY, [], [units[0].id], TODAY);
    const extension = courseTestSuggestions([SUBJECT], [parent, ...units], [evolving], addDays(TODAY, 3));
    expect(extension).toHaveLength(1);
    expect(extension[0]).toMatchObject({ action: 'extend', test: { id: evolving.id } });
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

  it('fusionne deux restitutions satisfaisantes et intègre la portion sans perdre une preuve', () => {
    const parent = chapter();
    const unit = newReviewUnit(parent, 'Ajout du 30/08/2026 — noyau', addDays(TODAY, -2), S);
    const reviewedA = applySelfAssessment(unit, 3, TODAY, S);
    const reviewedB = applySelfAssessment(unit, 3, addDays(TODAY, 1), S);
    const event = (id, date, result) => ({
      id, chapterId: unit.id, date, grade: 3, masteryLevel: 3,
      evidenceType: 'recall', axis: 'recall', source: 'self-review',
      before: result.before, after: result.after,
      lifecycleBefore: { reviewSuccessStreak: 0, integratedAt: null, lastMasteryLevel: null },
      lifecycleAfter: { reviewSuccessStreak: 1, integratedAt: null, lastMasteryLevel: 3 },
    });
    const a = stampState(state({
      chapters: [parent, reviewedA.chapter],
      reviewLog: [event('a1', TODAY, reviewedA)],
    }), 'a', 1000);
    const b = stampState(state({
      chapters: [parent, reviewedB.chapter],
      reviewLog: [event('b1', addDays(TODAY, 1), reviewedB)],
    }), 'b', 2000);
    const merged = mergeStates(a, b);
    const mergedUnit = merged.chapters.find((item) => item.id === unit.id);
    expect(merged.reviewLog).toHaveLength(2);
    expect(mergedUnit).toMatchObject({ reviewSuccessStreak: 2, integratedAt: addDays(TODAY, 1) });
  });

  it('conserve un seul chapitre courant après une création hors ligne sur deux appareils', () => {
    const older = stampState(state({ chapters: [chapter('c1')] }), 'a', 1000);
    const newerChapter = chapter('c2');
    const newer = stampState(state({ chapters: [newerChapter] }), 'b', 2000);
    const merged = mergeStates(older, newer);
    expect(merged.chapters.filter((item) => item.status === 'current').map((item) => item.id)).toEqual(['c2']);
    expect(merged.chapters.find((item) => item.id === 'c1').status).toBe('consolidating');
  });
});

describe('v8 → v11', () => {
  it('ajoute les champs neutres, choisit le chapitre courant et valide l’export v11', () => {
    const old = state();
    old.version = 8;
    delete old.courseTests;
    delete old.courseTestLog;
    delete old.subjects[0].dailyMinutes;
    delete old.subjects[0].minimumMinutes;
    const migrated = normalize(old, TODAY);
    expect(migrated.version).toBe(12);
    expect(migrated.subjects[0]).toMatchObject({ dailyMinutes: 120, minimumMinutes: 60 });
    expect(migrated.chapters[0].status).toBe('current');
    expect(migrated.courseTests).toEqual([]);
    expect(validateImport(migrated).ok).toBe(true);
  });
});
