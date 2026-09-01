import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS,
  FSRS_W,
  EVIDENCE,
  AXES,
  AXIS_KEYS,
  AXIS_MINUTES,
  RISK,
  gradeLabel,
  evidenceAxis,
  LEVELS,
  INITIAL_URGENCY,
  IMPORTANCE,
  retrievability,
  optimalInterval,
  initialDifficulty,
  nextDifficulty,
  stabilityAfterSuccess,
  stabilityAfterFailure,
  applyRecall,
  emptyPractice,
  applyPractice,
  practiceRisk,
  chapterPracticeRisk,
  applyEvidence,
  targetInterval,
  levelSeed,
  examMultiplier,
  chapterMetrics,
  axisMinutes,
  subjectScore,
  planDay,
  defaultDailyMinutes,
  todayCapacityMinutes,
  forecastDue,
  annalesModeFor,
  reasonPhrase,
  migrateV2,
  migrateV3,
  normalize,
  ensureV7,
  pendingDebriefs,
  DEBRIEF_WINDOW,
  IMPORT_BOUNDS,
  examReadiness,
  axisSummary,
  pruneBackups,
  isWorthReviewing,
  cruiseLoad,
  observedRetention,
  validateImport,
  recalibrateState,
  seedState,
  addDays,
} from './engine.js';

const S = DEFAULT_SETTINGS;

const TODAY = '2026-01-20';
const FIVE_AGO = '2026-01-15';
const EXAM_NEAR = '2026-01-27'; // dans 7 j
const EXAM_FAR = '2026-06-01';  // > horizon (35 j) -> ×1

// Chapitre v4 : trois axes indépendants. Par défaut : rappel testé il y a 5 j
// (S=10), exercice et problème testés (score 1) il y a 5 j -> l'axe rappel
// domine, comme dans les anciens tests centrés mémoire.
const donePractice = (over = {}) => ({ score: 1, attempts: 3, lastTested: FIVE_AGO, recentFails: 0, ...over });
const mkChapter = (over = {}) => ({
  id: 'c1', subjectId: 's1', name: 'x', initialLevel: 'ok',
  recall: { stability: 10, difficulty: 5, lastReviewed: FIVE_AGO },
  exercise: donePractice(),
  problem: donePractice(),
  minutes: { ...AXIS_MINUTES },
  ...over,
});
const untestedRecall = (levelKey) => {
  const seed = levelSeed(LEVELS.find((l) => l.key === levelKey), S);
  return { stability: seed.stability, difficulty: seed.difficulty, lastReviewed: null };
};

/* ------------------------------------------------------------------ *
 *  Axe rappel : modèle FSRS-4.5 (inchangé)
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

describe('applyRecall', () => {
  it('succès : stabilité en hausse ; échec : chute + difficulté en hausse', () => {
    const rec = { stability: 10, difficulty: 5, lastReviewed: '2026-01-10' };
    expect(applyRecall(rec, 'ok', 3, TODAY).stability).toBeGreaterThan(10);
    const fail = applyRecall(rec, 'ok', 1, TODAY);
    expect(fail.stability).toBeLessThan(10);
    expect(fail.difficulty).toBeGreaterThan(5);
    expect(fail.lastReviewed).toBe(TODAY);
  });
  it('jamais testé : retard supposé selon le niveau initial', () => {
    const rec = { stability: 10, difficulty: 5, lastReviewed: null };
    // « Jamais vu » suppose plus de retard -> R plus bas -> gain d'espacement plus fort
    const sNew = applyRecall(rec, 'new', 3, TODAY).stability;
    const sSolid = applyRecall(rec, 'solid', 3, TODAY).stability;
    expect(sNew).toBeGreaterThan(sSolid);
  });
});

/* ------------------------------------------------------------------ *
 *  Axes pratiques : score heuristique transparent
 * ------------------------------------------------------------------ */

describe('applyPractice — score EMA + échecs récents', () => {
  it('barème transparent : 1->0, 2->0.4, 3->0.8, 4->1', () => {
    expect(applyPractice(null, 4, TODAY).score).toBe(1);
    expect(applyPractice(null, 3, TODAY).score).toBeCloseTo(0.8);
    expect(applyPractice(null, 2, TODAY).score).toBeCloseTo(0.4);
    expect(applyPractice(null, 1, TODAY).score).toBe(0);
  });
  it('EMA (α=0.5), compteur de tentatives, échecs récents qui régressent', () => {
    let st = applyPractice(null, 4, '2026-01-10');
    st = applyPractice(st, 1, '2026-01-15');
    expect(st.score).toBeCloseTo(0.5, 6);
    expect(st.attempts).toBe(2);
    expect(st.recentFails).toBe(1);
    st = applyPractice(st, 3, TODAY);
    expect(st.score).toBeCloseTo(0.65, 6);
    expect(st.recentFails).toBe(0);
    expect(st.lastTested).toBe(TODAY);
  });
});

describe('practiceRisk — risque lisible', () => {
  it('jamais testé -> RISK.untestedPractice', () => {
    expect(practiceRisk(emptyPractice(), TODAY)).toBe(RISK.untestedPractice);
    expect(practiceRisk(null, TODAY)).toBe(RISK.untestedPractice);
  });
  it('score parfait testé aujourd’hui -> ~0 ; l’ancienneté sature à 21 j', () => {
    expect(practiceRisk({ score: 1, attempts: 1, lastTested: TODAY, recentFails: 0 }, TODAY)).toBeCloseTo(0, 6);
    const stale = practiceRisk({ score: 1, attempts: 1, lastTested: addDays(TODAY, -50), recentFails: 0 }, TODAY);
    expect(stale).toBeCloseTo(RISK.staleWeight, 6);
  });
  it('échecs répétés pèsent, plafonnés à 3', () => {
    const r = practiceRisk({ score: 0, attempts: 4, lastTested: TODAY, recentFails: 3 }, TODAY);
    expect(r).toBeCloseTo(1 + 3 * RISK.failWeight, 6);
    const r9 = practiceRisk({ score: 0, attempts: 9, lastTested: TODAY, recentFails: 9 }, TODAY);
    expect(r9).toBeCloseTo(r, 6);
  });
  it('axe pratique jamais testé : plafonné par le niveau initial du chapitre', () => {
    expect(chapterPracticeRisk({ initialLevel: 'new', exercise: emptyPractice() }, 'exercise', TODAY)).toBe(1.2);
    expect(chapterPracticeRisk({ initialLevel: 'ok', exercise: emptyPractice() }, 'exercise', TODAY)).toBe(1.0);
    expect(chapterPracticeRisk({ initialLevel: 'solid', exercise: emptyPractice() }, 'exercise', TODAY)).toBe(0.5);
  });
});

