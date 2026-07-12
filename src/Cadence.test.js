import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS,
  FSRS_W,
  retrievability,
  optimalInterval,
  initialDifficulty,
  nextDifficulty,
  stabilityAfterSuccess,
  stabilityAfterFailure,
  applyGrade,
  targetInterval,
  examMultiplier,
  chapterMetrics,
  planDay,
  forecastDue,
  annalesModeFor,
  reasonPhrase,
  migrateV1,
  examReadiness,
  pruneBackups,
  daysBetween,
  addDays,
} from './Cadence.jsx';

const S = DEFAULT_SETTINGS;

const TODAY = '2026-01-20';
const FIVE_AGO = '2026-01-15';
const EXAM_NEAR = '2026-01-27'; // dans 7 j
const EXAM_FAR = '2026-06-01';  // > horizon (35 j) -> ×1

/* ------------------------------------------------------------------ *
 *  Courbe d'oubli & intervalle optimal
 * ------------------------------------------------------------------ */

describe('courbe d’oubli (loi de puissance FSRS)', () => {
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

/* ------------------------------------------------------------------ *
 *  FSRS-4.5 : difficulté & stabilité (valeurs exactes avec les poids)
 * ------------------------------------------------------------------ */

describe('difficulté FSRS', () => {
  it('difficulté initiale selon la première note', () => {
    expect(initialDifficulty(1)).toBeCloseTo(7.6214, 3); // Oublié -> dur
    expect(initialDifficulty(3)).toBeCloseTo(5.1618, 3); // Bien -> moyen
    expect(initialDifficulty(4)).toBeCloseTo(3.932, 3);  // Facile -> facile
    expect(initialDifficulty(1)).toBeGreaterThan(initialDifficulty(4));
  });
  it('Oublié augmente D, Facile la baisse, bornes 1..10', () => {
    expect(nextDifficulty(5, 1)).toBeCloseTo(6.706, 2);
    expect(nextDifficulty(5, 4)).toBeCloseTo(4.097, 2);
    expect(nextDifficulty(10, 1)).toBeLessThanOrEqual(10);
    expect(nextDifficulty(1, 4)).toBeGreaterThanOrEqual(1);
  });
});

describe('stabilité FSRS après révision (S=10, D=5, R=0.9)', () => {
  it('valeurs exactes (poids par défaut 4.5)', () => {
    expect(stabilityAfterSuccess(10, 5, 0.9, 3)).toBeCloseTo(35.09, 1); // Bien
    expect(stabilityAfterSuccess(10, 5, 0.9, 2)).toBeCloseTo(15.70, 1); // Difficile
    expect(stabilityAfterSuccess(10, 5, 0.9, 4)).toBeCloseTo(82.13, 1); // Facile
    expect(stabilityAfterFailure(10, 5, 0.9)).toBeCloseTo(2.56, 1);     // Oublié
  });
  it('Facile > Bien > Difficile ; l’oubli fait chuter (jamais gagner)', () => {
    const hard = stabilityAfterSuccess(10, 5, 0.9, 2);
    const good = stabilityAfterSuccess(10, 5, 0.9, 3);
    const easy = stabilityAfterSuccess(10, 5, 0.9, 4);
    expect(easy).toBeGreaterThan(good);
    expect(good).toBeGreaterThan(hard);
    expect(hard).toBeGreaterThan(10);
    expect(stabilityAfterFailure(10, 5, 0.9)).toBeLessThan(10);
    expect(stabilityAfterFailure(0.5, 9, 0.99)).toBeLessThanOrEqual(0.5);
  });
  it('effet d’espacement : réviser près du seuil (R bas) consolide plus', () => {
    const late = stabilityAfterSuccess(10, 5, 0.75, 3);
    const early = stabilityAfterSuccess(10, 5, 0.98, 3);
    expect(late).toBeGreaterThan(early);
  });
  it('un chapitre difficile consolide moins vite', () => {
    expect(stabilityAfterSuccess(10, 8, 0.9, 3)).toBeLessThan(stabilityAfterSuccess(10, 3, 0.9, 3));
  });
});

describe('applyGrade — application complète', () => {
  it('révision réussie : stabilité en hausse, lastReviewed géré par l’appelant', () => {
    const ch = { stability: 10, difficulty: 5, lastReviewed: '2026-01-10' }; // il y a 10 j
    const r = applyGrade(ch, 3, TODAY);
    expect(r.stability).toBeGreaterThan(10);
    expect(r.difficulty).toBeLessThan(5.01);
  });
  it('oubli : stabilité en baisse, difficulté en hausse', () => {
    const ch = { stability: 10, difficulty: 5, lastReviewed: '2026-01-10' };
    const r = applyGrade(ch, 1, TODAY);
    expect(r.stability).toBeLessThan(10);
    expect(r.difficulty).toBeGreaterThan(5);
  });
  it('jamais révisé : traité comme un gros retard (t = 2.2·S)', () => {
    const ch = { stability: 2, difficulty: 8.5, lastReviewed: null };
    const r = applyGrade(ch, 3, TODAY);
    expect(r.stability).toBeGreaterThan(2);
    expect(r.R).toBeLessThan(0.9);
  });
});

/* ------------------------------------------------------------------ *
 *  Couche examens (inchangée) & priorité multiplicative
 * ------------------------------------------------------------------ */

describe('examMultiplier', () => {
  it('35 j -> 1.00 ; 21 j -> 1.64 ; 7 j -> 3.56 ; 0 j -> 5.00', () => {
    expect(examMultiplier(35, S)).toBeCloseTo(1.0, 2);
    expect(examMultiplier(21, S)).toBeCloseTo(1.64, 2);
    expect(examMultiplier(7, S)).toBeCloseTo(3.56, 2);
    expect(examMultiplier(0, S)).toBeCloseTo(5.0, 2);
  });
  it('passé ou au-delà de l’horizon -> 1', () => {
    expect(examMultiplier(-1, S)).toBe(1);
    expect(examMultiplier(36, S)).toBe(1);
  });
});

function priorityOf(stability, examDate) {
  const ch = { id: 'c1', subjectId: 's1', name: 'x', difficulty: 5, stability, lastReviewed: FIVE_AGO };
  const exams = examDate
    ? [{ id: 'e1', subjectId: 's1', name: 'CC', date: examDate, chapterIds: ['c1'] }]
    : [];
  return chapterMetrics(ch, exams, S, TODAY).priority;
}

describe('priorité multiplicative : faible+proche ≫ solide+proche', () => {
  it('la pression d’examen multiplie l’urgence', () => {
    const weakNear = priorityOf(3, EXAM_NEAR);   // fragile, examen dans 7 j
    const weakFar = priorityOf(3, EXAM_FAR);
    const solidNear = priorityOf(30, EXAM_NEAR); // solide, examen dans 7 j
    const solidFar = priorityOf(30, EXAM_FAR);
    expect(weakNear / weakFar).toBeCloseTo(3.56, 1);
    expect(solidNear / solidFar).toBeCloseTo(3.56, 1);
    expect(weakNear).toBeGreaterThan(solidNear * 5);
  });
});

describe('chapterMetrics — transparence', () => {
  it('expose R, solidité, difficulté, prochaine échéance et la décomposition', () => {
    const ch = { id: 'c1', subjectId: 's1', name: 'x', difficulty: 5, stability: 10, lastReviewed: FIVE_AGO };
    const exams = [{ id: 'e1', subjectId: 's1', name: 'CC1', date: EXAM_NEAR, chapterIds: ['c1'] }];
    const m = chapterMetrics(ch, exams, S, TODAY);
    expect(m.R).toBeGreaterThan(0.9); // 5 j sur S=10
    expect(m.stability).toBe(10);
    expect(m.dueIn).toBe(5);
    expect(m.factor).toBeCloseTo(3.56, 2);
    expect(m.exam.name).toBe('CC1');
    expect(m.priority).toBeCloseTo(m.urgency * m.factor, 6);
  });
});

/* ------------------------------------------------------------------ *
 *  Raison en clair, plan du jour, prévision, annales
 * ------------------------------------------------------------------ */

describe('reasonPhrase — langage clair', () => {
  const mk = (stability, lastReviewed, exams = []) =>
    chapterMetrics({ id: 'c1', subjectId: 's1', name: 'x', difficulty: 5, stability, lastReviewed }, exams, S, TODAY);

  it('épreuve proche : « Examen … dans N j »', () => {
    const exams = [{ id: 'e1', subjectId: 's1', name: 'CC1', date: EXAM_NEAR, chapterIds: ['c1'] }];
    const r = reasonPhrase(mk(3, FIVE_AGO, exams));
    expect(r.tone).toBe('exam');
    expect(r.text).toBe('Examen CC1 dans 7 j');
  });
  it('en retard : « En retard de N j »', () => {
    const r = reasonPhrase(mk(2, FIVE_AGO));
    expect(r.tone).toBe('late');
    expect(r.text).toBe('En retard de 3 j');
  });
  it('jamais révisé', () => {
    expect(reasonPhrase(mk(5, null)).text).toBe('Jamais révisé');
  });
  it('pas urgent quand récent', () => {
    const r = reasonPhrase(mk(30, FIVE_AGO));
    expect(r.tone).toBe('calm');
    expect(r.text.startsWith('Pas urgent')).toBe(true);
  });
});

describe('planDay — capacité', () => {
  const subjects = [
    { id: 'A', name: 'A', type: 'core' }, { id: 'B', name: 'B', type: 'core' },
    { id: 'C', name: 'C', type: 'core' }, { id: 'D', name: 'D', type: 'core' },
    { id: 'P', name: 'Anki', type: 'parallel' },
  ];
  const ranked = [
    { id: 'a1', subjectId: 'A', priority: 9 }, { id: 'a2', subjectId: 'A', priority: 8 }, { id: 'a3', subjectId: 'A', priority: 1 },
    { id: 'b1', subjectId: 'B', priority: 7 },
    { id: 'c1', subjectId: 'C', priority: 6 },
    { id: 'd1', subjectId: 'D', priority: 5 },
    { id: 'p1', subjectId: 'P', priority: 99 },
  ];
  it('retient les 3 matières les plus sous pression, parallèles exclues', () => {
    const sessions = planDay(ranked, subjects, 3, 4);
    expect(sessions.length).toBe(3);
    expect(sessions.map((s) => s.subject.id)).toEqual(['A', 'B', 'C']);
  });
  it('limite chaque séance et garde les plus prioritaires', () => {
    const sessions = planDay(ranked, subjects, 3, 2);
    const a = sessions.find((s) => s.subject.id === 'A');
    expect(a.chapters.map((c) => c.id)).toEqual(['a1', 'a2']);
    expect(a.total).toBe(3);
  });
});

describe('forecastDue — prévision de charge', () => {
  it('un chapitre S=10 revu il y a 4 j arrive à échéance dans 6 j', () => {
    const chapters = [{ id: 'c', subjectId: 's', stability: 10, difficulty: 5, lastReviewed: addDays(TODAY, -4) }];
    const map = forecastDue(chapters, S, TODAY);
    expect(map[addDays(TODAY, 6)]).toBe(1);
  });
  it('en retard ou jamais révisé -> aujourd’hui', () => {
    const chapters = [
      { id: 'c1', subjectId: 's', stability: 2, difficulty: 5, lastReviewed: addDays(TODAY, -30) },
      { id: 'c2', subjectId: 's', stability: 5, difficulty: 5, lastReviewed: null },
    ];
    const map = forecastDue(chapters, S, TODAY);
    expect(map[TODAY]).toBe(2);
  });
});

describe('annalesModeFor', () => {
  it('actif si la prochaine épreuve est <= seuil', () => {
    const exams = [{ id: 'e', subjectId: 's', name: 'CC', date: EXAM_NEAR, chapterIds: [] }];
    expect(annalesModeFor('s', exams, S, TODAY)).toBeTruthy();
  });
  it('inactif au-delà du seuil', () => {
    const exams = [{ id: 'e', subjectId: 's', name: 'CC', date: EXAM_FAR, chapterIds: [] }];
    expect(annalesModeFor('s', exams, S, TODAY)).toBeNull();
  });
});

describe('examReadiness — mémoire prévue le jour J', () => {
  const EXAM_5D = addDays(TODAY, 5);
  it('chapitre S=10 revu il y a 5 j, examen dans 5 j -> ~90 % prévu', () => {
    const exam = { id: 'e', subjectId: 's', name: 'CC', date: EXAM_5D, chapterIds: ['c1'] };
    const chapters = [{ id: 'c1', subjectId: 's', stability: 10, difficulty: 5, lastReviewed: FIVE_AGO }];
    const r = examReadiness(exam, chapters, S, TODAY);
    expect(r.days).toBe(5);
    expect(r.avgR).toBeCloseTo(0.9, 3); // 10 j écoulés le jour J sur S=10
    expect(r.weak).toBe(0);
  });
  it('chapitre jamais révisé -> fragile, trié en premier', () => {
    const exam = { id: 'e', subjectId: 's', name: 'CC', date: EXAM_5D, chapterIds: ['c1', 'c2'] };
    const chapters = [
      { id: 'c1', subjectId: 's', name: 'ok', stability: 30, difficulty: 4, lastReviewed: FIVE_AGO },
      { id: 'c2', subjectId: 's', name: 'neuf', stability: 2, difficulty: 8.5, lastReviewed: null },
    ];
    const r = examReadiness(exam, chapters, S, TODAY);
    expect(r.per[0].chapter.id).toBe('c2');
    expect(r.per[0].projR).toBeLessThan(0.7);
    expect(r.weak).toBe(1);
  });
  it('null si épreuve passée ou sans chapitre couvert', () => {
    const past = { id: 'e', subjectId: 's', name: 'CC', date: addDays(TODAY, -1), chapterIds: ['c1'] };
    const empty = { id: 'e2', subjectId: 's', name: 'CC', date: EXAM_5D, chapterIds: [] };
    const chapters = [{ id: 'c1', subjectId: 's', stability: 10, difficulty: 5, lastReviewed: FIVE_AGO }];
    expect(examReadiness(past, chapters, S, TODAY)).toBeNull();
    expect(examReadiness(empty, chapters, S, TODAY)).toBeNull();
  });
});

describe('pruneBackups — 7 jours glissants', () => {
  it('garde les 7 plus récentes (<= aujourd’hui)', () => {
    const backups = {};
    for (let i = 0; i < 10; i++) backups[addDays(TODAY, -i)] = { i };
    backups[addDays(TODAY, 3)] = { future: true }; // date future ignorée
    const out = pruneBackups(backups, TODAY, 7);
    const keys = Object.keys(out).sort();
    expect(keys.length).toBe(7);
    expect(keys[keys.length - 1]).toBe(TODAY);
    expect(keys[0]).toBe(addDays(TODAY, -6));
  });
});

/* ------------------------------------------------------------------ *
 *  Migration v1 -> v2
 * ------------------------------------------------------------------ */

describe('migration v1 -> v2', () => {
  it('maîtrise -> difficulté ; stabilité conservée ou dérivée ; journal vide', () => {
    const v1 = {
      subjects: [{ id: 's', name: 'EM', color: '#fff', type: 'core' }],
      chapters: [
        { id: 'c1', subjectId: 's', name: 'A', mastery: 50, lastReviewed: FIVE_AGO },
        { id: 'c2', subjectId: 's', name: 'B', mastery: 100, stability: 42, lastReviewed: null },
      ],
      exams: [], settings: { blocksPerDay: 5, requestRetention: 0.92 }, parallelLog: {},
    };
    const v2 = migrateV1(v1);
    expect(v2.version).toBe(2);
    expect(v2.chapters[0].difficulty).toBeCloseTo(5.5, 5);
    expect(v2.chapters[0].stability).toBeCloseTo(targetInterval(50, v2.settings), 4);
    expect(v2.chapters[1].difficulty).toBeCloseTo(1, 5);
    expect(v2.chapters[1].stability).toBe(42);
    expect(v2.reviewLog).toEqual([]);
    expect(v2.settings.requestRetention).toBe(0.92);
    expect(v2.settings.blocksPerDay).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 *  Défauts & garde-fous
 * ------------------------------------------------------------------ */

describe('défauts', () => {
  it('simpleMode actif, capacité 3 × 2 h, rétention 90 %', () => {
    expect(S.simpleMode).toBe(true);
    expect(S.subjectsPerDay).toBe(3);
    expect(S.sessionHours).toBe(2);
    expect(S.requestRetention).toBe(0.9);
  });
  it('17 poids FSRS', () => {
    expect(FSRS_W.length).toBe(17);
  });
  it('targetInterval : m=0 -> 2 j ; m=100 -> 30 j (stabilités initiales)', () => {
    expect(targetInterval(0, S)).toBeCloseTo(2, 5);
    expect(targetInterval(100, S)).toBeCloseTo(30, 5);
  });
});
