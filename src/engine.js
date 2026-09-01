/*
 * Moteur CADENCE — fonctions pures, sans React.
 *
 * v8 : le chapitre reste le repère stable ; chaque ajout quotidien daté crée
 * une unité de reprise interne avec son propre état de rappel.
 *
 * Le moteur conserve aussi les trois axes de preuve INDÉPENDANTS historiques,
 * notamment pour les annales et les bilans d'épreuve.
 *   - recall   : mémoire du cours   -> modèle inspiré de FSRS-4.5 (stabilité)
 *   - exercise : application standard -> score heuristique transparent
 *   - problem  : transfert (annale)   -> score heuristique transparent
 *
 * Honnêteté du modèle :
 *   - recall.R est une ESTIMATION DE RAPPEL (loi de puissance FSRS, poids par
 *     défaut publiés, NON personnalisés) — pas une probabilité de réussite.
 *   - exercise/problem N'UTILISENT PAS une probabilité FSRS. Leur état est un
 *     score/risque HEURISTIQUE fondé sur : résultats observés, nombre de
 *     tentatives, récence, répétition des erreurs. À présenter comme tel.
 *
 * Schéma v8 (champs principaux)
 *   Subject  = { id, name, color, type: 'core'|'parallel', weeklyFloor? }
 *   Chapter  = { id, subjectId, name, position, positionUpdatedAt, docs[],
 *                recall:   { stability, difficulty, lastReviewed, source? },
 *                exercise: { score: 0..1|null, attempts, lastTested, recentFails },
 *                problem:  { score: 0..1|null, attempts, lastTested, recentFails },
 *                minutes:  { recall, exercise, problem } }
 *   Exam     = { id, subjectId, name, date, chapterIds[], importance }
 *   Review   = { id, chapterId, date, grade: 1..4, evidenceType,
 *                before, after }               // before/after = snapshot de l'axe
 *   ReviewUnit = Chapter & { reviewUnit:true, parentChapterId, introducedAt,
 *                            kind:'resource', axes:['recall'] }
 *   State    = { version: 8, subjects, chapters, exams, settings, parallelLog,
 *                reviewLog, archivedReviews, skips, capacityOverrides, lastExportAt }
 */

/* ================================================================== *
 *  Constantes
 * ================================================================== */

export const STORAGE_KEY = 'cadence.v2'; // clé stable ; la version vit DANS l'état
export const LEGACY_KEY = 'cadence.v1';
export const BACKUP_KEY = 'cadence.backups';
export const SCHEMA_VERSION = 8;
export const KNOWN_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8];

// v5 — synchronisation multi-appareils :
//   syncMeta = { deviceId, updatedAt (ms), rev }   qui a modifié en dernier
//   deleted  = { subjects:{id:date}, chapters:{…}, exams:{…} }
// Les pierres tombales sont indispensables : sans elles, fusionner deux
// appareils ressusciterait ce que l'un des deux vient de supprimer.
export const DELETABLE = ['subjects', 'chapters', 'exams'];
export const TOMBSTONE_DAYS = 180;

export function emptyDeleted() {
  return { subjects: {}, chapters: {}, exams: {} };
}

export function markDeleted(deleted, kind, ids, today) {
  const next = { ...emptyDeleted(), ...(deleted || {}) };
  next[kind] = { ...(next[kind] || {}) };
  for (const id of [].concat(ids)) if (id != null) next[kind][id] = today;
  return next;
}

// Au-delà de TOMBSTONE_DAYS, la suppression est oubliée : un appareil resté
// hors-ligne plus longtemps pourrait ressusciter l'élément — compromis assumé
// pour que l'état ne grossisse pas indéfiniment.
export function pruneTombstones(deleted, today, days = TOMBSTONE_DAYS) {
  const cutoff = addDays(today, -days);
  const out = emptyDeleted();
  for (const kind of DELETABLE) {
    for (const [id, date] of Object.entries((deleted || {})[kind] || {})) {
      if (isValidISODate(date) && date >= cutoff) out[kind][id] = date;
    }
  }
  return out;
}

export const DEFAULT_SETTINGS = {
  requestRetention: 0.9, // rétention cible du rappel
  // Champs historiques conservés pour migrations/imports et annales. Ils ne
  // pilotent plus l'accueil quotidien simplifié.
  subjectsPerDay: 3,
  sessionHours: 2,
  minutesPerChapter: 30,
  maxExamPressure: 5,
  pressureHorizon: 35,
  examModeThreshold: 21,
  minInterval: 2,        // stabilité initiale « Jamais vu »
  maxInterval: 30,       // stabilité initiale « Solide »
  simpleMode: true,
};

export const GRADES = {
  1: { key: 1, label: 'Échec', color: '#f87171' },
  2: { key: 2, label: 'Difficile', color: '#fbbf24' },
  3: { key: 3, label: 'Réussi', color: '#34d399' },
  4: { key: 4, label: 'Facile', color: '#38bdf8' },
};

// Les trois AXES de preuve (+ metadata). L'ordre = ordre pédagogique
// (apprendre le cours -> savoir l'appliquer -> savoir transférer).
export const AXES = {
  recall: { key: 'recall', label: 'Rappel', long: 'rappel du cours' },
  exercise: { key: 'exercise', label: 'Exercice', long: 'exercice standard' },
  problem: { key: 'problem', label: 'Problème/annale', long: 'problème ou annale' },
};
export const AXIS_KEYS = ['recall', 'exercise', 'problem'];

// v6 — tout ce qui se révise n'est pas un cours.
//   'course'   : un chapitre de cours -> les trois axes s'appliquent.
//   'resource' : une ressource à reprendre régulièrement (liste de
//                vocabulaire, recueil d'exercices, annales, entraînement) ->
//                seuls les axes DÉCLARÉS s'appliquent. Sans ça, une liste de
//                vocabulaire afficherait éternellement « exercices non testés ».
export const KINDS = {
  course: {
    key: 'course', label: 'Chapitre', long: 'chapitre de cours',
    axes: AXIS_KEYS,
  },
  resource: {
    key: 'resource', label: 'Ressource', long: 'ressource à reprendre',
    axes: ['recall'],
  },
};
export const KIND_KEYS = ['course', 'resource'];

// Profils proposés à la création d'une ressource — des raccourcis, pas des
// catégories figées : les axes restent modifiables ensuite.
export const RESOURCE_PRESETS = [
  { key: 'memo', label: 'À mémoriser', hint: 'vocabulaire, cartes, formulaire', axes: ['recall'] },
  { key: 'practice', label: 'À pratiquer', hint: 'recueil d’exercices, entraînement', axes: ['exercise'] },
  { key: 'annales', label: 'Annales', hint: 'sujets complets, conditions réelles', axes: ['problem'] },
  { key: 'full', label: 'Complet', hint: 'cours + exercices + annales', axes: AXIS_KEYS },
];

// Longueur maximale du point de reprise (« p. 47 », « unité 5 »). Court
// volontairement : c'est un repère, pas un carnet de notes.
export const POSITION_MAX = 120;

// Une portion quotidienne est un rappel bref, pas une nouvelle séance de
// cours. Cette durée alimente uniquement le calendrier et la charge indicative.
export const REVIEW_UNIT_MINUTES = 5;

/* ---- Documents attachés (v7) --------------------------------------
 * Un document est une RÉFÉRENCE, jamais un fichier : un lien (Drive,
 * iCloud, une URL) ou, à défaut, un simple nom de fichier servant de
 * rappel. Le contenu n'est pas stocké — mettre des fichiers dans l'état
 * synchronisé le ferait exploser (un PDF de 2 Mo = 2,7 Mo encodés,
 * retransmis à chaque synchronisation, pour ~4 Mo de marge disponible).
 * Ici, un document coûte une centaine d'octets et se synchronise partout.
 */
export const DOC_LABEL_MAX = 80;
export const DOC_URL_MAX = 2000;
export const DOCS_PER_CHAPTER_MAX = 24;

// Seuls http(s) sont acceptés. `javascript:`, `data:` et consorts seraient
// une faille : ces liens sont rendus cliquables dans l'interface.
export function isSafeDocUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  if (url.length > DOC_URL_MAX) return false;
  try {
    const proto = new URL(url.trim()).protocol;
    return proto === 'http:' || proto === 'https:';
  } catch (e) { return false; }
}

// Normalise un document. Renvoie null si inexploitable (ni lien sûr ni nom).
export function normDoc(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const label = typeof doc.label === 'string'
    ? doc.label.replace(/\s+/g, ' ').trim().slice(0, DOC_LABEL_MAX) : '';
  const url = isSafeDocUrl(doc.url) ? doc.url.trim() : null;
  if (!url && !label) return null;
  return {
    id: typeof doc.id === 'string' && doc.id ? doc.id : uid(),
    label: label || url,
    url,
    addedAt: isValidISODate(doc.addedAt) ? doc.addedAt : null,
    lastUsedAt: isValidISODate(doc.lastUsedAt) ? doc.lastUsedAt : null,
  };
}

// Liste normalisée : documents valides, dédupliqués par identifiant, plafonnée.
export function normDocs(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const d of list) {
    const doc = normDoc(d);
    if (!doc || seen.has(doc.id)) continue;
    seen.add(doc.id);
    out.push(doc);
    if (out.length >= DOCS_PER_CHAPTER_MAX) break;
  }
  return out;
}

export function newDoc(label, url, today) {
  return normDoc({ id: uid(), label, url, addedAt: today, lastUsedAt: null });
}

// Documents d'un chapitre, les plus récemment utilisés d'abord — c'est ce
// qu'on veut retrouver quand le chapitre revient dans le plan.
export function sortedDocs(chapter) {
  return normDocs(chapter?.docs).slice().sort((a, b) => {
    const ka = a.lastUsedAt || a.addedAt || '';
    const kb = b.lastUsedAt || b.addedAt || '';
    if (ka !== kb) return ka < kb ? 1 : -1;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });
}

