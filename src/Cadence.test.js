import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS,
  FSRS_W,
  EVIDENCE,
  gradeLabel,
  LEVELS,
  INITIAL_URGENCY,
  IMPORTANCE,
  retrievability,
  optimalInterval,
  initialDifficulty,
  nextDifficulty,
  stabilityAfterSuccess,
  stabilityAfterFailure,
  applyGrade,
  targetInterval,
  levelSeed,
  examMultiplier,
  chapterMetrics,
  subjectScore,
  planDay,
  defaultDailyMinutes,
  todayCapacityMinutes,
  forecastDue,
  annalesModeFor,
  reasonPhrase,
  migrateV1,
  migrateV2,
  normalize,
  examReadiness,
  pruneBackups,
  isWorthReviewing,
  cruiseLoad,
  observedRetention,
  validateImport,
  recalibrateState,
  daysBetween,
  addDays,
} from './engine.js';

const S = DEFAULT_SETTINGS;

const TODAY = '2026-01-20';
const FIVE_AGO = '2026-01-15';
const EXAM_NEAR = '2026-01-27'; // dans 7 j
const EXAM_FAR = '2026-06-01';  // > horizon (35 j) -> ×1

const mkChapter = (over = {}) => ({
  id: 'c1', subjectId: 's1', name: 'x', difficulty: 5, stability: 10,
  lastReviewed: FIVE_AGO, initialLevel: 'ok', estimatedMinutes: 30, ...over,
});

/* ------------------------------------------------------------------ *
 *  Modèle de rappel (équations FSRS-4.5)
 * ------------------------------------------------------------------ */

describe('courbe d’oubli (loi de puissance)', () => {
  it('R(0)=1 ; R(S)=0.9 ; décroissante', () => {
    expect(retrievability(0, 10)).toBeCloseTo(1, 6);
    expect(retrievability(10, 10)).toBeCloseTo(0.9, 5);
    expect(retrievability(40, 10)).toBeLessThan(retrievability(10, 10));
  });
  it('intervalle optimal : = S à 90 % ; plus exigeant = plus court', () => {
    expect(optimalInterval(10, 0.9)).toBeCloseTo(10, 4);
    expect(optimalInterval(10, 0.95)).toBeLessThan(10);
    expect(optimalInterval(10, 0.85)).toBeGreaterThan(10);
  });
});

describe('difficulté', () => {
  it('difficulté initiale selon la première note', () => {
    expect(initialDifficulty(1)).toBeCloseTo(7.6214, 3);
    expect(initialDifficulty(3)).toBeCloseTo(5.1618, 3);
    expect(initialDifficulty(4)).toBeCloseTo(3.932, 3);
  });
  it('Échec augmente D, Facile la baisse, bornes 1..10', () => {
    expect(nextDifficulty(5, 1)).toBeCloseTo(6.706, 2);
    expect(nextDifficulty(5, 4)).toBeCloseTo(4.097, 2);
    expect(nextDifficulty(10, 1)).toBeLessThanOrEqual(10);
    expect(nextDifficulty(1, 4)).toBeGreaterThanOrEqual(1);
  });
});

describe('stabilité après un test (S=10, D=5, R=0.9)', () => {
  it('valeurs exactes (poids par défaut)', () => {
    expect(stabilityAfterSuccess(10, 5, 0.9, 3)).toBeCloseTo(35.09, 1);
    expect(stabilityAfterSuccess(10, 5, 0.9, 2)).toBeCloseTo(15.70, 1);
    expect(stabilityAfterSuccess(10, 5, 0.9, 4)).toBeCloseTo(82.13, 1);
    expect(stabilityAfterFailure(10, 5, 0.9)).toBeCloseTo(2.56, 1);
  });
  it('effet d’espacement + monotonies', () => {
    expect(stabilityAfterSuccess(10, 5, 0.75, 3)).toBeGreaterThan(stabilityAfterSuccess(10, 5, 0.98, 3));
    expect(stabilityAfterSuccess(10, 8, 0.9, 3)).toBeLessThan(stabilityAfterSuccess(10, 3, 0.9, 3));
    expect(stabilityAfterFailure(0.5, 9, 0.99)).toBeLessThanOrEqual(0.5);
  });
});

