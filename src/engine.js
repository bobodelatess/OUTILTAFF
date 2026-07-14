/*
 * Moteur CADENCE — fonctions pures, sans React.
 *
 * v4 : trois axes de preuve INDÉPENDANTS par chapitre.
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
 * Schéma v4
 *   Subject  = { id, name, color, type: 'core'|'parallel', weeklyFloor? }
 *   Chapter  = { id, subjectId, name, initialLevel,
 *                recall:   { stability, difficulty, lastReviewed, source? },
 *                exercise: { score: 0..1|null, attempts, lastTested, recentFails },
 *                problem:  { score: 0..1|null, attempts, lastTested, recentFails },
 *                minutes:  { recall, exercise, problem } }
 *   Exam     = { id, subjectId, name, date, chapterIds[], importance }
 *   Review   = { id, chapterId, date, grade: 1..4, evidenceType,
 *                before, after }               // before/after = snapshot de l'axe
 *   State    = { version: 4, subjects, chapters, exams, settings, parallelLog,
 *                reviewLog, archivedReviews, skips, capacityOverrides, lastExportAt }
 */

/* ================================================================== *
 *  Constantes
 * ================================================================== */

export const STORAGE_KEY = 'cadence.v2'; // clé stable ; la version vit DANS l'état
export const LEGACY_KEY = 'cadence.v1';
export const BACKUP_KEY = 'cadence.backups';
export const SCHEMA_VERSION = 4;
export const KNOWN_VERSIONS = [1, 2, 3, 4];