// Axes réellement applicables à un élément. Un élément sans `axes` explicite
// (données antérieures à la v6) est un cours : les trois s'appliquent.
export function applicableAxes(chapter) {
  const declared = Array.isArray(chapter?.axes) ? chapter.axes.filter((a) => AXIS_KEYS.includes(a)) : null;
  if (declared && declared.length) return AXIS_KEYS.filter((a) => declared.includes(a));
  return KINDS[chapter?.kind]?.axes ?? AXIS_KEYS;
}
export function axisApplies(chapter, axis) {
  return applicableAxes(chapter).includes(axis);
}

// Libellés des 4 issues, adaptés à l'axe. La note décrit le RÉSULTAT d'un test
// sans correction sous les yeux — pas le temps passé ni l'impression.
export const EVIDENCE = {
  recall: {
    key: 'recall', axis: 'recall', label: 'Rappel sans support', short: 'Rappel',
    hint: 'restituer de tête (définitions, formules, plan du cours)',
    grades: { 1: 'Oublié', 2: 'Avec effort', 3: 'Correct', 4: 'Immédiat' },
  },
  exercise: {
    key: 'exercise', axis: 'exercise', label: 'Exercice standard', short: 'Exercice',
    hint: 'exercice type, sans regarder cours ni corrigé',
    grades: { 1: 'Bloqué', 2: 'Avec aide', 3: 'Autonome', 4: 'Autonome et propre' },
  },
  problem: {
    key: 'problem', axis: 'problem', label: 'Problème / annale', short: 'Annale',
    hint: 'problème complet ou annale, conditions réelles',
    grades: { 1: 'Bloqué', 2: 'Partiel', 3: 'Résolu', 4: 'Résolu proprement dans le temps' },
  },
  legacy: {
    key: 'legacy', axis: 'recall', label: 'Ancienne note', short: 'Ancien',
    hint: 'note enregistrée avant la séparation des axes (traitée comme rappel)',
    grades: { 1: 'Oublié', 2: 'Difficile', 3: 'Bien', 4: 'Facile' },
  },
};

export function evidenceAxis(evidenceType) {
  return EVIDENCE[evidenceType]?.axis ?? 'recall';
}
export function gradeLabel(evidenceType, grade) {
  return EVIDENCE[evidenceType]?.grades?.[grade] ?? GRADES[grade]?.label ?? String(grade);
}

export const LEVELS = [
  { key: 'new', label: 'Jamais vu', m: 0, D: 8.5 },
  { key: 'fragile', label: 'Fragile', m: 33, D: 6.8 },
  { key: 'ok', label: 'Moyen', m: 66, D: 5.0 },
  { key: 'solid', label: 'Solide', m: 100, D: 3.2 },
];

// Urgence initiale du RAPPEL d'un chapitre jamais testé, selon son niveau.
export const INITIAL_URGENCY = { new: 2.2, fragile: 1.6, ok: 1.0, solid: 0.5 };
export function initialUrgencyOf(chapter) {
  return INITIAL_URGENCY[chapter?.initialLevel] ?? 2.2;
}

export const IMPORTANCE = {
  minor: { key: 'minor', label: 'Mineure', w: 0.6 },
  normal: { key: 'normal', label: 'Normale', w: 1.0 },
  major: { key: 'major', label: 'Majeure', w: 1.4 },
};

// Durées par défaut (minutes) par axe.
export const AXIS_MINUTES = { recall: 15, exercise: 30, problem: 60 };
export const MINUTE_CHOICES = [15, 30, 45, 60, 90, 120];

// Note pratique -> compétence observée (0..1). Barème transparent, unique.
export const PRACTICE_GRADE = { 1: 0, 2: 0.4, 3: 0.8, 4: 1.0 };

// Constantes du RISQUE pratique (exercice/problème) — centralisées, nommées.
// risque = (1 − score)·deficitWeight + ancienneté·staleWeight + échecsRécents·failWeight
export const RISK = {
  untestedPractice: 1.2, // risque d'un axe pratique jamais testé (fort mais < « cours jamais vu » = 2.2)
  deficitWeight: 1.0,    // poids du manque de maîtrise observée (1 − score)
  staleDays: 21,         // au-delà, l'ancienneté sature
  staleWeight: 0.4,      // poids max de l'ancienneté
  failWeight: 0.15,      // poids par échec récent
  failCap: 3,            // plafond d'échecs récents comptés
  emaAlpha: 0.5,         // poids de la preuve la plus récente dans le score
};

// Seuil « vaut la peine de travailler aujourd'hui » (sur le risque dominant).
export const WORTH_RISK = 0.75;
export const WORTH_EXAM_FACTOR = 1.15;

// Bilan d'épreuve : pendant N jours après une épreuve, proposer d'enregistrer
// ce qui a été constaté (axe problème/annale) — l'épreuve EST un test réel.
export const DEBRIEF_WINDOW = 3;

// Bornes acceptées à l'import (garde-fous, pas des réglages).
export const IMPORT_BOUNDS = {
  axisMinutes: [5, 480],   // durée d'un axe par chapitre
  dayMinutes: [0, 1440],   // capacité d'une journée
  weeklyFloor: [0, 50],    // minimum hebdo d'une matière parallèle
};

/* ================================================================== *
 *  Utilitaires
 * ================================================================== */

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const uid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'id-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export function isoOf(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
export function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function todayISO() { return isoOf(new Date()); }
export function daysBetween(aISO, bISO) {
  return Math.round((parseISO(bISO) - parseISO(aISO)) / 86400000);
}
export function addDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return isoOf(d);
}
export function mondayOf(iso) {
  const d = parseISO(iso);
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return isoOf(d);
}
// Date ISO stricte (YYYY-MM-DD réellement valide).
export function isValidISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/* ================================================================== *
 *  Axe RAPPEL — équations FSRS-4.5 (poids par défaut publiés)
 * ================================================================== */

export const FSRS_W = [
  0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031,
  1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755,
];

const DECAY = -0.5;
const FACTOR = Math.pow(0.9, 1 / DECAY) - 1; // = 19/81, calé pour R(S) = 90 %
const S_MIN = 0.2;
const S_MAX = 730;

export function retrievability(t, S) {
  if (S <= 0) return 0;
  return Math.pow(1 + FACTOR * Math.max(0, t) / S, DECAY);
}
export function optimalInterval(S, r = 0.9) {
  const rt = clamp(r, 0.7, 0.99);
  return (S / FACTOR) * (Math.pow(rt, 1 / DECAY) - 1);
}
export function initialDifficulty(grade) {
  return clamp(FSRS_W[4] - FSRS_W[5] * (grade - 3), 1, 10);
}
export function nextDifficulty(D, grade) {
  const target = initialDifficulty(4);
  return clamp(FSRS_W[7] * target + (1 - FSRS_W[7]) * (D - FSRS_W[6] * (grade - 3)), 1, 10);
}
export function stabilityAfterSuccess(S, D, R, grade) {
  let inc = Math.exp(FSRS_W[8]) * (11 - D) * Math.pow(S, -FSRS_W[9]) *
    (Math.exp(FSRS_W[10] * (1 - R)) - 1);
  if (grade === 2) inc *= FSRS_W[15];
  if (grade === 4) inc *= FSRS_W[16];
  return clamp(S * (1 + inc), S_MIN, S_MAX);
}
export function stabilityAfterFailure(S, D, R) {
  const s2 = FSRS_W[11] * Math.pow(D, -FSRS_W[12]) *
    (Math.pow(S + 1, FSRS_W[13]) - 1) * Math.exp(FSRS_W[14] * (1 - R));
  return clamp(Math.min(s2, S), S_MIN, S_MAX);
}

export function targetInterval(m, s) {
  const mm = clamp(m, 0, 100);
  return s.minInterval * Math.pow(s.maxInterval / s.minInterval, mm / 100);
}
export function levelSeed(level, s) {
  return { difficulty: level.D, stability: targetInterval(level.m, s) };
}
export function closestLevel(D) {
  let best = LEVELS[0];
  for (const l of LEVELS) if (Math.abs(l.D - D) < Math.abs(best.D - D)) best = l;
  return best;
}

// Applique une note de RAPPEL à un état recall -> nouvel état recall.
// initialLevel sert quand le chapitre n'a jamais été testé (élapsed supposé).
export function applyRecall(recall, initialLevel, grade, date) {
  const S = recall.stability;
  const D = recall.difficulty ?? 5;
  const since = recall.lastReviewed ? daysBetween(recall.lastReviewed, date) : null;
  const elapsed = since != null ? since : S * (INITIAL_URGENCY[initialLevel] ?? 2.2);
  const R = retrievability(elapsed, S);
  const stability = grade === 1
    ? stabilityAfterFailure(S, D, R)
    : stabilityAfterSuccess(S, D, R, grade);
  return { stability, difficulty: nextDifficulty(D, grade), lastReviewed: date };
}

/* ================================================================== *
 *  Axes PRATIQUES — score heuristique transparent (exercice / problème)
 * ================================================================== */

export function emptyPractice() {
  return { score: null, attempts: 0, lastTested: null, recentFails: 0 };
}

// Applique une note pratique -> nouvel état pratique (score EMA + échecs).
export function applyPractice(state, grade, date) {
  const g = PRACTICE_GRADE[grade] ?? 0;
  const prev = state && state.attempts > 0 ? state : null;
  const score = prev ? RISK.emaAlpha * g + (1 - RISK.emaAlpha) * prev.score : g;
  const recentFails = grade === 1
    ? Math.min(RISK.failCap, (prev?.recentFails ?? 0) + 1)
    : grade >= 3 ? Math.max(0, (prev?.recentFails ?? 0) - 1) : (prev?.recentFails ?? 0);
  return { score, attempts: (prev?.attempts ?? 0) + 1, lastTested: date, recentFails };
}

