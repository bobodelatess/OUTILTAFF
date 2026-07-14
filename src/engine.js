/*
 * Moteur CADENCE — fonctions pures, sans React.
 *
 * Contenu : modèle de rappel inspiré des équations FSRS-4.5 (niveau chapitre),
 * couche examens (pression multiplicative modulée par l'importance), plan du
 * jour en minutes, prévision de charge, préparation d'examen, migrations de
 * schéma (v1 -> v2 -> v3) et validation d'import.
 *
 * Honnêteté du modèle : R(t) est une ESTIMATION DE RAPPEL du chapitre, pas
 * une probabilité de réussir un examen. Les poids FSRS utilisés sont les
 * poids par défaut publiés — non personnalisés.
 *
 * Schéma v3
 *   Subject  = { id, name, color, type: 'core'|'parallel', weeklyFloor? }
 *   Chapter  = { id, subjectId, name, difficulty: 1..10, stability: jours,
 *                lastReviewed: ISODate|null, initialLevel: 'new'|'fragile'|'ok'|'solid',
 *                estimatedMinutes: 15|30|60|90 }
 *   Exam     = { id, subjectId, name, date: ISODate, chapterIds: string[],
 *                importance: 'minor'|'normal'|'major' }
 *   Review   = { id, chapterId, date, grade: 1..4, evidenceType,
 *                before: { stability, difficulty, lastReviewed },
 *                after:  { stability, difficulty } }
 *   State    = { version: 3, subjects, chapters, exams, settings, parallelLog,
 *                reviewLog, archivedReviews, skips, capacityOverrides,
 *                lastExportAt }
 */

/* ================================================================== *
 *  Constantes
 * ================================================================== */

export const STORAGE_KEY = 'cadence.v2'; // clé stable ; la version vit DANS l'état
export const LEGACY_KEY = 'cadence.v1';
export const BACKUP_KEY = 'cadence.backups';
export const SCHEMA_VERSION = 3;

export const DEFAULT_SETTINGS = {
  requestRetention: 0.9, // rétention cible : on revoit quand R retombe à ce niveau
  subjectsPerDay: 3,     // capacité par défaut : matières par jour
  sessionHours: 2,       // durée d'une séance par matière
  minutesPerChapter: 30, // durée par défaut d'un NOUVEAU chapitre
  maxExamPressure: 5,
  pressureHorizon: 35,
  examModeThreshold: 21,
  minInterval: 2,        // stabilité initiale « Jamais vu »
  maxInterval: 30,       // stabilité initiale « Solide »
  simpleMode: true,
};

// Notes génériques (couleurs stables) ; les libellés affichés dépendent du
// type de preuve (EVIDENCE) — la note décrit le RÉSULTAT D'UN TEST sans
// correction sous les yeux, jamais le temps passé ni l'impression.
export const GRADES = {
  1: { key: 1, label: 'Échec', color: '#f87171' },
  2: { key: 2, label: 'Difficile', color: '#fbbf24' },
  3: { key: 3, label: 'Réussi', color: '#34d399' },
  4: { key: 4, label: 'Facile', color: '#38bdf8' },
};

// Types de preuve : comment le chapitre a été testé.
export const EVIDENCE = {
  recall: {
    key: 'recall', label: 'Rappel sans support', short: 'Rappel',
    hint: 'restituer de tête (définitions, formules, plan du cours)',
    grades: { 1: 'Oublié', 2: 'Avec effort', 3: 'Correct', 4: 'Immédiat' },
  },
  exercise: {
    key: 'exercise', label: 'Exercice standard', short: 'Exercice',
    hint: 'exercice type, sans regarder cours ni corrigé',
    grades: { 1: 'Bloqué', 2: 'Avec aide', 3: 'Autonome', 4: 'Autonome et propre' },
  },
  problem: {
    key: 'problem', label: 'Problème / annale', short: 'Annale',
    hint: 'problème complet ou annale, conditions réelles',
    grades: { 1: 'Bloqué', 2: 'Partiel', 3: 'Résolu', 4: 'Résolu proprement dans le temps' },
  },
  legacy: {
    key: 'legacy', label: 'Ancienne révision', short: 'Ancien',
    hint: 'note enregistrée avant l’introduction des types de preuve',
    grades: { 1: 'Oublié', 2: 'Difficile', 3: 'Bien', 4: 'Facile' },
  },
};