describe('applyGrade', () => {
  it('succès : stabilité en hausse ; échec : chute + difficulté en hausse', () => {
    const ch = mkChapter({ lastReviewed: '2026-01-10' });
    expect(applyGrade(ch, 3, TODAY).stability).toBeGreaterThan(10);
    const fail = applyGrade(ch, 1, TODAY);
    expect(fail.stability).toBeLessThan(10);
    expect(fail.difficulty).toBeGreaterThan(5);
  });
  it('jamais testé : retard supposé selon le niveau initial', () => {
    const solid = applyGrade(mkChapter({ lastReviewed: null, initialLevel: 'solid' }), 3, TODAY);
    const fresh = applyGrade(mkChapter({ lastReviewed: null, initialLevel: 'new' }), 3, TODAY);
    // « Jamais vu » suppose plus de retard -> R plus bas au moment du test
    expect(fresh.R).toBeLessThan(solid.R);
  });
});

/* ------------------------------------------------------------------ *
 *  Niveaux initiaux : urgence réellement différenciée
 * ------------------------------------------------------------------ */

describe('chapitres jamais testés — urgence initiale par niveau', () => {
  const urgencyOf = (levelKey) => {
    const seed = levelSeed(LEVELS.find((l) => l.key === levelKey), S);
    const ch = mkChapter({ lastReviewed: null, ...seed });
    return chapterMetrics(ch, [], S, TODAY).urgency;
  };
  it('sans examen : Jamais vu > Fragile > Moyen > Solide', () => {
    const u = {
      new: urgencyOf('new'), fragile: urgencyOf('fragile'),
      ok: urgencyOf('ok'), solid: urgencyOf('solid'),
    };
    expect(u.new).toBeGreaterThan(u.fragile);
    expect(u.fragile).toBeGreaterThan(u.ok);
    expect(u.ok).toBeGreaterThan(u.solid);
  });
  it('valeurs exactes : 2.2 / 1.6 / 1.0 / 0.5', () => {
    expect(urgencyOf('new')).toBeCloseTo(2.2, 5);
    expect(urgencyOf('fragile')).toBeCloseTo(1.6, 5);
    expect(urgencyOf('ok')).toBeCloseTo(1.0, 5);
    expect(urgencyOf('solid')).toBeCloseTo(0.5, 5);
    expect(INITIAL_URGENCY.new).toBe(2.2);
  });
  it('un chapitre « Solide » jamais testé n’est pas planifié tout de suite', () => {
    const seed = levelSeed(LEVELS.find((l) => l.key === 'solid'), S);
    const m = chapterMetrics(mkChapter({ lastReviewed: null, ...seed }), [], S, TODAY);
    expect(isWorthReviewing(m)).toBe(false);
  });
});

describe('recalibrage cohérent', () => {
  const state = {
    settings: { ...S },
    chapters: [mkChapter({ id: 'c1', lastReviewed: FIVE_AGO }), mkChapter({ id: 'c2' })],
    reviewLog: [
      { id: 'r1', chapterId: 'c1', date: FIVE_AGO, grade: 3, evidenceType: 'recall', before: {}, after: {} },
      { id: 'r2', chapterId: 'c2', date: FIVE_AGO, grade: 3, evidenceType: 'recall', before: {}, after: {} },
    ],
    archivedReviews: [],
  };
  it('applique le niveau, efface lastReviewed, archive l’historique du chapitre', () => {
    const next = recalibrateState(state, 'c1', 'fragile');
    const c1 = next.chapters.find((c) => c.id === 'c1');
    expect(c1.initialLevel).toBe('fragile');
    expect(c1.lastReviewed).toBeNull();
    expect(c1.stability).toBeCloseTo(targetInterval(33, S), 4);
    // historique de c1 archivé, celui de c2 intact — rien n'est perdu
    expect(next.reviewLog.map((r) => r.id)).toEqual(['r2']);
    expect(next.archivedReviews.map((r) => r.id)).toEqual(['r1']);
    // pas d'état contradictoire : plus de journal actif pour un chapitre « jamais testé »
    expect(next.reviewLog.some((r) => r.chapterId === 'c1')).toBe(false);
  });
  it('niveau inconnu : état inchangé', () => {
    expect(recalibrateState(state, 'c1', 'zzz')).toBe(state);
  });
});

/* ------------------------------------------------------------------ *
 *  Examens : pression multiplicative + importance
 * ------------------------------------------------------------------ */