// Risque pratique (0..~1.85). Jamais testé -> RISK.untestedPractice.
export function practiceRisk(state, today) {
  if (!state || !state.attempts) return RISK.untestedPractice;
  const deficit = (1 - state.score) * RISK.deficitWeight;
  const days = state.lastTested ? daysBetween(state.lastTested, today) : 999;
  const stale = clamp(days / RISK.staleDays, 0, 1) * RISK.staleWeight;
  const fails = Math.min(state.recentFails ?? 0, RISK.failCap) * RISK.failWeight;
  return deficit + stale + fails;
}

// Risque pratique D'UN CHAPITRE : tant que l'axe n'a jamais été testé, le
// risque « non testé » est plafonné par le niveau initial déclaré — un
// chapitre « Solide » n'inonde pas le plan via ses exercices non testés,
// un « Jamais vu » entre immédiatement.
export function chapterPracticeRisk(chapter, axis, today) {
  const st = chapter[axis];
  if (!st || !st.attempts) return Math.min(RISK.untestedPractice, initialUrgencyOf(chapter));
  return practiceRisk(st, today);
}

/* ================================================================== *
 *  Application d'une preuve (une seule fonction, un seul axe touché)
 * ================================================================== */

// applyEvidence : renvoie { chapter, axis, before, after }.
// Ne modifie QUE l'axe concerné (recall FSRS, ou exercise/problem heuristique).
export function applyEvidence(chapter, evidenceType, grade, date) {
  const axis = evidenceAxis(evidenceType);
  const ch = {
    ...chapter,
    recall: { ...chapter.recall },
    exercise: { ...chapter.exercise },
    problem: { ...chapter.problem },
    minutes: { ...chapter.minutes },
  };
  if (axis === 'recall') {
    const before = { ...chapter.recall };
    const after = { ...applyRecall(chapter.recall, chapter.initialLevel, grade, date), source: 'tested' };
    ch.recall = after;
    return { chapter: ch, axis, before, after };
  }
  const before = { ...chapter[axis] };
  const after = applyPractice(chapter[axis], grade, date);
  ch[axis] = after;
  return { chapter: ch, axis, before, after };
}

/* ================================================================== *
 *  Examens & priorité multi-axes
 * ================================================================== */

export function examMultiplier(j, s, importance = 'normal') {
  if (j < 0 || j > s.pressureHorizon) return 1;
  const x = (s.pressureHorizon - j) / s.pressureHorizon;
  const base = 1 + (s.maxExamPressure - 1) * x * x;
  const w = IMPORTANCE[importance]?.w ?? 1;
  return Math.max(1, 1 + (base - 1) * w);
}

export function chapterExamFactor(chapter, exams, s, today) {
  let factor = 1, exam = null, examDays = null;
  for (const ex of exams) {
    if (!ex.chapterIds || !ex.chapterIds.includes(chapter.id)) continue;
    const j = daysBetween(today, ex.date);
    if (j < 0) continue;
    const mult = examMultiplier(j, s, ex.importance || 'normal');
    if (mult > factor) { factor = mult; exam = ex; examDays = j; }
  }
  return { factor, exam, examDays };
}

// Détail de l'axe rappel (urgence mémoire + rappel estimé).
export function recallInfo(chapter, s, today) {
  const rec = chapter.recall;
  const S = rec.stability;
  const ti = Math.max(0.5, optimalInterval(S, s.requestRetention));
  const since = rec.lastReviewed ? daysBetween(rec.lastReviewed, today) : null;
  const elapsed = since != null ? since : ti * initialUrgencyOf(chapter);
  const risk = Math.max(0, elapsed) / ti;
  const R = since != null ? retrievability(since, S) : null;
  const dueIn = Math.max(0, Math.round(ti - elapsed));
  return { risk, ti, since, R, dueIn, tested: since != null };
}

// Une unité de reprise est une portion datée du document cumulatif. Elle
// réutilise l'état FSRS du rappel, mais reste invisible dans la liste des
// chapitres : le chapitre organise le cours, l'unité organise la mémoire.
export function isReviewUnit(chapter) {
  return chapter?.reviewUnit === true;
}

// Contrairement à un chapitre historique, une portion nouvelle n'est jamais
// présentée comme « maîtrisée » ou « non maîtrisée ». Son premier rappel est
// simplement exigible le lendemain ; la courbe ne démarre qu'après ce rappel.
export function reviewUnitInfo(unit, s, today) {
  const introducedAt = isValidISODate(unit?.introducedAt) ? unit.introducedAt : today;
  const rec = unit?.recall || {};
  if (!rec.lastReviewed) {
    const dueAt = addDays(introducedAt, 1);
    return {
      tested: false,
      dueAt,
      due: dueAt <= today,
      overdueDays: Math.max(0, daysBetween(dueAt, today)),
      interval: 1,
      R: null,
    };
  }
  const interval = Math.max(1, Math.round(optimalInterval(rec.stability, s.requestRetention)));
  const dueAt = addDays(rec.lastReviewed, interval);
  const since = Math.max(0, daysBetween(rec.lastReviewed, today));
  return {
    tested: true,
    dueAt,
    due: dueAt <= today,
    overdueDays: Math.max(0, daysBetween(dueAt, today)),
    interval,
    since,
    R: retrievability(since, rec.stability),
  };
}

// Prévision dédiée aux portions. Les échéances déjà dépassées sont regroupées
// aujourd'hui : le calendrier ne prétend pas qu'on peut réviser dans le passé.
export function forecastReviewUnits(units, s, today, horizon = 28) {
  const map = {};
  for (const unit of units || []) {
    if (!isReviewUnit(unit)) continue;
    const info = reviewUnitInfo(unit, s, today);
    const date = info.dueAt < today ? today : info.dueAt;
    const offset = daysBetween(today, date);
    if (offset < 0 || offset > horizon) continue;
    const cell = map[date] || (map[date] = { count: 0, minutes: 0 });
    cell.count += 1;
    cell.minutes += unit.minutes?.recall ?? AXIS_MINUTES.recall;
  }
  return map;
}

// Axe au risque le plus élevé, parmi ceux qui s'appliquent. À égalité, l'ordre
// pédagogique tranche (apprendre -> appliquer -> transférer).
function argmaxAxis(risks, axes = AXIS_KEYS) {
  const usable = axes.length ? axes : AXIS_KEYS;
  let best = usable[0];
  for (const k of usable) if (risks[k] > risks[best]) best = k;
  return best;
}

export function axisMinutes(chapter, axis) {
  return chapter?.minutes?.[axis] ?? AXIS_MINUTES[axis] ?? 30;
}

// Priorité d'un chapitre = risque de l'axe dominant × pression d'examen.
// Les trois risques sont explicites et exposés (axes), la priorité en découle.
export function chapterMetrics(chapter, exams, s, today) {
  const rec = recallInfo(chapter, s, today);
  const exRisk = chapterPracticeRisk(chapter, 'exercise', today);
  const prRisk = chapterPracticeRisk(chapter, 'problem', today);
  const risks = { recall: rec.risk, exercise: exRisk, problem: prRisk };
  // Seuls les axes déclarés pèsent : une liste de vocabulaire ne doit pas
  // être poussée par un risque « annales jamais testées » qui n'a aucun sens.
  const axes = applicableAxes(chapter);
  const dominant = argmaxAxis(risks, axes);
  const { factor, exam, examDays } = chapterExamFactor(chapter, exams, s, today);
  const baseRisk = risks[dominant];
  const priority = baseRisk * factor;
  return {
    risks, axes, dominant, baseRisk, factor, exam, examDays, priority,
    minutes: axisMinutes(chapter, dominant),
    recall: rec,
    exercise: { risk: exRisk, state: chapter.exercise },
    problem: { risk: prRisk, state: chapter.problem },
    // champs rappel remontés (calendrier / prévision / progrès)
    R: rec.R, ti: rec.ti, since: rec.since, dueIn: rec.dueIn,
  };
}

// Épreuves récemment passées à débriefer : pour chaque épreuve passée depuis
// 1..DEBRIEF_WINDOW jours, non masquée, liste les chapitres couverts et si un
// constat explicitement rattaché à CETTE épreuve existe déjà. Une preuve
// générique ne doit pas fermer plusieurs bilans qui couvrent le même chapitre.
// Disparaît d'elle-même : tout noté, masquée, ou fenêtre écoulée.
export function pendingDebriefs(exams, chapters, reviewLog, debriefs, today, window = DEBRIEF_WINDOW) {
  const byId = new Map(chapters.map((c) => [c.id, c]));
  const out = [];
  for (const ex of exams) {
    if (!isValidISODate(ex.date)) continue;
    const daysAgo = daysBetween(ex.date, today);
    if (daysAgo < 1 || daysAgo > window) continue;
    if (debriefs && debriefs[ex.id]) continue;
    const items = (ex.chapterIds || [])
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((chapter) => ({
        chapter,
        done: (reviewLog || []).some((r) => r.chapterId === chapter.id
          && evidenceAxis(r.evidenceType) === 'problem'
          && r.source === 'exam-debrief' && r.examId === ex.id),
      }));
    if (!items.length) continue;
    if (items.every((it) => it.done)) continue; // tout constaté -> plus rien à demander
    out.push({ exam: ex, daysAgo, items });
  }
  return out.sort((a, b) => a.daysAgo - b.daysAgo);
}

export function nextFutureExam(subjectId, exams, today) {
  let best = null;
  for (const ex of exams) {
    if (ex.subjectId !== subjectId) continue;
    const j = daysBetween(today, ex.date);
    if (j < 0) continue;
    if (!best || j < best.days) best = { exam: ex, days: j };
  }
  return best;
}
export function annalesModeFor(subjectId, exams, s, today) {
  const n = nextFutureExam(subjectId, exams, today);
  return n && n.days <= s.examModeThreshold ? n : null;
}

