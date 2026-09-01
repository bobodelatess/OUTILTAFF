import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  DEFAULT_ROUTINE_TARGETS,
  addDays,
  emptyDeleted,
  emptyPractice,
  newCourseTest,
  newRoutineEvent,
  newRoutineItem,
  normalize,
  routineEventCount,
  routineItemInfo,
  subjectRoutineProgress,
  validateImport,
} from './engine.js';
import { mergeStates, stampState } from './sync.js';

const TODAY = '2026-09-01';
const SUBJECT = {
  id: 's1', name: 'Algèbre', color: '#5ea9ff', type: 'core',
  dailyMinutes: 120, minimumMinutes: 60,
  routineTargets: { ...DEFAULT_ROUTINE_TARGETS },
};
const chapter = {
  id: 'c1', subjectId: 's1', name: 'Applications linéaires', initialLevel: 'new',
  kind: 'course', status: 'current', axes: ['recall', 'exercise', 'problem'],
  position: null, positionUpdatedAt: TODAY, docs: [],
  recall: { stability: 2, difficulty: 8.5, lastReviewed: null, source: 'seed' },
  exercise: emptyPractice(), problem: emptyPractice(),
  minutes: { recall: 10, exercise: 25, problem: 40 },
};
const baseState = (over = {}) => ({
  version: 11, subjects: [SUBJECT], chapters: [chapter], exams: [],
  courseTests: [], courseTestLog: [], routineItems: [], routineLog: [],
  settings: { ...DEFAULT_SETTINGS }, parallelLog: {}, reviewLog: [], archivedReviews: [],
  skips: {}, capacityOverrides: {}, examDebriefs: {}, deleted: emptyDeleted(),
  syncMeta: null, lastExportAt: null, ...over,
});

describe('v11 — checklist quantitative sans faux test', () => {
  it('compte 5 exercices par jour et 2 annales dans la semaine', () => {
    const exerciseEvents = Array.from({ length: 5 }, () => newRoutineEvent('s1', 'exercise', TODAY));
    const pastPapers = [
      newRoutineEvent('s1', 'past-paper', addDays(TODAY, -1)),
      newRoutineEvent('s1', 'past-paper', TODAY),
    ];
    const log = [...exerciseEvents, ...pastPapers];
    expect(routineEventCount(log, 's1', 'exercise', TODAY, TODAY)).toBe(5);
    expect(subjectRoutineProgress(SUBJECT, log, [], [], TODAY)).toMatchObject({
      exercises: 5, pastPapers: 2, knowledgeTests: 0,
    });
  });

  it('dérive les tests uniquement des notes /20 réellement enregistrées', () => {
    const test = { ...newCourseTest('s1', 'Test stable', TODAY, ['c1'], [], TODAY), id: 't1' };
    const results = Array.from({ length: 3 }, (_, index) => ({
      id: `r${index}`, testId: 't1', date: index === 0 ? TODAY : addDays(TODAY, -1),
      score: 16, maxScore: 20, ratio: 0.8, closedBook: true,
      chapterIds: ['c1'], portionIds: [],
    }));
    expect(subjectRoutineProgress(SUBJECT, [], [test], results, TODAY).knowledgeTests).toBe(3);
    expect(subjectRoutineProgress(SUBJECT, [newRoutineEvent('s1', 'exercise', TODAY)], [test], [], TODAY).knowledgeTests).toBe(0);
  });
});

describe('v11 — entretien récurrent', () => {
  it('redevient dû selon sa fréquence et peut être annulé le jour même', () => {
    const item = newRoutineItem('s1', 'Démonstrations', 7, addDays(TODAY, -10));
    const done = newRoutineEvent('s1', 'maintenance', addDays(TODAY, -7), 1, item.id);
    expect(routineItemInfo(item, [done], TODAY)).toMatchObject({ due: true, dueAt: TODAY, doneToday: false });
    const todayDone = newRoutineEvent('s1', 'maintenance', TODAY, 1, item.id);
    expect(routineItemInfo(item, [done, todayDone], TODAY)).toMatchObject({ due: false, doneToday: true });
    const undo = newRoutineEvent('s1', 'maintenance', TODAY, -1, item.id);
    expect(routineItemInfo(item, [done, todayDone, undo], TODAY)).toMatchObject({ due: true, doneToday: false });
  });

  it('fusionne les réalisations de deux appareils par identifiant', () => {
    const aEvent = { ...newRoutineEvent('s1', 'exercise', TODAY), id: 'a1' };
    const bEvent = { ...newRoutineEvent('s1', 'exercise', TODAY), id: 'b1' };
    const a = stampState(baseState({ routineLog: [aEvent] }), 'a', 1000);
    const b = stampState(baseState({ routineLog: [bEvent] }), 'b', 2000);
    const merged = mergeStates(a, b);
    expect(routineEventCount(merged.routineLog, 's1', 'exercise', TODAY, TODAY)).toBe(2);
  });
});

describe('v10 → v11', () => {
  it('ajoute les objectifs sans inventer une réalisation', () => {
    const old = baseState();
    old.version = 10;
    delete old.subjects[0].routineTargets;
    delete old.routineItems;
    delete old.routineLog;
    const migrated = normalize(old, TODAY);
    expect(migrated.version).toBe(11);
    expect(migrated.subjects[0].routineTargets).toEqual(DEFAULT_ROUTINE_TARGETS);
    expect(migrated.routineItems).toEqual([]);
    expect(migrated.routineLog).toEqual([]);
    expect(validateImport(migrated).ok).toBe(true);
  });
});