/* ------------------------------------------------------------------ *
 *  applyEvidence : UNE preuve ne touche QUE son axe
 * ------------------------------------------------------------------ */

describe('applyEvidence — indépendance stricte des trois axes', () => {
  const base = () => mkChapter({ exercise: emptyPractice(), problem: emptyPractice() });

  it('une note d’exercice ne modifie NI le rappel NI le problème', () => {
    const ch = base();
    const { chapter, axis, before, after } = applyEvidence(ch, 'exercise', 3, TODAY);
    expect(axis).toBe('exercise');
    expect(chapter.recall).toEqual(ch.recall);
    expect(chapter.problem).toEqual(ch.problem);
    expect(chapter.exercise.attempts).toBe(1);
    expect(chapter.exercise.score).toBeCloseTo(0.8);
    expect(before.attempts).toBe(0);
    expect(after.lastTested).toBe(TODAY);
  });

  it('un échec sur problème ne modifie NI le rappel NI l’exercice', () => {
    const ch = base();
    const { chapter } = applyEvidence(ch, 'problem', 1, TODAY);
    expect(chapter.recall).toEqual(ch.recall);
    expect(chapter.exercise).toEqual(ch.exercise);
    expect(chapter.problem).toEqual({ score: 0, attempts: 1, lastTested: TODAY, recentFails: 1 });
  });

  it('une note de rappel ne modifie que le rappel ; « legacy » compte comme rappel', () => {
    const ch = base();
    const { chapter, axis, before } = applyEvidence(ch, 'recall', 3, TODAY);
    expect(chapter.exercise).toEqual(ch.exercise);
    expect(chapter.problem).toEqual(ch.problem);
    expect(chapter.recall.lastReviewed).toBe(TODAY);
    expect(chapter.recall.stability).toBeGreaterThan(10);
    expect(before.lastReviewed).toBe(FIVE_AGO);
    expect(applyEvidence(ch, 'legacy', 3, TODAY).axis).toBe('recall');
    expect(evidenceAxis('legacy')).toBe('recall');
  });

  it('trois preuves différentes le même jour : les trois axes avancent', () => {
    let c = base();
    c = applyEvidence(c, 'recall', 3, TODAY).chapter;
    c = applyEvidence(c, 'exercise', 4, TODAY).chapter;
    c = applyEvidence(c, 'problem', 2, TODAY).chapter;
    expect(c.recall.lastReviewed).toBe(TODAY);
    expect(c.exercise).toEqual({ score: 1, attempts: 1, lastTested: TODAY, recentFails: 0 });
    expect(c.problem.score).toBeCloseTo(0.4);
  });

  it('deux preuves identiques le même jour : la seconde s’applique sur l’état de la première (le blocage/confirmation vit dans l’interface)', () => {
    let c = base();
    c = applyEvidence(c, 'exercise', 4, TODAY).chapter;
    const again = applyEvidence(c, 'exercise', 1, TODAY).chapter;
    expect(again.exercise.attempts).toBe(2);
    expect(again.exercise.score).toBeCloseTo(0.5);
    expect(again.recall).toEqual(c.recall);
  });
});

/* ------------------------------------------------------------------ *
 *  Niveaux initiaux : urgence réellement différenciée
 * ------------------------------------------------------------------ */

