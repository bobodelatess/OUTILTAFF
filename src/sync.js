/*
 * Synchronisation multi-appareils — FUSION PURE (aucun réseau ici).
 *
 * Objectif : téléphone et ordinateur voient les mêmes données, sans serveur
 * CADENCE et sans compte. Le transport (dépôt privé chez l'utilisateur) vit
 * dans `src/remote.js` ; ce module ne fait que décider de l'état résultant.
 *
 * Propriétés garanties (testées) :
 *   1. CONVERGENCE — merge(a, b) et merge(b, a) donnent le même état.
 *      Aucun « dernier qui écrit gagne » global : on départage champ par
 *      champ, avec des règles écrites.
 *   2. AUCUNE PERTE DE TEST — le journal est une union par identifiant.
 *      Un test noté sur un appareil ne peut pas être effacé par l'autre.
 *   3. ÉTAT DES AXES RECALCULÉ — après fusion, les trois axes de chaque
 *      chapitre sont rejoués depuis le niveau initial à partir du journal
 *      fusionné. C'est ce qui rend le résultat indépendant de l'ordre :
 *      deux notes prises en parallèle donnent le même état des deux côtés.
 *   4. SUPPRESSIONS RESPECTÉES — une suppression laisse une pierre tombale
 *      datée (`deleted`), sinon l'union ressusciterait l'élément supprimé.
 *
 * Règles de départage, par champ :
 *   journal, historique archivé  -> union par identifiant
 *   matières, épreuves, chapitres-> union par id ; en cas de conflit, la
 *                                   version de l'appareil modifié en dernier
 *   axes des chapitres           -> rejeu du journal fusionné (pas de conflit)
 *   reports (skips)              -> la date la plus tardive
 *   capacités d'un jour          -> l'appareil modifié en dernier
 *   compteurs hebdo parallèles   -> le maximum (compteur manuel, jamais réduit)
 *   bilans d'épreuve masqués     -> union (masqué quelque part = masqué)
 *   réglages                     -> l'appareil modifié en dernier
 *   dernier export               -> la date la plus tardive (c'est un fait)
 */

import {
  DELETABLE, LEVELS, DEFAULT_SETTINGS, levelSeed, applyRecall, applyPractice,
  emptyPractice, emptyDeleted, evidenceAxis, uid,
} from './engine.js';

export function newDeviceId() {
  return `dev-${uid().slice(0, 8)}`;
}

/* ------------------------------------------------------------------ *
 *  Horodatage local
 * ------------------------------------------------------------------ */

// Marque l'état comme « modifié ici, maintenant ». Appelé à chaque
// modification faite par l'utilisateur (pas après une fusion entrante).
export function stampState(state, deviceId, now = Date.now()) {
  return {
    ...state,
    syncMeta: {
      deviceId: deviceId || state?.syncMeta?.deviceId || 'inconnu',
      updatedAt: now,
      rev: (state?.syncMeta?.rev ?? 0) + 1,
    },
  };
}

// Ordre canonique : le plus récemment modifié d'abord. Départage par
// identifiant d'appareil pour rester déterministe à horodatage égal —
// c'est ce qui rend la fusion commutative.
function orderByRecency(a, b) {
  const ta = a?.syncMeta?.updatedAt ?? 0;
  const tb = b?.syncMeta?.updatedAt ?? 0;
  if (ta !== tb) return ta > tb ? [a, b] : [b, a];
  const da = String(a?.syncMeta?.deviceId ?? '');
  const db = String(b?.syncMeta?.deviceId ?? '');
  return da >= db ? [a, b] : [b, a];
}

/* ------------------------------------------------------------------ *
 *  Pierres tombales
 * ------------------------------------------------------------------ */

