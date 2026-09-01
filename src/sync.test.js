import { describe, it, expect } from 'vitest';
import {
  mergeStates, rebuildAxes, stampState, entryKey, sameContent,
  contentSignature, newDeviceId,
} from './sync.js';
import {
  DEFAULT_SETTINGS, AXIS_MINUTES, emptyPractice, emptyDeleted, markDeleted,
  pruneTombstones, normalize, applyEvidence, seedState, validateImport,
  levelSeed, LEVELS, addDays,
} from './engine.js';

const S = DEFAULT_SETTINGS;
const TODAY = '2026-01-20';

const seedRecall = (levelKey = 'new') => {
  const seed = levelSeed(LEVELS.find((l) => l.key === levelKey), S);
  return { stability: seed.stability, difficulty: seed.difficulty, lastReviewed: null, source: 'seed' };
};

const chapter = (id, over = {}) => ({
  id, subjectId: 's1', name: id, initialLevel: 'new',
  recall: seedRecall(), exercise: emptyPractice(), problem: emptyPractice(),
  minutes: { ...AXIS_MINUTES }, ...over,
});

const baseState = (over = {}) => ({
  version: 5,
  subjects: [{ id: 's1', name: 'Maths', color: '#7c9cf5', type: 'core' }],
  chapters: [chapter('c1')],
  exams: [],
  settings: { ...S },
  parallelLog: {}, reviewLog: [], archivedReviews: [], skips: {},
  capacityOverrides: {}, examDebriefs: {}, deleted: emptyDeleted(),
  syncMeta: { deviceId: 'dev-a', updatedAt: 1000, rev: 1 },
  lastExportAt: null,
  ...over,
});

// Note un test sur un appareil : renvoie l'état avec le chapitre à jour et
// l'entrée de journal, exactement comme le fait l'interface.
const grade = (state, chapterId, evidenceType, g, date, entryId) => {
  const ch = state.chapters.find((c) => c.id === chapterId);
  const { chapter: next, axis, before, after } = applyEvidence(ch, evidenceType, g, date);
  return {
    ...state,
    chapters: state.chapters.map((c) => (c.id === chapterId ? next : c)),
    reviewLog: [...state.reviewLog, { id: entryId, chapterId, date, grade: g, evidenceType, axis, before, after }],
  };
};

describe('fusion — convergence', () => {
  it('merge(a, b) et merge(b, a) donnent le même résultat', () => {
    const a = stampState(grade(baseState(), 'c1', 'recall', 3, TODAY, 'r-a'), 'dev-a', 2000);
    const b = stampState(grade(baseState(), 'c1', 'exercise', 4, TODAY, 'r-b'), 'dev-b', 3000);
    expect(contentSignature(mergeStates(a, b))).toBe(contentSignature(mergeStates(b, a)));
  });

  it('à horodatage identique, le départage reste déterministe', () => {
    const a = stampState(grade(baseState(), 'c1', 'recall', 3, TODAY, 'r-a'), 'dev-a', 5000);
    const b = stampState(grade(baseState(), 'c1', 'problem', 2, TODAY, 'r-b'), 'dev-b', 5000);
    expect(contentSignature(mergeStates(a, b))).toBe(contentSignature(mergeStates(b, a)));
  });

  it('fusionner deux fois ne change plus rien (idempotence)', () => {
    const a = stampState(grade(baseState(), 'c1', 'recall', 3, TODAY, 'r-a'), 'dev-a', 2000);
    const b = stampState(grade(baseState(), 'c1', 'exercise', 4, TODAY, 'r-b'), 'dev-b', 3000);
    const once = mergeStates(a, b);
    expect(sameContent(mergeStates(once, b), once)).toBe(true);
    expect(sameContent(mergeStates(once, once), once)).toBe(true);
  });

  it('un état absent ou vide ne détruit rien', () => {
    const a = stampState(baseState(), 'dev-a', 1);
    expect(mergeStates(a, null)).toBe(a);
    expect(mergeStates(null, a)).toBe(a);
  });
});