// Étiquette d'axe + explication courte, selon l'axe dominant et le contexte.
export function reasonPhrase(m, chapter) {
  const axis = m.dominant;
  const examSoon = m.exam && m.examDays != null && m.factor > 1.15;
  // « cours » n'a de sens que pour un chapitre de cours : une liste de
  // vocabulaire n'est pas un cours jamais testé, juste un élément jamais testé.
  const isCourse = (chapter?.kind ?? 'course') === 'course';
  if (axis === 'recall') {
    if (!m.recall.tested) return { text: isCourse ? 'cours jamais testé' : 'jamais testé', tone: 'late', axis };
    if (m.recall.risk >= 1) {
      const over = Math.round((m.recall.since ?? 0) - m.recall.ti);
      return { text: over > 1 ? `rappel en retard de ${over} j` : 'rappel à retester', tone: 'late', axis };
    }
    if (examSoon) return { text: `rappel à consolider avant ${m.exam.name}`, tone: 'exam', axis };
    return { text: 'rappel bientôt à revoir', tone: 'calm', axis };
  }
  const st = axis === 'exercise' ? m.exercise.state : m.problem.state;
  const noun = axis === 'exercise' ? 'exercices' : 'problèmes/annales';
  if (!st || !st.attempts) {
    if (examSoon) return { text: `${axis === 'problem' ? 'annale importante' : 'exercice important'} avant ${m.exam.name}`, tone: 'exam', axis };
    return { text: `${noun} non testés`, tone: 'late', axis };
  }
  if (examSoon) return { text: `${noun} à sécuriser avant ${m.exam.name}`, tone: 'exam', axis };
  return { text: `${noun} à consolider`, tone: 'late', axis };
}

export function isWorthReviewing(m) {
  return m.baseRisk >= WORTH_RISK || m.factor > WORTH_EXAM_FACTOR;
}

/* ================================================================== *
 *  Capacité & plan du jour (en minutes, par axe)
 * ================================================================== */

export function defaultDailyMinutes(s) {
  return Math.round(s.subjectsPerDay * s.sessionHours * 60);
}
export function todayCapacityMinutes(s, capacityOverrides, today) {
  const o = capacityOverrides?.[today];
  return (o == null ? defaultDailyMinutes(s) : Math.max(0, o));
}

// Score robuste d'une matière : priorité max + moyenne des 3 meilleures.
export function subjectScore(priorities) {
  if (!priorities.length) return 0;
  const top = priorities.slice(0, 3);
  return priorities[0] + top.reduce((a, b) => a + b, 0) / top.length;
}

// Plan du jour. `ranked` = chapitres enrichis par chapterMetrics (donc
// `.priority`, `.dominant`, `.minutes` [nombre = durée de l'axe dominant]).
// Chaque séance est remplie EN MINUTES (≤ sessionMinutes), le tout borné par
// `totalMinutes`. On ne dépasse jamais. totalMinutes = 0 -> aucun plan.
export function planDay(ranked, subjects, opts) {
  const { subjectsPerDay, sessionMinutes, totalMinutes, settings } = opts;
  if (!totalMinutes || totalMinutes <= 0) return [];
  const core = new Map(subjects.filter((s) => s.type === 'core').map((s) => [s.id, s]));
  const bySubject = new Map();
  for (const ch of ranked) {
    if (!core.has(ch.subjectId)) continue;
    if (!bySubject.has(ch.subjectId)) bySubject.set(ch.subjectId, []);
    bySubject.get(ch.subjectId).push(ch);
  }
  const candidates = [];
  for (const [sid, chs] of bySubject) {
    candidates.push({ subject: core.get(sid), all: chs, score: subjectScore(chs.map((c) => c.priority)) });
  }
  candidates.sort((a, b) => b.score - a.score);

  const sessions = [];
  let remainingTotal = totalMinutes;
  for (const cand of candidates) {
    if (sessions.length >= Math.max(1, subjectsPerDay)) break;
    if (remainingTotal <= 0) break;
    const budget = Math.min(sessionMinutes, remainingTotal);
    const items = [];
    let minutes = 0;
    for (const ch of cand.all) {
      const m = ch.minutes ?? axisMinutes(ch, ch.dominant || 'exercise');
      if (m <= budget - minutes) {
        items.push(ch);
        minutes += m;
        if (minutes >= budget) break;
      }
    }
    if (!items.length) continue;
    remainingTotal -= minutes;
    sessions.push({ subject: cand.subject, chapters: items, minutes, score: cand.score, total: cand.all.length });
  }
  return sessions;
}

// Charge d'entretien du RAPPEL, en MINUTES/jour : Σ minutesRappel / intervalle.
// (Le travail exercice/problème est piloté par les examens, pas périodique.)
export function cruiseLoad(chapters, s) {
  let minutes = 0;
  for (const c of chapters) {
    if (!axisApplies(c, 'recall')) continue; // pas de rappel -> pas d'entretien périodique
    const I = Math.max(1, optimalInterval(c.recall.stability, s.requestRetention));
    minutes += (c.minutes?.recall ?? AXIS_MINUTES.recall) / I;
  }
  return minutes;
}

// observedRetention : calibration du RAPPEL uniquement (ignore exercise/problem).
export function observedRetention(reviewLog) {
  const entries = (reviewLog || []).filter((r) => {
    const ax = r.evidenceType ? evidenceAxis(r.evidenceType) : 'recall';
    return ax === 'recall' && r.before && r.before.lastReviewed;
  });
  if (!entries.length) return { n: 0, rate: null, predicted: null };
  let ok = 0, pred = 0;
  for (const r of entries) {
    if (r.grade > 1) ok++;
    pred += retrievability(daysBetween(r.before.lastReviewed, r.date), r.before.stability);
  }
  return { n: entries.length, rate: ok / entries.length, predicted: pred / entries.length };
}

// Prévision de charge du rappel : par jour, { count, minutes }.
export function forecastDue(chapters, s, today, horizon = 28) {
  const map = {};
  for (const c of chapters) {
    if (!axisApplies(c, 'recall')) continue;
    const I = Math.max(1, Math.round(optimalInterval(c.recall.stability, s.requestRetention)));
    const since = c.recall.lastReviewed ? daysBetween(c.recall.lastReviewed, today) : null;
    const elapsed = since != null ? since : I * initialUrgencyOf(c);
    const dueIn = Math.max(0, Math.round(I - elapsed));
    if (dueIn <= horizon) {
      const iso = addDays(today, dueIn);
      const cell = map[iso] || (map[iso] = { count: 0, minutes: 0 });
      cell.count += 1;
      cell.minutes += (c.minutes?.recall ?? AXIS_MINUTES.recall);
    }
  }
  return map;
}

// Préparation d'examen : rappel estimé le jour J (chapitres au rappel testé),
// + couverture des trois axes. Les non-testés (par axe) sont explicites.
export function examReadiness(exam, chapters, s, today) {
  const j = daysBetween(today, exam.date);
  if (j < 0) return null;
  const covered = chapters.filter((c) => (exam.chapterIds || []).includes(c.id));
  if (!covered.length) return null;
  // Le rappel estimé ne porte que sur les éléments concernés par le rappel.
  const recallItems = covered.filter((c) => axisApplies(c, 'recall'));
  const untestedRecall = recallItems.filter((c) => !c.recall.lastReviewed);
  const tested = recallItems
    .filter((c) => c.recall.lastReviewed)
    .map((c) => ({ chapter: c, projR: retrievability(daysBetween(c.recall.lastReviewed, exam.date), c.recall.stability) }))
    .sort((a, b) => a.projR - b.projR);
  const avgR = tested.length ? tested.reduce((a, x) => a + x.projR, 0) / tested.length : null;
  // Chaque couverture est rapportée aux seuls éléments auxquels l'axe s'applique.
  const cov = (axis) => {
    const scope = covered.filter((c) => axisApplies(c, axis));
    const testedN = scope.filter((c) => c[axis]?.attempts > 0).length;
    return { tested: testedN, total: scope.length, untested: scope.length - testedN };
  };
  const covRecall = () => {
    const testedN = recallItems.filter((c) => c.recall?.lastReviewed).length;
    return { tested: testedN, total: recallItems.length, untested: recallItems.length - testedN };
  };
  return {
    days: j, avgR, per: tested, untested: untestedRecall,
    testedCount: tested.length, coveredCount: covered.length,
    weak: tested.filter((x) => x.projR < 0.7).length,
    coverage: { recall: covRecall(), exercise: cov('exercise'), problem: cov('problem') },
  };
}

// Synthèse par axe sur un ensemble de chapitres (indicateurs honnêtes).
// Le total d'un axe ne compte que les éléments AUXQUELS il s'applique : une
// liste de vocabulaire ne doit pas gonfler les « annales non testées ».
export function axisSummary(chapters, s, today) {
  const out = { recall: { tested: 0, total: 0, sum: 0 },
    exercise: { tested: 0, total: 0, sum: 0 },
    problem: { tested: 0, total: 0, sum: 0 } };
  for (const c of chapters) {
    for (const axis of applicableAxes(c)) out[axis].total++;
    if (axisApplies(c, 'recall')) {
      const rec = recallInfo(c, s, today);
      if (rec.tested) { out.recall.tested++; out.recall.sum += rec.R; }
    }
    if (axisApplies(c, 'exercise') && c.exercise?.attempts > 0) { out.exercise.tested++; out.exercise.sum += c.exercise.score; }
    if (axisApplies(c, 'problem') && c.problem?.attempts > 0) { out.problem.tested++; out.problem.sum += c.problem.score; }
  }
  for (const k of AXIS_KEYS) {
    out[k].avg = out[k].tested ? out[k].sum / out[k].tested : null;
    out[k].untested = out[k].total - out[k].tested;
  }
  return out;
}

/* ================================================================== *
 *  Instantanés locaux, validation d'import, migrations
 * ================================================================== */

export function pruneBackups(backups, today, keep = 7) {
  const dates = Object.keys(backups || {}).filter((d) => d <= today).sort().slice(-keep);
  const out = {};
  for (const d of dates) out[d] = backups[d];
  return out;
}

