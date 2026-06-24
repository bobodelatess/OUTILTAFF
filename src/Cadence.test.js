import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS,
  targetInterval,
  examMultiplier,
  chapterMetrics,
  planDay,
  annalesModeFor,
  reasonPhrase,
  retrievability,
  optimalInterval,
  nextStability,
} from './Cadence.jsx';

const S = DEFAULT_SETTINGS;

// Date d'ancrage + chapitre révisé il y a 5 jours (cf. tests d'acceptation).
const TODAY = '2026-01-20';
const FIVE_AGO = '2026-01-15';
const EXAM_NEAR = '2026-01-27'; // dans 7 j
const EXAM_FAR = '2026-06-01';  // > horizon (35 j) -> ×1

describe('targetInterval', () => {
  it('m=0 -> 2 j ; m=50 -> ~7.7 j ; m=100 -> 30 j', () => {
    expect(targetInterval(0, S)).toBeCloseTo(2, 5);
    expect(targetInterval(50, S)).toBeCloseTo(7.746, 2);
    expect(targetInterval(100, S)).toBeCloseTo(30, 5);
  });
});

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

function priorityOf(mastery, examDate) {
  const ch = { id: 'c1', subjectId: 's1', name: 'x', mastery, lastReviewed: FIVE_AGO };
  const exams = examDate
    ? [{ id: 'e1', subjectId: 's1', name: 'CC', date: examDate, chapterIds: ['c1'] }]
    : [];
  return chapterMetrics(ch, exams, S, TODAY).priority;
}

describe('ordre clé (multiplicatif, pas additif)', () => {
  const weakNear = priorityOf(30, EXAM_NEAR);
  const weakFar = priorityOf(30, EXAM_FAR);
  const solidNear = priorityOf(90, EXAM_NEAR);
  const solidFar = priorityOf(90, EXAM_FAR);

  it('valeurs attendues', () => {
    expect(weakNear).toBeCloseTo(3.95, 1);
    expect(weakFar).toBeCloseTo(1.11, 1);
    expect(solidNear).toBeCloseTo(0.78, 1);
    expect(solidFar).toBeCloseTo(0.22, 1);
  });

  it('faible+proche >> solide+proche', () => {
    expect(weakNear).toBeGreaterThan(solidNear);
    expect(weakNear / solidNear).toBeGreaterThan(4); // explosion vs petite montée
  });

  it('la pression multiplie : faible monte beaucoup, solide peu', () => {
    expect(weakNear / weakFar).toBeCloseTo(3.56, 1);   // ≈ examMultiplier(7)
    expect(solidNear / solidFar).toBeCloseTo(3.56, 1);
  });
});

describe('jamais révisé -> urgent', () => {
  it('urgence = 2.2 (jamais révisé, sans examen)', () => {
    const ch = { id: 'c', subjectId: 's', name: 'x', mastery: 50, lastReviewed: null };
    expect(chapterMetrics(ch, [], S, TODAY).urgency).toBeCloseTo(2.2, 5);
  });
});

describe('chapterMetrics — décomposition transparente', () => {
  it('expose urgence, facteur, épreuve et jours restants', () => {
    const ch = { id: 'c1', subjectId: 's1', name: 'x', mastery: 30, lastReviewed: FIVE_AGO };
    const exams = [{ id: 'e1', subjectId: 's1', name: 'CC1', date: EXAM_NEAR, chapterIds: ['c1'] }];
    const m = chapterMetrics(ch, exams, S, TODAY);
    expect(m.factor).toBeCloseTo(3.56, 2);
    expect(m.exam.name).toBe('CC1');
    expect(m.examDays).toBe(7);
    expect(m.priority).toBeCloseTo(m.urgency * m.factor, 6);
  });

  it('prend le max du multiplicateur sur plusieurs épreuves couvrantes', () => {
    const ch = { id: 'c1', subjectId: 's1', name: 'x', mastery: 50, lastReviewed: FIVE_AGO };
    const exams = [
      { id: 'e1', subjectId: 's1', name: 'loin', date: EXAM_FAR, chapterIds: ['c1'] },
      { id: 'e2', subjectId: 's1', name: 'proche', date: EXAM_NEAR, chapterIds: ['c1'] },
    ];
    const m = chapterMetrics(ch, exams, S, TODAY);
    expect(m.exam.name).toBe('proche');
    expect(m.factor).toBeCloseTo(3.56, 2);
  });
});

describe('courbe d’oubli (loi de puissance)', () => {
  it('R(0)=1, R(stabilité)=0.9, décroissante', () => {
    expect(retrievability(0, 10)).toBeCloseTo(1, 5);
    expect(retrievability(10, 10)).toBeCloseTo(0.9, 4);
    expect(retrievability(40, 10)).toBeLessThan(retrievability(10, 10));
  });
  it('intervalle optimal : à 90 % il vaut la stabilité ; plus exigeant = plus court', () => {
    expect(optimalInterval(10, 0.9)).toBeCloseTo(10, 4);
    expect(optimalInterval(10, 0.95)).toBeLessThan(10);
    expect(optimalInterval(10, 0.85)).toBeGreaterThan(10);
  });
});