export function gradeLabel(evidenceType, grade) {
  return EVIDENCE[evidenceType]?.grades?.[grade] ?? GRADES[grade]?.label ?? String(grade);
}

// Niveaux nommés pour calibrer un chapitre sans historique.
export const LEVELS = [
  { key: 'new', label: 'Jamais vu', m: 0, D: 8.5 },
  { key: 'fragile', label: 'Fragile', m: 33, D: 6.8 },
  { key: 'ok', label: 'Moyen', m: 66, D: 5.0 },
  { key: 'solid', label: 'Solide', m: 100, D: 3.2 },
];

// Urgence initiale d'un chapitre JAMAIS testé, selon son niveau déclaré.
// « Jamais vu » est très urgent ; « Solide » peut attendre la moitié de son
// intervalle. C'est ce qui différencie réellement les niveaux au départ.
export const INITIAL_URGENCY = { new: 2.2, fragile: 1.6, ok: 1.0, solid: 0.5 };

export function initialUrgencyOf(chapter) {
  return INITIAL_URGENCY[chapter?.initialLevel] ?? 2.2;
}

// Importance d'une épreuve : module la pression d'examen SANS l'exploser.
// mult_final = 1 + (mult_base − 1) × w  avec w ∈ {0.6, 1, 1.4}.
// Borne : mult_base ≤ maxExamPressure ⇒ mult_final ≤ 1 + (maxExamPressure−1)×1.4
// (par défaut : ≤ 6.6).
export const IMPORTANCE = {
  minor: { key: 'minor', label: 'Mineure', w: 0.6 },
  normal: { key: 'normal', label: 'Normale', w: 1.0 },
  major: { key: 'major', label: 'Majeure', w: 1.4 },
};

// Tailles proposées pour un chapitre (minutes de travail estimées).
export const CHAPTER_SIZES = [15, 30, 60, 90];

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

/* ================================================================== *
 *  Modèle de rappel (équations FSRS-4.5, poids par défaut publiés)
 * ================================================================== */

export const FSRS_W = [
  0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031,
  1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755,
];

const DECAY = -0.5;
const FACTOR = Math.pow(0.9, 1 / DECAY) - 1; // = 19/81, calé pour R(S) = 90 %
const S_MIN = 0.2;
const S_MAX = 730;

// Rappel estimé après t jours (loi de puissance). Estimation, pas mesure.
export function retrievability(t, S) {
  if (S <= 0) return 0;
  return Math.pow(1 + FACTOR * Math.max(0, t) / S, DECAY);
}

// Intervalle qui ramène le rappel estimé à la rétention cible.
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

// Applique une note. Jamais testé : retard supposé proportionnel au niveau
// initial (cohérent avec l'urgence initiale).
export function applyGrade(chapter, grade, today) {
  const S = chapter.stability;
  const D = chapter.difficulty ?? 5;
  const since = chapter.lastReviewed ? daysBetween(chapter.lastReviewed, today) : null;
  const elapsed = since != null ? since : S * initialUrgencyOf(chapter);
  const R = retrievability(elapsed, S);
  const stability = grade === 1
    ? stabilityAfterFailure(S, D, R)
    : stabilityAfterSuccess(S, D, R, grade);
  return { stability, difficulty: nextDifficulty(D, grade), R };
}

// Stabilité initiale d'un niveau (interpolation géométrique min..max).
export function targetInterval(m, s) {
  const mm = clamp(m, 0, 100);
  return s.minInterval * Math.pow(s.maxInterval / s.minInterval, mm / 100);
}
export function levelSeed(level, s) {
  return { difficulty: level.D, stability: targetInterval(level.m, s), initialLevel: level.key };
}
export function closestLevel(D) {
  let best = LEVELS[0];
  for (const l of LEVELS) if (Math.abs(l.D - D) < Math.abs(best.D - D)) best = l;
  return best;
}

/* ================================================================== *
 *  Couche examens & priorité
 * ================================================================== */

// Multiplicateur d'examen : ≈1 loin de l'épreuve, montée quadratique jusqu'au
// jour J, modulée par l'importance (cf. IMPORTANCE — borné, jamais explosif).
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