describe('examMultiplier', () => {
  it('épreuve normale : 35 j -> 1.00 ; 21 j -> 1.64 ; 7 j -> 3.56 ; 0 j -> 5.00', () => {
    expect(examMultiplier(35, S)).toBeCloseTo(1.0, 2);
    expect(examMultiplier(21, S)).toBeCloseTo(1.64, 2);
    expect(examMultiplier(7, S)).toBeCloseTo(3.56, 2);
    expect(examMultiplier(0, S)).toBeCloseTo(5.0, 2);
  });
  it('importance : majeure > normale > mineure (même date), bornée', () => {
    const minor = examMultiplier(7, S, 'minor');
    const normal = examMultiplier(7, S, 'normal');
    const major = examMultiplier(7, S, 'major');
    expect(major).toBeGreaterThan(normal);
    expect(normal).toBeGreaterThan(minor);
    // formule : 1 + (base-1)×w -> bornes documentées
    expect(major).toBeCloseTo(1 + (normal - 1) * 1.4, 6);
    expect(minor).toBeCloseTo(1 + (normal - 1) * 0.6, 6);
    expect(examMultiplier(0, S, 'major')).toBeLessThanOrEqual(1 + (S.maxExamPressure - 1) * 1.4 + 1e-9);
    expect(examMultiplier(40, S, 'major')).toBe(1); // hors horizon
  });
});

describe('priorité d’un chapitre : importance de l’épreuve', () => {
  const prio = (importance) => {
    const ch = mkChapter();
    const exams = [{ id: 'e1', subjectId: 's1', name: 'CC', date: EXAM_NEAR, chapterIds: ['c1'], importance }];
    return chapterMetrics(ch, exams, S, TODAY).priority;
  };
  it('à date et couverture identiques : majeure > normale > mineure', () => {
    expect(prio('major')).toBeGreaterThan(prio('normal'));
    expect(prio('normal')).toBeGreaterThan(prio('minor'));
  });
});

describe('priorité multiplicative (inchangée)', () => {
  const prioOf = (stability, examDate) => {
    const ch = mkChapter({ stability });
    const exams = examDate
      ? [{ id: 'e1', subjectId: 's1', name: 'CC', date: examDate, chapterIds: ['c1'], importance: 'normal' }]
      : [];
    return chapterMetrics(ch, exams, S, TODAY).priority;
  };
  it('faible+proche ≫ solide+proche', () => {
    expect(prioOf(3, EXAM_NEAR) / prioOf(3, EXAM_FAR)).toBeCloseTo(3.56, 1);
    expect(prioOf(3, EXAM_NEAR)).toBeGreaterThan(prioOf(30, EXAM_NEAR) * 5);
  });
});

/* ------------------------------------------------------------------ *
 *  Capacité en minutes & plan du jour
 * ------------------------------------------------------------------ */

describe('capacité quotidienne en minutes', () => {
  it('défaut dérivé des réglages : 3 × 2 h = 360 min', () => {
    expect(defaultDailyMinutes(S)).toBe(360);
  });
  it('dérogation datée prioritaire ; 0 accepté ; défaut sinon', () => {
    expect(todayCapacityMinutes(S, { [TODAY]: 120 }, TODAY)).toBe(120);
    expect(todayCapacityMinutes(S, { [TODAY]: 0 }, TODAY)).toBe(0);
    expect(todayCapacityMinutes(S, { '2026-01-19': 120 }, TODAY)).toBe(360);
    expect(todayCapacityMinutes(S, {}, TODAY)).toBe(360);
  });
});

describe('subjectScore — robuste au saucissonnage', () => {
  it('max + moyenne du top 3 (pas la somme brute)', () => {
    expect(subjectScore([10])).toBeCloseTo(20, 6);
    expect(subjectScore([6, 5, 4, 3, 2, 1])).toBeCloseTo(6 + 5, 6);
    expect(subjectScore([])).toBe(0);
  });
  it('beaucoup de petits chapitres ne battent pas une matière urgente', () => {
    const urgent = subjectScore([8]);                     // 1 chapitre réellement urgent
    const many = subjectScore([2, ...Array(30).fill(0.4)]); // 31 chapitres tièdes
    expect(urgent).toBeGreaterThan(many);
  });
});