function mergeDeleted(a, b) {
  const out = emptyDeleted();
  for (const kind of DELETABLE) {
    const src = { ...((a || {})[kind] || {}) };
    for (const [id, date] of Object.entries((b || {})[kind] || {})) {
      // date la plus tardive : la suppression la plus récente fait foi
      if (!src[id] || date > src[id]) src[id] = date;
    }
    out[kind] = src;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  Journal : union par identifiant
 * ------------------------------------------------------------------ */

// Clé d'une entrée d'historique. `id` quand il existe (cas normal), sinon
// une clé synthétique stable pour les journaux anciens/importés.
export function entryKey(r) {
  if (r && typeof r.id === 'string' && r.id) return r.id;
  return [r?.chapterId, r?.date, r?.evidenceType ?? 'legacy', r?.grade].join('|');
}

function unionEntries(a, b) {
  const map = new Map();
  for (const r of [...(a || []), ...(b || [])]) if (r && typeof r === 'object') map.set(entryKey(r), r);
  return [...map.values()];
}

function sortEntries(entries) {
  return entries.slice().sort((x, y) => {
    if (x.date !== y.date) return x.date < y.date ? -1 : 1;
    const kx = entryKey(x), ky = entryKey(y);
    return kx < ky ? -1 : kx > ky ? 1 : 0;
  });
}

/* ------------------------------------------------------------------ *
 *  Rejeu des trois axes d'un chapitre depuis son journal
 * ------------------------------------------------------------------ */

const isRecallEvent = (e) => {
  const t = e?.evidenceType;
  return !t || t === 'recall' || t === 'legacy';
};

// Recalcule les axes d'un chapitre à partir des événements qui le concernent.
// Un axe sans aucun événement garde son état existant : on ne réinvente pas
// une donnée héritée (import v3, état `legacy`) qu'aucun test ne documente.
export function rebuildAxes(chapter, events, settings = DEFAULT_SETTINGS) {
  const sorted = sortEntries(events || []);
  const level = LEVELS.find((l) => l.key === chapter.initialLevel) || LEVELS[0];

  const recallEvents = sorted.filter(isRecallEvent);
  let recall = chapter.recall;
  if (recallEvents.length) {
    const seed = levelSeed(level, settings);
    let rec = { stability: seed.stability, difficulty: seed.difficulty, lastReviewed: null };
    for (const e of recallEvents) rec = applyRecall(rec, chapter.initialLevel, e.grade, e.date);
    recall = { ...rec, source: 'replayed' };
  }

  const practice = {};
  for (const axis of ['exercise', 'problem']) {
    const evs = sorted.filter((e) => e.evidenceType && evidenceAxis(e.evidenceType) === axis);
    if (!evs.length) { practice[axis] = chapter[axis] || emptyPractice(); continue; }
    let st = null;
    for (const e of evs) st = applyPractice(st, e.grade, e.date);
    practice[axis] = st;
  }
  return { ...chapter, recall, exercise: practice.exercise, problem: practice.problem };
}

/* ------------------------------------------------------------------ *
 *  Fusion complète
 * ------------------------------------------------------------------ */

function mergeById(hiList, loList, tombstones) {
  const map = new Map();
  for (const item of loList || []) if (item?.id) map.set(item.id, item);
  for (const item of hiList || []) if (item?.id) map.set(item.id, item); // le plus récent écrase
  const out = [];
  for (const [id, item] of map) if (!tombstones?.[id]) out.push(item);
  return out;
}

function mergeDateMap(a, b, pick) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = k in out ? pick(out[k], v) : v;
  }
  return out;
}