// Priorité + décomposition transparente d'un chapitre.
export function chapterMetrics(chapter, exams, s, today) {
  const S = chapter.stability;
  const ti = Math.max(0.5, optimalInterval(S, s.requestRetention));
  const since = chapter.lastReviewed ? daysBetween(chapter.lastReviewed, today) : null;
  const elapsed = since != null ? since : ti * initialUrgencyOf(chapter);
  const urgency = Math.max(0, elapsed) / ti;
  const R = since != null ? retrievability(since, S) : null;
  const { factor, exam, examDays } = chapterExamFactor(chapter, exams, s, today);
  const dueIn = Math.max(0, Math.round(ti - elapsed));
  return {
    ti, stability: S, difficulty: chapter.difficulty ?? 5,
    since, R, urgency, factor, exam, examDays, dueIn,
    priority: urgency * factor,
  };
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

// Raison en langage clair : pourquoi ce chapitre maintenant.
export function reasonPhrase(m) {
  if (m.exam && m.examDays != null) {
    const d = m.examDays;
    const when = d <= 0 ? 'aujourd’hui' : d === 1 ? 'demain' : `dans ${d} j`;
    return { text: `Examen ${m.exam.name} ${when}`, tone: 'exam' };
  }
  if (m.urgency >= 1) {
    if (m.since == null) return { text: 'Jamais testé', tone: 'late' };
    const over = Math.round(m.since - m.ti);
    return { text: over <= 0 ? 'À retester maintenant' : `En retard de ${over} j`, tone: 'late' };
  }
  const inDays = Math.max(0, Math.round(m.ti - (m.since ?? m.ti * (m.urgency ?? 0))));
  return { text: inDays <= 1 ? 'Pas urgent' : `Pas urgent · à retester dans ~${inDays} j`, tone: 'calm' };
}

// Pertinence : vaut-il la peine de retester ce chapitre AUJOURD'HUI ?
export function isWorthReviewing(m) {
  return m.urgency >= 0.75 || m.factor > 1.15;
}

/* ================================================================== *
 *  Capacité & plan du jour (en minutes)
 * ================================================================== */

// Capacité par défaut d'une journée (minutes), dérivée des réglages.
export function defaultDailyMinutes(s) {
  return Math.round(s.subjectsPerDay * s.sessionHours * 60);
}

// Capacité réelle du jour : dérogation datée sinon défaut.
export function todayCapacityMinutes(s, capacityOverrides, today) {
  const o = capacityOverrides?.[today];
  return (o == null ? defaultDailyMinutes(s) : Math.max(0, o));
}

export function chapterMinutes(ch, s) {
  return ch.estimatedMinutes ?? s?.minutesPerChapter ?? 30;
}

// Score robuste d'une matière : priorité max + moyenne des 3 meilleures.
// (Jamais la somme brute : une matière saucissonnée en beaucoup de petits
// chapitres peu prioritaires ne doit pas dominer une matière urgente.)
export function subjectScore(priorities) {
  if (!priorities.length) return 0;
  const top = priorities.slice(0, 3);
  return priorities[0] + top.reduce((a, b) => a + b, 0) / top.length;
}

// Plan du jour : au plus `subjectsPerDay` matières (score robuste), chaque
// séance remplie EN MINUTES (≤ sessionMinutes), le tout borné par
// `totalMinutes` (capacité réelle du jour). totalMinutes = 0 ⇒ pas de plan.
export function planDay(ranked, subjects, opts) {
  const { subjectsPerDay, sessionMinutes, totalMinutes, settings } = opts;
  if (!totalMinutes || totalMinutes <= 0) return [];
  const core = new Map(subjects.filter((s) => s.type === 'core').map((s) => [s.id, s]));
  const bySubject = new Map();
  for (const ch of ranked) { // ranked déjà trié par priorité décroissante
    if (!core.has(ch.subjectId)) continue;
    if (!bySubject.has(ch.subjectId)) bySubject.set(ch.subjectId, []);
    bySubject.get(ch.subjectId).push(ch);
  }
  const candidates = [];
  for (const [sid, chs] of bySubject) {
    candidates.push({
      subject: core.get(sid), all: chs,
      score: subjectScore(chs.map((c) => c.priority)),
    });
  }
  candidates.sort((a, b) => b.score - a.score);

  const sessions = [];
  let remainingTotal = totalMinutes;
  for (const cand of candidates) {
    if (sessions.length >= Math.max(1, subjectsPerDay)) break;
    if (remainingTotal <= 0) break;
    const budget = Math.min(sessionMinutes, remainingTotal);
    const chapters = [];
    let minutes = 0;
    for (const ch of cand.all) {
      const m = chapterMinutes(ch, settings);
      // Strict : on ne dépasse JAMAIS le budget (ni séance, ni total du jour).
      if (m <= budget - minutes) {
        chapters.push(ch);
        minutes += m;
        if (minutes >= budget) break;
      }
    }
    if (!chapters.length) continue; // rien ne tient dans le temps restant
    remainingTotal -= minutes;
    sessions.push({ subject: cand.subject, chapters, minutes, score: cand.score, total: cand.all.length });
  }
  return sessions;
}

// Charge de croisière : chapitres/jour qu'exige la rétention cible (Σ 1/I).
export function cruiseLoad(chapters, s) {
  let sum = 0;
  for (const c of chapters) {
    sum += 1 / Math.max(1, optimalInterval(c.stability, s.requestRetention));
  }
  return sum;
}

// Calibration : taux de réussite observé vs rappel prévu au moment des tests.
export function observedRetention(reviewLog) {
  const entries = (reviewLog || []).filter((r) => r.before && r.before.lastReviewed);
  if (!entries.length) return { n: 0, rate: null, predicted: null };
  let ok = 0, pred = 0;
  for (const r of entries) {
    if (r.grade > 1) ok++;
    pred += retrievability(daysBetween(r.before.lastReviewed, r.date), r.before.stability);
  }
  return { n: entries.length, rate: ok / entries.length, predicted: pred / entries.length };
}

// Prévision de charge : chapitres arrivant à échéance par jour.
export function forecastDue(chapters, s, today, horizon = 28) {
  const map = {};
  for (const c of chapters) {
    const interval = Math.max(1, Math.round(optimalInterval(c.stability, s.requestRetention)));
    const since = c.lastReviewed ? daysBetween(c.lastReviewed, today) : null;
    const elapsed = since != null ? since : interval * initialUrgencyOf(c);
    const dueIn = Math.max(0, Math.round(interval - elapsed));
    if (dueIn <= horizon) {
      const iso = addDays(today, dueIn);
      map[iso] = (map[iso] || 0) + 1;
    }
  }
  return map;
}

// Préparation d'examen : rappel ESTIMÉ le jour J (sans nouvelle révision
// d'ici là) pour les chapitres DÉJÀ TESTÉS ; les chapitres jamais testés sont
// listés À PART — on ne les mélange pas silencieusement à la moyenne.
export function examReadiness(exam, chapters, s, today) {
  const j = daysBetween(today, exam.date);
  if (j < 0) return null;
  const covered = chapters.filter((c) => (exam.chapterIds || []).includes(c.id));
  if (!covered.length) return null;
  const untested = covered.filter((c) => !c.lastReviewed);
  const tested = covered
    .filter((c) => c.lastReviewed)
    .map((c) => ({ chapter: c, projR: retrievability(daysBetween(c.lastReviewed, exam.date), c.stability) }))
    .sort((a, b) => a.projR - b.projR);
  const avgR = tested.length
    ? tested.reduce((a, x) => a + x.projR, 0) / tested.length
    : null;
  return {
    days: j, avgR,
    per: tested, untested,
    testedCount: tested.length, coveredCount: covered.length,
    weak: tested.filter((x) => x.projR < 0.7).length,
  };
}

/* ================================================================== *
 *  Sauvegarde locale, validation d'import, migrations
 * ================================================================== */

// Instantanés LOCAUX (même appareil, même stockage — pas une sauvegarde
// externe) : garde les `keep` plus récents (≤ today).
export function pruneBackups(backups, today, keep = 7) {
  const dates = Object.keys(backups || {})
    .filter((d) => d <= today)
    .sort()
    .slice(-keep);
  const out = {};
  for (const d of dates) out[d] = backups[d];
  return out;
}

// Validation stricte d'un import JSON : structure minimale reconnaissable.
export function validateImport(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'Le fichier ne contient pas un objet JSON CADENCE.' };
  }
  if (!Array.isArray(obj.subjects)) {
    return { ok: false, error: 'Structure incompatible : « subjects » manquant ou invalide.' };
  }
  if (obj.chapters != null && !Array.isArray(obj.chapters)) {
    return { ok: false, error: 'Structure incompatible : « chapters » doit être une liste.' };
  }
  if (obj.exams != null && !Array.isArray(obj.exams)) {
    return { ok: false, error: 'Structure incompatible : « exams » doit être une liste.' };
  }
  for (const su of obj.subjects) {
    if (!su || typeof su !== 'object' || typeof su.name !== 'string') {
      return { ok: false, error: 'Structure incompatible : une matière est mal formée.' };
    }
  }
  for (const c of obj.chapters || []) {
    if (!c || typeof c !== 'object' || typeof c.name !== 'string' || c.subjectId == null) {
      return { ok: false, error: 'Structure incompatible : un chapitre est mal formé.' };
    }
  }
  return { ok: true };
}