describe('fusion — aucun test noté n’est perdu', () => {
  it('deux notes prises en parallèle sur des axes différents survivent toutes les deux', () => {
    const a = stampState(grade(baseState(), 'c1', 'recall', 3, TODAY, 'r-a'), 'dev-a', 2000);
    const b = stampState(grade(baseState(), 'c1', 'exercise', 4, TODAY, 'r-b'), 'dev-b', 3000);
    const m = mergeStates(a, b);
    expect(m.reviewLog.map((r) => r.id).sort()).toEqual(['r-a', 'r-b']);
    const c = m.chapters[0];
    expect(c.recall.lastReviewed).toBe(TODAY);   // la note de rappel a bien été appliquée
    expect(c.exercise.attempts).toBe(1);          // celle d'exercice aussi
    expect(c.exercise.score).toBe(1);
    expect(c.problem.attempts).toBe(0);           // l'axe non testé reste intact
  });

  it('deux notes sur le MÊME axe à des dates différentes sont rejouées dans l’ordre', () => {
    const a = stampState(grade(baseState(), 'c1', 'exercise', 1, '2026-01-10', 'r-a'), 'dev-a', 2000);
    const b = stampState(grade(baseState(), 'c1', 'exercise', 4, '2026-01-15', 'r-b'), 'dev-b', 3000);
    const m = mergeStates(a, b);
    expect(m.chapters[0].exercise.attempts).toBe(2);
    expect(m.chapters[0].exercise.lastTested).toBe('2026-01-15');
    // ordre chronologique : échec puis réussite -> score = EMA(0 puis 1) = 0.5
    expect(m.chapters[0].exercise.score).toBeCloseTo(0.5, 6);
  });

  it('l’état des axes est recalculé depuis le journal fusionné, pas copié d’un côté', () => {
    const a = stampState(grade(baseState(), 'c1', 'recall', 3, '2026-01-10', 'r-a'), 'dev-a', 2000);
    // b ne connaît pas r-a : son état de rappel est en retard d'un test
    const b = stampState(grade(baseState(), 'c1', 'recall', 3, '2026-01-15', 'r-b'), 'dev-b', 3000);
    const m = mergeStates(a, b);
    const solo = mergeStates(b, b); // b seul : un seul test rejoué
    expect(m.chapters[0].recall.lastReviewed).toBe('2026-01-15');
    // deux tests rejoués -> stabilité strictement supérieure à un seul
    expect(m.chapters[0].recall.stability).toBeGreaterThan(solo.chapters[0].recall.stability);
    expect(m.chapters[0].recall.source).toBe('replayed');
  });

  it('les entrées sans identifiant sont dédupliquées par leur contenu', () => {
    const entry = { chapterId: 'c1', date: TODAY, grade: 3, evidenceType: 'recall' };
    const a = stampState(baseState({ reviewLog: [entry] }), 'dev-a', 2000);
    const b = stampState(baseState({ reviewLog: [{ ...entry }] }), 'dev-b', 3000);
    expect(mergeStates(a, b).reviewLog.length).toBe(1);
    expect(entryKey(entry)).toBe(entryKey({ ...entry }));
  });
});