// Réglages acceptés à l'import. Les bornes englobent les anciennes interfaces
// tout en protégeant les calculs contre les zéros, valeurs négatives et NaN.
const IMPORT_SETTING_RULES = {
  requestRetention: { min: 0.7, max: 0.99 },
  subjectsPerDay: { min: 1, max: 24, integer: true },
  sessionHours: { min: 0.25, max: 24 },
  minutesPerChapter: { min: IMPORT_BOUNDS.axisMinutes[0], max: IMPORT_BOUNDS.axisMinutes[1] },
  maxExamPressure: { min: 1, max: 20 },
  pressureHorizon: { min: 1, max: 365, integer: true },
  examModeThreshold: { min: 0, max: 365, integer: true },
  minInterval: { min: 0.2, max: 730 },
  maxInterval: { min: 0.2, max: 730 },
  simpleMode: { type: 'boolean' },
  // Champ v1 supprimé par migrateV1, mais encore accepté pour restaurer un
  // ancien export.
  blocksPerDay: { min: 1, max: 24, integer: true },
};

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const safeName = (obj) => (typeof obj?.name === 'string' && obj.name ? obj.name : '?');

// Validation STRICTE avant tout remplacement. Renvoie toujours
// { ok, errors: [...] }, même pour une forme JSON profondément malformée.
// N'altère jamais l'état existant : c'est à l'appelant de refuser si !ok.
export function validateImport(obj) {
  const errors = [];
  const push = (e) => { if (errors.length < 20) errors.push(e); };

  try {
    if (!isRecord(obj)) {
      return { ok: false, errors: ['Le fichier ne contient pas un objet JSON CADENCE.'] };
    }

    // Les exports v1 historiques pouvaient ne pas porter de version. Une
    // version présente doit en revanche être un entier explicitement connu.
    const version = hasOwn(obj, 'version') ? obj.version : 1;
    const knownVersion = Number.isInteger(version) && KNOWN_VERSIONS.includes(version);
    if (!knownVersion) push(`Version de schéma inconnue : ${typeof version === 'number' || typeof version === 'string' ? version : '?'}.`);

    const subjects = Array.isArray(obj.subjects) ? obj.subjects : [];
    const chapters = Array.isArray(obj.chapters) ? obj.chapters : [];
    const exams = Array.isArray(obj.exams) ? obj.exams : [];
    const reviews = Array.isArray(obj.reviewLog) ? obj.reviewLog : [];
    if (!Array.isArray(obj.subjects)) push('« subjects » manquant ou n’est pas une liste.');
    if (hasOwn(obj, 'chapters') && !Array.isArray(obj.chapters)) push('« chapters » doit être une liste.');
    if (hasOwn(obj, 'exams') && !Array.isArray(obj.exams)) push('« exams » doit être une liste.');
    if (hasOwn(obj, 'reviewLog') && !Array.isArray(obj.reviewLog)) push('« reviewLog » doit être une liste.');

    const subjectIds = new Set();
    for (const su of subjects) {
      if (!isRecord(su)) { push('Une matière n’est pas un objet.'); continue; }
      if (typeof su.id !== 'string' || !su.id) push(`Matière sans identifiant valide (« ${safeName(su)} »).`);
      else if (subjectIds.has(su.id)) push(`Identifiant de matière dupliqué : ${su.id}.`);
      else subjectIds.add(su.id);
      if (typeof su.name !== 'string') push('Une matière n’a pas de nom.');
      if (su.type != null && su.type !== 'core' && su.type !== 'parallel') push('Type de matière invalide.');
      if (su.weeklyFloor != null && !(Number.isFinite(su.weeklyFloor)
        && su.weeklyFloor >= IMPORT_BOUNDS.weeklyFloor[0] && su.weeklyFloor <= IMPORT_BOUNDS.weeklyFloor[1])) {
        push(`Matière « ${safeName(su)} » : minimum hebdo hors bornes.`);
      }
    }

    const validateRecall = (a, label) => {
      if (!isRecord(a)) { push(`Chapitre « ${label} » : état recall invalide.`); return; }
      if (!(Number.isFinite(a.stability) && a.stability > 0)) push(`Chapitre « ${label} » : stability recall invalide.`);
      if (!(Number.isFinite(a.difficulty) && a.difficulty >= 1 && a.difficulty <= 10)) push(`Chapitre « ${label} » : difficulté recall hors [1,10].`);
      if (a.lastReviewed != null && !isValidISODate(a.lastReviewed)) push(`Chapitre « ${label} » : date rappel invalide.`);
    };
    const validatePractice = (a, axis, label) => {
      if (!isRecord(a)) { push(`Chapitre « ${label} » : état ${axis} invalide.`); return; }
      const attemptsOk = Number.isInteger(a.attempts) && a.attempts >= 0;
      const failsOk = Number.isInteger(a.recentFails) && a.recentFails >= 0 && a.recentFails <= RISK.failCap;
      const scoreOk = a.score === null || (Number.isFinite(a.score) && a.score >= 0 && a.score <= 1);
      if (!attemptsOk) push(`Chapitre « ${label} » : attempts ${axis} doit être un entier positif ou nul.`);
      if (!failsOk) push(`Chapitre « ${label} » : recentFails ${axis} invalide.`);
      if (!scoreOk) push(`Chapitre « ${label} » : score ${axis} hors [0,1].`);
      if (a.lastTested != null && !isValidISODate(a.lastTested)) push(`Chapitre « ${label} » : date ${axis} invalide.`);
      if (attemptsOk && a.attempts === 0) {
        if (a.score !== null || a.lastTested != null || a.recentFails !== 0) {
          push(`Chapitre « ${label} » : état ${axis} incohérent sans tentative.`);
        }
      } else if (attemptsOk && a.attempts > 0) {
        if (!(Number.isFinite(a.score) && a.score >= 0 && a.score <= 1) || !isValidISODate(a.lastTested)) {
          push(`Chapitre « ${label} » : état ${axis} incohérent avec des tentatives.`);
        }
        if (failsOk && a.recentFails > a.attempts) push(`Chapitre « ${label} » : recentFails dépasse attempts (${axis}).`);
      }
    };

    const chapterIds = new Set();
    const reviewUnitRefs = [];
    for (const c of chapters) {
      if (!isRecord(c)) { push('Un chapitre n’est pas un objet.'); continue; }
      const label = safeName(c);
      if (typeof c.id !== 'string' || !c.id) push(`Chapitre sans identifiant valide (« ${label} »).`);
      else if (chapterIds.has(c.id)) push(`Identifiant de chapitre dupliqué : ${c.id}.`);
      else chapterIds.add(c.id);
      if (typeof c.name !== 'string') push('Un chapitre n’a pas de nom.');
      if (typeof c.subjectId !== 'string' || !subjectIds.has(c.subjectId)) push(`Chapitre « ${label} » : matière introuvable.`);
      if (c.initialLevel != null && !LEVELS.some((l) => l.key === c.initialLevel)) {
        push(`Chapitre « ${label} » : niveau initial inconnu.`);
      }
      // v6 : type, axes applicables et point de reprise.
      if (c.kind != null && !KIND_KEYS.includes(c.kind)) push(`« ${label} » : type inconnu.`);
      if (c.axes != null) {
        if (!Array.isArray(c.axes)) push(`« ${label} » : « axes » doit être une liste.`);
        else if (!c.axes.length) push(`« ${label} » : au moins un axe est nécessaire.`);
        else for (const a of c.axes) if (!AXIS_KEYS.includes(a)) push(`« ${label} » : axe inconnu (${a}).`);
      }
      if (c.position != null && (typeof c.position !== 'string' || c.position.length > POSITION_MAX)) {
        push(`« ${label} » : point de reprise invalide ou trop long.`);
      }
      if (c.positionUpdatedAt != null && !isValidISODate(c.positionUpdatedAt)) {
        push(`« ${label} » : date de mise à jour du point invalide.`);
      }
      if (c.reviewUnit != null && typeof c.reviewUnit !== 'boolean') {
        push(`« ${label} » : indicateur d’unité de reprise invalide.`);
      }
      if (c.reviewUnit === true) {
        if (typeof c.parentChapterId !== 'string' || !c.parentChapterId) {
          push(`« ${label} » : chapitre parent manquant.`);
        }
        if (!isValidISODate(c.introducedAt)) push(`« ${label} » : date d’introduction invalide.`);
        if (c.kind !== 'resource') push(`« ${label} » : une unité de reprise doit être une ressource interne.`);
        if (!Array.isArray(c.axes) || c.axes.length !== 1 || c.axes[0] !== 'recall') {
          push(`« ${label} » : une unité de reprise ne doit porter que le rappel.`);
        }
        reviewUnitRefs.push({ id: c.id, parentChapterId: c.parentChapterId, label });
      }
      // v7 : documents attachés (références, jamais de fichiers).
      if (c.docs != null) {
        if (!Array.isArray(c.docs)) push(`« ${label} » : « docs » doit être une liste.`);
        else if (c.docs.length > DOCS_PER_CHAPTER_MAX) push(`« ${label} » : trop de documents (max ${DOCS_PER_CHAPTER_MAX}).`);
        else for (const d of c.docs) {
          if (!d || typeof d !== 'object') { push(`« ${label} » : document invalide.`); continue; }
          if (d.url != null && !isSafeDocUrl(d.url)) push(`« ${label} » : lien non autorisé (http/https uniquement).`);
          if (d.label != null && (typeof d.label !== 'string' || d.label.length > DOC_LABEL_MAX)) push(`« ${label} » : libellé de document trop long.`);
          if (d.url == null && !d.label) push(`« ${label} » : document sans lien ni libellé.`);
          if (d.addedAt != null && !isValidISODate(d.addedAt)) push(`« ${label} » : date de document invalide.`);
          if (d.lastUsedAt != null && !isValidISODate(d.lastUsedAt)) push(`« ${label} » : date d'utilisation invalide.`);
        }
      }

      // Le schéma v4 exige les trois axes indépendants. Les schémas v1-v3
      // gardent leurs champs plats, mais tout axe éventuellement présent doit
      // déjà être cohérent.
      if (version === 4 || hasOwn(c, 'recall')) validateRecall(c.recall, label);
      for (const ax of ['exercise', 'problem']) {
        if (version === 4 || hasOwn(c, ax)) validatePractice(c[ax], ax, label);
      }

      if (version === 4 && !isRecord(c.minutes)) push(`Chapitre « ${label} » : durées par axe manquantes.`);
      else if (hasOwn(c, 'minutes') && !isRecord(c.minutes)) push(`Chapitre « ${label} » : « minutes » doit être un objet.`);
      if (isRecord(c.minutes)) {
        for (const ax of AXIS_KEYS) {
          const mn = c.minutes[ax];
          if (!(Number.isFinite(mn) && mn >= IMPORT_BOUNDS.axisMinutes[0] && mn <= IMPORT_BOUNDS.axisMinutes[1])) {
            push(`Chapitre « ${label} » : durée ${ax} hors bornes (${IMPORT_BOUNDS.axisMinutes[0]}–${IMPORT_BOUNDS.axisMinutes[1]} min).`);
          }
        }
      }

      // Champs plats des schémas v1-v3.
      if (c.mastery != null && !(Number.isFinite(c.mastery) && c.mastery >= 0 && c.mastery <= 100)) push(`Chapitre « ${label} » : mastery hors [0,100].`);
      if (c.stability != null && !(Number.isFinite(c.stability) && c.stability >= 0)) push(`Chapitre « ${label} » : stability non numérique.`);
      if (c.difficulty != null && !(Number.isFinite(c.difficulty) && c.difficulty >= 1 && c.difficulty <= 10)) push(`Chapitre « ${label} » : difficulté hors [1,10].`);
      if (c.lastReviewed != null && !isValidISODate(c.lastReviewed)) push(`Chapitre « ${label} » : lastReviewed invalide.`);
      if (c.estimatedMinutes != null && !(Number.isFinite(c.estimatedMinutes)
        && c.estimatedMinutes >= IMPORT_BOUNDS.axisMinutes[0] && c.estimatedMinutes <= IMPORT_BOUNDS.axisMinutes[1])) {
        push(`Chapitre « ${label} » : durée historique hors bornes.`);
      }
    }

    for (const unit of reviewUnitRefs) {
      if (!chapterIds.has(unit.parentChapterId) || unit.parentChapterId === unit.id) {
        push(`« ${unit.label} » : chapitre parent introuvable.`);
      }
    }

    const examIds = new Set();
    for (const e of exams) {
      if (!isRecord(e)) { push('Une épreuve n’est pas un objet.'); continue; }
      const label = safeName(e);
      if (typeof e.id !== 'string' || !e.id) push(`Épreuve sans identifiant valide (« ${label} »).`);
      else if (examIds.has(e.id)) push(`Identifiant d’épreuve dupliqué : ${e.id}.`);
      else examIds.add(e.id);
      if (typeof e.name !== 'string') push('Une épreuve n’a pas de nom.');
      if (typeof e.subjectId !== 'string' || !subjectIds.has(e.subjectId)) push(`Épreuve « ${label} » : matière introuvable.`);
      if (!isValidISODate(e.date)) push(`Épreuve « ${label} » : date invalide.`);
      if (e.importance != null && !IMPORTANCE[e.importance]) push(`Épreuve « ${label} » : importance invalide.`);

      if (hasOwn(e, 'chapterIds') && !Array.isArray(e.chapterIds)) {
        push(`Épreuve « ${label} » : « chapterIds » doit être une liste.`);
      } else if (Array.isArray(e.chapterIds)) {
        const covered = new Set();
        for (const cid of e.chapterIds) {
          if (typeof cid !== 'string' || !chapterIds.has(cid)) push(`Épreuve « ${label} » : chapitre couvert introuvable.`);
          else if (covered.has(cid)) push(`Épreuve « ${label} » : chapitre couvert dupliqué (${cid}).`);
          else covered.add(cid);
        }
      }
    }

    const reviewIds = new Set();
    for (const r of reviews) {
      if (!isRecord(r)) { push('Une entrée d’historique n’est pas un objet.'); continue; }
      if (typeof r.id !== 'string' || !r.id) push('Historique : identifiant de review manquant ou invalide.');
      else if (reviewIds.has(r.id)) push(`Identifiant de review dupliqué : ${r.id}.`);
      else reviewIds.add(r.id);
      if (typeof r.chapterId !== 'string' || !chapterIds.has(r.chapterId)) push('Historique : chapitre introuvable.');
      if (!(Number.isInteger(r.grade) && r.grade >= 1 && r.grade <= 4)) push('Note d’historique : entier attendu dans [1,4].');
      if (!isValidISODate(r.date)) push('Historique : date invalide.');
      if (r.evidenceType != null && !EVIDENCE[r.evidenceType]) push('Historique : type de preuve inconnu.');
      if (r.axis != null && !AXIS_KEYS.includes(r.axis)) push('Historique : axe inconnu.');
    }

    if (hasOwn(obj, 'settings')) {
      if (!isRecord(obj.settings)) push('« settings » doit être un objet.');
      else {
        for (const [key, value] of Object.entries(obj.settings)) {
          const rule = IMPORT_SETTING_RULES[key];
          if (!rule) { push(`Réglage inconnu : ${key}.`); continue; }
          if (rule.type === 'boolean') {
            if (typeof value !== 'boolean') push(`Réglage « ${key} » : booléen attendu.`);
            continue;
          }
          if (!(typeof value === 'number' && Number.isFinite(value)
            && value >= rule.min && value <= rule.max && (!rule.integer || Number.isInteger(value)))) {
            push(`Réglage « ${key} » hors type ou bornes.`);
          }
        }
        const merged = { ...DEFAULT_SETTINGS, ...obj.settings };
        if (Number.isFinite(merged.minInterval) && Number.isFinite(merged.maxInterval)
          && merged.minInterval > merged.maxInterval) {
          push('Réglages incohérents : minInterval doit être inférieur ou égal à maxInterval.');
        }
      }
    }

    if (hasOwn(obj, 'capacityOverrides')) {
      if (!isRecord(obj.capacityOverrides)) {
        push('« capacityOverrides » doit être un objet { date: minutes }.');
      } else for (const [d, v] of Object.entries(obj.capacityOverrides)) {
        if (!isValidISODate(d)) push(`Capacité : date invalide (${d}).`);
        if (!(Number.isFinite(v) && v >= IMPORT_BOUNDS.dayMinutes[0] && v <= IMPORT_BOUNDS.dayMinutes[1])) {
          push(`Capacité du ${d} hors bornes (0–${IMPORT_BOUNDS.dayMinutes[1]} min).`);
        }
      }
    }

    if (hasOwn(obj, 'examDebriefs')) {
      if (!isRecord(obj.examDebriefs)) {
        push('« examDebriefs » doit être un objet { épreuve: date }.');
      } else for (const [, v] of Object.entries(obj.examDebriefs)) {
        if (!isValidISODate(v)) push('Bilan d’épreuve : date invalide.');
      }
    }

    // v5 : historique de suppression et métadonnées de synchronisation.
    if (hasOwn(obj, 'deleted')) {
      if (!isRecord(obj.deleted)) push('« deleted » doit être un objet { type: { id: date } }.');
      else for (const [kind, map] of Object.entries(obj.deleted)) {
        if (!DELETABLE.includes(kind)) { push(`Suppressions : type inconnu (${kind}).`); continue; }
        if (!isRecord(map)) { push(`Suppressions « ${kind} » : objet attendu.`); continue; }
        for (const [, d] of Object.entries(map)) {
          if (!isValidISODate(d)) push(`Suppressions « ${kind} » : date invalide.`);
        }
      }
    }
    if (hasOwn(obj, 'syncMeta') && obj.syncMeta != null) {
      if (!isRecord(obj.syncMeta)) push('« syncMeta » doit être un objet.');
      else {
        const m = obj.syncMeta;
        if (m.deviceId != null && typeof m.deviceId !== 'string') push('syncMeta : identifiant d’appareil invalide.');
        if (m.updatedAt != null && !Number.isFinite(m.updatedAt)) push('syncMeta : horodatage non numérique.');
        if (m.rev != null && !Number.isFinite(m.rev)) push('syncMeta : révision non numérique.');
      }
    }
  } catch (e) {
    // Dernier garde-fou : une validation d'import ne doit jamais faire tomber
    // l'interface, même face à un objet exotique fourni par un test/hôte.
    push('Structure JSON illisible ou invalide.');
  }
  return { ok: errors.length === 0, errors };
}

