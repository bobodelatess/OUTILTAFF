import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS, AXIS_MINUTES, KINDS, KIND_KEYS, RESOURCE_PRESETS, POSITION_MAX,
  applicableAxes, axisApplies, normAxes, normPosition,
  newChapter, newResource, chapterMetrics, axisSummary, examReadiness,
  cruiseLoad, forecastDue, emptyPractice, emptyDeleted, normalize, migrateV5,
  validateImport, seedState, levelSeed, LEVELS, addDays, reasonPhrase,
} from './engine.js';

const S = DEFAULT_SETTINGS;
const TODAY = '2026-01-20';

const seedRecall = (levelKey = 'new') => {
  const seed = levelSeed(LEVELS.find((l) => l.key === levelKey), S);
  return { stability: seed.stability, difficulty: seed.difficulty, lastReviewed: null, source: 'seed' };
};
const item = (over = {}) => ({
  id: 'c1', subjectId: 's1', name: 'x', initialLevel: 'new', kind: 'course',
  axes: ['recall', 'exercise', 'problem'], position: null,
  recall: seedRecall(), exercise: emptyPractice(), problem: emptyPractice(),
  minutes: { ...AXIS_MINUTES }, ...over,
});

/* ------------------------------------------------------------------ *
 *  Axes applicables
 * ------------------------------------------------------------------ */

describe('axes applicables', () => {
  it('un chapitre de cours : les trois axes', () => {
    expect(applicableAxes(item())).toEqual(['recall', 'exercise', 'problem']);
  });
  it('une ressource ne déclare que ses axes', () => {
    const vocab = item({ kind: 'resource', axes: ['recall'] });
    expect(applicableAxes(vocab)).toEqual(['recall']);
    expect(axisApplies(vocab, 'recall')).toBe(true);
    expect(axisApplies(vocab, 'problem')).toBe(false);
  });
  it('données antérieures (sans kind ni axes) : traitées comme un cours complet', () => {
    expect(applicableAxes({ recall: seedRecall() })).toEqual(['recall', 'exercise', 'problem']);
  });
  it('axes invalides ou vides : repli sur le défaut du type, ordre pédagogique conservé', () => {
    expect(normAxes(['zzz'], 'resource')).toEqual(['recall']);
    expect(normAxes([], 'course')).toEqual(['recall', 'exercise', 'problem']);
    expect(normAxes(['problem', 'recall'], 'course')).toEqual(['recall', 'problem']);
  });
});

/* ------------------------------------------------------------------ *
 *  Priorité : ne pas réclamer ce qui ne s'applique pas
 * ------------------------------------------------------------------ */

describe('priorité d’une ressource', () => {
  it('une liste de vocabulaire n’est JAMAIS poussée par « annales non testées »', () => {
    const vocab = item({ kind: 'resource', axes: ['recall'] });
    const m = chapterMetrics(vocab, [], S, TODAY);
    expect(m.dominant).toBe('recall');
    expect(m.axes).toEqual(['recall']);
    // le risque des autres axes est calculé mais n'entre pas dans la priorité
    expect(m.baseRisk).toBeCloseTo(m.risks.recall, 10);
    expect(m.priority).toBeCloseTo(m.risks.recall, 10);
  });

  it('une ressource « à pratiquer » est portée par l’exercice, pas par le rappel', () => {
    const drill = item({ kind: 'resource', axes: ['exercise'] });
    const m = chapterMetrics(drill, [], S, TODAY);
    expect(m.dominant).toBe('exercise');
    expect(m.minutes).toBe(AXIS_MINUTES.exercise);
    expect(reasonPhrase(m, drill).axis).toBe('exercise');
  });

  it('la formulation s’adapte : une ressource n’est pas un « cours »', () => {
    const vocab = item({ kind: 'resource', axes: ['recall'] });
    expect(reasonPhrase(chapterMetrics(vocab, [], S, TODAY), vocab).text).toBe('jamais testé');
    const course = item();
    expect(reasonPhrase(chapterMetrics(course, [], S, TODAY), course).text).toBe('cours jamais testé');
    // sans second argument, on reste sur la formulation « cours » (compatibilité)
    expect(reasonPhrase(chapterMetrics(course, [], S, TODAY)).text).toBe('cours jamais testé');
  });

  it('à contenu identique, restreindre les axes ne peut qu’abaisser la priorité', () => {
    const full = chapterMetrics(item(), [], S, TODAY);
    const restricted = chapterMetrics(item({ kind: 'resource', axes: ['exercise'] }), [], S, TODAY);
    expect(restricted.priority).toBeLessThanOrEqual(full.priority);
  });

  it('un axe non applicable ne peut pas devenir dominant même s’il est le plus risqué', () => {
    // exercice jamais testé (risque élevé) mais l'élément ne concerne que le rappel
    const vocab = item({
      kind: 'resource', axes: ['recall'], initialLevel: 'solid',
      recall: { stability: 30, difficulty: 3, lastReviewed: TODAY, source: 'seed' },
      exercise: emptyPractice(),
    });
    const m = chapterMetrics(vocab, [], S, TODAY);
    expect(m.risks.exercise).toBeGreaterThan(m.risks.recall);
    expect(m.dominant).toBe('recall');
  });
});