describe('fusion — suppressions', () => {
  it('un chapitre supprimé sur un appareil ne ressuscite pas', () => {
    const a = stampState({
      ...baseState(), chapters: [],
      deleted: markDeleted(emptyDeleted(), 'chapters', ['c1'], TODAY),
    }, 'dev-a', 3000);
    const b = stampState(baseState(), 'dev-b', 2000); // b a encore le chapitre
    expect(mergeStates(a, b).chapters).toEqual([]);
    expect(mergeStates(b, a).chapters).toEqual([]);
  });

  it('la suppression l’emporte même si l’autre appareil a modifié le chapitre après', () => {
    const a = stampState({
      ...baseState(), chapters: [],
      deleted: markDeleted(emptyDeleted(), 'chapters', ['c1'], TODAY),
    }, 'dev-a', 1000);
    const b = stampState(grade(baseState(), 'c1', 'recall', 3, TODAY, 'r-b'), 'dev-b', 9000);
    const m = mergeStates(a, b);
    expect(m.chapters).toEqual([]);
    // le journal du chapitre supprimé disparaît aussi : pas d'orphelin
    expect(m.reviewLog).toEqual([]);
  });

  it('supprimer une matière ou une épreuve suit la même règle', () => {
    const a = stampState({
      ...baseState(), subjects: [], exams: [],
      deleted: markDeleted(emptyDeleted(), 'subjects', ['s1'], TODAY),
    }, 'dev-a', 3000);
    const b = stampState(baseState({ exams: [{ id: 'e1', subjectId: 's1', name: 'CC', date: TODAY, chapterIds: ['c1'] }] }), 'dev-b', 2000);
    expect(mergeStates(a, b).subjects).toEqual([]);
  });

  it('les pierres tombales expirent après la fenêtre de conservation', () => {
    const old = { chapters: { c9: addDays(TODAY, -200) }, subjects: {}, exams: {} };
    expect(pruneTombstones(old, TODAY).chapters.c9).toBeUndefined();
    const fresh = { chapters: { c9: addDays(TODAY, -10) }, subjects: {}, exams: {} };
    expect(pruneTombstones(fresh, TODAY).chapters.c9).toBe(addDays(TODAY, -10));
  });

  it('une épreuve conserve seulement les chapitres encore existants', () => {
    const exam = { id: 'e1', subjectId: 's1', name: 'CC', date: TODAY, chapterIds: ['c1', 'c2'] };
    const a = stampState(baseState({ exams: [exam] }), 'dev-a', 2000);
    const b = stampState({
      ...baseState({ exams: [exam] }), chapters: [],
      deleted: markDeleted(emptyDeleted(), 'chapters', ['c1'], TODAY),
    }, 'dev-b', 3000);
    expect(mergeStates(a, b).exams[0].chapterIds).toEqual([]);
  });
});