describe('chapitres jamais testés — risque de rappel initial par niveau', () => {
  const riskOf = (levelKey) => chapterMetrics(
    mkChapter({ initialLevel: levelKey, recall: untestedRecall(levelKey) }), [], S, TODAY).risks.recall;
  it('sans examen : Jamais vu > Fragile > Moyen > Solide', () => {
    expect(riskOf('new')).toBeGreaterThan(riskOf('fragile'));
    expect(riskOf('fragile')).toBeGreaterThan(riskOf('ok'));
    expect(riskOf('ok')).toBeGreaterThan(riskOf('solid'));
  });
  it('valeurs exactes : 2.2 / 1.6 / 1.0 / 0.5', () => {
    expect(riskOf('new')).toBeCloseTo(2.2, 5);
    expect(riskOf('fragile')).toBeCloseTo(1.6, 5);
    expect(riskOf('ok')).toBeCloseTo(1.0, 5);
    expect(riskOf('solid')).toBeCloseTo(0.5, 5);
    expect(INITIAL_URGENCY.new).toBe(2.2);
  });
  it('un chapitre « Solide » jamais testé (aucun axe) n’est pas planifié tout de suite', () => {
    const ch = mkChapter({
      initialLevel: 'solid', recall: untestedRecall('solid'),
      exercise: emptyPractice(), problem: emptyPractice(),
    });
    const m = chapterMetrics(ch, [], S, TODAY);
    expect(m.baseRisk).toBeCloseTo(0.5, 5);
    expect(isWorthReviewing(m)).toBe(false);
  });
  it('un chapitre « Jamais vu » entre immédiatement, par l’axe rappel', () => {
    const ch = mkChapter({
      initialLevel: 'new', recall: untestedRecall('new'),
      exercise: emptyPractice(), problem: emptyPractice(),
    });
    const m = chapterMetrics(ch, [], S, TODAY);
    expect(m.dominant).toBe('recall');
    expect(isWorthReviewing(m)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 *  Priorité multi-axes : risques explicites, axe dominant
 * ------------------------------------------------------------------ */

describe('chapterMetrics — trois risques, un axe dominant, priorité explicite', () => {
  it('rappel à jour mais exercices jamais testés -> l’axe exercice domine', () => {
    const ch = mkChapter({ initialLevel: 'fragile', exercise: emptyPractice() });
    const m = chapterMetrics(ch, [], S, TODAY);
    expect(m.risks.recall).toBeCloseTo(0.5, 5);
    expect(m.risks.exercise).toBeCloseTo(1.2, 5);
    expect(m.dominant).toBe('exercise');
    expect(m.baseRisk).toBeCloseTo(1.2, 5);
    expect(m.priority).toBeCloseTo(1.2, 5); // pas d'examen -> ×1
    expect(m.minutes).toBe(30); // durée de l'axe dominant (exercice)
  });
  it('après un exercice réussi, le rappel redevient l’axe dominant', () => {
    const ch = mkChapter({ initialLevel: 'fragile', exercise: emptyPractice() });
    const done = applyEvidence(ch, 'exercise', 4, TODAY).chapter;
    const m = chapterMetrics(done, [], S, TODAY);
    expect(m.dominant).toBe('recall');
    expect(m.minutes).toBe(15); // durée de l'axe rappel
  });
  it('la priorité est le produit exact risque dominant × pression d’examen', () => {
    const exams = [{ id: 'e1', subjectId: 's1', name: 'CC', date: EXAM_NEAR, chapterIds: ['c1'], importance: 'normal' }];
    const m = chapterMetrics(mkChapter(), exams, S, TODAY);
    expect(m.priority).toBeCloseTo(m.baseRisk * m.factor, 10);
    expect(m.factor).toBeCloseTo(3.56, 2);
  });
  it('axisMinutes : durée par axe, modifiable par chapitre', () => {
    const ch = mkChapter({ minutes: { recall: 30, exercise: 45, problem: 120 } });
    expect(axisMinutes(ch, 'recall')).toBe(30);
    expect(axisMinutes(ch, 'problem')).toBe(120);
    expect(axisMinutes({}, 'problem')).toBe(60); // défaut nommé
  });
});

describe('priorité d’un chapitre : importance de l’épreuve', () => {
  const prio = (importance) => {
    const exams = [{ id: 'e1', subjectId: 's1', name: 'CC', date: EXAM_NEAR, chapterIds: ['c1'], importance }];
    return chapterMetrics(mkChapter(), exams, S, TODAY).priority;
  };
  it('à date et couverture identiques : majeure > normale > mineure', () => {
    expect(prio('major')).toBeGreaterThan(prio('normal'));
    expect(prio('normal')).toBeGreaterThan(prio('minor'));
  });
});

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
    expect(major).toBeCloseTo(1 + (normal - 1) * 1.4, 6);
    expect(minor).toBeCloseTo(1 + (normal - 1) * 0.6, 6);
    expect(examMultiplier(0, S, 'major')).toBeLessThanOrEqual(1 + (S.maxExamPressure - 1) * 1.4 + 1e-9);
    expect(examMultiplier(40, S, 'major')).toBe(1); // hors horizon
  });
});

/* ------------------------------------------------------------------ *
 *  Capacité en minutes & plan du jour (durées par axe)
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
});

describe('planDay — plan en minutes, durée de l’axe proposé', () => {
  const subjects = [
    { id: 'A', name: 'A', type: 'core' }, { id: 'B', name: 'B', type: 'core' },
    { id: 'C', name: 'C', type: 'core' }, { id: 'P', name: 'Anki', type: 'parallel' },
  ];
  const opts = { subjectsPerDay: 3, sessionMinutes: 120, totalMinutes: 360, settings: S };
  const ch = (id, subjectId, priority, minutes = 30, dominant = 'exercise') =>
    ({ id, subjectId, priority, minutes, dominant });

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

  it('un chapitre de 90 min N’ENTRE PAS dans une capacité de 60 min', () => {
    const sessions = planDay([ch('a1', 'A', 9, 90, 'problem')], subjects, { ...opts, totalMinutes: 60 });
    expect(sessions).toEqual([]);
  });

  it('respecte STRICTEMENT le total du jour (jamais de dépassement)', () => {
    const ranked = [ch('a1', 'A', 9, 90), ch('b1', 'B', 8, 90), ch('c1', 'C', 7, 90)];
    const sessions = planDay(ranked, subjects, { ...opts, totalMinutes: 150 });
    expect(sessions.length).toBe(1);
    expect(sessions.reduce((x, s) => x + s.minutes, 0)).toBeLessThanOrEqual(150);
  });

  it('capacité 0 : aucun plan (pas de faux travail)', () => {
    expect(planDay([ch('a1', 'A', 9)], subjects, { ...opts, totalMinutes: 0 })).toEqual([]);
  });

  it('anti-biais : une matière saucissonnée ne domine pas une matière urgente', () => {
    const ranked = [
      ch('b1', 'B', 8),
      ...Array.from({ length: 25 }, (_, i) => ch('a' + i, 'A', 0.9, 15)),
    ];
    expect(planDay(ranked, subjects, opts)[0].subject.id).toBe('B');
  });

  it('exclut les matières parallèles', () => {
    const sessions = planDay([ch('p1', 'P', 99), ch('a1', 'A', 1)], subjects, opts);
    expect(sessions.every((s) => s.subject.id !== 'P')).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 *  Types de preuve & raisons affichées
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
  it('trois types + legacy ; chaque type pointe vers son axe', () => {
    expect(Object.keys(EVIDENCE)).toEqual(['recall', 'exercise', 'problem', 'legacy']);
    expect(AXIS_KEYS).toEqual(['recall', 'exercise', 'problem']);
    expect(EVIDENCE.legacy.axis).toBe('recall');
    expect(AXES.problem.label).toBe('Problème/annale');
  });
});

describe('reasonPhrase — étiquette d’axe + explication courte', () => {
  const mk = (over, exams = []) => chapterMetrics(mkChapter(over), exams, S, TODAY);
  it('rappel : jamais testé / en retard / à consolider avant l’épreuve', () => {
    const exams = [{ id: 'e1', subjectId: 's1', name: 'CC1', date: EXAM_NEAR, chapterIds: ['c1'], importance: 'normal' }];
    const never = mk({ initialLevel: 'new', recall: untestedRecall('new') });
    expect(reasonPhrase(never)).toMatchObject({ text: 'cours jamais testé', axis: 'recall' });
    const late = mk({ recall: { stability: 2, difficulty: 5, lastReviewed: FIVE_AGO } });
    expect(reasonPhrase(late).text).toBe('rappel en retard de 3 j');
    const soon = mk({ recall: { stability: 12, difficulty: 5, lastReviewed: FIVE_AGO } }, exams);
    expect(reasonPhrase(soon)).toMatchObject({ text: 'rappel à consolider avant CC1', tone: 'exam' });
    expect(reasonPhrase(mk({ recall: { stability: 30, difficulty: 5, lastReviewed: FIVE_AGO } })).tone).toBe('calm');
  });
  it('exercices non testés / annale importante avant l’épreuve', () => {
    const noEx = mk({ initialLevel: 'fragile', exercise: emptyPractice() });
    expect(reasonPhrase(noEx)).toMatchObject({ text: 'exercices non testés', axis: 'exercise' });
    const exams = [{ id: 'e1', subjectId: 's1', name: 'Partiel', date: EXAM_NEAR, chapterIds: ['c1'], importance: 'normal' }];
    const noPr = mk({ initialLevel: 'fragile', problem: emptyPractice() }, exams);
    expect(reasonPhrase(noPr)).toMatchObject({ text: 'annale importante avant Partiel', axis: 'problem', tone: 'exam' });
  });
});

/* ------------------------------------------------------------------ *
 *  Prévision & charge : en minutes
 * ------------------------------------------------------------------ */

describe('forecastDue — { jour: { count, minutes } }', () => {
  it('chapitre S=10 testé il y a 4 j -> échéance dans 6 j, minutes de rappel', () => {
    const chapters = [mkChapter({ recall: { stability: 10, difficulty: 5, lastReviewed: addDays(TODAY, -4) } })];
    const cell = forecastDue(chapters, S, TODAY)[addDays(TODAY, 6)];
    expect(cell).toEqual({ count: 1, minutes: 15 });
  });
  it('« Solide » jamais testé n’échoit pas aujourd’hui ; « Jamais vu » si', () => {
    const solid = mkChapter({ id: 'c1', initialLevel: 'solid', recall: untestedRecall('solid') });
    const fresh = mkChapter({ id: 'c2', initialLevel: 'new', recall: untestedRecall('new') });
    const map = forecastDue([solid, fresh], S, TODAY);
    expect(map[TODAY]).toEqual({ count: 1, minutes: 15 });
  });
  it('additionne les minutes de rappel PAR CHAPITRE (durées différentes)', () => {
    const a = mkChapter({ id: 'a', recall: { stability: 10, difficulty: 5, lastReviewed: addDays(TODAY, -4) }, minutes: { recall: 15, exercise: 30, problem: 60 } });
    const b = mkChapter({ id: 'b', recall: { stability: 10, difficulty: 5, lastReviewed: addDays(TODAY, -4) }, minutes: { recall: 30, exercise: 30, problem: 60 } });
    expect(forecastDue([a, b], S, TODAY)[addDays(TODAY, 6)]).toEqual({ count: 2, minutes: 45 });
  });
});

describe('cruiseLoad — minutes de rappel par jour', () => {
  it('Σ minutes_rappel / intervalle : 2 × (15/10) = 3 min/jour', () => {
    expect(cruiseLoad([mkChapter(), mkChapter()], S)).toBeCloseTo(3, 5);
  });
  it('une rétention plus exigeante augmente la charge', () => {
    const chs = [mkChapter()];
    expect(cruiseLoad(chs, { ...S, requestRetention: 0.95 }))
      .toBeGreaterThan(cruiseLoad(chs, { ...S, requestRetention: 0.85 }));
  });
});

/* ------------------------------------------------------------------ *
 *  observedRetention : RAPPEL uniquement
 * ------------------------------------------------------------------ */

describe('observedRetention — ignore exercices et problèmes', () => {
  it('ne compte que les re-tests de rappel (et les anciennes notes « legacy »)', () => {
    const before = { stability: 10, difficulty: 5, lastReviewed: addDays(TODAY, -10) };
    const log = [
      { grade: 3, date: TODAY, evidenceType: 'recall', before },
      { grade: 1, date: TODAY, before },                                   // sans type -> rappel
      { grade: 1, date: TODAY, evidenceType: 'exercise', before: { score: 0.5, attempts: 2, lastTested: addDays(TODAY, -10) } },
      { grade: 1, date: TODAY, evidenceType: 'problem', before: { score: 0.5, attempts: 2, lastTested: addDays(TODAY, -10) } },
      { grade: 3, date: TODAY, evidenceType: 'recall', before: { stability: 2, difficulty: 8, lastReviewed: null } }, // premier test : ignoré
    ];
    const r = observedRetention(log);
    expect(r.n).toBe(2);
    expect(r.rate).toBeCloseTo(0.5, 5);
    expect(r.predicted).toBeCloseTo(0.9, 4);
  });
});

/* ------------------------------------------------------------------ *
 *  Recalibrage : les trois axes repartent du niveau
 * ------------------------------------------------------------------ */

describe('recalibrage cohérent (v4)', () => {
  const state = {
    settings: { ...S },
    chapters: [mkChapter({ id: 'c1' }), mkChapter({ id: 'c2' })],
    reviewLog: [
      { id: 'r1', chapterId: 'c1', date: FIVE_AGO, grade: 3, evidenceType: 'exercise', before: {}, after: {} },
      { id: 'r2', chapterId: 'c2', date: FIVE_AGO, grade: 3, evidenceType: 'recall', before: {}, after: {} },
    ],
    archivedReviews: [],
  };
  it('remet les 3 axes au niveau choisi, archive l’historique du chapitre', () => {
    const next = recalibrateState(state, 'c1', 'fragile');
    const c1 = next.chapters.find((c) => c.id === 'c1');
    expect(c1.initialLevel).toBe('fragile');
    expect(c1.recall.lastReviewed).toBeNull();
    expect(c1.recall.stability).toBeCloseTo(targetInterval(33, S), 4);
    expect(c1.exercise).toEqual(emptyPractice());
    expect(c1.problem).toEqual(emptyPractice());
    expect(next.reviewLog.map((r) => r.id)).toEqual(['r2']);
    expect(next.archivedReviews.map((r) => r.id)).toEqual(['r1']);
  });
  it('niveau inconnu : état inchangé', () => {
    expect(recalibrateState(state, 'c1', 'zzz')).toBe(state);
  });
});

/* ------------------------------------------------------------------ *
 *  Migration v3 -> v4 : déterministe, non destructive
 * ------------------------------------------------------------------ */

describe('migration v3 -> v4', () => {
  const v3state = () => ({
    version: 3,
    subjects: [{ id: 's', name: 'EM', color: '#fff', type: 'core' }],
    chapters: [
      { id: 'c1', subjectId: 's', name: 'A', difficulty: 6, stability: 14, lastReviewed: '2026-01-18', initialLevel: 'ok', estimatedMinutes: 45 },
      { id: 'c2', subjectId: 's', name: 'B', difficulty: 5, stability: 8, lastReviewed: '2026-01-10', initialLevel: 'fragile', estimatedMinutes: 90 },
      { id: 'c3', subjectId: 's', name: 'C', difficulty: 8.5, stability: 2, lastReviewed: null, initialLevel: 'new', estimatedMinutes: 30 },
    ],
    exams: [{ id: 'e1', subjectId: 's', name: 'CC', date: EXAM_NEAR, chapterIds: ['c1', 'c2'], importance: 'major' }],
    settings: { ...S, requestRetention: 0.92 },
    parallelLog: { '2026-01-12': { p: 2 } },
    reviewLog: [
      { id: 'r1', chapterId: 'c1', date: '2026-01-05', grade: 3 },                         // sans type -> rappel
      { id: 'r2', chapterId: 'c1', date: '2026-01-12', grade: 2, evidenceType: 'recall' },
      { id: 'r3', chapterId: 'c1', date: '2026-01-15', grade: 3, evidenceType: 'exercise' },
      { id: 'r4', chapterId: 'c1', date: '2026-01-18', grade: 1, evidenceType: 'problem' },
      { id: 'r5', chapterId: 'c2', date: '2026-01-10', grade: 4, evidenceType: 'legacy' },
    ],
    archivedReviews: [{ id: 'old1' }],
    skips: { c3: '2026-01-19' },
    capacityOverrides: { [TODAY]: 120 },
    lastExportAt: '2026-01-01',
  });

  it('déterministe : deux exécutions -> résultat identique', () => {
    expect(JSON.stringify(migrateV3(v3state()))).toBe(JSON.stringify(migrateV3(v3state())));
  });

  it('aucune perte : matières, chapitres, examens, journal, reports, réglages', () => {
    const v4 = migrateV3(v3state());
    expect(v4.version).toBe(4); // migrateV3 rend de la v4 ; c'est migrateV4/normalize qui passe en v5
    expect(v4.subjects).toEqual(v3state().subjects);
    expect(v4.chapters.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(v4.exams[0].chapterIds).toEqual(['c1', 'c2']);
    expect(v4.exams[0].importance).toBe('major');
    expect(v4.reviewLog.length).toBe(5);
    expect(v4.archivedReviews).toEqual([{ id: 'old1' }]);
    expect(v4.skips).toEqual({ c3: '2026-01-19' });
    expect(v4.capacityOverrides).toEqual({ [TODAY]: 120 });
    expect(v4.lastExportAt).toBe('2026-01-01');
    expect(v4.settings.requestRetention).toBe(0.92);
  });

  it('les anciennes révisions sans type deviennent des preuves de rappel (legacy)', () => {
    const v4 = migrateV3(v3state());
    expect(v4.reviewLog.find((r) => r.id === 'r1').evidenceType).toBe('legacy');
    expect(v4.reviewLog.find((r) => r.id === 'r3').evidenceType).toBe('exercise');
  });

  it('rappel reconstruit en rejouant SEULEMENT ses événements (exercices/problèmes exclus)', () => {
    const v4 = migrateV3(v3state());
    const c1 = v4.chapters.find((c) => c.id === 'c1');
    expect(c1.recall.source).toBe('replayed');
    // dernier événement de RAPPEL : r2 (12/01) — r3/r4 (exercice/problème) ne touchent pas le rappel
    expect(c1.recall.lastReviewed).toBe('2026-01-12');
    expect(c1.exercise).toMatchObject({ attempts: 1, lastTested: '2026-01-15' });
    expect(c1.exercise.score).toBeCloseTo(0.8);
    expect(c1.problem).toMatchObject({ attempts: 1, lastTested: '2026-01-18', recentFails: 1, score: 0 });
  });

  it('chapitre avec état v3 mais sans événement : conservé en donnée héritée (source legacy)', () => {
    const v4 = migrateV3(v3state());
    const c3 = v4.chapters.find((c) => c.id === 'c3');
    expect(c3.recall.source).toBe('legacy');
    expect(c3.recall.stability).toBe(2);
    expect(c3.recall.lastReviewed).toBeNull();
    expect(c3.exercise).toEqual(emptyPractice());
  });

  it('durées migrées : rappel min(30, ancienne), exercice = ancienne, problème max(60, ancienne)', () => {
    const v4 = migrateV3(v3state());
    const [c1, c2, c3] = v4.chapters;
    expect(c1.minutes).toEqual({ recall: 30, exercise: 45, problem: 60 });
    expect(c2.minutes).toEqual({ recall: 30, exercise: 90, problem: 90 });
    expect(c3.minutes).toEqual({ recall: 30, exercise: 30, problem: 60 });
  });

  it('normalize : v1, v2, v3 et v4 -> toujours un état courant sain', () => {
    expect(normalize(v3state()).version).toBe(8);
    const fromV1 = normalize({ subjects: [], chapters: [{ id: 'c', subjectId: 's', name: 'x', mastery: 50 }] });
    expect(fromV1.version).toBe(8);
    expect(fromV1.chapters[0].minutes).toEqual({ recall: 30, exercise: 30, problem: 60 });
    expect(fromV1.chapters[0].exercise).toEqual(emptyPractice());
    const v2 = { version: 2, subjects: [{ id: 's', name: 'EM' }], chapters: [{ id: 'c1', subjectId: 's', name: 'A', difficulty: 6.8, stability: 12, lastReviewed: FIVE_AGO }] };
    const m = normalize(v2);
    expect(m.version).toBe(8);
    expect(m.chapters[0].recall.stability).toBe(12);
    expect(m.chapters[0].initialLevel).toBe('fragile'); // D=6.8 -> niveau le plus proche
    const already = normalize(migrateV3(v3state()));
    expect(already.version).toBe(8);
    expect(already.chapters.find((c) => c.id === 'c1').recall.lastReviewed).toBe('2026-01-12');
  });
});

describe('migration v2 -> v3 (étape intermédiaire, inchangée)', () => {
  const v2 = {
    version: 2,
    subjects: [{ id: 's', name: 'EM', color: '#fff', type: 'core' }],
    chapters: [{ id: 'c1', subjectId: 's', name: 'A', difficulty: 6.8, stability: 12, lastReviewed: FIVE_AGO }],
    exams: [{ id: 'e1', subjectId: 's', name: 'CC', date: EXAM_NEAR, chapterIds: ['c1'] }],
    settings: { requestRetention: 0.92 },
    reviewLog: [{ id: 'r1', chapterId: 'c1', date: FIVE_AGO, grade: 3, before: {}, after: {} }],
  };
  it('ajoute niveaux, minutes, importance, evidenceType legacy', () => {
    const v3 = migrateV2(v2);
    expect(v3.version).toBe(3);
    expect(v3.chapters[0].initialLevel).toBe('fragile');
    expect(v3.chapters[0].estimatedMinutes).toBe(30);
    expect(v3.exams[0].importance).toBe('normal');
    expect(v3.reviewLog[0].evidenceType).toBe('legacy');
  });
});

/* ------------------------------------------------------------------ *
 *  validateImport durci
 * ------------------------------------------------------------------ */

describe('validateImport — refus strict, sans toucher aux données', () => {
  const valid = () => ({
    version: 4,
    subjects: [{ id: 's1', name: 'EM', color: '#fff', type: 'core' }],
    chapters: [{
      id: 'c1', subjectId: 's1', name: 'A', initialLevel: 'ok',
      recall: { stability: 10, difficulty: 5, lastReviewed: FIVE_AGO },
      exercise: { score: 0.8, attempts: 1, lastTested: FIVE_AGO, recentFails: 0 },
      problem: { score: null, attempts: 0, lastTested: null, recentFails: 0 },
      minutes: { recall: 15, exercise: 30, problem: 60 },
    }],
    exams: [{ id: 'e1', subjectId: 's1', name: 'CC', date: EXAM_NEAR, chapterIds: ['c1'], importance: 'major' }],
    settings: { ...S },
    parallelLog: {},
    reviewLog: [{ id: 'r1', chapterId: 'c1', date: FIVE_AGO, grade: 3, evidenceType: 'recall' }],
    archivedReviews: [], skips: {}, capacityOverrides: {}, lastExportAt: null,
  });

  it('accepte un état v4 complet, et le seed', () => {
    expect(validateImport(valid())).toEqual({ ok: true, errors: [] });
    expect(validateImport(seedState()).ok).toBe(true);
  });
  it('rejette les structures invalides', () => {
    expect(validateImport(null).ok).toBe(false);
    expect(validateImport([1, 2]).ok).toBe(false);
    expect(validateImport({}).ok).toBe(false);
    expect(validateImport({ subjects: 'nope' }).ok).toBe(false);
  });
  it('est totale : aucune forme JSON arbitraire ne fait lever le validateur', () => {
    const values = [
      null, true, false, 0, 'texte', [], {},
      { subjects: null },
      { subjects: [null, 3, []], chapters: {}, exams: 'non', reviewLog: true },
      { subjects: [], exams: [{ chapterIds: { c1: true } }] },
      { subjects: [], chapters: [{ recall: [], exercise: 'x', problem: 4, minutes: [] }] },
      { subjects: [], settings: [], capacityOverrides: [], examDebriefs: [] },
    ];
    for (const value of values) {
      let result;
      expect(() => { result = validateImport(value); }).not.toThrow();
      expect(typeof result.ok).toBe('boolean');
      expect(Array.isArray(result.errors)).toBe(true);
    }
  });
  it('préserve les exports v1 à v4, y compris le v1 historique sans version', () => {
    const subject = { id: 's1', name: 'Maths', color: '#fff', type: 'core' };
    const legacyV1 = {
      subjects: [subject],
      chapters: [{ id: 'c1', subjectId: 's1', name: 'A', mastery: 50 }],
      exams: [], settings: { requestRetention: 0.9, blocksPerDay: 3 },
    };
    expect(validateImport(legacyV1).ok).toBe(true);
    expect(validateImport({ ...legacyV1, version: 1 }).ok).toBe(true);

    const v2 = {
      version: 2, subjects: [subject],
      chapters: [{ id: 'c1', subjectId: 's1', name: 'A', stability: 10, difficulty: 5, lastReviewed: FIVE_AGO }],
      exams: [], settings: { requestRetention: 0.9 },
      reviewLog: [{ id: 'r1', chapterId: 'c1', date: FIVE_AGO, grade: 3 }],
    };
    expect(validateImport(v2).ok).toBe(true);

    const v3 = {
      ...v2, version: 3,
      chapters: [{ ...v2.chapters[0], initialLevel: 'ok', estimatedMinutes: 30 }],
      reviewLog: [{ ...v2.reviewLog[0], evidenceType: 'exercise' }],
    };
    expect(validateImport(v3).ok).toBe(true);
    expect(validateImport(valid()).ok).toBe(true);
  });
  it('version inconnue -> refus', () => {
    const v = valid(); v.version = 9;
    const r = validateImport(v);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('Version');
  });
  it('identifiant dupliqué -> refus', () => {
    const v = valid(); v.chapters.push({ ...v.chapters[0] });
    const r = validateImport(v);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('dupliqué');
  });
  it('référence orpheline (épreuve -> chapitre inconnu) -> refus', () => {
    const v = valid(); v.exams[0].chapterIds = ['fantome'];
    expect(validateImport(v).ok).toBe(false);
  });
  it('chapterIds d’une épreuve doit être un tableau et ne fait jamais lever', () => {
    for (const malformed of [{ c1: true }, 'c1', 42, null]) {
      const v = valid(); v.exams[0].chapterIds = malformed;
      expect(() => validateImport(v)).not.toThrow();
      expect(validateImport(v).ok).toBe(false);
    }
  });
  it('chapitre pointant une matière inconnue -> refus', () => {
    const v = valid(); v.chapters[0].subjectId = 'ghost';
    expect(validateImport(v).ok).toBe(false);
  });
  it('date impossible (2026-02-30) -> refus', () => {
    const v = valid(); v.exams[0].date = '2026-02-30';
    expect(validateImport(v).ok).toBe(false);
  });
  it('NaN dans les réglages ou l’état -> refus', () => {
    const v = valid(); v.settings.requestRetention = NaN;
    expect(validateImport(v).ok).toBe(false);
    const w = valid(); w.chapters[0].recall.stability = NaN;
    expect(validateImport(w).ok).toBe(false);
  });
  it('note hors bornes / score hors [0,1] / importance inconnue -> refus', () => {
    const g = valid(); g.reviewLog[0].grade = 7;
    expect(validateImport(g).ok).toBe(false);
    const sc = valid(); sc.chapters[0].exercise.score = 1.5;
    expect(validateImport(sc).ok).toBe(false);
    const imp = valid(); imp.exams[0].importance = 'catastrophique';
    expect(validateImport(imp).ok).toBe(false);
  });
  it('review : id et chapitre existant obligatoires, grade entier 1..4', () => {
    const noId = valid(); delete noId.reviewLog[0].id;
    expect(validateImport(noId).ok).toBe(false);
    const noChapter = valid(); delete noChapter.reviewLog[0].chapterId;
    expect(validateImport(noChapter).ok).toBe(false);
    const ghost = valid(); ghost.reviewLog[0].chapterId = 'fantome';
    expect(validateImport(ghost).ok).toBe(false);
    const stringGrade = valid(); stringGrade.reviewLog[0].grade = '3';
    expect(validateImport(stringGrade).ok).toBe(false);
    const decimalGrade = valid(); decimalGrade.reviewLog[0].grade = 2.5;
    expect(validateImport(decimalGrade).ok).toBe(false);
  });
  it('axes pratiques : compteurs non négatifs et score cohérent avec attempts', () => {
    const mutate = (fn) => { const v = valid(); fn(v.chapters[0].exercise); return v; };
    expect(validateImport(mutate((a) => { a.attempts = -1; })).ok).toBe(false);
    expect(validateImport(mutate((a) => { a.attempts = 1.5; })).ok).toBe(false);
    expect(validateImport(mutate((a) => { a.recentFails = -1; })).ok).toBe(false);
    expect(validateImport(mutate((a) => { a.attempts = 0; a.score = 0.8; a.lastTested = null; })).ok).toBe(false);
    expect(validateImport(mutate((a) => { a.attempts = 1; a.score = null; })).ok).toBe(false);
    expect(validateImport(mutate((a) => { a.attempts = 1; a.recentFails = 2; })).ok).toBe(false);
    const primitive = valid(); primitive.chapters[0].problem = 'invalide';
    expect(validateImport(primitive).ok).toBe(false);
  });
  it('settings : types, bornes et ordre minInterval/maxInterval sont stricts', () => {
    const bad = (key, value) => { const v = valid(); v.settings[key] = value; return v; };
    expect(validateImport(bad('requestRetention', '0.9')).ok).toBe(false);
    expect(validateImport(bad('requestRetention', 0.5)).ok).toBe(false);
    expect(validateImport(bad('subjectsPerDay', 1.5)).ok).toBe(false);
    expect(validateImport(bad('sessionHours', 0)).ok).toBe(false);
    expect(validateImport(bad('pressureHorizon', 0)).ok).toBe(false);
    expect(validateImport(bad('simpleMode', 'oui')).ok).toBe(false);
    expect(validateImport(bad('inconnu', 1)).ok).toBe(false);
    const inverted = valid(); inverted.settings.minInterval = 40; inverted.settings.maxInterval = 30;
    expect(validateImport(inverted).ok).toBe(false);
  });
  it('type de preuve inconnu dans le journal -> refus', () => {
    const v = valid(); v.reviewLog[0].evidenceType = 'vibe';
    expect(validateImport(v).ok).toBe(false);
  });
  it('export -> réimport complet : validé puis normalisé sans perte', () => {
    const st = valid();
    const round = normalize(JSON.parse(JSON.stringify(st)));
    expect(validateImport(st).ok).toBe(true);
    expect(round.version).toBe(8);
    expect(round.chapters[0].recall.stability).toBe(10);
    expect(round.chapters[0].exercise.score).toBe(0.8);
    expect(round.reviewLog.length).toBe(1);
    expect(round.exams[0].importance).toBe('major');
  });
});

/* ------------------------------------------------------------------ *
 *  Préparation d'examen & indicateurs par axe
 * ------------------------------------------------------------------ */

describe('examReadiness — rappel estimé + couverture des trois axes', () => {
  const EXAM_5D = addDays(TODAY, 5);
  const exam = { id: 'e', subjectId: 's', name: 'CC', date: EXAM_5D, chapterIds: ['c1', 'c2'] };
  const chapters = [
    mkChapter({ id: 'c1' }), // tout testé
    mkChapter({
      id: 'c2', name: 'neuf', initialLevel: 'new',
      recall: untestedRecall('new'), exercise: emptyPractice(), problem: emptyPractice(),
    }),
  ];
  it('les non-testés sont une catégorie à part, jamais fondus dans la moyenne', () => {
    const r = examReadiness(exam, chapters, S, TODAY);
    expect(r.testedCount).toBe(1);
    expect(r.coveredCount).toBe(2);
    expect(r.untested.map((c) => c.id)).toEqual(['c2']);
    expect(r.avgR).toBeCloseTo(retrievability(10, 10), 5); // testé il y a 5 j, +5 j -> R(10)
  });
  it('couverture par axe : rappel / exercice / problème séparés', () => {
    const r = examReadiness(exam, chapters, S, TODAY);
    expect(r.coverage.recall).toEqual({ tested: 1, total: 2, untested: 1 });
    expect(r.coverage.exercise).toEqual({ tested: 1, total: 2, untested: 1 });
    expect(r.coverage.problem).toEqual({ tested: 1, total: 2, untested: 1 });
  });
  it('aucun testé -> avgR null (pas de fausse moyenne)', () => {
    const only = { id: 'e', subjectId: 's', name: 'CC', date: EXAM_5D, chapterIds: ['c2'] };
    const r = examReadiness(only, chapters, S, TODAY);
    expect(r.avgR).toBeNull();
    expect(r.untested.length).toBe(1);
  });
});

describe('axisSummary — indicateurs honnêtes par axe', () => {
  it('sépare testés / jamais testés, moyenne uniquement sur les testés', () => {
    const chs = [
      mkChapter({ id: 'a' }),
      mkChapter({ id: 'b', initialLevel: 'new', recall: untestedRecall('new'), exercise: emptyPractice(), problem: emptyPractice() }),
    ];
    const sum = axisSummary(chs, S, TODAY);
    expect(sum.recall).toMatchObject({ tested: 1, total: 2, untested: 1 });
    expect(sum.recall.avg).toBeCloseTo(retrievability(5, 10), 5);
    expect(sum.exercise).toMatchObject({ tested: 1, total: 2, untested: 1, avg: 1 });
    expect(sum.problem.untested).toBe(1);
  });
  it('aucun testé -> moyenne null (jamais 0 trompeur)', () => {
    const sum = axisSummary([mkChapter({ initialLevel: 'new', recall: untestedRecall('new'), exercise: emptyPractice(), problem: emptyPractice() })], S, TODAY);
    expect(sum.recall.avg).toBeNull();
    expect(sum.exercise.avg).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 *  Bilan d'épreuve (épreuves récemment passées)
 * ------------------------------------------------------------------ */

describe('pendingDebriefs — proposer le constat après une épreuve', () => {
  const chapters = [mkChapter({ id: 'c1', name: 'A' }), mkChapter({ id: 'c2', name: 'B' })];
  const exam = (over = {}) => ({
    id: 'e1', subjectId: 's1', name: 'CC', date: addDays(TODAY, -1), chapterIds: ['c1', 'c2'], ...over,
  });

  it('épreuve passée hier -> à débriefer ; aujourd’hui ou trop vieille -> non', () => {
    expect(pendingDebriefs([exam()], chapters, [], {}, TODAY).length).toBe(1);
    expect(pendingDebriefs([exam({ date: TODAY })], chapters, [], {}, TODAY).length).toBe(0);
    expect(pendingDebriefs([exam({ date: addDays(TODAY, -DEBRIEF_WINDOW - 1) })], chapters, [], {}, TODAY).length).toBe(0);
    expect(pendingDebriefs([exam({ date: addDays(TODAY, 3) })], chapters, [], {}, TODAY).length).toBe(0);
  });
  it('masquée -> exclue ; sans chapitre couvert -> exclue', () => {
    expect(pendingDebriefs([exam()], chapters, [], { e1: TODAY }, TODAY).length).toBe(0);
    expect(pendingDebriefs([exam({ chapterIds: [] })], chapters, [], {}, TODAY).length).toBe(0);
  });
  it('un constat doit être explicitement rattaché à l’épreuve concernée', () => {
    const log = [
      { chapterId: 'c1', date: exam().date, grade: 3, evidenceType: 'problem', source: 'exam-debrief', examId: 'e1' },
      { chapterId: 'c2', date: TODAY, grade: 3, evidenceType: 'problem' }, // preuve générique
      { chapterId: 'c2', date: exam().date, grade: 3, evidenceType: 'exercise', source: 'exam-debrief', examId: 'e1' },
    ];
    const [d] = pendingDebriefs([exam()], chapters, log, {}, TODAY);
    expect(d.items.find((it) => it.chapter.id === 'c1').done).toBe(true);
    expect(d.items.find((it) => it.chapter.id === 'c2').done).toBe(false);
  });
  it('tout constaté -> plus rien à demander', () => {
    const log = ['c1', 'c2'].map((id) => ({
      chapterId: id, date: exam().date, grade: 3, evidenceType: 'problem', source: 'exam-debrief', examId: 'e1',
    }));
    expect(pendingDebriefs([exam()], chapters, log, {}, TODAY).length).toBe(0);
  });
  it('deux épreuves couvrant le même chapitre gardent deux bilans distincts', () => {
    const exams = [exam({ id: 'e1' }), exam({ id: 'e2', name: 'Partiel' })];
    const log = [{
      chapterId: 'c1', date: exam().date, grade: 3, evidenceType: 'problem', source: 'exam-debrief', examId: 'e1',
    }];
    const result = pendingDebriefs(exams, chapters, log, {}, TODAY);
    expect(result.find((d) => d.exam.id === 'e1').items.find((it) => it.chapter.id === 'c1').done).toBe(true);
    expect(result.find((d) => d.exam.id === 'e2').items.find((it) => it.chapter.id === 'c1').done).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 *  Hygiène d'état (ensureV7) & bornes d'import supplémentaires
 * ------------------------------------------------------------------ */

describe('ensureV7 — bornes et purge (déterministe via `today` explicite)', () => {
  const base = () => ({
    version: 4,
    subjects: [{ id: 's1', name: 'EM', type: 'core' }],
    chapters: [mkChapter({ minutes: { recall: 2, exercise: 900, problem: 60 } })],
    exams: [{ id: 'e1', subjectId: 's1', name: 'CC', date: EXAM_NEAR, chapterIds: [] }],
    settings: { ...S }, parallelLog: {}, reviewLog: [], archivedReviews: [],
    skips: { a: TODAY, b: addDays(TODAY, -1), c: addDays(TODAY, -5) },
    capacityOverrides: {},
    examDebriefs: { e1: TODAY, fantome: TODAY },
    lastExportAt: null,
  });
  it('clampe les durées d’axe dans les bornes', () => {
    const out = ensureV7(base(), TODAY);
    expect(out.chapters[0].minutes.recall).toBe(IMPORT_BOUNDS.axisMinutes[0]);
    expect(out.chapters[0].minutes.exercise).toBe(IMPORT_BOUNDS.axisMinutes[1]);
    expect(out.chapters[0].minutes.problem).toBe(60);
  });
  it('purge les reports plus vieux qu’hier, garde aujourd’hui et hier', () => {
    const out = ensureV7(base(), TODAY);
    expect(Object.keys(out.skips).sort()).toEqual(['a', 'b']);
  });
  it('purge les bilans d’épreuves supprimées, garde les autres', () => {
    const out = ensureV7(base(), TODAY);
    expect(out.examDebriefs).toEqual({ e1: TODAY });
  });
  it('normalize applique la même hygiène après migration', () => {
    const v3ish = { version: 3, subjects: [], chapters: [], exams: [], settings: {}, skips: { z: '2020-01-01' } };
    expect(normalize(v3ish, TODAY).skips).toEqual({});
    expect(normalize(v3ish, TODAY).examDebriefs).toEqual({});
  });
});

describe('validateImport — bornes durées/capacités/niveaux/bilans', () => {
  const valid = () => ({
    version: 4,
    subjects: [{ id: 's1', name: 'EM', color: '#fff', type: 'core' }],
    chapters: [{
      id: 'c1', subjectId: 's1', name: 'A', initialLevel: 'ok',
      recall: { stability: 10, difficulty: 5, lastReviewed: FIVE_AGO },
      exercise: { score: 0.8, attempts: 1, lastTested: FIVE_AGO, recentFails: 0 },
      problem: { score: null, attempts: 0, lastTested: null, recentFails: 0 },
      minutes: { recall: 15, exercise: 30, problem: 60 },
    }],
    exams: [{ id: 'e1', subjectId: 's1', name: 'CC', date: EXAM_NEAR, chapterIds: ['c1'], importance: 'major' }],
    settings: { ...S },
    capacityOverrides: { [TODAY]: 120 },
    examDebriefs: { e1: TODAY },
    reviewLog: [],
  });
  it('accepte capacités datées et bilans valides', () => {
    expect(validateImport(valid())).toEqual({ ok: true, errors: [] });
  });
  it('durée d’axe hors bornes -> refus', () => {
    const a = valid(); a.chapters[0].minutes.recall = 2;
    expect(validateImport(a).ok).toBe(false);
    const b = valid(); b.chapters[0].minutes.problem = 999;
    expect(validateImport(b).ok).toBe(false);
  });
  it('capacité : date invalide ou valeur hors bornes -> refus', () => {
    const a = valid(); a.capacityOverrides = { '2026-02-30': 120 };
    expect(validateImport(a).ok).toBe(false);
    const b = valid(); b.capacityOverrides = { [TODAY]: -10 };
    expect(validateImport(b).ok).toBe(false);
    const c = valid(); c.capacityOverrides = { [TODAY]: NaN };
    expect(validateImport(c).ok).toBe(false);
  });
  it('niveau initial inconnu -> refus ; minimum hebdo délirant -> refus', () => {
    const a = valid(); a.chapters[0].initialLevel = 'expert';
    expect(validateImport(a).ok).toBe(false);
    const b = valid(); b.subjects[0].weeklyFloor = 999;
    expect(validateImport(b).ok).toBe(false);
  });
  it('examDebriefs malformé -> refus', () => {
    const a = valid(); a.examDebriefs = 'oui';
    expect(validateImport(a).ok).toBe(false);
    const b = valid(); b.examDebriefs = { e1: 'pas-une-date' };
    expect(validateImport(b).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 *  Divers conservés
 * ------------------------------------------------------------------ */

describe('pruneBackups / annales / défauts', () => {
  it('pruneBackups garde les 7 plus récents', () => {
    const backups = {};
    for (let i = 0; i < 10; i++) backups[addDays(TODAY, -i)] = { i };
    expect(Object.keys(pruneBackups(backups, TODAY, 7)).length).toBe(7);
  });
  it('annalesModeFor : seuil', () => {
    expect(annalesModeFor('s', [{ id: 'e', subjectId: 's', name: 'CC', date: EXAM_NEAR, chapterIds: [] }], S, TODAY)).toBeTruthy();
    expect(annalesModeFor('s', [{ id: 'e', subjectId: 's', name: 'CC', date: EXAM_FAR, chapterIds: [] }], S, TODAY)).toBeNull();
  });
  it('défauts sains et constantes nommées', () => {
    expect(S.simpleMode).toBe(true);
    expect(S.subjectsPerDay).toBe(3);
    expect(FSRS_W.length).toBe(17);
    expect(IMPORTANCE.normal.w).toBe(1);
    expect(AXIS_MINUTES).toEqual({ recall: 15, exercise: 30, problem: 60 });
    expect(targetInterval(0, S)).toBeCloseTo(2, 5);
    expect(targetInterval(100, S)).toBeCloseTo(30, 5);
    expect(seedState().version).toBe(8);
  });
});