export const DEFAULT_SETTINGS = {
  requestRetention: 0.9, // rétention cible du rappel
  subjectsPerDay: 3,     // capacité par défaut : matières par jour
  sessionHours: 2,       // durée d'une séance par matière (défaut)
  minutesPerChapter: 30, // durée héritée (compat) — v4 utilise `minutes` par axe
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

function argmaxAxis(risks) {
  let best = 'recall';
  for (const k of AXIS_KEYS) if (risks[k] > risks[best]) best = k;
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
  const dominant = argmaxAxis(risks);
  const { factor, exam, examDays } = chapterExamFactor(chapter, exams, s, today);
  const baseRisk = risks[dominant];
  const priority = baseRisk * factor;
  return {
    risks, dominant, baseRisk, factor, exam, examDays, priority,
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
// constat (note d'axe problème datée du jour de l'épreuve ou après) existe déjà.
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
          && evidenceAxis(r.evidenceType) === 'problem' && r.date >= ex.date),
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
export function reasonPhrase(m) {
  const axis = m.dominant;
  const examSoon = m.exam && m.examDays != null && m.factor > 1.15;
  if (axis === 'recall') {
    if (!m.recall.tested) return { text: 'cours jamais testé', tone: 'late', axis };
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
  const untestedRecall = covered.filter((c) => !c.recall.lastReviewed);
  const tested = covered
    .filter((c) => c.recall.lastReviewed)
    .map((c) => ({ chapter: c, projR: retrievability(daysBetween(c.recall.lastReviewed, exam.date), c.recall.stability) }))
    .sort((a, b) => a.projR - b.projR);
  const avgR = tested.length ? tested.reduce((a, x) => a + x.projR, 0) / tested.length : null;
  const cov = (axis) => {
    const testedN = covered.filter((c) => c[axis]?.attempts > 0).length;
    return { tested: testedN, total: covered.length, untested: covered.length - testedN };
  };
  const covRecall = () => {
    const testedN = covered.filter((c) => c.recall?.lastReviewed).length;
    return { tested: testedN, total: covered.length, untested: covered.length - testedN };
  };
  return {
    days: j, avgR, per: tested, untested: untestedRecall,
    testedCount: tested.length, coveredCount: covered.length,
    weak: tested.filter((x) => x.projR < 0.7).length,
    coverage: { recall: covRecall(), exercise: cov('exercise'), problem: cov('problem') },
  };
}

// Synthèse par axe sur un ensemble de chapitres (indicateurs honnêtes).
export function axisSummary(chapters, s, today) {
  const out = { recall: { tested: 0, total: chapters.length, sum: 0 },
    exercise: { tested: 0, total: chapters.length, sum: 0 },
    problem: { tested: 0, total: chapters.length, sum: 0 } };
  for (const c of chapters) {
    const rec = recallInfo(c, s, today);
    if (rec.tested) { out.recall.tested++; out.recall.sum += rec.R; }
    if (c.exercise?.attempts > 0) { out.exercise.tested++; out.exercise.sum += c.exercise.score; }
    if (c.problem?.attempts > 0) { out.problem.tested++; out.problem.sum += c.problem.score; }
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

// Validation STRICTE avant tout remplacement. Renvoie { ok, errors: [...] }.
// N'altère jamais l'état existant : c'est à l'appelant de refuser si !ok.
export function validateImport(obj) {
  const errors = [];
  const push = (e) => { if (errors.length < 20) errors.push(e); };

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['Le fichier ne contient pas un objet JSON CADENCE.'] };
  }
  if (obj.version != null && !KNOWN_VERSIONS.includes(obj.version)) {
    push(`Version de schéma inconnue : ${obj.version}.`);
  }
  if (!Array.isArray(obj.subjects)) push('« subjects » manquant ou n’est pas une liste.');
  if (obj.chapters != null && !Array.isArray(obj.chapters)) push('« chapters » doit être une liste.');
  if (obj.exams != null && !Array.isArray(obj.exams)) push('« exams » doit être une liste.');
  if (obj.reviewLog != null && !Array.isArray(obj.reviewLog)) push('« reviewLog » doit être une liste.');
  if (errors.length) return { ok: false, errors };

  const subjectIds = new Set();
  for (const su of obj.subjects) {
    if (!su || typeof su !== 'object') { push('Une matière n’est pas un objet.'); continue; }
    if (typeof su.id !== 'string' || !su.id) push(`Matière sans identifiant valide (« ${su.name ?? '?'} »).`);
    else if (subjectIds.has(su.id)) push(`Identifiant de matière dupliqué : ${su.id}.`);
    else subjectIds.add(su.id);
    if (typeof su.name !== 'string') push('Une matière n’a pas de nom.');
    if (su.type != null && su.type !== 'core' && su.type !== 'parallel') push(`Type de matière invalide : ${su.type}.`);
    if (su.weeklyFloor != null && !(Number.isFinite(su.weeklyFloor)
      && su.weeklyFloor >= IMPORT_BOUNDS.weeklyFloor[0] && su.weeklyFloor <= IMPORT_BOUNDS.weeklyFloor[1])) {
      push(`Matière « ${su.name ?? su.id} » : minimum hebdo hors bornes.`);
    }
  }

  const chapterIds = new Set();
  for (const c of obj.chapters || []) {
    if (!c || typeof c !== 'object') { push('Un chapitre n’est pas un objet.'); continue; }
    if (typeof c.id !== 'string' || !c.id) push(`Chapitre sans identifiant valide (« ${c.name ?? '?'} »).`);
    else if (chapterIds.has(c.id)) push(`Identifiant de chapitre dupliqué : ${c.id}.`);
    else chapterIds.add(c.id);
    if (typeof c.name !== 'string') push('Un chapitre n’a pas de nom.');
    if (!subjectIds.has(c.subjectId)) push(`Chapitre « ${c.name ?? c.id} » : matière introuvable (${c.subjectId}).`);
    if (c.initialLevel != null && !LEVELS.some((l) => l.key === c.initialLevel)) {
      push(`Chapitre « ${c.name ?? c.id} » : niveau initial inconnu (${c.initialLevel}).`);
    }
    for (const ax of AXIS_KEYS) {
      const a = c[ax];
      if (a && typeof a === 'object') {
        if (a.stability != null && (!Number.isFinite(a.stability) || a.stability < 0)) push(`Chapitre « ${c.name} » : stability invalide.`);
        if (a.score != null && (!Number.isFinite(a.score) || a.score < 0 || a.score > 1)) push(`Chapitre « ${c.name} » : score ${ax} hors [0,1].`);
        if (a.lastReviewed != null && !isValidISODate(a.lastReviewed)) push(`Chapitre « ${c.name} » : date rappel invalide.`);
        if (a.lastTested != null && !isValidISODate(a.lastTested)) push(`Chapitre « ${c.name} » : date ${ax} invalide.`);
      }
      const mn = c.minutes?.[ax];
      if (mn != null && !(Number.isFinite(mn) && mn >= IMPORT_BOUNDS.axisMinutes[0] && mn <= IMPORT_BOUNDS.axisMinutes[1])) {
        push(`Chapitre « ${c.name ?? c.id} » : durée ${ax} hors bornes (${IMPORT_BOUNDS.axisMinutes[0]}–${IMPORT_BOUNDS.axisMinutes[1]} min).`);
      }
    }
    if (c.stability != null && !Number.isFinite(c.stability)) push(`Chapitre « ${c.name} » : stability non numérique.`);
    if (c.lastReviewed != null && !isValidISODate(c.lastReviewed)) push(`Chapitre « ${c.name} » : lastReviewed invalide.`);
  }

  const examIds = new Set();
  for (const e of obj.exams || []) {
    if (!e || typeof e !== 'object') { push('Une épreuve n’est pas un objet.'); continue; }
    if (typeof e.id !== 'string' || !e.id) push(`Épreuve sans identifiant valide (« ${e.name ?? '?'} »).`);
    else if (examIds.has(e.id)) push(`Identifiant d’épreuve dupliqué : ${e.id}.`);
    else examIds.add(e.id);
    if (!subjectIds.has(e.subjectId)) push(`Épreuve « ${e.name ?? e.id} » : matière introuvable (${e.subjectId}).`);
    if (!isValidISODate(e.date)) push(`Épreuve « ${e.name ?? e.id} » : date invalide (${e.date}).`);
    if (e.importance != null && !IMPORTANCE[e.importance]) push(`Épreuve « ${e.name ?? e.id} » : importance invalide.`);
    for (const cid of e.chapterIds || []) {
      if (!chapterIds.has(cid)) push(`Épreuve « ${e.name ?? e.id} » : chapitre couvert introuvable (${cid}).`);
    }
  }

  const reviewIds = new Set();
  for (const r of obj.reviewLog || []) {
    if (!r || typeof r !== 'object') { push('Une entrée d’historique n’est pas un objet.'); continue; }
    if (r.id != null) { if (reviewIds.has(r.id)) push(`Identifiant de review dupliqué : ${r.id}.`); else reviewIds.add(r.id); }
    if (!(r.grade >= 1 && r.grade <= 4)) push('Note d’historique hors [1,4].');
    if (!isValidISODate(r.date)) push(`Historique : date invalide (${r.date}).`);
    if (r.evidenceType != null && !EVIDENCE[r.evidenceType]) push(`Historique : type de preuve inconnu (${r.evidenceType}).`);
    if (r.chapterId != null && chapterIds.size && !chapterIds.has(r.chapterId)) push('Historique : chapitre introuvable.');
  }

  if (obj.settings != null) {
    if (typeof obj.settings !== 'object') push('« settings » doit être un objet.');
    else for (const [k, v] of Object.entries(obj.settings)) {
      if (typeof v === 'number' && !Number.isFinite(v)) push(`Réglage non fini : ${k}.`);
    }
  }

  if (obj.capacityOverrides != null) {
    if (typeof obj.capacityOverrides !== 'object' || Array.isArray(obj.capacityOverrides)) {
      push('« capacityOverrides » doit être un objet { date: minutes }.');
    } else for (const [d, v] of Object.entries(obj.capacityOverrides)) {
      if (!isValidISODate(d)) push(`Capacité : date invalide (${d}).`);
      if (!(Number.isFinite(v) && v >= IMPORT_BOUNDS.dayMinutes[0] && v <= IMPORT_BOUNDS.dayMinutes[1])) {
        push(`Capacité du ${d} hors bornes (0–${IMPORT_BOUNDS.dayMinutes[1]} min).`);
      }
    }
  }

  if (obj.examDebriefs != null) {
    if (typeof obj.examDebriefs !== 'object' || Array.isArray(obj.examDebriefs)) {
      push('« examDebriefs » doit être un objet { épreuve: date }.');
    } else for (const [, v] of Object.entries(obj.examDebriefs)) {
      if (!isValidISODate(v)) push('Bilan d’épreuve : date invalide.');
    }
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
export function ensureV4(s, today = todayISO()) {
  const settings = { ...DEFAULT_SETTINGS, ...(s?.settings || {}) };
  const exams = (Array.isArray(s.exams) ? s.exams : []).map((e) => ({ ...e, importance: e.importance ?? 'normal' }));
  const examIds = new Set(exams.map((e) => e.id));
  const clampMinutes = (v, fallback) => (Number.isFinite(v)
    ? Math.round(clamp(v, IMPORT_BOUNDS.axisMinutes[0], IMPORT_BOUNDS.axisMinutes[1]))
    : fallback);
  // Un report ne concerne que « aujourd'hui » : les entrées plus vieilles
  // qu'hier sont du poids mort.
  const skips = Object.fromEntries(Object.entries(s.skips && typeof s.skips === 'object' ? s.skips : {})
    .filter(([, d]) => typeof d === 'string' && d >= addDays(today, -1)));
  return {
    version: 4,
    subjects: Array.isArray(s.subjects) ? s.subjects : [],
    chapters: (Array.isArray(s.chapters) ? s.chapters : []).map((c) => {
      const initialLevel = c.initialLevel ?? closestLevel(c.recall?.difficulty ?? c.difficulty ?? 5).key;
      const level = LEVELS.find((l) => l.key === initialLevel) || LEVELS[0];
      const rec = c.recall || {};
      return {
        id: c.id, subjectId: c.subjectId, name: c.name, initialLevel,
        recall: {
          stability: Math.max(S_MIN, rec.stability ?? targetInterval(level.m, settings)),
          difficulty: clamp(rec.difficulty ?? level.D, 1, 10),
          lastReviewed: rec.lastReviewed ?? null,
          source: rec.source ?? 'seed',
        },
        exercise: normPractice(c.exercise),
        problem: normPractice(c.problem),
        minutes: {
          recall: clampMinutes(c.minutes?.recall, AXIS_MINUTES.recall),
          exercise: clampMinutes(c.minutes?.exercise, AXIS_MINUTES.exercise),
          problem: clampMinutes(c.minutes?.problem, AXIS_MINUTES.problem),
        },
      };
    }),
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
    lastExportAt: s.lastExportAt ?? null,
  };
}
function normPractice(p) {
  if (!p || typeof p !== 'object') return emptyPractice();
  return {
    score: p.score == null ? null : clamp(p.score, 0, 1),
    attempts: Number.isFinite(p.attempts) ? p.attempts : 0,
    lastTested: p.lastTested ?? null,
    recentFails: Number.isFinite(p.recentFails) ? p.recentFails : 0,
  };
}

// Accepte v1, v2, v3 ou v4 -> renvoie toujours un état v4 sain.
// Tout passe par ensureV4 (bornes + hygiène), y compris après migration.
export function normalize(s, today = todayISO()) {
  if (!s || typeof s !== 'object') return seedState();
  if (s.version === 4) return ensureV4(s, today);
  if (s.version === 3) return ensureV4(migrateV3(s), today);
  if (s.version === 2) return ensureV4(migrateV3(migrateV2(s)), today);
  return ensureV4(migrateV3(migrateV2(migrateV1(s))), today);
}

export function newChapter(subjectId, name, level, s) {
  const lv = level || LEVELS[0];
  const seed = levelSeed(lv, s);
  return {
    id: uid(), subjectId, name, initialLevel: lv.key,
    recall: { stability: seed.stability, difficulty: seed.difficulty, lastReviewed: null, source: 'seed' },
    exercise: emptyPractice(),
    problem: emptyPractice(),
    minutes: { ...AXIS_MINUTES },
  };
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
    version: 4, subjects: [...core, ...parallel], chapters: [], exams: [],
    settings: { ...DEFAULT_SETTINGS }, parallelLog: {}, reviewLog: [],
    archivedReviews: [], skips: {}, capacityOverrides: {}, examDebriefs: {},
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