describe('fusion — recalibrage et champs annexes', () => {
  it('un recalibrage sur un appareil n’est pas défait par l’autre', () => {
    // a : le chapitre a été recalibré -> ses notes sont passées aux archives
    const noted = grade(baseState(), 'c1', 'recall', 3, '2026-01-10', 'r-1');
    const archivedEntry = noted.reviewLog[0];
    const a = stampState({
      ...noted,
      chapters: [chapter('c1')], // remis au niveau initial
      reviewLog: [],
      archivedReviews: [archivedEntry],
    }, 'dev-a', 3000);
    const b = stampState(noted, 'dev-b', 2000); // b a encore la note active
    const m = mergeStates(a, b);
    expect(m.reviewLog).toEqual([]);                       // pas de résurrection
    expect(m.archivedReviews.map((r) => r.id)).toEqual(['r-1']); // rien n'est perdu
    expect(m.chapters[0].recall.lastReviewed).toBeNull();
  });

  it('compteurs hebdo : le maximum de chaque case (un compteur manuel ne recule pas)', () => {
    const a = stampState(baseState({ parallelLog: { '2026-01-19': { p: 3, q: 1 } } }), 'dev-a', 2000);
    const b = stampState(baseState({ parallelLog: { '2026-01-19': { p: 1, q: 5 } } }), 'dev-b', 3000);
    expect(mergeStates(a, b).parallelLog['2026-01-19']).toEqual({ p: 3, q: 5 });
  });

  it('report : la date la plus tardive ; bilan masqué : reste masqué', () => {
    const a = stampState(baseState({ skips: { c1: '2026-01-18' }, examDebriefs: { e1: '2026-01-18' } }), 'dev-a', 2000);
    const b = stampState(baseState({ skips: { c1: '2026-01-20' }, examDebriefs: { e1: '2026-01-20' } }), 'dev-b', 3000);
    const m = mergeStates(a, b);
    expect(m.skips.c1).toBe('2026-01-20');
    expect(m.examDebriefs.e1).toBe('2026-01-18');
  });

  it('réglages : ceux de l’appareil modifié en dernier ; dernier export : la date la plus récente', () => {
    const a = stampState(baseState({ settings: { ...S, requestRetention: 0.85 }, lastExportAt: '2026-01-05' }), 'dev-a', 2000);
    const b = stampState(baseState({ settings: { ...S, requestRetention: 0.95 }, lastExportAt: '2026-01-02' }), 'dev-b', 3000);
    const m = mergeStates(a, b);
    expect(m.settings.requestRetention).toBe(0.95);
    expect(m.lastExportAt).toBe('2026-01-05');
  });

  it('un chapitre ajouté d’un seul côté est conservé', () => {
    const a = stampState(baseState(), 'dev-a', 2000);
    const b = stampState(baseState({ chapters: [chapter('c1'), chapter('c2')] }), 'dev-b', 3000);
    expect(mergeStates(a, b).chapters.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
  });
});

describe('rebuildAxes — rejeu fidèle', () => {
  it('un axe sans aucun événement garde son état (donnée héritée non réinventée)', () => {
    const legacy = chapter('c1', {
      recall: { stability: 12, difficulty: 6, lastReviewed: '2026-01-01', source: 'legacy' },
      exercise: { score: 0.8, attempts: 2, lastTested: '2026-01-02', recentFails: 0 },
    });
    const out = rebuildAxes(legacy, [], S);
    expect(out.recall).toEqual(legacy.recall);
    expect(out.exercise).toEqual(legacy.exercise);
  });

  it('les anciennes notes « legacy » comptent comme du rappel', () => {
    const out = rebuildAxes(chapter('c1'), [{ id: 'x', chapterId: 'c1', date: TODAY, grade: 3, evidenceType: 'legacy' }], S);
    expect(out.recall.lastReviewed).toBe(TODAY);
    expect(out.recall.source).toBe('replayed');
    expect(out.exercise.attempts).toBe(0);
  });

  it('une note d’exercice ne touche jamais le rappel', () => {
    const out = rebuildAxes(chapter('c1'), [{ id: 'x', chapterId: 'c1', date: TODAY, grade: 4, evidenceType: 'exercise' }], S);
    expect(out.recall).toEqual(chapter('c1').recall);
    expect(out.exercise.score).toBe(1);
  });
});

describe('schéma v5 & interopérabilité', () => {
  it('normalize accepte un état v4 et le passe en v5 sans rien perdre', () => {
    const v4 = { ...baseState(), version: 4 };
    delete v4.deleted; delete v4.syncMeta;
    const out = normalize(v4, TODAY);
    expect(out.version).toBe(8);
    expect(out.deleted).toEqual(emptyDeleted());
    expect(out.syncMeta).toBeNull();
    expect(out.chapters.map((c) => c.id)).toEqual(['c1']);
  });

  it('un état v5 complet passe la validation d’import', () => {
    const st = stampState(baseState(), 'dev-a', 1234);
    expect(validateImport(st)).toEqual({ ok: true, errors: [] });
    expect(validateImport(seedState()).ok).toBe(true);
  });

  it('suppressions ou métadonnées malformées : import refusé', () => {
    const bad = (over) => validateImport({ ...baseState(), ...over }).ok;
    expect(bad({ deleted: 'non' })).toBe(false);
    expect(bad({ deleted: { chapitres: {} } })).toBe(false);
    expect(bad({ deleted: { chapters: { c1: 'pas-une-date' } } })).toBe(false);
    expect(bad({ syncMeta: { deviceId: 42 } })).toBe(false);
    expect(bad({ syncMeta: { updatedAt: NaN } })).toBe(false);
  });

  it('stampState horodate et incrémente la révision sans toucher au contenu', () => {
    const a = baseState();
    const b = stampState(a, 'dev-z', 7777);
    expect(b.syncMeta).toEqual({ deviceId: 'dev-z', updatedAt: 7777, rev: 2 });
    expect(sameContent(a, b)).toBe(true); // le contenu n'a pas changé
  });

  it('newDeviceId produit des identifiants distincts', () => {
    expect(newDeviceId()).not.toBe(newDeviceId());
  });
});