describe('planDay — plan en minutes', () => {
  const subjects = [
    { id: 'A', name: 'A', type: 'core' }, { id: 'B', name: 'B', type: 'core' },
    { id: 'C', name: 'C', type: 'core' }, { id: 'P', name: 'Anki', type: 'parallel' },
  ];
  const opts = { subjectsPerDay: 3, sessionMinutes: 120, totalMinutes: 360, settings: S };
  const ch = (id, subjectId, priority, estimatedMinutes = 30) => ({ id, subjectId, priority, estimatedMinutes });

  it('remplit chaque séance en minutes (≤ 120), en gardant l’ordre de priorité', () => {
    const ranked = [
      ch('a1', 'A', 9, 90), ch('a2', 'A', 8, 60), ch('a3', 'A', 7, 15), ch('a4', 'A', 6, 30),
      ch('b1', 'B', 5, 30),
    ];
    const sessions = planDay(ranked, subjects, opts);
    const a = sessions.find((s) => s.subject.id === 'A');
    // 90 pris ; 60 ne tient pas (30 restants) ; 15 tient ; 30 ne tient plus -> 105 min
    expect(a.chapters.map((c) => c.id)).toEqual(['a1', 'a3']);
    expect(a.minutes).toBe(105);
  });

  it('respecte STRICTEMENT le total du jour (jamais de dépassement)', () => {
    const ranked = [
      ch('a1', 'A', 9, 90), ch('b1', 'B', 8, 90), ch('c1', 'C', 7, 90),
    ];
    const sessions = planDay(ranked, subjects, { ...opts, totalMinutes: 150 });
    // A prend 90 ; il reste 60 : aucun chapitre de 90 ne tient -> on s'arrête.
    expect(sessions.length).toBe(1);
    expect(sessions.reduce((x, s) => x + s.minutes, 0)).toBeLessThanOrEqual(150);
  });

  it('capacité 0 : aucun plan (pas de faux travail)', () => {
    const ranked = [ch('a1', 'A', 9)];
    expect(planDay(ranked, subjects, { ...opts, totalMinutes: 0 })).toEqual([]);
  });

  it('anti-biais : une matière saucissonnée ne domine pas une matière urgente', () => {
    const ranked = [
      ch('b1', 'B', 8),                                        // B : 1 chapitre urgent
      ...Array.from({ length: 25 }, (_, i) => ch('a' + i, 'A', 0.9, 15)), // A : 25 miettes
    ];
    const sessions = planDay(ranked, subjects, opts);
    expect(sessions[0].subject.id).toBe('B');
  });

  it('exclut les matières parallèles', () => {
    const ranked = [ch('p1', 'P', 99), ch('a1', 'A', 1)];
    const sessions = planDay(ranked, subjects, opts);
    expect(sessions.every((s) => s.subject.id !== 'P')).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 *  Types de preuve
 * ------------------------------------------------------------------ */

describe('types de preuve (evidenceType)', () => {
  it('libellés adaptés au type de preuve', () => {
    expect(gradeLabel('recall', 1)).toBe('Oublié');
    expect(gradeLabel('recall', 4)).toBe('Immédiat');
    expect(gradeLabel('exercise', 2)).toBe('Avec aide');
    expect(gradeLabel('exercise', 4)).toBe('Autonome et propre');
    expect(gradeLabel('problem', 2)).toBe('Partiel');
    expect(gradeLabel('problem', 4)).toBe('Résolu proprement dans le temps');
    expect(gradeLabel('legacy', 3)).toBe('Bien');
  });
  it('trois types proposés + legacy pour l’existant', () => {
    expect(Object.keys(EVIDENCE)).toEqual(['recall', 'exercise', 'problem', 'legacy']);
  });
});

/* ------------------------------------------------------------------ *
 *  Migrations & validation d'import
 * ------------------------------------------------------------------ */

describe('migration v2 -> v3 : aucune donnée perdue', () => {
  const v2 = {
    version: 2,
    subjects: [{ id: 's', name: 'EM', color: '#fff', type: 'core' }],
    chapters: [
      { id: 'c1', subjectId: 's', name: 'A', difficulty: 6.8, stability: 12, lastReviewed: FIVE_AGO },
      { id: 'c2', subjectId: 's', name: 'B', difficulty: 3.2, stability: 30, lastReviewed: null },
    ],
    exams: [{ id: 'e1', subjectId: 's', name: 'CC', date: EXAM_NEAR, chapterIds: ['c1'] }],
    settings: { requestRetention: 0.92, subjectsPerDay: 2 },
    parallelLog: { '2026-01-19': { p: 3 } },
    reviewLog: [{ id: 'r1', chapterId: 'c1', date: FIVE_AGO, grade: 3, before: { stability: 8, difficulty: 7, lastReviewed: null }, after: { stability: 12, difficulty: 6.8 } }],
    skips: { c2: '2026-01-18' },
  };
  const v3 = migrateV2(v2);

  it('préserve matières, chapitres, examens, réglages, historique, reports', () => {
    expect(v3.version).toBe(3);
    expect(v3.subjects).toEqual(v2.subjects);
    expect(v3.chapters.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(v3.chapters[0].stability).toBe(12);
    expect(v3.chapters[0].lastReviewed).toBe(FIVE_AGO);
    expect(v3.exams[0].chapterIds).toEqual(['c1']);
    expect(v3.settings.requestRetention).toBe(0.92);
    expect(v3.settings.subjectsPerDay).toBe(2);
    expect(v3.parallelLog).toEqual(v2.parallelLog);
    expect(v3.reviewLog.length).toBe(1);
    expect(v3.skips).toEqual(v2.skips);
  });
  it('ajoute les nouveaux champs avec de bons défauts', () => {
    expect(v3.chapters[0].estimatedMinutes).toBe(30);
    expect(v3.chapters[0].initialLevel).toBe('fragile'); // D=6.8 -> niveau le plus proche
    expect(v3.chapters[1].initialLevel).toBe('solid');   // D=3.2
    expect(v3.exams[0].importance).toBe('normal');
    expect(v3.reviewLog[0].evidenceType).toBe('legacy');
    expect(v3.archivedReviews).toEqual([]);
    expect(v3.capacityOverrides).toEqual({});
    expect(v3.lastExportAt).toBeNull();
  });
  it('normalize accepte v1, v2 et v3', () => {
    const fromV1 = normalize({ subjects: [], chapters: [{ id: 'c', subjectId: 's', name: 'x', mastery: 50 }] });
    expect(fromV1.version).toBe(3);
    expect(fromV1.chapters[0].estimatedMinutes).toBe(30);
    expect(normalize(v2).version).toBe(3);
    expect(normalize(v3).version).toBe(3);
  });
});

describe('migration v1 -> v3 (chaînée)', () => {
  it('maîtrise -> difficulté -> niveau initial', () => {
    const v3 = normalize({
      subjects: [{ id: 's', name: 'EM', color: '#fff', type: 'core' }],
      chapters: [{ id: 'c1', subjectId: 's', name: 'A', mastery: 100, lastReviewed: null }],
      exams: [], settings: {}, parallelLog: {},
    });
    expect(v3.chapters[0].difficulty).toBeCloseTo(1, 5);
    expect(v3.chapters[0].initialLevel).toBe('solid');
  });
});

describe('validateImport — import JSON strict', () => {
  it('rejette les structures invalides avec un message clair', () => {
    expect(validateImport(null).ok).toBe(false);
    expect(validateImport([1, 2]).ok).toBe(false);
    expect(validateImport({}).ok).toBe(false);
    expect(validateImport({ subjects: 'nope' }).ok).toBe(false);
    expect(validateImport({ subjects: [{ nom: 'sans name' }] }).ok).toBe(false);
    expect(validateImport({ subjects: [], chapters: 'nope' }).ok).toBe(false);
    expect(validateImport({ subjects: [], chapters: [{ id: 'c' }] }).ok).toBe(false);
    expect(validateImport({ subjects: [] }).error).toBeUndefined();
  });
  it('accepte un état v2/v3 réel', () => {
    expect(validateImport(migrateV2({ subjects: [{ id: 's', name: 'EM' }], chapters: [] })).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 *  Préparation d'examen : testés / non testés séparés
 * ------------------------------------------------------------------ */

describe('examReadiness — couverture testés/non testés', () => {
  const EXAM_5D = addDays(TODAY, 5);
  it('les non-testés sont une catégorie à part, jamais fondus dans la moyenne', () => {
    const exam = { id: 'e', subjectId: 's', name: 'CC', date: EXAM_5D, chapterIds: ['c1', 'c2'] };
    const chapters = [
      mkChapter({ id: 'c1', stability: 10, lastReviewed: FIVE_AGO }),
      mkChapter({ id: 'c2', name: 'neuf', stability: 2, lastReviewed: null, initialLevel: 'new' }),
    ];
    const r = examReadiness(exam, chapters, S, TODAY);
    expect(r.testedCount).toBe(1);
    expect(r.coveredCount).toBe(2);
    expect(r.untested.map((c) => c.id)).toEqual(['c2']);
    expect(r.avgR).toBeCloseTo(0.9, 3); // moyenne SUR LES TESTÉS uniquement
  });
  it('aucun testé -> avgR null (pas de fausse moyenne)', () => {
    const exam = { id: 'e', subjectId: 's', name: 'CC', date: EXAM_5D, chapterIds: ['c1'] };
    const r = examReadiness(exam, [mkChapter({ lastReviewed: null })], S, TODAY);
    expect(r.avgR).toBeNull();
    expect(r.untested.length).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 *  Divers conservés
 * ------------------------------------------------------------------ */

describe('reasonPhrase', () => {
  const mk = (over, exams = []) => chapterMetrics(mkChapter(over), exams, S, TODAY);
  it('examen proche / retard / jamais testé / pas urgent', () => {
    const exams = [{ id: 'e1', subjectId: 's1', name: 'CC1', date: EXAM_NEAR, chapterIds: ['c1'], importance: 'normal' }];
    expect(reasonPhrase(mk({ stability: 3 }, exams)).text).toBe('Examen CC1 dans 7 j');
    expect(reasonPhrase(mk({ stability: 2 })).text).toBe('En retard de 3 j');
    expect(reasonPhrase(mk({ lastReviewed: null, initialLevel: 'new', stability: 2 })).text).toBe('Jamais testé');
    expect(reasonPhrase(mk({ stability: 30 })).tone).toBe('calm');
  });
});

describe('forecastDue', () => {
  it('chapitre S=10 testé il y a 4 j -> échéance dans 6 j', () => {
    const chapters = [mkChapter({ lastReviewed: addDays(TODAY, -4) })];
    expect(forecastDue(chapters, S, TODAY)[addDays(TODAY, 6)]).toBe(1);
  });
  it('« Solide » jamais testé n’échoit pas aujourd’hui ; « Jamais vu » si', () => {
    const solid = mkChapter({ id: 'c1', lastReviewed: null, initialLevel: 'solid', stability: 30 });
    const fresh = mkChapter({ id: 'c2', lastReviewed: null, initialLevel: 'new', stability: 2 });
    const map = forecastDue([solid, fresh], S, TODAY);
    expect(map[TODAY]).toBe(1); // seulement « Jamais vu »
  });
});

describe('cruiseLoad / observedRetention / pruneBackups / annales / défauts', () => {
  it('cruiseLoad : Σ 1/intervalle', () => {
    expect(cruiseLoad([mkChapter(), mkChapter()], S)).toBeCloseTo(0.2, 5);
  });
  it('observedRetention ignore les premiers tests', () => {
    const log = [
      { grade: 3, date: TODAY, before: { stability: 10, difficulty: 5, lastReviewed: addDays(TODAY, -10) } },
      { grade: 1, date: TODAY, before: { stability: 10, difficulty: 5, lastReviewed: addDays(TODAY, -10) } },
      { grade: 3, date: TODAY, before: { stability: 2, difficulty: 8, lastReviewed: null } },
    ];
    const r = observedRetention(log);
    expect(r.n).toBe(2);
    expect(r.rate).toBeCloseTo(0.5, 5);
    expect(r.predicted).toBeCloseTo(0.9, 4);
  });
  it('pruneBackups garde les 7 plus récents', () => {
    const backups = {};
    for (let i = 0; i < 10; i++) backups[addDays(TODAY, -i)] = { i };
    expect(Object.keys(pruneBackups(backups, TODAY, 7)).length).toBe(7);
  });
  it('annalesModeFor : seuil', () => {
    expect(annalesModeFor('s', [{ id: 'e', subjectId: 's', name: 'CC', date: EXAM_NEAR, chapterIds: [] }], S, TODAY)).toBeTruthy();
    expect(annalesModeFor('s', [{ id: 'e', subjectId: 's', name: 'CC', date: EXAM_FAR, chapterIds: [] }], S, TODAY)).toBeNull();
  });
  it('défauts sains', () => {
    expect(S.simpleMode).toBe(true);
    expect(S.subjectsPerDay).toBe(3);
    expect(FSRS_W.length).toBe(17);
    expect(IMPORTANCE.normal.w).toBe(1);
    expect(targetInterval(0, S)).toBeCloseTo(2, 5);
    expect(targetInterval(100, S)).toBeCloseTo(30, 5);
  });
});
