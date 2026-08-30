import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS, AXIS_MINUTES, DOC_LABEL_MAX, DOCS_PER_CHAPTER_MAX,
  isSafeDocUrl, normDoc, normDocs, newDoc, sortedDocs,
  newChapter, chapterMetrics, normalize, migrateV6, validateImport,
  seedState, emptyPractice, emptyDeleted, LEVELS, uid,
} from './engine.js';
import { mergeStates, stampState, contentSignature } from './sync.js';

const S = DEFAULT_SETTINGS;
const TODAY = '2026-01-20';

const doc = (over = {}) => ({ id: 'd1', label: 'TD 3', url: 'https://exemple.org/td3.pdf', addedAt: TODAY, lastUsedAt: null, ...over });

/* ------------------------------------------------------------------ *
 *  Sécurité des liens — le point sensible : ils sont rendus cliquables
 * ------------------------------------------------------------------ */

describe('liens autorisés', () => {
  it('accepte http et https', () => {
    expect(isSafeDocUrl('https://drive.google.com/file/x')).toBe(true);
    expect(isSafeDocUrl('http://exemple.org/a.pdf')).toBe(true);
    expect(isSafeDocUrl('  https://exemple.org/a.pdf  ')).toBe(true);
  });

  it('refuse tout schéma exécutable ou exotique', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://exemple.org/x',
      'chrome://settings',
      'exemple.org/sans-schema',
      '', '   ', null, undefined, 42, {},
    ]) {
      expect(isSafeDocUrl(bad)).toBe(false);
    }
  });

  it('refuse une adresse démesurée', () => {
    expect(isSafeDocUrl(`https://exemple.org/${'a'.repeat(3000)}`)).toBe(false);
  });

  it('un document au lien refusé ne garde AUCUN lien', () => {
    const d = normDoc({ id: 'x', label: 'Piégé', url: 'javascript:alert(1)' });
    expect(d.url).toBeNull();
    expect(d.label).toBe('Piégé'); // le repère reste, le lien disparaît
  });

  it('un document sans lien ni libellé est écarté', () => {
    expect(normDoc({ url: 'javascript:alert(1)' })).toBeNull();
    expect(normDoc({})).toBeNull();
    expect(normDoc(null)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 *  Normalisation
 * ------------------------------------------------------------------ */

describe('normalisation des documents', () => {
  it('nettoie le libellé et le borne', () => {
    expect(normDoc(doc({ label: '  TD   3  ' })).label).toBe('TD 3');
    expect(normDoc(doc({ label: 'x'.repeat(200) })).label).toHaveLength(DOC_LABEL_MAX);
  });
  it('sans libellé, le lien sert de nom', () => {
    expect(normDoc({ url: 'https://exemple.org/a.pdf' }).label).toBe('https://exemple.org/a.pdf');
  });
  it('dédoublonne par identifiant et plafonne la liste', () => {
    expect(normDocs([doc(), doc()]).length).toBe(1);
    const many = Array.from({ length: 40 }, (_, i) => doc({ id: `d${i}` }));
    expect(normDocs(many).length).toBe(DOCS_PER_CHAPTER_MAX);
  });
  it('dates invalides ramenées à null ; entrée non-liste -> liste vide', () => {
    expect(normDoc(doc({ addedAt: '2026-02-30', lastUsedAt: 'hier' })).addedAt).toBeNull();
    expect(normDocs('non')).toEqual([]);
  });
  it('newDoc horodate l’ajout et laisse l’utilisation à null', () => {
    const d = newDoc('TD 3', 'https://exemple.org/x', TODAY);
    expect(d).toMatchObject({ label: 'TD 3', addedAt: TODAY, lastUsedAt: null });
    expect(d.id).toBeTruthy();
  });
});

describe('ordre d’affichage — retrouver ce qu’on vient d’utiliser', () => {
  it('le plus récemment utilisé d’abord, puis les plus récemment ajoutés', () => {
    const chapter = { docs: [
      doc({ id: 'a', label: 'A', addedAt: '2026-01-01', lastUsedAt: null }),
      doc({ id: 'b', label: 'B', addedAt: '2026-01-02', lastUsedAt: '2026-01-18' }),
      doc({ id: 'c', label: 'C', addedAt: '2026-01-03', lastUsedAt: TODAY }),
    ] };
    expect(sortedDocs(chapter).map((d) => d.label)).toEqual(['C', 'B', 'A']);
  });
});

/* ------------------------------------------------------------------ *
 *  Aucun effet sur le modèle
 * ------------------------------------------------------------------ */

describe('les documents n’influencent pas la planification', () => {
  it('priorité identique avec ou sans documents', () => {
    const base = newChapter('s1', 'Optique', LEVELS[1], S);
    const withDocs = { ...base, docs: [doc(), doc({ id: 'd2', label: 'Annale' })] };
    expect(chapterMetrics(withDocs, [], S, TODAY).priority)
      .toBe(chapterMetrics(base, [], S, TODAY).priority);
  });
  it('un nouveau chapitre part sans document', () => {
    expect(newChapter('s1', 'X', LEVELS[0], S).docs).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 *  Synchronisation : union, jamais d'écrasement
 * ------------------------------------------------------------------ */

describe('fusion des documents entre appareils', () => {
  const stateWith = (docs, meta) => stampState({
    version: 7,
    subjects: [{ id: 's1', name: 'Maths', type: 'core' }],
    chapters: [{
      id: 'c1', subjectId: 's1', name: 'Optique', initialLevel: 'new',
      kind: 'course', axes: ['recall', 'exercise', 'problem'], position: null, docs,
      recall: { stability: 2, difficulty: 8.5, lastReviewed: null, source: 'seed' },
      exercise: emptyPractice(), problem: emptyPractice(), minutes: { ...AXIS_MINUTES },
    }],
    exams: [], settings: { ...S }, parallelLog: {}, reviewLog: [], archivedReviews: [],
    skips: {}, capacityOverrides: {}, examDebriefs: {}, deleted: emptyDeleted(),
    lastExportAt: null,
  }, meta.deviceId, meta.updatedAt);

  it('un document ajouté sur chaque appareil : les DEUX survivent', () => {
    const phone = stateWith([doc({ id: 'd-tel', label: 'Photo TD' })], { deviceId: 'dev-tel', updatedAt: 2000 });
    const pc = stateWith([doc({ id: 'd-pc', label: 'Annale 2024' })], { deviceId: 'dev-pc', updatedAt: 3000 });
    const m = mergeStates(phone, pc);
    expect(m.chapters[0].docs.map((d) => d.id).sort()).toEqual(['d-pc', 'd-tel']);
  });

  it('la fusion des documents reste commutative', () => {
    const a = stateWith([doc({ id: 'd1' })], { deviceId: 'dev-a', updatedAt: 2000 });
    const b = stateWith([doc({ id: 'd2', label: 'Autre' })], { deviceId: 'dev-b', updatedAt: 3000 });
    expect(contentSignature(mergeStates(a, b))).toBe(contentSignature(mergeStates(b, a)));
  });

  it('même document des deux côtés : on garde la dernière utilisation', () => {
    const a = stateWith([doc({ id: 'd1', lastUsedAt: '2026-01-10' })], { deviceId: 'dev-a', updatedAt: 2000 });
    const b = stateWith([doc({ id: 'd1', lastUsedAt: TODAY })], { deviceId: 'dev-b', updatedAt: 3000 });
    expect(mergeStates(a, b).chapters[0].docs[0].lastUsedAt).toBe(TODAY);
    expect(mergeStates(b, a).chapters[0].docs[0].lastUsedAt).toBe(TODAY);
  });
});

/* ------------------------------------------------------------------ *
 *  Migration & import
 * ------------------------------------------------------------------ */

describe('migration v6 -> v7', () => {
  const v6 = () => ({
    version: 6,
    subjects: [{ id: 's1', name: 'Maths', type: 'core' }],
    chapters: [{
      id: 'c1', subjectId: 's1', name: 'A', initialLevel: 'ok', kind: 'course',
      axes: ['recall'], position: 'p. 12',
      recall: { stability: 10, difficulty: 5, lastReviewed: '2026-01-15' },
      exercise: emptyPractice(), problem: emptyPractice(), minutes: { ...AXIS_MINUTES },
    }],
    exams: [], settings: { ...S }, parallelLog: {}, reviewLog: [], archivedReviews: [],
    skips: {}, capacityOverrides: {}, examDebriefs: {}, deleted: emptyDeleted(),
    syncMeta: null, lastExportAt: null,
  });

  it('ajoute une liste vide sans toucher au reste', () => {
    const out = migrateV6(v6());
    expect(out.version).toBe(7);
    expect(out.chapters[0].docs).toEqual([]);
    expect(out.chapters[0].position).toBe('p. 12');
    expect(out.chapters[0].axes).toEqual(['recall']);
    expect(out.chapters[0].recall).toEqual(v6().chapters[0].recall);
  });

  it('normalize passe en v7 et reste idempotent', () => {
    const once = normalize(v6(), TODAY);
    expect(once.version).toBe(7);
    expect(JSON.stringify(normalize(once, TODAY).chapters)).toBe(JSON.stringify(once.chapters));
  });

  it('un import contenant un lien piégé est nettoyé, pas propagé', () => {
    const st = v6();
    st.chapters[0].docs = [{ id: 'x', label: 'Piège', url: 'javascript:alert(1)' }];
    const out = normalize(st, TODAY);
    expect(out.chapters[0].docs[0].url).toBeNull();
  });
});

describe('validation d’import', () => {
  const valid = () => {
    const st = seedState();
    st.chapters = [{
      ...newChapter(st.subjects[0].id, 'Optique', LEVELS[0], S),
      id: 'c1', docs: [doc()],
    }];
    return st;
  };

  it('accepte des documents valides', () => {
    expect(validateImport(valid())).toEqual({ ok: true, errors: [] });
  });

  it('refuse un lien non autorisé', () => {
    const st = valid();
    st.chapters[0].docs = [doc({ url: 'javascript:alert(1)' })];
    const r = validateImport(st);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/http/i);
  });

  it('refuse une liste malformée, trop longue, ou un libellé démesuré', () => {
    const bad = (docs) => { const st = valid(); st.chapters[0].docs = docs; return validateImport(st).ok; };
    expect(bad('non')).toBe(false);
    expect(bad(Array.from({ length: DOCS_PER_CHAPTER_MAX + 1 }, (_, i) => doc({ id: `d${i}` })))).toBe(false);
    expect(bad([doc({ label: 'x'.repeat(DOC_LABEL_MAX + 1) })])).toBe(false);
    expect(bad([doc({ addedAt: '2026-02-30' })])).toBe(false);
    expect(bad([{ id: 'z' }])).toBe(false); // ni lien ni libellé
  });
});