// v1 -> v2 : mastery (0..100) devient difficulté ; stabilité conservée/dérivée.
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
    version: 2,
    subjects: v1?.subjects || [],
    chapters,
    exams: v1?.exams || [],
    settings,
    parallelLog: v1?.parallelLog || {},
    reviewLog: [],
    skips: {},
  };
}

// v2 -> v3 : rien n'est perdu. Ajouts :
// - chapitres : initialLevel (déduit de la difficulté), estimatedMinutes ;
// - épreuves : importance 'normal' ;
// - journal : evidenceType 'legacy' sur les anciennes révisions ;
// - état : archivedReviews, capacityOverrides, lastExportAt.
export function migrateV2(v2) {
  const settings = { ...DEFAULT_SETTINGS, ...(v2?.settings || {}) };
  return {
    version: 3,
    subjects: v2?.subjects || [],
    chapters: (v2?.chapters || []).map((c) => ({
      ...c,
      difficulty: clamp(c.difficulty ?? 5, 1, 10),
      stability: Math.max(S_MIN, c.stability ?? 2),
      lastReviewed: c.lastReviewed ?? null,
      initialLevel: c.initialLevel ?? closestLevel(c.difficulty ?? 5).key,
      estimatedMinutes: c.estimatedMinutes ?? settings.minutesPerChapter ?? 30,
    })),
    exams: (v2?.exams || []).map((e) => ({ ...e, importance: e.importance ?? 'normal' })),
    settings,
    parallelLog: v2?.parallelLog || {},
    reviewLog: (v2?.reviewLog || []).map((r) => ({ ...r, evidenceType: r.evidenceType ?? 'legacy' })),
    archivedReviews: v2?.archivedReviews || [],
    skips: v2?.skips || {},
    capacityOverrides: v2?.capacityOverrides || {},
    lastExportAt: v2?.lastExportAt ?? null,
  };
}