/* ---- migrations ---- */

export function migrateV1(v1) {
  const settings = { ...DEFAULT_SETTINGS, ...(v1?.settings || {}) };
  delete settings.blocksPerDay;
  const chapters = (v1?.chapters || []).map((c) => {
    const m = clamp(c.mastery ?? 50, 0, 100);
    return {
      id: c.id, subjectId: c.subjectId, name: c.name,
      difficulty: c.difficulty ?? clamp(1 + 9 * (1 - m / 100), 1, 10),
      stability: c.stability ?? targetInterval(m, settings),
      lastReviewed: c.lastReviewed ?? null,
    };
  });
  return {
    version: 2, subjects: v1?.subjects || [], chapters, exams: v1?.exams || [],
    settings, parallelLog: v1?.parallelLog || {}, reviewLog: [], skips: {},
  };
}

export function migrateV2(v2) {
  const settings = { ...DEFAULT_SETTINGS, ...(v2?.settings || {}) };
  return {
    version: 3, subjects: v2?.subjects || [],
    chapters: (v2?.chapters || []).map((c) => ({
      ...c,
      difficulty: clamp(c.difficulty ?? 5, 1, 10),
      stability: Math.max(S_MIN, c.stability ?? 2),
      lastReviewed: c.lastReviewed ?? null,
      initialLevel: c.initialLevel ?? closestLevel(c.difficulty ?? 5).key,
      estimatedMinutes: c.estimatedMinutes ?? settings.minutesPerChapter ?? 30,
    })),
    exams: (v2?.exams || []).map((e) => ({ ...e, importance: e.importance ?? 'normal' })),
    settings, parallelLog: v2?.parallelLog || {},
    reviewLog: (v2?.reviewLog || []).map((r) => ({ ...r, evidenceType: r.evidenceType ?? 'legacy' })),
    archivedReviews: v2?.archivedReviews || [], skips: v2?.skips || {},
    capacityOverrides: v2?.capacityOverrides || {}, lastExportAt: v2?.lastExportAt ?? null,
  };
}

