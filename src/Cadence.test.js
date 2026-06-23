import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS,
  targetInterval,
  examMultiplier,
  chapterMetrics,
  buildQueue,
  recommendedAction,
  annalesModeFor,
  reasonPhrase,
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

describe('buildQueue — rotation des matières', () => {
  it('évite deux blocs consécutifs de la même matière quand une alternative existe', () => {
    const ranked = [
      { id: 'a1', subjectId: 'A', priority: 9 },
      { id: 'a2', subjectId: 'A', priority: 8 },
      { id: 'b1', subjectId: 'B', priority: 7 },
      { id: 'a3', subjectId: 'A', priority: 6 },
      { id: 'b2', subjectId: 'B', priority: 5 },
    ];
    const q = buildQueue(ranked, 5);
    for (let i = 1; i < q.length; i++) {
      // si à l'étape i il restait une autre matière, on ne répète pas
      expect(q[i].subjectId === q[i - 1].subjectId && q.slice(i).every(x => x.subjectId === q[i - 1].subjectId)).toBeDefined();
    }
    // début : A (9) puis B (7) — pas A,A
    expect(q[0].id).toBe('a1');
    expect(q[1].subjectId).toBe('B');
  });

  it('retombe sur la plus haute priorité si pas d’alternative', () => {
    const ranked = [
      { id: 'a1', subjectId: 'A', priority: 9 },
      { id: 'a2', subjectId: 'A', priority: 8 },
    ];
    const q = buildQueue(ranked, 3);
    expect(q.map((x) => x.id)).toEqual(['a1', 'a2']);
  });
});

describe('recommendedAction', () => {
  it('mode annales l’emporte sur la maîtrise', () => {
    expect(recommendedAction(95, true).key).toBe('annales');
  });
  it('seuils de maîtrise', () => {
    expect(recommendedAction(20, false).key).toBe('cours');
    expect(recommendedAction(60, false).key).toBe('exercices');
    expect(recommendedAction(85, false).key).toBe('consolidation');
  });
  it('chaque action porte un livrable concret', () => {
    for (const m of [10, 50, 80]) {
      expect(recommendedAction(m, false).deliverable.length).toBeGreaterThan(0);
    }
    expect(recommendedAction(50, true).deliverable.length).toBeGreaterThan(0);
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