// Normalisation : accepte v1, v2 ou v3 et renvoie toujours un état v3 sain.
export function normalize(s) {
  if (!s || typeof s !== 'object') return seedState();
  if (s.version === 3) return migrateV2(s); // ré-applique les défauts champ à champ
  if (s.version === 2) return migrateV2(s);
  return migrateV2(migrateV1(s));
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
    version: 3,
    subjects: [...core, ...parallel],
    chapters: [],
    exams: [],
    settings: { ...DEFAULT_SETTINGS },
    parallelLog: {},
    reviewLog: [],
    archivedReviews: [],
    skips: {},
    capacityOverrides: {},
    lastExportAt: null,
  };
}

export function stripChapterIds(exams, ids) {
  const set = new Set(ids);
  return exams.map((e) => ({
    ...e,
    chapterIds: (e.chapterIds || []).filter((cid) => !set.has(cid)),
  }));
}

// Recalibrer un chapitre : nouveau niveau, plus de date de test, historique
// ARCHIVÉ (pas supprimé) — aucun état contradictoire entre niveau, date et
// journal. La confirmation utilisateur est gérée par l'appelant.
export function recalibrateState(state, chapterId, levelKey) {
  const level = LEVELS.find((l) => l.key === levelKey);
  if (!level) return state;
  const moved = (state.reviewLog || []).filter((r) => r.chapterId === chapterId);
  return {
    ...state,
    chapters: state.chapters.map((c) => (c.id === chapterId
      ? { ...c, ...levelSeed(level, state.settings), lastReviewed: null }
      : c)),
    reviewLog: (state.reviewLog || []).filter((r) => r.chapterId !== chapterId),
    archivedReviews: [...(state.archivedReviews || []), ...moved],
  };
}

// Stockage : window.storage -> localStorage -> mémoire (repli gracieux).
export function makeStore() {
  try {
    if (typeof window !== 'undefined' && window.storage &&
        typeof window.storage.getItem === 'function') return window.storage;
  } catch (e) { /* ignore */ }
  try {
    if (typeof localStorage !== 'undefined') {
      const k = '__cadence_probe__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return localStorage;
    }
  } catch (e) { /* ignore */ }
  const mem = {};
  return {
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: (k) => { delete mem[k]; },
  };
}