describe('nextStability — intervalles expansifs + effet d’espacement', () => {
  it('réviser fait toujours grandir la stabilité', () => {
    const s = nextStability(10, 60, 0.9, S);
    expect(s).toBeGreaterThan(10);
  });
  it('réviser tard (R bas) consolide plus que réviser tôt (R haut)', () => {
    const late = nextStability(10, 60, 0.7, S); // révisé bien après le seuil
    const early = nextStability(10, 60, 0.98, S); // révisé trop tôt (bachotage)
    expect(late).toBeGreaterThan(early);
  });
  it('une maîtrise plus haute consolide plus vite', () => {
    expect(nextStability(10, 90, 0.9, S)).toBeGreaterThan(nextStability(10, 20, 0.9, S));
  });
});

describe('chapterMetrics — rétro-compatibilité (défauts = ancien modèle)', () => {
  it('sans stabilité ni rétention custom, l’intervalle = targetInterval(maîtrise)', () => {
    const ch = { id: 'c', subjectId: 's', name: 'x', mastery: 30, lastReviewed: FIVE_AGO };
    const m = chapterMetrics(ch, [], S, TODAY);
    expect(m.ti).toBeCloseTo(targetInterval(30, S), 5);
  });
  it('expose la rétrievabilité courante', () => {
    const ch = { id: 'c', subjectId: 's', name: 'x', mastery: 50, lastReviewed: FIVE_AGO };
    const m = chapterMetrics(ch, [], S, TODAY);
    expect(m.R).toBeGreaterThan(0);
    expect(m.R).toBeLessThanOrEqual(1);
  });
});

describe('planDay — capacité : N matières/jour, chapitres prioritaires', () => {
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
    { id: 'p1', subjectId: 'P', priority: 99 }, // parallèle : exclu du plan
  ];

  it('retient les 3 matières les plus sous pression, parallèles exclues', () => {
    const sessions = planDay(ranked, subjects, 3, 4);
    expect(sessions.length).toBe(3);
    expect(sessions.map((s) => s.subject.id)).toEqual(['A', 'B', 'C']);
    expect(sessions.every((s) => s.subject.type === 'core')).toBe(true);
  });

  it('limite chaque séance à chaptersPerSession et compte le reste', () => {
    const sessions = planDay(ranked, subjects, 3, 2);
    const a = sessions.find((s) => s.subject.id === 'A');
    expect(a.chapters.length).toBe(2);          // 2 sur 3
    expect(a.total).toBe(3);
    expect(a.chapters.map((c) => c.id)).toEqual(['a1', 'a2']); // les plus prioritaires
  });
});

describe('reasonPhrase — langage clair, pas de formule', () => {
  it('épreuve proche : « Examen … dans N j »', () => {
    const ch = { id: 'c1', subjectId: 's1', name: 'x', mastery: 30, lastReviewed: FIVE_AGO };
    const exams = [{ id: 'e1', subjectId: 's1', name: 'CC1', date: EXAM_NEAR, chapterIds: ['c1'] }];
    const m = chapterMetrics(ch, exams, S, TODAY);
    const r = reasonPhrase(m);
    expect(r.tone).toBe('exam');
    expect(r.text).toBe('Examen CC1 dans 7 j');
  });

  it('en retard : « En retard de N j » (ou « À revoir maintenant »)', () => {
    // m=0 -> ti=2 j ; révisé il y a 5 j -> en retard d'environ 3 j
    const ch = { id: 'c', subjectId: 's', name: 'x', mastery: 0, lastReviewed: FIVE_AGO };
    const r = reasonPhrase(chapterMetrics(ch, [], S, TODAY));
    expect(r.tone).toBe('late');
    expect(r.text).toBe('En retard de 3 j');
  });

  it('jamais révisé', () => {
    const ch = { id: 'c', subjectId: 's', name: 'x', mastery: 50, lastReviewed: null };
    expect(reasonPhrase(chapterMetrics(ch, [], S, TODAY)).text).toBe('Jamais révisé');
  });

  it('pas urgent quand récent et sans épreuve', () => {
    const ch = { id: 'c', subjectId: 's', name: 'x', mastery: 90, lastReviewed: FIVE_AGO };
    const r = reasonPhrase(chapterMetrics(ch, [], S, TODAY));
    expect(r.tone).toBe('calm');
    expect(r.text.startsWith('Pas urgent')).toBe(true);
  });
});

describe('simpleMode activé par défaut', () => {
  it('DEFAULT_SETTINGS.simpleMode === true', () => {
    expect(DEFAULT_SETTINGS.simpleMode).toBe(true);
  });
});

describe('annalesModeFor', () => {
  it('actif si la prochaine épreuve est <= seuil', () => {
    const exams = [{ id: 'e', subjectId: 's', name: 'CC', date: EXAM_NEAR, chapterIds: [] }];
    expect(annalesModeFor('s', exams, S, TODAY)).toBeTruthy(); // 7 j <= 21
  });
  it('inactif si la prochaine épreuve est au-delà du seuil', () => {
    const exams = [{ id: 'e', subjectId: 's', name: 'CC', date: EXAM_FAR, chapterIds: [] }];
    expect(annalesModeFor('s', exams, S, TODAY)).toBeNull();
  });
});