// Rejoue une liste d'événements d'un axe pratique -> état (immuable, ordonné).
function replayPractice(events) {
  if (!events.length) return emptyPractice();
  let st = null;
  for (const e of events) st = applyPractice(st, e.grade, e.date);
  return st;
}

// v3 -> v4 : DÉTERMINISTE et NON DESTRUCTIVE.
// - journal préservé intégralement (evidenceType manquant -> 'legacy' = recall) ;
// - recall reconstruit en rejouant SES événements depuis le seed de niveau
//   (v3 mélangeait tous les axes dans un seul état FSRS : le rejeu nettoie) ;
// - exercise/problem construits depuis leurs propres événements ;
// - si aucun événement recall exploitable, on conserve l'état v3 comme
//   donnée héritée (source: 'legacy') sans inventer de précision.
export function migrateV3(v3) {
  const settings = { ...DEFAULT_SETTINGS, ...(v3?.settings || {}) };
  const log = Array.isArray(v3?.reviewLog) ? v3.reviewLog : [];
  const byChapter = new Map();
  for (const r of log) {
    if (r.chapterId == null) continue;
    if (!byChapter.has(r.chapterId)) byChapter.set(r.chapterId, []);
    byChapter.get(r.chapterId).push(r);
  }
  const chapters = (v3?.chapters || []).map((c) => {
    const initialLevel = c.initialLevel ?? closestLevel(c.difficulty ?? 5).key;
    const level = LEVELS.find((l) => l.key === initialLevel) || LEVELS[0];
    const oldMin = c.estimatedMinutes ?? settings.minutesPerChapter ?? 30;
    const minutes = {
      recall: Math.min(30, oldMin),
      exercise: oldMin,
      problem: Math.max(60, oldMin),
    };
    const events = (byChapter.get(c.id) || []).slice()
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const isRecall = (e) => { const t = e.evidenceType; return !t || t === 'recall' || t === 'legacy'; };
    const recallEvents = events.filter(isRecall);

    let recall;
    if (recallEvents.length) {
      const seed = levelSeed(level, settings);
      let rec = { stability: seed.stability, difficulty: seed.difficulty, lastReviewed: null };
      for (const e of recallEvents) rec = applyRecall(rec, initialLevel, e.grade, e.date);
      recall = { ...rec, source: 'replayed' };
    } else if (c.lastReviewed != null || c.stability != null) {
      recall = {
        stability: Math.max(S_MIN, c.stability ?? targetInterval(level.m, settings)),
        difficulty: clamp(c.difficulty ?? level.D, 1, 10),
        lastReviewed: c.lastReviewed ?? null, source: 'legacy',
      };
    } else {
      const seed = levelSeed(level, settings);
      recall = { stability: seed.stability, difficulty: seed.difficulty, lastReviewed: null, source: 'seed' };
    }
    return {
      id: c.id, subjectId: c.subjectId, name: c.name, initialLevel,
      recall,
      exercise: replayPractice(events.filter((e) => e.evidenceType === 'exercise')),
      problem: replayPractice(events.filter((e) => e.evidenceType === 'problem')),
      minutes,
    };
  });
  return {
    version: 4,
    subjects: v3?.subjects || [],
    chapters,
    exams: (v3?.exams || []).map((e) => ({ ...e, importance: e.importance ?? 'normal' })),
    settings,
    parallelLog: v3?.parallelLog || {},
    reviewLog: log.map((r) => ({ ...r, evidenceType: r.evidenceType ?? 'legacy' })),
    archivedReviews: v3?.archivedReviews || [],
    skips: v3?.skips || {},
    capacityOverrides: v3?.capacityOverrides || {},
    examDebriefs: v3?.examDebriefs || {},
    lastExportAt: v3?.lastExportAt ?? null,
  };
}

// S'assure qu'un état déjà v4 a tous les champs (idempotent, sans rejeu).
// `today` sert uniquement à l'hygiène (purge des vieux reports) — passer une
// date fixe dans les tests garde la fonction déterministe.
export function ensureV8(s, today = todayISO()) {
  const settings = { ...DEFAULT_SETTINGS, ...(s?.settings || {}) };
  const deleted = pruneTombstones(s.deleted, today);
  const exams = (Array.isArray(s.exams) ? s.exams : [])
    .filter((e) => !deleted.exams[e?.id])
    .map((e) => ({ ...e, importance: e.importance ?? 'normal' }));
  const examIds = new Set(exams.map((e) => e.id));
  const clampMinutes = (v, fallback) => (Number.isFinite(v)
    ? Math.round(clamp(v, IMPORT_BOUNDS.axisMinutes[0], IMPORT_BOUNDS.axisMinutes[1]))
    : fallback);
  // Un report ne concerne que « aujourd'hui » : les entrées plus vieilles
  // qu'hier sont du poids mort.
  const skips = Object.fromEntries(Object.entries(s.skips && typeof s.skips === 'object' ? s.skips : {})
    .filter(([, d]) => typeof d === 'string' && d >= addDays(today, -1)));
  const normalizedChapters = (Array.isArray(s.chapters) ? s.chapters : [])
    .filter((x) => !deleted.chapters[x?.id])
    .map((c) => {
      const initialLevel = c.initialLevel ?? closestLevel(c.recall?.difficulty ?? c.difficulty ?? 5).key;
      const level = LEVELS.find((l) => l.key === initialLevel) || LEVELS[0];
      const rec = c.recall || {};
      const reviewUnit = c.reviewUnit === true;
      const kind = reviewUnit ? 'resource' : (KIND_KEYS.includes(c.kind) ? c.kind : 'course');
      const position = reviewUnit ? null : normPosition(c.position);
      const positionUpdatedAt = isValidISODate(c.positionUpdatedAt)
        ? c.positionUpdatedAt : additionDateFromPosition(position);
      return {
        id: c.id, subjectId: c.subjectId, name: normPosition(c.name) || c.name, initialLevel,
        kind,
        axes: reviewUnit ? ['recall'] : normAxes(c.axes, kind),
        position,
        positionUpdatedAt,
        docs: reviewUnit ? [] : normDocs(c.docs),
        ...(reviewUnit ? {
          reviewUnit: true,
          parentChapterId: typeof c.parentChapterId === 'string' ? c.parentChapterId : null,
          introducedAt: isValidISODate(c.introducedAt) ? c.introducedAt : positionUpdatedAt,
        } : {}),
        recall: {
          stability: Math.max(S_MIN, rec.stability ?? targetInterval(level.m, settings)),
          difficulty: clamp(rec.difficulty ?? level.D, 1, 10),
          lastReviewed: rec.lastReviewed ?? null,
          source: rec.source ?? 'seed',
        },
        exercise: reviewUnit ? emptyPractice() : normPractice(c.exercise),
        problem: reviewUnit ? emptyPractice() : normPractice(c.problem),
        minutes: {
          recall: reviewUnit
            ? REVIEW_UNIT_MINUTES
            : clampMinutes(c.minutes?.recall, AXIS_MINUTES.recall),
          exercise: clampMinutes(c.minutes?.exercise, AXIS_MINUTES.exercise),
          problem: clampMinutes(c.minutes?.problem, AXIS_MINUTES.problem),
        },
      };
    });
  const parentIds = new Set(normalizedChapters.filter((c) => !isReviewUnit(c)).map((c) => c.id));
  return {
    version: 8,
    subjects: (Array.isArray(s.subjects) ? s.subjects : []).filter((x) => !deleted.subjects[x?.id]),
    chapters: normalizedChapters.filter((c) => !isReviewUnit(c)
      || (c.parentChapterId && c.introducedAt && parentIds.has(c.parentChapterId))),
    exams,
    settings,
    parallelLog: s.parallelLog && typeof s.parallelLog === 'object' ? s.parallelLog : {},
    reviewLog: Array.isArray(s.reviewLog) ? s.reviewLog : [],
    archivedReviews: Array.isArray(s.archivedReviews) ? s.archivedReviews : [],
    skips,
    capacityOverrides: s.capacityOverrides && typeof s.capacityOverrides === 'object' ? s.capacityOverrides : {},
    examDebriefs: Object.fromEntries(Object.entries(
      s.examDebriefs && typeof s.examDebriefs === 'object' ? s.examDebriefs : {},
    ).filter(([id]) => examIds.has(id))),
    deleted,
    syncMeta: s.syncMeta && typeof s.syncMeta === 'object' && s.syncMeta.deviceId
      ? {
        deviceId: String(s.syncMeta.deviceId),
        updatedAt: Number.isFinite(s.syncMeta.updatedAt) ? s.syncMeta.updatedAt : 0,
        rev: Number.isFinite(s.syncMeta.rev) ? s.syncMeta.rev : 0,
      }
      : null,
    lastExportAt: s.lastExportAt ?? null,
  };
}

// Alias temporaire pour les imports internes historiques ; tout état produit
// est néanmoins bien un état v8.
export const ensureV7 = ensureV8;
function normPractice(p) {
  if (!p || typeof p !== 'object') return emptyPractice();
  return {
    score: p.score == null ? null : clamp(p.score, 0, 1),
    attempts: Number.isFinite(p.attempts) ? p.attempts : 0,
    lastTested: p.lastTested ?? null,
    recentFails: Number.isFinite(p.recentFails) ? p.recentFails : 0,
  };
}

// v4 -> v5 : ajout des champs de synchronisation. Aucune donnée n'est touchée
// (un état v4 est un état v5 sans historique de suppression ni horodatage) —
// c'est ensureV7 qui pose les valeurs par défaut.
export function migrateV4(v4) {
  return { ...v4, version: 5, deleted: v4?.deleted ?? emptyDeleted(), syncMeta: v4?.syncMeta ?? null };
}