// Fusionne deux états CADENCE (déjà normalisés) en un état convergent.
export function mergeStates(a, b) {
  if (!a) return b;
  if (!b) return a;
  const [hi, lo] = orderByRecency(a, b);

  const deleted = mergeDeleted(a.deleted, b.deleted);
  const settings = { ...DEFAULT_SETTINGS, ...(hi.settings || {}) };

  const archived = unionEntries(a.archivedReviews, b.archivedReviews);
  const archivedKeys = new Set(archived.map(entryKey));
  const chapters = mergeById(hi.chapters, lo.chapters, deleted.chapters);
  const chapterIds = new Set(chapters.map((c) => c.id));

  // Journal actif : union, moins ce qui a été archivé (recalibrage sur un
  // appareil) et moins les chapitres supprimés.
  const reviewLog = sortEntries(unionEntries(a.reviewLog, b.reviewLog)
    .filter((r) => !archivedKeys.has(entryKey(r)))
    .filter((r) => r.chapterId == null || chapterIds.has(r.chapterId)));

  const eventsByChapter = new Map();
  for (const r of reviewLog) {
    if (r.chapterId == null) continue;
    if (!eventsByChapter.has(r.chapterId)) eventsByChapter.set(r.chapterId, []);
    eventsByChapter.get(r.chapterId).push(r);
  }

  // Compteurs hebdo : maximum par cellule (un compteur manuel ne recule pas).
  const parallelLog = { ...(lo.parallelLog || {}) };
  for (const [week, cells] of Object.entries(hi.parallelLog || {})) {
    const prev = parallelLog[week] || {};
    const merged = { ...prev };
    for (const [sid, n] of Object.entries(cells || {})) {
      merged[sid] = Math.max(Number(prev[sid]) || 0, Number(n) || 0);
    }
    parallelLog[week] = merged;
  }

  return {
    ...hi,
    version: Math.max(a.version || 0, b.version || 0),
    subjects: mergeById(hi.subjects, lo.subjects, deleted.subjects),
    exams: mergeById(hi.exams, lo.exams, deleted.exams)
      .map((e) => ({ ...e, chapterIds: (e.chapterIds || []).filter((id) => chapterIds.has(id)) })),
    chapters: chapters.map((c) => rebuildAxes(c, eventsByChapter.get(c.id) || [], settings)),
    settings,
    reviewLog,
    archivedReviews: sortEntries(archived),
    parallelLog,
    // report : la date la plus tardive ; capacité d'un jour : appareil récent
    skips: mergeDateMap(hi.skips, lo.skips, (x, y) => (x > y ? x : y)),
    capacityOverrides: mergeDateMap(hi.capacityOverrides, lo.capacityOverrides, (x) => x),
    // bilan masqué quelque part = masqué (on garde la date la plus ancienne)
    examDebriefs: mergeDateMap(hi.examDebriefs, lo.examDebriefs, (x, y) => (x < y ? x : y)),
    deleted,
    lastExportAt: [a.lastExportAt, b.lastExportAt].filter(Boolean).sort().pop() ?? null,
    syncMeta: hi.syncMeta,
  };
}

/* ------------------------------------------------------------------ *
 *  Signature : deux états portent-ils le même contenu ?
 * ------------------------------------------------------------------ */

// Sérialisation stable : clés triées à tous les niveaux, pour que deux objets
// équivalents produisent exactement la même chaîne.
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// Ignore syncMeta : deux appareils peuvent porter le même contenu avec des
// horodatages différents — inutile de renvoyer des données pour ça.
export function contentSignature(state) {
  if (!state) return '';
  const { syncMeta, ...rest } = state;
  return stable(rest);
}

export function sameContent(a, b) {
  return contentSignature(a) === contentSignature(b);
}

// État « vierge » : une installation neuve, jamais modifiée ici — seulement
// les matières proposées par défaut. Quand un tel appareil rejoint un coffre,
// il ADOPTE l'état distant au lieu de fusionner : sinon les matières
// d'exemple d'un téléphone neuf viendraient polluer les données réelles.
export function isPristine(state) {
  if (!state) return true;
  if (state.syncMeta) return false; // déjà modifié sur cet appareil
  return (state.chapters?.length ?? 0) === 0
    && (state.exams?.length ?? 0) === 0
    && (state.reviewLog?.length ?? 0) === 0
    && (state.archivedReviews?.length ?? 0) === 0;
}