/* ------------------------------------------------------------------ *
 *  Indicateurs : compter le bon dénominateur
 * ------------------------------------------------------------------ */

describe('indicateurs honnêtes avec des ressources', () => {
  it('le total d’un axe ne compte que les éléments concernés', () => {
    const chapters = [item({ id: 'a' }), item({ id: 'b', kind: 'resource', axes: ['recall'] })];
    const sum = axisSummary(chapters, S, TODAY);
    expect(sum.recall.total).toBe(2);   // les deux ont du rappel
    expect(sum.exercise.total).toBe(1); // seul le chapitre de cours
    expect(sum.problem.total).toBe(1);
    expect(sum.problem.untested).toBe(1);
  });

  it('la couverture d’une épreuve suit la même règle', () => {
    const chapters = [item({ id: 'a' }), item({ id: 'b', kind: 'resource', axes: ['problem'] })];
    const exam = { id: 'e', subjectId: 's1', name: 'CC', date: addDays(TODAY, 5), chapterIds: ['a', 'b'] };
    const r = examReadiness(exam, chapters, S, TODAY);
    expect(r.coverage.problem.total).toBe(2);
    expect(r.coverage.exercise.total).toBe(1);
    expect(r.coverage.recall.total).toBe(1); // la ressource « annales » n'a pas de rappel
  });

  it('sans axe rappel, aucune charge d’entretien ni échéance de rappel', () => {
    const drill = item({ kind: 'resource', axes: ['exercise'] });
    expect(cruiseLoad([drill], S)).toBe(0);
    expect(forecastDue([drill], S, TODAY)).toEqual({});
    // le même élément avec le rappel actif compte, lui
    expect(cruiseLoad([item({ kind: 'resource', axes: ['recall'] })], S)).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 *  Point de reprise
 * ------------------------------------------------------------------ */

describe('point de reprise', () => {
  it('nettoie les espaces, borne la longueur, vide -> null', () => {
    expect(normPosition('  p.  47  ')).toBe('p. 47');
    expect(normPosition('   ')).toBeNull();
    expect(normPosition(null)).toBeNull();
    expect(normPosition(42)).toBeNull();
    expect(normPosition('x'.repeat(200))).toHaveLength(POSITION_MAX);
  });
  it('se conserve à la création et à la normalisation', () => {
    const r = newChapter('s1', 'Vocabulaire', LEVELS[0], S, { kind: 'resource', axes: ['recall'], position: 'unité 5' });
    expect(r.position).toBe('unité 5');
    const st = normalize({ ...seedState(), chapters: [r] }, TODAY);
    expect(st.chapters[0].position).toBe('unité 5');
  });
  it('n’influence ni la priorité ni le modèle', () => {
    const a = chapterMetrics(item(), [], S, TODAY);
    const b = chapterMetrics(item({ position: 'p. 120' }), [], S, TODAY);
    expect(b.priority).toBe(a.priority);
  });
});

/* ------------------------------------------------------------------ *
 *  Création & migration
 * ------------------------------------------------------------------ */

describe('création', () => {
  it('newChapter reste un cours complet par défaut', () => {
    const c = newChapter('s1', 'Diagonalisation', LEVELS[0], S);
    expect(c.kind).toBe('course');
    expect(c.axes).toEqual(['recall', 'exercise', 'problem']);
    expect(c.position).toBeNull();
  });
  it('newResource applique le profil demandé', () => {
    const r = newResource('s1', 'Annales 2024', ['problem'], S);
    expect(r.kind).toBe('resource');
    expect(r.axes).toEqual(['problem']);
    expect(r.minutes).toEqual(AXIS_MINUTES); // durées par axe inchangées
  });
  it('les profils proposés sont cohérents', () => {
    expect(RESOURCE_PRESETS.map((p) => p.key)).toEqual(['memo', 'practice', 'annales', 'full']);
    for (const p of RESOURCE_PRESETS) expect(normAxes(p.axes, 'resource')).toEqual(p.axes);
    expect(KIND_KEYS).toEqual(['course', 'resource']);
    expect(KINDS.resource.axes).toEqual(['recall']);
  });
});

describe('migration v5 -> v6', () => {
  const v5 = () => ({
    version: 5,
    subjects: [{ id: 's1', name: 'Maths', type: 'core' }],
    chapters: [{
      id: 'c1', subjectId: 's1', name: 'A', initialLevel: 'ok',
      recall: { stability: 10, difficulty: 5, lastReviewed: '2026-01-15' },
      exercise: emptyPractice(), problem: emptyPractice(), minutes: { ...AXIS_MINUTES },
    }],
    exams: [], settings: { ...S }, parallelLog: {}, reviewLog: [], archivedReviews: [],
    skips: {}, capacityOverrides: {}, examDebriefs: {}, deleted: emptyDeleted(),
    syncMeta: null, lastExportAt: null,
  });

  it('tout élément existant devient un chapitre de cours complet — comportement inchangé', () => {
    const out = migrateV5(v5());
    expect(out.version).toBe(6); // migrateV5 rend de la v6 ; normalize poursuit jusqu'au schéma courant
    expect(out.chapters[0].kind).toBe('course');
    expect(out.chapters[0].axes).toEqual(['recall', 'exercise', 'problem']);
    expect(out.chapters[0].position).toBeNull();
    // l'état du modèle n'est pas touché
    expect(out.chapters[0].recall).toEqual(v5().chapters[0].recall);
  });

  it('la priorité d’un chapitre migré est identique à avant', () => {
    const before = chapterMetrics(v5().chapters[0], [], S, TODAY);
    const after = chapterMetrics(migrateV5(v5()).chapters[0], [], S, TODAY);
    expect(after.priority).toBeCloseTo(before.priority, 12);
    expect(after.dominant).toBe(before.dominant);
  });

  it('normalize accepte v5 et v6, et reste idempotent', () => {
    const once = normalize(v5(), TODAY);
    expect(once.version).toBe(9);
    const twice = normalize(once, TODAY);
    expect(JSON.stringify(twice.chapters)).toBe(JSON.stringify(once.chapters));
  });
});

describe('validation d’import', () => {
  const valid = () => ({ ...seedState(), chapters: [item()] });
  it('accepte un état v6 avec ressources', () => {
    const st = seedState();
    const sid = st.subjects[0].id;
    st.chapters = [
      item({ subjectId: sid }),
      item({ id: 'c2', subjectId: sid, kind: 'resource', axes: ['recall'], position: 'p. 12' }),
    ];
    expect(validateImport(st)).toEqual({ ok: true, errors: [] });
  });
  it('refuse un type inconnu, une liste d’axes vide ou invalide, un repère trop long', () => {
    const bad = (over) => {
      const st = valid();
      st.chapters = [{ ...item({ subjectId: st.subjects[0].id }), ...over }];
      return validateImport(st).ok;
    };
    expect(bad({ kind: 'devoir' })).toBe(false);
    expect(bad({ axes: [] })).toBe(false);
    expect(bad({ axes: 'recall' })).toBe(false);
    expect(bad({ axes: ['lecture'] })).toBe(false);
    expect(bad({ position: 'x'.repeat(POSITION_MAX + 1) })).toBe(false);
    expect(bad({ position: 12 })).toBe(false);
  });
});