// v5 -> v6 : tout élément existant devient un « chapitre de cours » avec les
// trois axes — exactement son comportement actuel. Rien n'est perdu ni changé.
export function migrateV5(v5) {
  return {
    ...v5, version: 6,
    chapters: (v5?.chapters || []).map((c) => ({
      ...c, kind: c.kind ?? 'course', axes: normAxes(c.axes, c.kind ?? 'course'),
      position: normPosition(c.position),
    })),
  };
}

// v6 -> v7 : chaque élément reçoit une liste de documents vide. Aucune
// donnée existante n'est touchée.
export function migrateV6(v6) {
  return {
    ...v6, version: 7,
    chapters: (v6?.chapters || []).map((c) => ({ ...c, docs: normDocs(c.docs) })),
  };
}

// v7 -> v8 : un « Ajout du jj/mm/aaaa » déjà présent devient une unité de
// reprise. C'est la seule donnée que l'ancien schéma permet de reconstruire
// honnêtement ; les sections antérieures restent dans le PDF mais ne sont pas
// inventées dans CADENCE.
export function migrateV7(v7, today = todayISO()) {
  const settings = { ...DEFAULT_SETTINGS, ...(v7?.settings || {}) };
  const base = (v7?.chapters || []).map((c) => ({
    ...c,
    positionUpdatedAt: isValidISODate(c.positionUpdatedAt)
      ? c.positionUpdatedAt : additionDateFromPosition(c.position),
  }));
  let chapters = [...base];
  for (const chapter of base) {
    if (isReviewUnit(chapter)) continue;
    const introducedAt = additionDateFromPosition(chapter.position);
    if (!introducedAt || introducedAt > today) continue;
    const id = reviewUnitId(chapter.id, introducedAt);
    if (!chapters.some((c) => c.id === id)) {
      chapters.push(newReviewUnit(chapter, chapter.position, introducedAt, settings));
    }
  }
  return { ...v7, version: 8, chapters };
}

// Accepte v1 à v8 -> renvoie toujours un état v8 sain.
// Tout passe par ensureV8 (bornes + hygiène), y compris après migration.
export function normalize(s, today = todayISO()) {
  if (!s || typeof s !== 'object') return seedState();
  if (s.version === 8) return ensureV8(s, today);
  if (s.version === 7) return ensureV8(migrateV7(s, today), today);
  if (s.version === 6) return ensureV8(migrateV7(migrateV6(s), today), today);
  if (s.version === 5) return ensureV8(migrateV7(migrateV6(migrateV5(s)), today), today);
  if (s.version === 4) return ensureV8(migrateV7(migrateV6(migrateV5(migrateV4(s))), today), today);
  if (s.version === 3) return ensureV8(migrateV7(migrateV6(migrateV5(migrateV4(migrateV3(s)))), today), today);
  if (s.version === 2) return ensureV8(migrateV7(migrateV6(migrateV5(migrateV4(migrateV3(migrateV2(s))))), today), today);
  return ensureV8(migrateV7(migrateV6(migrateV5(migrateV4(migrateV3(migrateV2(migrateV1(s)))))), today), today);
}

// `opts` : { kind, axes, position } — par défaut, un chapitre de cours complet.
export function newChapter(subjectId, name, level, s, opts = {}) {
  const lv = level || LEVELS[0];
  const seed = levelSeed(lv, s);
  const kind = KIND_KEYS.includes(opts.kind) ? opts.kind : 'course';
  return {
    id: uid(), subjectId, name, initialLevel: lv.key,
    kind, axes: normAxes(opts.axes, kind), position: normPosition(opts.position),
    docs: normDocs(opts.docs),
    recall: { stability: seed.stability, difficulty: seed.difficulty, lastReviewed: null, source: 'seed' },
    exercise: emptyPractice(),
    problem: emptyPractice(),
    minutes: { ...AXIS_MINUTES },
  };
}

// Ressource : même moteur qu'un chapitre, mais seuls les axes déclarés
// s'appliquent, et elle sert surtout à être reprise là où on s'est arrêté.
export function newResource(subjectId, name, axes, s, level) {
  return newChapter(subjectId, name, level || LEVELS[0], s, { kind: 'resource', axes });
}

export function normAxes(axes, kind) {
  const declared = Array.isArray(axes) ? axes.filter((a) => AXIS_KEYS.includes(a)) : [];
  const kept = AXIS_KEYS.filter((a) => declared.includes(a));
  return kept.length ? kept : [...(KINDS[kind]?.axes ?? AXIS_KEYS)];
}

// Point de reprise : texte court, nettoyé et borné. `null` quand vide — c'est
// un repère (« p. 47 », « unité 5 »), pas un carnet de notes.
export function normPosition(value) {
  if (typeof value !== 'string') return null;
  return value.replace(/\s+/g, ' ').trim().slice(0, POSITION_MAX) || null;
}

// Le récapitulatif quotidien utilise « Ajout du jj/mm/aaaa — notion ». La
// date est l'identifiant stable de la portion : corriger son libellé le même
// jour met à jour la même unité au lieu d'en créer plusieurs.
export function additionDateFromPosition(value) {
  const position = normPosition(value);
  const match = position?.match(/\bAjout du\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i);
  if (!match) return null;
  const iso = `${match[3]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[1])).padStart(2, '0')}`;
  return isValidISODate(iso) ? iso : null;
}

export function reviewUnitId(parentChapterId, introducedAt) {
  return `reprise:${parentChapterId}:${introducedAt}`;
}

export function newReviewUnit(parent, label, introducedAt, settings) {
  const position = normPosition(label);
  const date = isValidISODate(introducedAt) ? introducedAt : todayISO();
  const unit = newChapter(parent.subjectId, position || parent.name, LEVELS[0], settings, {
    kind: 'resource', axes: ['recall'],
  });
  return {
    ...unit,
    id: reviewUnitId(parent.id, date),
    name: position || parent.name,
    reviewUnit: true,
    parentChapterId: parent.id,
    introducedAt: date,
    position: null,
    positionUpdatedAt: date,
    docs: [],
    minutes: { ...unit.minutes, recall: REVIEW_UNIT_MINUTES },
  };
}

// Crée la portion liée à un nouvel « Ajout du … », ou corrige son libellé si
// elle existe déjà. Un point libre (« p. 47 ») reste un simple signet et ne
// déclenche aucune fausse révision.
export function upsertReviewUnit(chapters, parentChapterId, value, settings) {
  const label = normPosition(value);
  const introducedAt = additionDateFromPosition(label);
  const parent = (chapters || []).find((c) => c.id === parentChapterId && !isReviewUnit(c));
  if (!parent || !label || !introducedAt) return chapters;
  const id = reviewUnitId(parentChapterId, introducedAt);
  const existing = (chapters || []).find((c) => c.id === id);
  if (!existing) return [...chapters, newReviewUnit(parent, label, introducedAt, settings)];
  return chapters.map((c) => (c.id === id ? {
    ...c,
    name: label,
    subjectId: parent.subjectId,
    parentChapterId,
    introducedAt,
    reviewUnit: true,
  } : c));
}

export function seedState() {
  const core = [
    ['Algèbre linéaire 2', '#7c9cf5'],
    ['Outils Mathématiques 2', '#a78bfa'],
    ['Optique ondulatoire', '#38bdf8'],
    ['Mécanique du solide', '#fbbf24'],
    ['Électromagnétisme 1', '#f472b6'],
    ['Atomistique 2', '#34d399'],
  ].map(([name, color]) => ({ id: uid(), name, color, type: 'core' }));
  const parallel = [
    { id: uid(), name: 'Anglais / TOEIC', color: '#5eead4', type: 'parallel', weeklyFloor: 4 },
    { id: uid(), name: 'Anki', color: '#fca5a5', type: 'parallel', weeklyFloor: 6 },
  ];
  return {
    version: 8, subjects: [...core, ...parallel], chapters: [], exams: [],
    settings: { ...DEFAULT_SETTINGS }, parallelLog: {}, reviewLog: [],
    archivedReviews: [], skips: {}, capacityOverrides: {}, examDebriefs: {},
    deleted: emptyDeleted(), syncMeta: null,
    lastExportAt: null,
  };
}

export function stripChapterIds(exams, ids) {
  const set = new Set(ids);
  return exams.map((e) => ({ ...e, chapterIds: (e.chapterIds || []).filter((cid) => !set.has(cid)) }));
}

// Recalibrer : le chapitre repart du niveau choisi (tous axes réinitialisés),
// et son historique est ARCHIVÉ (jamais supprimé). Confirmation gérée en amont.
export function recalibrateState(state, chapterId, levelKey) {
  const level = LEVELS.find((l) => l.key === levelKey);
  if (!level) return state;
  const moved = (state.reviewLog || []).filter((r) => r.chapterId === chapterId);
  const seed = levelSeed(level, state.settings);
  return {
    ...state,
    chapters: state.chapters.map((c) => (c.id === chapterId ? {
      ...c, initialLevel: level.key,
      recall: { stability: seed.stability, difficulty: seed.difficulty, lastReviewed: null, source: 'seed' },
      exercise: emptyPractice(), problem: emptyPractice(),
    } : c)),
    reviewLog: (state.reviewLog || []).filter((r) => r.chapterId !== chapterId),
    archivedReviews: [...(state.archivedReviews || []), ...moved],
  };
}

export function makeStore() {
  const wrap = (storage, kind) => ({
    kind,
    persistent: true,
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: (key) => storage.removeItem(key),
  });
  try {
    if (typeof window !== 'undefined' && window.storage &&
        typeof window.storage.getItem === 'function') return wrap(window.storage, 'window.storage');
  } catch (e) { /* ignore */ }
  try {
    if (typeof localStorage !== 'undefined') {
      const k = '__cadence_probe__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return wrap(localStorage, 'localStorage');
    }
  } catch (e) { /* ignore */ }
  const mem = {};
  return {
    kind: 'memory',
    persistent: false,
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: (k) => { delete mem[k]; },
  };
}
