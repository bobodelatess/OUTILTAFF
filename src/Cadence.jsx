/*
 * CADENCE v2 — planificateur d'étude piloté par les examens.
 *
 * Répétition espacée au niveau CHAPITRE, moteur FSRS-4.5 (courbe d'oubli en
 * loi de puissance, stabilité + difficulté par chapitre, notation à 4 niveaux),
 * plus une couche examens (pression MULTIPLICATIVE), un plan du jour borné par
 * la capacité (N matières × H heures), une prévision de charge et des stats.
 *
 * Idée centrale : priorité = urgence_de_péremption × pression_d'examen.
 *
 * Modèle de données (v2)
 *   Subject  = { id, name, color, type: 'core'|'parallel', weeklyFloor? }
 *   Chapter  = { id, subjectId, name, difficulty: 1..10, stability: jours,
 *                lastReviewed: ISODate|null }
 *   Exam     = { id, subjectId, name, date: ISODate, chapterIds: string[] }
 *   Review   = { id, chapterId, date, grade: 1..4,
 *                before: { stability, difficulty, lastReviewed },
 *                after:  { stability, difficulty } }
 *   State    = { version: 2, subjects, chapters, exams, settings,
 *                parallelLog, reviewLog }
 *
 * Migration : les données v1 (mastery 0..100) sont converties automatiquement
 * (difficulté dérivée de la maîtrise, stabilité conservée ou dérivée).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, CalendarDays, Layers, Settings as SettingsIcon, TrendingUp,
  Plus, Trash2, ChevronDown, ChevronRight, ChevronLeft, Check,
  Download, Upload, RotateCcw, AlertTriangle, Lock, Undo2,
  BookOpen, FlaskConical, Flame, Pencil,
} from 'lucide-react';

/* ================================================================== *
 *  Constantes & thème
 * ================================================================== */

const STORAGE_KEY = 'cadence.v2';
const LEGACY_KEY = 'cadence.v1';
const BACKUP_KEY = 'cadence.backups';

export const DEFAULT_SETTINGS = {
  requestRetention: 0.9, // rétention cible : on revoit quand R retombe à ce niveau
  subjectsPerDay: 3,     // capacité : matières par jour
  sessionHours: 2,       // durée d'une séance par matière
  minutesPerChapter: 30, // -> nb de chapitres par séance
  maxExamPressure: 5,
  pressureHorizon: 35,
  examModeThreshold: 21,
  minInterval: 2,        // stabilité initiale « Jamais vu »
  maxInterval: 30,       // stabilité initiale « Solide »
  simpleMode: true,
};

const C = {
  bg: '#0a0e14',
  panel: '#111824',
  panel2: '#0d1320',
  inset: '#0a0f18',
  line: '#1e2735',
  line2: '#2b3645',
  text: '#cdd8e6',
  dim: '#7c8a9e',
  faint: '#54616f',
  accent: '#5ea9ff',
  good: '#34d399',
  warn: '#fbbf24',
  bad: '#f87171',
};

const MONO = "'JetBrains Mono','SFMono-Regular',ui-monospace,Menlo,Consolas,monospace";
const SANS = "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// Rampe thermique : froid (calme) -> ambre -> rouge (urgent).
const RAMP = [
  [0.0, [56, 189, 248]],
  [0.3, [45, 212, 191]],
  [0.55, [250, 204, 21]],
  [0.8, [251, 146, 60]],
  [1.0, [239, 68, 68]],
];

// Notation d'une révision (FSRS) : 1 tape = 1 signal précis pour le modèle.
export const GRADES = {
  1: { key: 1, label: 'Oublié', hint: 'je ne savais plus', color: '#f87171' },
  2: { key: 2, label: 'Difficile', hint: 'retrouvé avec effort', color: '#fbbf24' },
  3: { key: 3, label: 'Bien', hint: 'retrouvé correctement', color: '#34d399' },
  4: { key: 4, label: 'Facile', hint: 'trop facile', color: '#38bdf8' },
};

// Niveaux nommés pour calibrer un chapitre sans historique.
export const LEVELS = [
  { key: 'new', label: 'Jamais vu', m: 0, D: 8.5 },
  { key: 'fragile', label: 'Fragile', m: 33, D: 6.8 },
  { key: 'ok', label: 'Moyen', m: 66, D: 5.0 },
  { key: 'solid', label: 'Solide', m: 100, D: 3.2 },
];

/* ================================================================== *
 *  Utilitaires
 * ================================================================== */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round1 = (x) => Math.round(x * 10) / 10;
const f2 = (x) => x.toFixed(2);

const uid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'id-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function isoOf(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function parseISO(iso) {
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
function fmtLongDate(iso) {
  return parseISO(iso).toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}
function fmtShortDate(iso) {
  return parseISO(iso).toLocaleDateString('fr-FR', {
    weekday: 'short', day: '2-digit', month: 'short',
  });
}

/* ================================================================== *
 *  Moteur FSRS-4.5 (fonctions pures, testées)
 *  Réf. : algorithme FSRS (open-spaced-repetition), poids par défaut 4.5.
 * ================================================================== */

export const FSRS_W = [
  0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031,
  1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755,
];

const DECAY = -0.5;
const FACTOR = Math.pow(0.9, 1 / DECAY) - 1; // = 19/81, calé pour R(S) = 90 %
const S_MIN = 0.2;
const S_MAX = 730;

// Rétrievabilité : probabilité de rappel après t jours (loi de puissance).
export function retrievability(t, S) {
  if (S <= 0) return 0;
  return Math.pow(1 + FACTOR * Math.max(0, t) / S, DECAY);
}

// Intervalle qui ramène R à la rétention cible (= S quand cible = 90 %).
export function optimalInterval(S, r = 0.9) {
  const rt = clamp(r, 0.7, 0.99);
  return (S / FACTOR) * (Math.pow(rt, 1 / DECAY) - 1);
}

// Difficulté initiale selon la première note (1..10 ; 1 = facile).
export function initialDifficulty(grade) {
  return clamp(FSRS_W[4] - FSRS_W[5] * (grade - 3), 1, 10);
}

// Mise à jour de la difficulté (dérive selon la note + rappel vers la moyenne).
export function nextDifficulty(D, grade) {
  const target = initialDifficulty(4);
  return clamp(FSRS_W[7] * target + (1 - FSRS_W[7]) * (D - FSRS_W[6] * (grade - 3)), 1, 10);
}

// Croissance de stabilité après une révision réussie (grade 2..4).
// Encode l'effet d'espacement : gain max quand R est bas (revu près du seuil).
export function stabilityAfterSuccess(S, D, R, grade) {
  let inc = Math.exp(FSRS_W[8]) * (11 - D) * Math.pow(S, -FSRS_W[9]) *
    (Math.exp(FSRS_W[10] * (1 - R)) - 1);
  if (grade === 2) inc *= FSRS_W[15]; // pénalité « Difficile »
  if (grade === 4) inc *= FSRS_W[16]; // bonus « Facile »
  return clamp(S * (1 + inc), S_MIN, S_MAX);
}

// Stabilité après un oubli (grade 1) : chute, jamais de gain.
export function stabilityAfterFailure(S, D, R) {
  const s2 = FSRS_W[11] * Math.pow(D, -FSRS_W[12]) *
    (Math.pow(S + 1, FSRS_W[13]) - 1) * Math.exp(FSRS_W[14] * (1 - R));
  return clamp(Math.min(s2, S), S_MIN, S_MAX);
}

// Applique une note à un chapitre -> nouvel état mémoire.
// Jamais révisé : on suppose un retard important (t = 2.2 × S), cohérent avec
// le modèle d'urgence.
export function applyGrade(chapter, grade, today) {
  const S = chapter.stability;
  const D = chapter.difficulty ?? 5;
  const since = chapter.lastReviewed ? daysBetween(chapter.lastReviewed, today) : null;
  const elapsed = since != null ? since : S * 2.2;
  const R = retrievability(elapsed, S);
  const stability = grade === 1
    ? stabilityAfterFailure(S, D, R)
    : stabilityAfterSuccess(S, D, R, grade);
  return { stability, difficulty: nextDifficulty(D, grade), R };
}

// Stabilité initiale d'un niveau nommé (interpolation géométrique min..max).
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

/* ------------------------------------------------------------------ *
 *  Couche examens (pression multiplicative) + priorité
 * ------------------------------------------------------------------ */

export function examMultiplier(j, s) {
  if (j < 0 || j > s.pressureHorizon) return 1;
  const x = (s.pressureHorizon - j) / s.pressureHorizon;
  return 1 + (s.maxExamPressure - 1) * x * x;
}

export function chapterExamFactor(chapter, exams, s, today) {
  let factor = 1, exam = null, examDays = null;
  for (const ex of exams) {
    if (!ex.chapterIds || !ex.chapterIds.includes(chapter.id)) continue;
    const j = daysBetween(today, ex.date);
    if (j < 0) continue;
    const mult = examMultiplier(j, s);
    if (mult > factor) { factor = mult; exam = ex; examDays = j; }
  }
  return { factor, exam, examDays };
}

// Priorité + décomposition transparente d'un chapitre.
export function chapterMetrics(chapter, exams, s, today) {
  const S = chapter.stability;
  const ti = Math.max(0.5, optimalInterval(S, s.requestRetention));
  const since = chapter.lastReviewed ? daysBetween(chapter.lastReviewed, today) : null;
  const elapsed = since != null ? since : ti * 2.2;
  const urgency = Math.max(0, elapsed) / ti;
  const R = since != null ? retrievability(since, S) : null;
  const { factor, exam, examDays } = chapterExamFactor(chapter, exams, s, today);
  const dueIn = since == null ? 0 : Math.max(0, Math.round(ti - since));
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
    if (m.since == null) return { text: 'Jamais révisé', tone: 'late' };
    const over = Math.round(m.since - m.ti);
    return { text: over <= 0 ? 'À revoir maintenant' : `En retard de ${over} j`, tone: 'late' };
  }
  const inDays = Math.max(0, Math.round(m.ti - (m.since ?? 0)));
  return { text: inDays <= 1 ? 'Pas urgent' : `Pas urgent · à revoir dans ~${inDays} j`, tone: 'calm' };
}

// Pertinence : vaut-il la peine de réviser ce chapitre AUJOURD'HUI ?
// Réviser trop tôt consolide peu (effet d'espacement) et gaspille du temps :
// on ne planifie un chapitre que s'il approche de son échéance (≥ 75 % de
// l'intervalle écoulé) ou si un examen le pousse réellement.
export function isWorthReviewing(m) {
  return m.urgency >= 0.75 || m.factor > 1.15;
}

// Charge de croisière : nombre moyen de chapitres/jour qu'exige la rétention
// cible en régime établi (Σ 1/intervalle). Sert d'aperçu au réglage.
export function cruiseLoad(chapters, s) {
  let sum = 0;
  for (const c of chapters) {
    sum += 1 / Math.max(1, optimalInterval(c.stability, s.requestRetention));
  }
  return sum;
}

// Calibration : rétention observée (taux de réussite, note > Oublié) vs
// prévue par le modèle au moment de chaque révision. Ignore les premières
// révisions (pas d'historique -> pas de prédiction honnête).
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

// Plan du jour sous contrainte de capacité : les `subjectsPerDay` matières
// (core) les plus sous pression, chacune avec ses chapitres prioritaires.
export function planDay(ranked, subjects, subjectsPerDay, chaptersPerSession) {
  const core = new Map(subjects.filter((s) => s.type === 'core').map((s) => [s.id, s]));
  const bySubject = new Map();
  for (const ch of ranked) {
    if (!core.has(ch.subjectId)) continue;
    if (!bySubject.has(ch.subjectId)) bySubject.set(ch.subjectId, []);
    bySubject.get(ch.subjectId).push(ch);
  }
  const sessions = [];
  for (const [sid, chs] of bySubject) {
    const chapters = chs.slice(0, Math.max(1, chaptersPerSession));
    const score = chapters.reduce((a, c) => a + c.priority, 0);
    sessions.push({ subject: core.get(sid), chapters, score, total: chs.length });
  }
  sessions.sort((a, b) => b.score - a.score);
  return sessions.slice(0, Math.max(1, subjectsPerDay));
}

// Prévision de charge : combien de chapitres arrivent à échéance chaque jour.
export function forecastDue(chapters, s, today, horizon = 28) {
  const map = {};
  for (const c of chapters) {
    const interval = Math.max(1, Math.round(optimalInterval(c.stability, s.requestRetention)));
    const since = c.lastReviewed ? daysBetween(c.lastReviewed, today) : null;
    const dueIn = since == null ? 0 : Math.max(0, interval - since);
    if (dueIn <= horizon) {
      const iso = addDays(today, dueIn);
      map[iso] = (map[iso] || 0) + 1;
    }
  }
  return map;
}

// Préparation d'examen : mémoire PRÉVUE le jour J pour chaque chapitre couvert
// (projection « si tu ne revois rien d'ici là »). Trie du plus fragile au plus
// solide ; `weak` = chapitres sous 70 % prévus.
export function examReadiness(exam, chapters, s, today) {
  const j = daysBetween(today, exam.date);
  if (j < 0) return null;
  const covered = chapters.filter((c) => (exam.chapterIds || []).includes(c.id));
  if (!covered.length) return null;
  const per = covered.map((c) => {
    const elapsed = c.lastReviewed
      ? daysBetween(c.lastReviewed, exam.date)
      : c.stability * 2.2 + j;
    return { chapter: c, projR: retrievability(elapsed, c.stability) };
  }).sort((a, b) => a.projR - b.projR);
  const avgR = per.reduce((a, x) => a + x.projR, 0) / per.length;
  return { days: j, avgR, per, weak: per.filter((x) => x.projR < 0.7).length };
}

// Sauvegardes quotidiennes : garde les `keep` plus récentes (≤ today).
export function pruneBackups(backups, today, keep = 7) {
  const dates = Object.keys(backups || {})
    .filter((d) => d <= today)
    .sort()
    .slice(-keep);
  const out = {};
  for (const d of dates) out[d] = backups[d];
  return out;
}

/* ================================================================== *
 *  Persistance, migration & seed
 * ================================================================== */

function makeStore() {
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

// v1 -> v2 : mastery (0..100) devient difficulté (10..1) ; stabilité conservée
// ou dérivée de la maîtrise ; journal vide.
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

function normalize(s) {
  if (!s || typeof s !== 'object') return seedState();
  if (s.version !== 2) return migrateV1(s);
  return {
    version: 2,
    subjects: Array.isArray(s.subjects) ? s.subjects : [],
    chapters: (Array.isArray(s.chapters) ? s.chapters : []).map((c) => ({
      ...c,
      difficulty: clamp(c.difficulty ?? 5, 1, 10),
      stability: Math.max(S_MIN, c.stability ?? 2),
      lastReviewed: c.lastReviewed ?? null,
    })),
    exams: Array.isArray(s.exams) ? s.exams : [],
    settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) },
    parallelLog: s.parallelLog && typeof s.parallelLog === 'object' ? s.parallelLog : {},
    reviewLog: Array.isArray(s.reviewLog) ? s.reviewLog : [],
    skips: s.skips && typeof s.skips === 'object' ? s.skips : {},
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
    version: 2,
    subjects: [...core, ...parallel],
    chapters: [],
    exams: [],
    settings: { ...DEFAULT_SETTINGS },
    parallelLog: {},
    reviewLog: [],
    skips: {},
  };
}

function stripChapterIds(exams, ids) {
  const set = new Set(ids);
  return exams.map((e) => ({
    ...e,
    chapterIds: (e.chapterIds || []).filter((cid) => !set.has(cid)),
  }));
}

/* ================================================================== *
 *  Rampe thermique
 * ================================================================== */

function thermal(priority) {
  const t = clamp(priority / 4, 0, 1);
  let i = 0;
  while (i < RAMP.length - 1 && t > RAMP[i + 1][0]) i++;
  const [t0, c0] = RAMP[i];
  const [t1, c1] = RAMP[Math.min(i + 1, RAMP.length - 1)];
  const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
  const rgb = c0.map((c, k) => Math.round(c + (c1[k] - c) * f));
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

/* ================================================================== *
 *  Atomes d'interface
 * ================================================================== */

const Mono = ({ children, style, color }) => (
  <span style={{ fontFamily: MONO, color, ...style }}>{children}</span>
);

const Pastille = ({ color, size = 10 }) => (
  <span style={{
    width: size, height: size, borderRadius: '50%', background: color,
    display: 'inline-block', flex: '0 0 auto', boxShadow: '0 0 0 1px rgba(0,0,0,.35)',
  }} />
);

function Chip({ children, color = C.dim, bg, title, style }) {
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontFamily: SANS, fontSize: 11, color, padding: '2px 7px',
      borderRadius: 999, background: bg || 'transparent',
      border: `1px solid ${bg ? 'transparent' : C.line2}`, whiteSpace: 'nowrap', ...style,
    }}>{children}</span>
  );
}

function Btn({ children, onClick, variant = 'ghost', title, disabled, style, type }) {
  const base = {
    display: 'inline-flex', alignItems: 'center', gap: 6, cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: SANS, fontSize: 13, padding: '7px 12px', borderRadius: 8,
    border: `1px solid ${C.line2}`, background: 'transparent', color: C.text,
    opacity: disabled ? 0.45 : 1,
  };
  const variants = {
    primary: { background: 'rgba(94,169,255,.14)', borderColor: 'rgba(94,169,255,.5)', color: '#dbeafe' },
    danger: { borderColor: 'rgba(248,113,113,.4)', color: C.bad },
    ghost: {},
    bare: { border: '1px solid transparent', padding: '6px 8px' },
  };
  return (
    <button type={type || 'button'} onClick={onClick} title={title} disabled={disabled}
      style={{ ...base, ...(variants[variant] || {}), ...style }}>
      {children}
    </button>
  );
}

function IconBtn({ icon: Icon, onClick, title, danger, size = 15 }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title} style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 30, height: 30, borderRadius: 7, cursor: 'pointer',
      border: `1px solid ${C.line}`, background: 'transparent',
      color: danger ? C.bad : C.dim,
    }}>
      <Icon size={size} />
    </button>
  );
}

function Range({ value, min, max, step = 1, onChange, ariaLabel }) {
  return (
    <input type="range" aria-label={ariaLabel} value={value} min={min} max={max} step={step}
      onChange={(e) => onChange(Number(e.target.value))} style={{ width: '100%' }} />
  );
}

function TextInput({ value, onChange, placeholder, type = 'text', style, ariaLabel, onKeyDown }) {
  return (
    <input type={type} value={value} placeholder={placeholder} aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown}
      style={{
        fontFamily: type === 'date' ? MONO : SANS, fontSize: 13, color: C.text,
        background: C.inset, border: `1px solid ${C.line2}`, borderRadius: 7,
        padding: '7px 9px', width: '100%', boxSizing: 'border-box', ...style,
      }} />
  );
}

function Segmented({ value, options, onChange, ariaLabel }) {
  return (
    <div role="group" aria-label={ariaLabel} style={{
      display: 'inline-flex', border: `1px solid ${C.line2}`, borderRadius: 8, overflow: 'hidden',
    }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button key={o.value} type="button" onClick={() => onChange(o.value)} style={{
            fontFamily: SANS, fontSize: 12, padding: '5px 11px', cursor: 'pointer', border: 'none',
            background: active ? 'rgba(94,169,255,.16)' : 'transparent',
            color: active ? '#dbeafe' : C.dim,
          }}>{o.label}</button>
        );
      })}
    </div>
  );
}

function SectionTitle({ icon: Icon, children, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
      {Icon && <Icon size={15} color={C.dim} />}
      <h2 style={{ margin: 0, fontFamily: SANS, fontSize: 13, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: C.dim }}>
        {children}
      </h2>
      <div style={{ flex: 1, height: 1, background: C.line }} />
      {right}
    </div>
  );
}

function Empty({ children }) {
  return (
    <div style={{
      fontFamily: SANS, fontSize: 13, color: C.dim, padding: '18px 16px',
      border: `1px dashed ${C.line2}`, borderRadius: 9, background: C.panel2, lineHeight: 1.5,
    }}>{children}</div>
  );
}

function AddRow({ placeholder, onAdd, cta = 'Ajouter' }) {
  const [v, setV] = useState('');
  const add = () => { const t = v.trim(); if (!t) return; onAdd(t); setV(''); };
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <TextInput value={v} onChange={setV} placeholder={placeholder} ariaLabel={placeholder}
        onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
      <Btn variant="primary" onClick={add}><Plus size={14} /> {cta}</Btn>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Visuels : anneaux SVG (progression du jour, jauge mémoire)
 * ------------------------------------------------------------------ */

function Ring({ value, total, size = 54, label }) {
  const stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = total > 0 ? clamp(value / total, 0, 1) : 0;
  const col = frac >= 1 ? C.good : C.accent;
  return (
    <svg width={size} height={size} role="img" aria-label={label || `${value} sur ${total}`}
      style={{ flex: '0 0 auto' }}>
      <circle cx={size / 2} cy={size / 2} r={r} stroke={C.line} strokeWidth={stroke} fill="none" />
      <circle cx={size / 2} cy={size / 2} r={r} stroke={col} strokeWidth={stroke} fill="none"
        strokeLinecap="round" strokeDasharray={`${c * frac} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dasharray .5s var(--ease), stroke .3s var(--ease)' }} />
      <text x="50%" y="52%" dominantBaseline="middle" textAnchor="middle"
        style={{ fontFamily: MONO, fontSize: 13, fill: C.text, fontWeight: 700 }}>
        {value}/{total}
      </text>
    </svg>
  );
}

// Jauge mémoire compacte : R (%) en anneau thermique. Tiret si jamais révisé.
function MemGauge({ R, size = 30 }) {
  const stroke = 3.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  if (R == null) {
    return (
      <svg width={size} height={size} role="img" aria-label="jamais révisé" style={{ flex: '0 0 auto' }}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke={C.line2} strokeWidth={stroke}
          fill="none" strokeDasharray="3 4" />
        <text x="50%" y="54%" dominantBaseline="middle" textAnchor="middle"
          style={{ fontFamily: MONO, fontSize: 9, fill: C.faint }}>–</text>
      </svg>
    );
  }
  const col = thermal((1 - R) * 4);
  return (
    <svg width={size} height={size} role="img" aria-label={`mémoire ${Math.round(R * 100)} %`}
      title={`mémoire ~${Math.round(R * 100)} %`} style={{ flex: '0 0 auto' }}>
      <circle cx={size / 2} cy={size / 2} r={r} stroke={C.line} strokeWidth={stroke} fill="none" />
      <circle cx={size / 2} cy={size / 2} r={r} stroke={col} strokeWidth={stroke} fill="none"
        strokeLinecap="round" strokeDasharray={`${c * clamp(R, 0, 1)} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dasharray .45s var(--ease), stroke .3s var(--ease)' }} />
      <text x="50%" y="54%" dominantBaseline="middle" textAnchor="middle"
        style={{ fontFamily: MONO, fontSize: 8.5, fill: col, fontWeight: 700 }}>
        {Math.round(R * 100)}
      </text>
    </svg>
  );
}

function ThermalLegend() {
  const grad = `linear-gradient(90deg, ${thermal(0)}, ${thermal(1.2)}, ${thermal(2.2)}, ${thermal(4)})`;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontFamily: SANS, fontSize: 10.5, color: C.faint }}>calme</span>
      <div style={{ flex: '0 1 140px', width: 140, height: 5, borderRadius: 3, background: grad, border: `1px solid ${C.line}` }} />
      <span style={{ fontFamily: SANS, fontSize: 10.5, color: C.faint }}>urgent</span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Lecture de priorité & raison
 * ------------------------------------------------------------------ */

function PriorityReader({ m, compact }) {
  const col = thermal(m.priority);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: compact ? 8 : 10, flexWrap: 'wrap',
      fontFamily: MONO, fontSize: compact ? 11 : 12,
    }}>
      <span title="priorité = urgence × multiplicateur d'examen" style={{
        color: col, fontWeight: 700, fontSize: compact ? 13 : 15,
      }}>
        ▲ {f2(m.priority)}
      </span>
      <span style={{ color: C.dim }}>
        {f2(m.urgency)}<span style={{ color: C.faint }}> urg</span>
        {' × '}
        {f2(m.factor)}<span style={{ color: C.faint }}> mult</span>
      </span>
      {m.exam ? (
        <span style={{ color: C.warn }} title={`épreuve : ${m.exam.name}`}>
          ⟶ {m.exam.name} · J−{m.examDays}
        </span>
      ) : (
        <span style={{ color: C.faint }}>aucune épreuve proche</span>
      )}
    </div>
  );
}

const REASON_ICON = { exam: CalendarDays, late: AlertTriangle, calm: Check };
function ReasonLine({ m, size = 13.5 }) {
  const r = reasonPhrase(m);
  const col = thermal(m.priority);
  const Icon = REASON_ICON[r.tone] || Check;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
      <Icon size={14} color={col} />
      <span style={{ fontFamily: SANS, fontSize: size, color: col, fontWeight: 600 }}>{r.text}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ *
 *  Notation (4 boutons) & carte de chapitre
 * ------------------------------------------------------------------ */

function GradeButtons({ onGrade, previewFor, compact }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {[1, 2, 3, 4].map((g) => {
        const G = GRADES[g];
        const days = previewFor ? previewFor(g) : null;
        const title = days != null ? `${G.hint} → revoir dans ~${days} j` : G.hint;
        return (
          <button key={g} type="button" onClick={() => onGrade(g)}
            title={title}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
              fontFamily: SANS, fontSize: compact ? 12 : 12.5, fontWeight: 600,
              padding: compact ? '5px 9px' : '6px 11px', borderRadius: 8,
              border: `1px solid ${G.color}55`, background: `${G.color}14`, color: G.color,
            }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: G.color }} />
            {G.label}
          </button>
        );
      })}
    </div>
  );
}

// Carte d'un chapitre dans le plan du jour.
// Clavier : Tab pour sélectionner la carte, 1–4 pour noter.
function QueueCard({ idx, ch, subject, simpleMode, done, today, settings, onGrade, onUndo, onSkip }) {
  const [expanded, setExpanded] = useState(false);
  const open = !simpleMode || expanded;
  const tcol = thermal(ch.priority);
  const sinceLabel = ch.since == null ? 'jamais révisé'
    : ch.since === 0 ? 'révisé aujourd’hui' : `revu il y a ${ch.since} j`;
  const G = done ? GRADES[done.grade] : null;

  // Aperçu : où atterrirait la prochaine révision selon la note.
  const previewFor = (g) => {
    const r = applyGrade(ch, g, today);
    return Math.max(1, Math.round(optimalInterval(r.stability, settings.requestRetention)));
  };

  const onKey = (e) => {
    if (e.target !== e.currentTarget) return;
    if (!done && ['1', '2', '3', '4'].includes(e.key)) { onGrade(ch.id, Number(e.key)); e.preventDefault(); }
  };

  return (
    <div className={`cad-card${done ? ' cad-done' : ''}`} tabIndex={0} onKeyDown={onKey}
      title={done ? undefined : 'Tab pour sélectionner · touches 1–4 pour noter'}
      style={{
      background: C.panel, border: `1px solid ${done ? `${G.color}44` : C.line}`,
      borderLeft: `3px solid ${done ? G.color : tcol}`,
      borderRadius: 10, padding: 13, display: 'flex', flexDirection: 'column', gap: 9,
      opacity: done ? 0.82 : 1,
    }}>
      {/* Quel chapitre + jauge mémoire */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Mono style={{ color: C.faint, fontSize: 12, width: 16 }}>{idx + 1}</Mono>
        <MemGauge R={ch.R} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span style={{
              fontFamily: SANS, fontSize: 15.5, color: C.text, fontWeight: 600,
              textDecoration: done ? 'line-through' : 'none',
              textDecorationColor: done ? `${G.color}88` : undefined,
            }}>{ch.name}</span>
            <span style={{ fontFamily: SANS, fontSize: 11, color: C.dim }}>{subject.name}</span>
          </div>
          <div style={{ marginTop: 3 }}>
            <ReasonLine m={ch} size={12.5} />
          </div>
        </div>
        <Pastille color={subject.color} />
      </div>

      {/* Détails (repliés en mode simple) : chiffres transparents */}
      <div className={`cad-collapse${open ? ' open' : ''}`}>
        <div className="cad-collapse-in" {...(open ? {} : { inert: '' })}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7, paddingLeft: 26, paddingTop: 4 }}>
            <Mono style={{ color: C.faint, fontSize: 11 }}>
              {sinceLabel}
              {ch.R != null ? ` · mémoire ~${Math.round(ch.R * 100)} %` : ''}
              {` · solidité ${round1(ch.stability)} j · difficulté ${round1(ch.difficulty)}/10`}
            </Mono>
            <Mono style={{ color: C.faint, fontSize: 11 }}>
              prochaine révision {ch.dueIn <= 0 ? 'aujourd’hui' : `dans ~${ch.dueIn} j`} · intervalle visé {Math.round(ch.ti)} j
            </Mono>
            <PriorityReader m={ch} compact />
          </div>
        </div>
      </div>

      {/* Notation ou état fait */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 26, flexWrap: 'wrap' }}>
        {done ? (
          <>
            <Chip color={G.color} bg={`${G.color}18`} style={{ fontWeight: 700 }}>
              <Check size={12} className="cad-pop" /> {G.label}
            </Chip>
            <Btn variant="bare" onClick={() => onUndo(done.id)} title="Annuler cette révision"
              style={{ color: C.faint, fontSize: 12 }}>
              <Undo2 size={13} /> annuler
            </Btn>
          </>
        ) : (
          <GradeButtons onGrade={(g) => onGrade(ch.id, g)} previewFor={previewFor} />
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 }}>
          {!done && onSkip && (
            <Btn variant="bare" onClick={() => onSkip(ch.id)}
              title="Pas aujourd'hui : sort du plan du jour, un autre chapitre le remplace"
              style={{ color: C.faint, fontSize: 12 }}>
              reporter
            </Btn>
          )}
          {simpleMode && (
            <Btn variant="bare" onClick={() => setExpanded((v) => !v)}
              style={{ color: C.faint, fontSize: 12 }}>
              détails <ChevronRight size={14} style={{ transition: 'transform .22s var(--ease)', transform: expanded ? 'rotate(90deg)' : 'none' }} />
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}

// Ligne compacte du classement complet.
function RankRow({ idx, ch, subject }) {
  const tcol = thermal(ch.priority);
  return (
    <div className="cad-card" style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
      borderLeft: `3px solid ${tcol}`, background: C.panel2, border: `1px solid ${C.line}`,
      borderLeftWidth: 3, borderRadius: 7,
    }}>
      <Mono style={{ color: C.faint, fontSize: 11, width: 18 }}>{idx + 1}</Mono>
      <MemGauge R={ch.R} size={24} />
      <Pastille color={subject.color} size={8} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: SANS, fontSize: 13, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {ch.name} <span style={{ color: C.faint, fontSize: 11 }}>· {subject.name}</span>
        </div>
        <PriorityReader m={ch} compact />
      </div>
    </div>
  );
}

function Stat({ label, value, unit, tone }) {
  return (
    <div className="cad-card" style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 9, padding: '8px 13px', minWidth: 108 }}>
      <div style={{ fontFamily: SANS, fontSize: 10.5, color: C.faint, textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <Mono style={{ fontSize: 19, color: tone || C.text }}>{value}</Mono>
        {unit != null && <span style={{ fontFamily: SANS, fontSize: 11, color: C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>{unit}</span>}
      </div>
    </div>
  );
}

/* ================================================================== *
 *  Styles globaux (mouvement, repli fluide, reduced-motion)
 * ================================================================== */

const GLOBAL_CSS = `
  .cadence { --ease: cubic-bezier(.22,.61,.36,1); }
  .cadence * { box-sizing: border-box; }
  .cadence input[type=range] {
    -webkit-appearance: none; appearance: none; height: 4px;
    background: ${C.line}; border-radius: 2px; outline: none; cursor: pointer;
  }
  .cadence input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none; width: 14px; height: 14px;
    border-radius: 50%; background: ${C.accent}; border: 2px solid ${C.bg}; cursor: pointer;
    transition: transform .12s var(--ease), box-shadow .12s var(--ease);
  }
  .cadence input[type=range]::-webkit-slider-thumb:hover { transform: scale(1.25); box-shadow: 0 0 0 6px rgba(94,169,255,.16); }
  .cadence input[type=range]:active::-webkit-slider-thumb { transform: scale(1.1); }
  .cadence input[type=range]::-moz-range-thumb {
    width: 14px; height: 14px; border-radius: 50%; background: ${C.accent};
    border: 2px solid ${C.bg}; cursor: pointer;
  }
  .cadence *:focus-visible { outline: 2px solid ${C.accent}; outline-offset: 2px; border-radius: 4px; }

  .cadence button {
    font: inherit;
    transition: background .18s var(--ease), border-color .18s var(--ease),
      color .18s var(--ease), filter .14s var(--ease), transform .07s var(--ease),
      box-shadow .18s var(--ease);
  }
  .cadence button:hover { filter: brightness(1.22); }
  .cadence button:active { transform: scale(.96); }
  .cadence input { transition: border-color .16s var(--ease), background .16s var(--ease); }
  .cadence input:hover { border-color: ${C.line2}; }

  .cad-card { transition: transform .18s var(--ease), box-shadow .22s var(--ease), border-color .22s var(--ease), opacity .3s var(--ease); }
  .cad-card:hover { transform: translateY(-2px); box-shadow: 0 12px 30px -10px rgba(0,0,0,.6); }
  .cad-done:hover { transform: none; box-shadow: none; }

  .cad-cell { transition: background .15s var(--ease), border-color .15s var(--ease), transform .12s var(--ease); }
  .cad-cell:hover { background: rgba(255,255,255,.05); transform: translateY(-1px); }

  .cad-bar { transition: width .35s var(--ease), background .25s var(--ease), height .3s var(--ease); }

  .cad-collapse { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .26s var(--ease), opacity .2s var(--ease); opacity: .4; }
  .cad-collapse.open { grid-template-rows: 1fr; opacity: 1; }
  .cad-collapse > .cad-collapse-in { overflow: hidden; min-height: 0; }

  @keyframes cad-fade-up { from { opacity: 0; transform: translateY(9px); } to { opacity: 1; transform: none; } }
  @keyframes cad-fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  @keyframes cad-pop { 0% { transform: scale(.5); opacity: .3; } 60% { transform: scale(1.18); } 100% { transform: scale(1); opacity: 1; } }
  @keyframes cad-toast { from { opacity: 0; transform: translate(-50%, 14px); } to { opacity: 1; transform: translate(-50%, 0); } }
  .cad-in { animation: cad-fade-up .36s var(--ease) both; }
  .cad-view { animation: cad-fade .24s var(--ease) both; }
  .cad-pop { animation: cad-pop .32s var(--ease); }

  .cad-toast {
    position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%);
    z-index: 50; display: flex; align-items: center; gap: 12px;
    background: #141c2b; border: 1px solid ${C.line2}; border-radius: 12px;
    padding: 10px 16px; box-shadow: 0 18px 40px -12px rgba(0,0,0,.7);
    animation: cad-toast .3s var(--ease) both;
  }

  @media (max-width: 640px) { .cad-tab-label { display: none; } }

  .cadence ::-webkit-scrollbar { width: 10px; height: 10px; }
  .cadence ::-webkit-scrollbar-thumb { background: #26303d; border-radius: 5px; }
  .cadence ::-webkit-scrollbar-thumb:hover { background: #344150; }
  .cadence ::-webkit-scrollbar-track { background: transparent; }
  .cadence input::placeholder { color: ${C.faint}; }

  @media (prefers-reduced-motion: reduce) {
    .cadence *, .cad-card, .cad-in, .cad-view, .cad-collapse, .cad-pop, .cad-toast {
      animation: none !important; transition: none !important;
    }
    .cad-collapse { opacity: 1; }
  }
`;

/* ================================================================== *
 *  Application
 * ================================================================== */

const TABS = [
  { id: 'today', label: 'Aujourd’hui', icon: Activity },
  { id: 'calendar', label: 'Calendrier', icon: CalendarDays },
  { id: 'subjects', label: 'Matières', icon: Layers },
  { id: 'progress', label: 'Progrès', icon: TrendingUp },
  { id: 'settings', label: 'Réglages', icon: SettingsIcon },
];

export default function Cadence() {
  const store = useMemo(() => makeStore(), []);
  const [state, setState] = useState(() => {
    try {
      const raw = store.getItem(STORAGE_KEY);
      if (raw) return normalize(JSON.parse(raw));
      const legacy = store.getItem(LEGACY_KEY);
      if (legacy) return migrateV1(JSON.parse(legacy));
    } catch (e) { /* ignore */ }
    return seedState();
  });

  useEffect(() => {
    try { store.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
    // Sauvegarde quotidienne automatique (7 jours glissants, restaurable).
    try {
      const t = todayISO();
      const raw = store.getItem(BACKUP_KEY);
      const backups = raw ? JSON.parse(raw) : {};
      if (!backups[t]) {
        store.setItem(BACKUP_KEY, JSON.stringify(pruneBackups({ ...backups, [t]: state }, t, 7)));
      }
    } catch (e) { /* ignore */ }
  }, [state, store]);

  const [tab, setTab] = useState('today');
  const [toast, setToast] = useState(null); // { text, entryId }
  const toastTimer = useRef(null);
  const today = todayISO();
  const { subjects, chapters, exams, settings, parallelLog, reviewLog, skips } = state;

  /* ----- Mutations ----- */
  const patch = (fn) => setState((prev) => fn(prev));

  const addSubject = (name) => patch((p) => ({
    ...p, subjects: [...p.subjects, { id: uid(), name, color: '#7c9cf5', type: 'core' }],
  }));
  const updateSubject = (id, up) => patch((p) => ({
    ...p, subjects: p.subjects.map((s) => (s.id === id ? { ...s, ...up } : s)),
  }));
  const deleteSubject = (id) => patch((p) => {
    const chapIds = p.chapters.filter((c) => c.subjectId === id).map((c) => c.id);
    const idSet = new Set(chapIds);
    return {
      ...p,
      subjects: p.subjects.filter((s) => s.id !== id),
      chapters: p.chapters.filter((c) => c.subjectId !== id),
      exams: stripChapterIds(p.exams.filter((e) => e.subjectId !== id), chapIds),
      reviewLog: p.reviewLog.filter((r) => !idSet.has(r.chapterId)),
    };
  });

  const addChapter = (subjectId, name) => patch((p) => ({
    ...p, chapters: [...p.chapters, {
      id: uid(), subjectId, name, lastReviewed: null,
      ...levelSeed(LEVELS[0], p.settings), // « Jamais vu » par défaut
    }],
  }));
  const updateChapter = (id, up) => patch((p) => ({
    ...p, chapters: p.chapters.map((c) => (c.id === id ? { ...c, ...up } : c)),
  }));
  const deleteChapter = (id) => patch((p) => ({
    ...p,
    chapters: p.chapters.filter((c) => c.id !== id),
    exams: stripChapterIds(p.exams, [id]),
    reviewLog: p.reviewLog.filter((r) => r.chapterId !== id),
  }));
  // Recalibrer un chapitre sur un niveau nommé (repart de zéro côté mémoire).
  const setChapterLevel = (id, level) => patch((p) => ({
    ...p, chapters: p.chapters.map((c) => (c.id === id ? { ...c, ...levelSeed(level, p.settings) } : c)),
  }));

  // Noter une révision (FSRS) : met à jour stabilité + difficulté, journalise.
  const gradeChapter = (id, grade) => {
    const entryId = uid();
    patch((p) => {
      const ch = p.chapters.find((c) => c.id === id);
      if (!ch) return p;
      const already = p.reviewLog.some((r) => r.chapterId === id && r.date === today);
      if (already) return p; // une note par jour et par chapitre
      const { stability, difficulty } = applyGrade(ch, grade, today);
      const entry = {
        id: entryId, chapterId: id, date: today, grade,
        before: { stability: ch.stability, difficulty: ch.difficulty, lastReviewed: ch.lastReviewed },
        after: { stability, difficulty },
      };
      return {
        ...p,
        chapters: p.chapters.map((c) => (c.id === id ? { ...c, stability, difficulty, lastReviewed: today } : c)),
        reviewLog: [...p.reviewLog, entry],
      };
    });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text: `Noté « ${GRADES[grade].label} »`, entryId });
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  };

  // Annuler une révision : restaure l'état mémoire d'avant, retire l'entrée.
  const undoReview = (entryId) => {
    patch((p) => {
      const entry = p.reviewLog.find((r) => r.id === entryId);
      if (!entry) return p;
      return {
        ...p,
        chapters: p.chapters.map((c) => (c.id === entry.chapterId
          ? { ...c, stability: entry.before.stability, difficulty: entry.before.difficulty, lastReviewed: entry.before.lastReviewed }
          : c)),
        reviewLog: p.reviewLog.filter((r) => r.id !== entryId),
      };
    });
    setToast(null);
  };

  // Reporter un chapitre : il sort du plan d'aujourd'hui, un autre le remplace.
  const skipChapter = (id) => patch((p) => ({ ...p, skips: { ...p.skips, [id]: today } }));
  const unskipToday = () => patch((p) => ({
    ...p,
    skips: Object.fromEntries(Object.entries(p.skips || {}).filter(([, d]) => d !== today)),
  }));

  // Restauration d'une sauvegarde quotidienne.
  const restoreBackup = (date) => {
    try {
      const raw = store.getItem(BACKUP_KEY);
      const backups = raw ? JSON.parse(raw) : {};
      if (!backups[date]) return;
      if (confirm(`Restaurer la sauvegarde du ${date} ? L'état actuel sera remplacé.`)) {
        setState(normalize(backups[date]));
      }
    } catch (e) { alert('Restauration impossible.'); }
  };
  const listBackups = () => {
    try {
      const raw = store.getItem(BACKUP_KEY);
      return Object.keys(raw ? JSON.parse(raw) : {}).sort().reverse();
    } catch (e) { return []; }
  };

  const addExam = (subjectId, exam) => patch((p) => ({
    ...p, exams: [...p.exams, { id: uid(), subjectId, name: exam.name, date: exam.date, chapterIds: exam.chapterIds || [] }],
  }));
  const updateExam = (id, up) => patch((p) => ({
    ...p, exams: p.exams.map((e) => (e.id === id ? { ...e, ...up } : e)),
  }));
  const deleteExam = (id) => patch((p) => ({ ...p, exams: p.exams.filter((e) => e.id !== id) }));
  const toggleExamChapter = (examId, chapterId) => patch((p) => ({
    ...p,
    exams: p.exams.map((e) => {
      if (e.id !== examId) return e;
      const has = (e.chapterIds || []).includes(chapterId);
      return { ...e, chapterIds: has ? e.chapterIds.filter((x) => x !== chapterId) : [...(e.chapterIds || []), chapterId] };
    }),
  }));

  const updateSetting = (key, value) => patch((p) => ({ ...p, settings: { ...p.settings, [key]: value } }));

  const adjustParallel = (subjectId, delta) => patch((p) => {
    const wk = mondayOf(today);
    const log = { ...(p.parallelLog || {}) };
    const week = { ...(log[wk] || {}) };
    week[subjectId] = Math.max(0, (week[subjectId] || 0) + delta);
    log[wk] = week;
    return { ...p, parallelLog: log };
  });

  const importState = (obj) => setState(normalize(obj));
  const resetAll = () => {
    if (confirm('Réinitialiser CADENCE ? Tes chapitres, épreuves, historique et réglages seront effacés.')) setState(seedState());
  };

  /* ----- Données dérivées ----- */
  const subjectById = useMemo(
    () => Object.fromEntries(subjects.map((s) => [s.id, s])), [subjects]);
  const coreSubjects = useMemo(() => subjects.filter((s) => s.type === 'core'), [subjects]);
  const parallelSubjects = useMemo(() => subjects.filter((s) => s.type === 'parallel'), [subjects]);

  // Révisions du jour (pour l'état « fait » et la stabilité du plan).
  const todayEntries = useMemo(
    () => reviewLog.filter((r) => r.date === today), [reviewLog, today]);
  const doneByChapter = useMemo(
    () => Object.fromEntries(todayEntries.map((r) => [r.chapterId, r])), [todayEntries]);

  // Classement courant (post-révisions).
  const ranked = useMemo(() => chapters
    .map((ch) => ({ ...ch, ...chapterMetrics(ch, exams, settings, today) }))
    .sort((a, b) => b.priority - a.priority), [chapters, exams, settings, today]);

  // Plan du jour STABLE : les chapitres déjà notés aujourd'hui sont replacés
  // dans leur état d'avant révision, pour que la liste ne se réorganise pas.
  // Les chapitres « reportés » aujourd'hui sortent du plan.
  const skippedToday = useMemo(
    () => Object.entries(skips || {}).filter(([, d]) => d === today).map(([id]) => id),
    [skips, today]);
  const planningRanked = useMemo(() => chapters
    .filter((ch) => skips?.[ch.id] !== today)
    .map((ch) => {
      const e = doneByChapter[ch.id];
      const base = e ? { ...ch, ...e.before } : ch;
      return { ...base, ...chapterMetrics(base, exams, settings, today) };
    })
    .sort((a, b) => b.priority - a.priority), [chapters, skips, doneByChapter, exams, settings, today]);

  const overdue = ranked.filter((c) => c.urgency >= 1 && !doneByChapter[c.id]).length;
  const chaptersPerSession = Math.max(1, Math.round((settings.sessionHours * 60) / settings.minutesPerChapter));
  const dailyCapacity = chaptersPerSession * settings.subjectsPerDay;
  // Plan honnête : seulement les chapitres qui valent la peine aujourd'hui
  // (proches de l'échéance ou poussés par un examen) — jamais de remplissage.
  const worthToday = useMemo(
    () => planningRanked.filter((c) => isWorthReviewing(c) || doneByChapter[c.id]),
    [planningRanked, doneByChapter]);
  const sessions = useMemo(
    () => planDay(worthToday, subjects, settings.subjectsPerDay, chaptersPerSession),
    [worthToday, subjects, settings.subjectsPerDay, chaptersPerSession]);
  const plannedCount = sessions.reduce((a, s) => a + s.chapters.length, 0);
  const doneCount = sessions.reduce((a, s) => a + s.chapters.filter((c) => doneByChapter[c.id]).length, 0);
  const hasCoreChapters = useMemo(
    () => chapters.some((c) => subjectById[c.subjectId]?.type === 'core'),
    [chapters, subjectById]);

  const annalesBanners = useMemo(() => coreSubjects
    .map((s) => ({ subject: s, info: annalesModeFor(s.id, exams, settings, today) }))
    .filter((x) => x.info), [coreSubjects, exams, settings, today]);

  const upcomingExams = useMemo(() => exams
    .map((e) => ({ ...e, days: daysBetween(today, e.date) }))
    .filter((e) => e.days >= 0)
    .sort((a, b) => a.days - b.days), [exams, today]);
  const nextExam = upcomingExams[0] || null;

  const dueForecast = useMemo(
    () => forecastDue(chapters, settings, today, 35), [chapters, settings, today]);

  // Préparation d'examen : mémoire prévue le jour J par épreuve à venir.
  const readinessByExam = useMemo(() => {
    const map = {};
    for (const e of upcomingExams) {
      const r = examReadiness(e, chapters, settings, today);
      if (r) map[e.id] = r;
    }
    return map;
  }, [upcomingExams, chapters, settings, today]);

  return (
    <div className="cadence" style={{
      minHeight: '100%', background: C.bg, color: C.text, fontFamily: SANS,
      WebkitFontSmoothing: 'antialiased',
    }}>
      <style>{GLOBAL_CSS}</style>

      <header style={{
        position: 'sticky', top: 0, zIndex: 10, background: 'rgba(10,14,20,.86)',
        backdropFilter: 'blur(8px)', borderBottom: `1px solid ${C.line}`,
      }}>
        <div style={{ maxWidth: 1000, margin: '0 auto', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Flame size={18} color={C.accent} />
            <span style={{ fontFamily: MONO, fontWeight: 700, letterSpacing: '.22em', fontSize: 16 }}>CADENCE</span>
          </div>
          <nav style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginLeft: 'auto' }}>
            {TABS.map((t) => {
              const active = tab === t.id;
              return (
                <button key={t.id} onClick={() => setTab(t.id)} title={t.label} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer',
                  fontFamily: SANS, fontSize: 13, padding: '7px 12px', borderRadius: 8,
                  border: `1px solid ${active ? 'rgba(94,169,255,.5)' : 'transparent'}`,
                  background: active ? 'rgba(94,169,255,.14)' : 'transparent',
                  color: active ? '#dbeafe' : C.dim,
                }}>
                  <t.icon size={15} /> <span className="cad-tab-label">{t.label}</span>
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main style={{ maxWidth: 1000, margin: '0 auto', padding: '18px 16px 72px' }}>
        <div key={tab} className="cad-view">
          {tab === 'today' && (
            <TodayView
              today={today} overdue={overdue} nextExam={nextExam} subjectById={subjectById}
              annalesBanners={annalesBanners} sessions={sessions} ranked={ranked}
              plannedCount={plannedCount} doneCount={doneCount} doneByChapter={doneByChapter}
              skippedToday={skippedToday} readinessByExam={readinessByExam}
              dailyCapacity={dailyCapacity} hasCoreChapters={hasCoreChapters}
              parallelSubjects={parallelSubjects} parallelLog={parallelLog} settings={settings}
              onGrade={gradeChapter} onUndo={undoReview} onSkip={skipChapter} onUnskip={unskipToday}
              onAdjustParallel={adjustParallel}
              onGoSubjects={() => setTab('subjects')}
              onSetSimpleMode={(v) => updateSetting('simpleMode', v)}
            />
          )}
          {tab === 'calendar' && (
            <CalendarView today={today} exams={exams} subjectById={subjectById}
              settings={settings} upcomingExams={upcomingExams} dueForecast={dueForecast}
              readinessByExam={readinessByExam} />
          )}
          {tab === 'subjects' && (
            <SubjectsView
              subjects={subjects} chapters={chapters} exams={exams} settings={settings} today={today}
              onAddSubject={addSubject} onUpdateSubject={updateSubject} onDeleteSubject={deleteSubject}
              onAddChapter={addChapter} onUpdateChapter={updateChapter} onDeleteChapter={deleteChapter}
              onSetLevel={setChapterLevel}
              onAddExam={addExam} onUpdateExam={updateExam} onDeleteExam={deleteExam}
              onToggleExamChapter={toggleExamChapter}
            />
          )}
          {tab === 'progress' && (
            <ProgressView reviewLog={reviewLog} ranked={ranked} today={today}
              subjects={subjects} settings={settings} />
          )}
          {tab === 'settings' && (
            <SettingsView settings={settings} state={state} chapters={chapters}
              onUpdate={updateSetting}
              onImport={importState} onReset={resetAll} today={today}
              listBackups={listBackups} onRestore={restoreBackup} />
          )}
        </div>
      </main>

      {toast && (
        <div className="cad-toast" role="status">
          <Check size={15} color={C.good} />
          <span style={{ fontFamily: SANS, fontSize: 13 }}>{toast.text}</span>
          <Btn variant="bare" onClick={() => undoReview(toast.entryId)} style={{ color: C.accent, fontSize: 13 }}>
            <Undo2 size={13} /> Annuler
          </Btn>
        </div>
      )}
    </div>
  );
}

/* ================================================================== *
 *  Vue 1 — Aujourd'hui
 * ================================================================== */

function TodayView({
  today, overdue, nextExam, subjectById, annalesBanners, sessions, ranked,
  plannedCount, doneCount, doneByChapter, skippedToday, readinessByExam,
  dailyCapacity, hasCoreChapters, parallelSubjects, parallelLog, settings,
  onGrade, onUndo, onSkip, onUnskip, onAdjustParallel, onGoSubjects, onSetSimpleMode,
}) {
  const [showAll, setShowAll] = useState(false);
  const wk = mondayOf(today);
  const hrs = settings.sessionHours;
  const hLabel = `${hrs} h`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* En-tête : date + anneau de progression + métriques */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        {plannedCount > 0 && <Ring value={doneCount} total={plannedCount} label="progression du jour" />}
        <div>
          <Mono style={{ fontSize: 22, color: C.text, textTransform: 'capitalize' }}>{fmtLongDate(today)}</Mono>
          <div style={{ fontFamily: SANS, fontSize: 12, color: C.faint, marginTop: 2 }}>
            Révise, puis note chaque chapitre : Oublié · Difficile · Bien · Facile
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginLeft: 'auto', flexWrap: 'wrap' }}>
          <Stat label="en retard" value={overdue} unit="chap." tone={overdue ? C.warn : C.good} />
          {nextExam ? (
            <Stat label="prochaine épreuve" value={`J−${nextExam.days}`} unit={nextExam.name} tone={C.accent} />
          ) : (
            <Stat label="prochaine épreuve" value="—" unit="aucune" tone={C.faint} />
          )}
        </div>
      </div>

      {/* Bannières « examen proche » */}
      {annalesBanners.map(({ subject, info }, bi) => (
        <div key={subject.id} className="cad-in cad-card" style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 13px', borderRadius: 9,
          background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.32)',
          animationDelay: `${bi * 50}ms`,
        }}>
          <CalendarDays size={16} color={C.warn} />
          <Pastille color={subject.color} />
          <span style={{ fontFamily: SANS, fontSize: 13.5 }}>
            <b>{subject.name}</b> · examen proche
          </span>
          {readinessByExam[info.exam.id] && (
            <Chip color={thermal((1 - readinessByExam[info.exam.id].avgR) * 4)}
              title="Mémoire moyenne prévue le jour J, si tu ne revois rien d'ici là.">
              mémoire prévue ~{Math.round(readinessByExam[info.exam.id].avgR * 100)} %
            </Chip>
          )}
          <Mono style={{ marginLeft: 'auto', color: C.warn, fontSize: 12 }}>
            {info.exam.name} · J−{info.days}
          </Mono>
        </div>
      ))}

      {/* Alerte de surcharge : le retard dépasse la capacité quotidienne */}
      {overdue > dailyCapacity && (
        <div className="cad-in cad-card" style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 13px', borderRadius: 9,
          background: 'rgba(248,113,113,.08)', border: '1px solid rgba(248,113,113,.35)', flexWrap: 'wrap',
        }}>
          <AlertTriangle size={16} color={C.bad} />
          <span style={{ fontFamily: SANS, fontSize: 13 }}>
            <b>Surcharge</b> · {overdue} chapitres en retard pour ~{dailyCapacity}/jour de capacité
            (≈ {Math.ceil(overdue / Math.max(1, dailyCapacity))} j pour résorber)
          </span>
          <span style={{ fontFamily: SANS, fontSize: 11.5, color: C.dim, marginLeft: 'auto' }}>
            options : +1 matière/jour quelque temps, ou rétention cible à 85 %
          </span>
        </div>
      )}

      {/* Plan du jour */}
      <div>
        <SectionTitle icon={Activity} right={
          ranked.length > 0 ? (
            <Btn variant="bare" onClick={() => setShowAll((v) => !v)} style={{ color: C.dim, fontSize: 12 }}>
              {showAll ? 'voir le plan du jour' : 'voir tout le classement'}
              {showAll ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </Btn>
          ) : null
        }>
          Plan du jour
          <Chip color={C.faint} style={{ marginLeft: 8 }} title="Ta capacité : ce nombre de matières par jour, les plus sous pression d'abord. Les autres montent en priorité les jours suivants.">
            {settings.subjectsPerDay} matières × {hLabel}
          </Chip>
        </SectionTitle>

        {ranked.length === 0 ? (
          <Empty>
            Rien à réviser pour l’instant. <b>Onglet Matières → déplie une UE → ajoute tes chapitres</b>,
            puis crée une épreuve avec sa date.
            <div style={{ marginTop: 10 }}>
              <Btn variant="primary" onClick={onGoSubjects}><Layers size={14} /> Onglet Matières</Btn>
            </div>
          </Empty>
        ) : sessions.length === 0 ? (
          hasCoreChapters ? (
            <div className="cad-in" style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '18px 16px',
              border: `1px solid rgba(52,211,153,.35)`, borderRadius: 9, background: 'rgba(52,211,153,.06)',
            }}>
              <Check size={18} color={C.good} />
              <div style={{ fontFamily: SANS, fontSize: 13.5, lineHeight: 1.5 }}>
                <b style={{ color: C.good }}>Rien d’urgent aujourd’hui — tout est à jour.</b>
                <div style={{ color: C.dim, fontSize: 12.5 }}>
                  Réviser en avance consolide peu : profites-en pour avancer sur les nouvelles notions.
                  La file se remplira toute seule quand des chapitres approcheront de leur échéance.
                </div>
              </div>
            </div>
          ) : (
            <Empty>Tes chapitres sont dans des matières « parallèle ». Passe une UE en « core » (onglet Matières) pour qu’elle entre dans le plan.</Empty>
          )
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '2px 0 14px', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>affichage</span>
              <Segmented value={settings.simpleMode ? 'simple' : 'full'} ariaLabel="Affichage des cartes"
                onChange={(v) => onSetSimpleMode(v === 'simple')}
                options={[{ value: 'simple', label: 'Simple' }, { value: 'full', label: 'Détaillé' }]} />
              <div style={{ flex: 1 }} />
              <ThermalLegend />
            </div>
            {!showAll ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                {sessions.map((session, si) => {
                  const sDone = session.chapters.filter((c) => doneByChapter[c.id]).length;
                  return (
                    <div key={session.subject.id} className="cad-in" style={{ animationDelay: `${si * 70}ms` }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 9 }}>
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          width: 22, height: 22, borderRadius: 6, background: `${session.subject.color}22`,
                          color: session.subject.color, fontFamily: MONO, fontSize: 12, fontWeight: 700,
                        }}>{si + 1}</span>
                        <span style={{ fontFamily: SANS, fontSize: 15.5, fontWeight: 700, color: C.text }}>{session.subject.name}</span>
                        <Chip color={C.dim}>séance ≈ {hLabel}</Chip>
                        <Mono style={{ marginLeft: 'auto', color: sDone === session.chapters.length ? C.good : C.faint, fontSize: 11 }}>
                          {sDone}/{session.chapters.length} fait{sDone > 1 ? 's' : ''}
                          {session.total > session.chapters.length ? ` · +${session.total - session.chapters.length} en attente` : ''}
                        </Mono>
                      </div>
                      <div style={{
                        display: 'flex', flexDirection: 'column', gap: 10,
                        paddingLeft: 11, borderLeft: `2px solid ${session.subject.color}33`,
                      }}>
                        {session.chapters.map((ch, i) => (
                          <QueueCard key={ch.id} idx={i} ch={ch} subject={session.subject}
                            simpleMode={settings.simpleMode} done={doneByChapter[ch.id]}
                            today={today} settings={settings}
                            onGrade={onGrade} onUndo={onUndo} onSkip={onSkip} />
                        ))}
                      </div>
                    </div>
                  );
                })}
                {skippedToday.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontFamily: SANS, fontSize: 12, color: C.faint }}>
                    <span>{skippedToday.length} chapitre{skippedToday.length > 1 ? 's' : ''} reporté{skippedToday.length > 1 ? 's' : ''} aujourd’hui</span>
                    <Btn variant="bare" onClick={onUnskip} style={{ color: C.accent, fontSize: 12 }}>
                      <Undo2 size={13} /> rétablir
                    </Btn>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {ranked.map((ch, i) => (
                  <RankRow key={ch.id} idx={i} ch={ch} subject={subjectById[ch.subjectId]} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Minimums hebdo */}
      {parallelSubjects.length > 0 && (
        <div>
          <SectionTitle icon={Lock}>À tenir cette semaine</SectionTitle>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {parallelSubjects.map((s) => {
              const done = parallelLog?.[wk]?.[s.id] || 0;
              const floor = s.weeklyFloor || 0;
              const below = done < floor;
              return (
                <div key={s.id} className="cad-card" style={{
                  flex: '1 1 220px', minWidth: 200, background: C.panel, borderRadius: 10,
                  border: `1px solid ${below ? 'rgba(251,191,36,.4)' : C.line}`, padding: 12,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Pastille color={s.color} />
                    <span style={{ fontFamily: SANS, fontSize: 13.5, fontWeight: 600 }}>{s.name}</span>
                    <Mono style={{ marginLeft: 'auto', fontSize: 14, color: below ? C.warn : C.good }}>
                      {done}/{floor}
                    </Mono>
                  </div>
                  <div style={{ height: 5, background: C.inset, borderRadius: 3, margin: '9px 0', overflow: 'hidden', border: `1px solid ${C.line}` }}>
                    <div className="cad-bar" style={{ width: `${floor ? clamp((done / floor) * 100, 0, 100) : 0}%`, height: '100%', background: below ? C.warn : C.good, opacity: .7 }} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <IconBtn icon={ChevronLeft} title="−1" onClick={() => onAdjustParallel(s.id, -1)} />
                    <IconBtn icon={Plus} title="+1 séance" onClick={() => onAdjustParallel(s.id, +1)} />
                    {below ? (
                      <Chip color={C.warn} style={{ marginLeft: 'auto' }}><AlertTriangle size={11} /> il en manque</Chip>
                    ) : (
                      <Chip color={C.good} style={{ marginLeft: 'auto' }}><Check size={11} /> c’est bon</Chip>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.faint, marginTop: 8 }}>
            À faire chaque semaine quoi qu’il arrive — même les semaines chargées.
          </div>
        </div>
      )}
    </div>
  );
}

/* ================================================================== *
 *  Vue 2 — Calendrier (épreuves + prévision de charge)
 * ================================================================== */

function monthMatrix(year, month) {
  const first = new Date(year, month, 1);
  const startDay = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

const WEEKDAYS = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];

function CalendarView({ today, exams, subjectById, settings, upcomingExams, dueForecast, readinessByExam }) {
  const t = parseISO(today);
  const [cursor, setCursor] = useState({ y: t.getFullYear(), m: t.getMonth() });
  const cells = monthMatrix(cursor.y, cursor.m);
  const monthLabel = new Date(cursor.y, cursor.m, 1)
    .toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

  const examsByDay = useMemo(() => {
    const map = {};
    for (const e of exams) (map[e.date] ||= []).push(e);
    return map;
  }, [exams]);

  const maxDue = Math.max(1, ...Object.values(dueForecast));

  function annalesShade(iso) {
    let best = null;
    for (const e of exams) {
      const d = daysBetween(iso, e.date);
      if (d >= 0 && d <= settings.examModeThreshold) {
        const sub = subjectById[e.subjectId];
        if (sub && (!best || d < best.d)) best = { color: sub.color, d };
      }
    }
    return best;
  }

  const move = (delta) => setCursor((c) => {
    const d = new Date(c.y, c.m + delta, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  // Charge des 14 prochains jours (liste latérale).
  const nextDays = Array.from({ length: 14 }, (_, i) => {
    const iso = addDays(today, i);
    return { iso, count: dueForecast[iso] || 0 };
  });
  const maxNext = Math.max(1, ...nextDays.map((d) => d.count));

  return (
    <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <div style={{ flex: '1 1 380px', minWidth: 300 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <IconBtn icon={ChevronLeft} title="Mois précédent" onClick={() => move(-1)} />
          <Mono style={{ fontSize: 16, textTransform: 'capitalize', minWidth: 150, textAlign: 'center' }}>{monthLabel}</Mono>
          <IconBtn icon={ChevronRight} title="Mois suivant" onClick={() => move(1)} />
          <Btn variant="bare" style={{ marginLeft: 'auto', color: C.dim, fontSize: 12 }}
            onClick={() => setCursor({ y: t.getFullYear(), m: t.getMonth() })}>aujourd’hui</Btn>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
          {WEEKDAYS.map((d) => (
            <div key={d} style={{ textAlign: 'center', fontFamily: SANS, fontSize: 10.5, color: C.faint, padding: '2px 0' }}>{d}</div>
          ))}
          {cells.map((cell, i) => {
            if (!cell) return <div key={i} />;
            const iso = isoOf(cell);
            const isToday = iso === today;
            const dayExams = examsByDay[iso] || [];
            const shade = annalesShade(iso);
            const due = dueForecast[iso] || 0;
            const titleParts = [
              ...dayExams.map((e) => `${e.name} (${(e.chapterIds || []).length} chap.)`),
              due ? `${due} chapitre${due > 1 ? 's' : ''} à revoir` : null,
            ].filter(Boolean);
            return (
              <div key={i} className="cad-cell" title={titleParts.join('\n')}
                style={{
                  aspectRatio: '1 / 1', borderRadius: 7, padding: 5,
                  background: shade ? `${shade.color}1f` : C.panel2,
                  border: `1px solid ${isToday ? C.accent : C.line}`,
                  display: 'flex', flexDirection: 'column', gap: 3, position: 'relative', overflow: 'hidden',
                }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  {due > 0 && (
                    <Mono style={{ fontSize: 9, color: thermal((due / maxDue) * 4) }}>{due}</Mono>
                  )}
                  <Mono style={{
                    fontSize: 11, color: isToday ? C.accent : C.dim, marginLeft: 'auto',
                    fontWeight: isToday ? 700 : 400,
                  }}>{cell.getDate()}</Mono>
                </div>
                <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {due > 0 && (
                    <div style={{ height: 3, borderRadius: 2, background: C.inset, overflow: 'hidden' }}>
                      <div className="cad-bar" style={{
                        width: `${clamp((due / maxDue) * 100, 8, 100)}%`, height: '100%',
                        background: thermal((due / maxDue) * 4), opacity: .85,
                      }} />
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                    {dayExams.map((e) => (
                      <span key={e.id} style={{
                        height: 6, minWidth: 6, flex: dayExams.length > 1 ? '1 1 auto' : '0 0 auto',
                        borderRadius: 3, background: subjectById[e.subjectId]?.color || C.dim,
                      }} />
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 10, fontFamily: SANS, fontSize: 11, color: C.faint, flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 18, height: 10, borderRadius: 3, background: '#fbbf241f', border: `1px solid ${C.line}` }} /> fenêtre « examen proche »
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 18, height: 4, borderRadius: 2, background: thermal(2.5) }} /> chapitres à revoir ce jour-là
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, border: `1px solid ${C.accent}` }} /> aujourd’hui
          </span>
        </div>
      </div>

      <div style={{ flex: '1 1 260px', minWidth: 250, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div>
          <SectionTitle icon={CalendarDays}>Épreuves à venir</SectionTitle>
          {upcomingExams.length === 0 ? (
            <Empty>Aucune épreuve. <b>Onglet Matières → ajoute une épreuve à une UE</b> (nom, date, chapitres couverts).</Empty>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {upcomingExams.map((e, ei) => {
                const sub = subjectById[e.subjectId];
                const annales = e.days <= settings.examModeThreshold;
                return (
                  <div key={e.id} className="cad-card cad-in" style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 9, padding: 11, animationDelay: `${ei * 45}ms` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Pastille color={sub?.color || C.dim} />
                      <span style={{ fontFamily: SANS, fontSize: 13.5, fontWeight: 600 }}>{e.name}</span>
                      <Mono style={{ marginLeft: 'auto', fontSize: 14, color: annales ? C.warn : C.accent }}>J−{e.days}</Mono>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7, flexWrap: 'wrap' }}>
                      <Mono style={{ fontSize: 11, color: C.dim }}>{fmtShortDate(e.date)}</Mono>
                      <Chip color={C.dim}>{(e.chapterIds || []).length} chap.</Chip>
                      {annales && <Chip color={C.warn}><CalendarDays size={11} /> examen proche</Chip>}
                    </div>
                    {readinessByExam?.[e.id] && (() => {
                      const r = readinessByExam[e.id];
                      const col = thermal((1 - r.avgR) * 4);
                      return (
                        <div title="Mémoire moyenne prévue le jour J, si tu ne revois rien d'ici là."
                          style={{ marginTop: 8 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>mémoire prévue le jour J</span>
                            <Mono style={{ fontSize: 12, color: col, fontWeight: 700 }}>~{Math.round(r.avgR * 100)} %</Mono>
                            {r.weak > 0 && (
                              <Chip color={C.warn} style={{ marginLeft: 'auto' }}>
                                <AlertTriangle size={11} /> {r.weak} fragile{r.weak > 1 ? 's' : ''}
                              </Chip>
                            )}
                          </div>
                          <div style={{ height: 5, background: C.inset, borderRadius: 3, marginTop: 5, overflow: 'hidden', border: `1px solid ${C.line}` }}>
                            <div className="cad-bar" style={{ width: `${clamp(r.avgR, 0, 1) * 100}%`, height: '100%', background: col, opacity: .8 }} />
                          </div>
                          {r.weak > 0 && (
                            <div style={{ fontFamily: SANS, fontSize: 10.5, color: C.faint, marginTop: 4 }}>
                              le plus fragile : {r.per[0].chapter.name} (~{Math.round(r.per[0].projR * 100)} %)
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <SectionTitle icon={TrendingUp}>Charge à venir (14 j)</SectionTitle>
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 5 }}>
            {nextDays.map((d, i) => (
              <div key={d.iso} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Mono style={{ fontSize: 10.5, color: i === 0 ? C.accent : C.faint, width: 64 }}>
                  {i === 0 ? 'auj.' : fmtShortDate(d.iso)}
                </Mono>
                <div style={{ flex: 1, height: 7, background: C.inset, borderRadius: 4, overflow: 'hidden', border: `1px solid ${C.line}` }}>
                  <div className="cad-bar" style={{
                    width: `${(d.count / maxNext) * 100}%`, height: '100%',
                    background: d.count ? thermal((d.count / maxNext) * 4) : 'transparent', opacity: .85,
                  }} />
                </div>
                <Mono style={{ fontSize: 10.5, color: d.count ? C.dim : C.faint, width: 18, textAlign: 'right' }}>{d.count || '·'}</Mono>
              </div>
            ))}
          </div>
          <div style={{ fontFamily: SANS, fontSize: 11, color: C.faint, marginTop: 7 }}>
            Nombre de chapitres qui arrivent à échéance chaque jour (rétention cible {Math.round(settings.requestRetention * 100)} %).
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================================================================== *
 *  Vue 3 — Matières
 * ================================================================== */

function LevelPicker({ current, onPick, compact }) {
  const active = closestLevel(current);
  return (
    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
      {LEVELS.map((l) => {
        const on = l.key === active.key;
        return (
          <button key={l.key} type="button" onClick={() => onPick(l)}
            title={`repartir de « ${l.label} »`}
            style={{
              fontFamily: SANS, fontSize: compact ? 11 : 12, padding: compact ? '3px 8px' : '4px 10px',
              borderRadius: 999, cursor: 'pointer',
              border: `1px solid ${on ? 'rgba(94,169,255,.5)' : C.line2}`,
              background: on ? 'rgba(94,169,255,.14)' : 'transparent',
              color: on ? '#dbeafe' : C.dim,
            }}>
            {l.label}
          </button>
        );
      })}
    </div>
  );
}

function SubjectsView({
  subjects, chapters, exams, settings, today,
  onAddSubject, onUpdateSubject, onDeleteSubject,
  onAddChapter, onUpdateChapter, onDeleteChapter, onSetLevel,
  onAddExam, onUpdateExam, onDeleteExam, onToggleExamChapter,
}) {
  const [open, setOpen] = useState({});
  const toggle = (id) => setOpen((o) => ({ ...o, [id]: !o[id] }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionTitle icon={Layers}>Matières (UE)</SectionTitle>

      {subjects.map((s, sidx) => {
        const isCore = s.type === 'core';
        const subChapters = chapters.filter((c) => c.subjectId === s.id);
        const subExams = exams.filter((e) => e.subjectId === s.id);
        const expanded = !!open[s.id];
        return (
          <div key={s.id} className="cad-in" style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, animationDelay: `${Math.min(sidx, 8) * 40}ms` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, flexWrap: 'wrap' }}>
              {isCore ? (
                <button onClick={() => toggle(s.id)} aria-label="déplier" style={{
                  background: 'transparent', border: 'none', cursor: 'pointer', color: C.dim, display: 'flex', padding: 2,
                }}>
                  <ChevronRight size={18} style={{ transition: 'transform .22s var(--ease)', transform: expanded ? 'rotate(90deg)' : 'none' }} />
                </button>
              ) : <span style={{ width: 22 }} />}

              <input type="color" value={s.color} aria-label="couleur"
                onChange={(e) => onUpdateSubject(s.id, { color: e.target.value })}
                style={{ width: 26, height: 26, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }} />

              <TextInput value={s.name} onChange={(v) => onUpdateSubject(s.id, { name: v })} ariaLabel="nom de la matière" style={{ maxWidth: 280 }} />

              {isCore && subChapters.length > 0 && (
                <Chip color={C.dim} title="chapitres">{subChapters.length} chap.</Chip>
              )}

              <button onClick={() => onUpdateSubject(s.id, { type: isCore ? 'parallel' : 'core', weeklyFloor: isCore ? 4 : undefined })}
                title="core = planifiée par CADENCE · parallèle = minimum hebdo à tenir"
                style={{ background: 'transparent', border: `1px solid ${C.line}`, color: C.faint, borderRadius: 7, fontSize: 11, padding: '4px 7px', cursor: 'pointer', fontFamily: SANS }}>
                ↔ {isCore ? 'parallèle' : 'core'}
              </button>

              {!isCore && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>minimum</span>
                  <input type="number" min={0} max={20} value={s.weeklyFloor ?? 0}
                    onChange={(e) => onUpdateSubject(s.id, { weeklyFloor: Math.max(0, Number(e.target.value) || 0) })}
                    aria-label="minimum hebdo"
                    style={{ width: 52, fontFamily: MONO, fontSize: 13, color: C.text, background: C.inset, border: `1px solid ${C.line2}`, borderRadius: 6, padding: '5px 6px' }} />
                  <span style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>/sem</span>
                </div>
              )}

              <div style={{ marginLeft: 'auto' }}>
                <IconBtn icon={Trash2} danger title="Supprimer la matière"
                  onClick={() => { if (confirm(`Supprimer « ${s.name} » et tout son contenu ?`)) onDeleteSubject(s.id); }} />
              </div>
            </div>

            {isCore && expanded && (
              <div style={{ borderTop: `1px solid ${C.line}`, padding: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
                {/* Chapitres */}
                <div>
                  <SectionTitle icon={BookOpen}>Chapitres</SectionTitle>
                  {subChapters.length === 0 && (
                    <Empty>Aucun chapitre. Ajoute-les ci-dessous, puis choisis leur niveau de départ.</Empty>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
                    {subChapters.map((c) => {
                      const m = chapterMetrics(c, exams, settings, today);
                      const tcol = thermal(m.priority);
                      const since = c.lastReviewed
                        ? (m.since === 0 ? 'revu aujourd’hui' : `revu il y a ${m.since} j`)
                        : 'jamais révisé';
                      return (
                        <div key={c.id} className="cad-card" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, background: C.panel2, border: `1px solid ${C.line}`, borderLeft: `3px solid ${tcol}`, borderRadius: 8 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <MemGauge R={m.R} size={26} />
                            <TextInput value={c.name} onChange={(v) => onUpdateChapter(c.id, { name: v })} ariaLabel="nom du chapitre" />
                            <IconBtn icon={Trash2} danger title="Supprimer le chapitre" onClick={() => onDeleteChapter(c.id)} />
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', paddingLeft: 34 }}>
                            <Pencil size={12} color={C.faint} />
                            <span style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>niveau</span>
                            <LevelPicker compact current={c.difficulty} onPick={(l) => onSetLevel(c.id, l)} />
                            <Mono style={{ fontSize: 11, color: C.faint }}>
                              · {since} · prochaine {m.dueIn <= 0 ? 'auj.' : `dans ~${m.dueIn} j`} · solidité {round1(m.stability)} j
                            </Mono>
                          </div>
                          <div style={{ paddingLeft: 34 }}>
                            <PriorityReader m={m} compact />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <AddRow placeholder="Nouveau chapitre (ex. Réduction des endomorphismes)" cta="Chapitre" onAdd={(name) => onAddChapter(s.id, name)} />
                </div>

                {/* Épreuves */}
                <div>
                  <SectionTitle icon={FlaskConical}>Épreuves</SectionTitle>
                  {subChapters.length === 0 ? (
                    <Empty>Ajoute d’abord des chapitres : une épreuve couvre une sélection de chapitres.</Empty>
                  ) : (
                    <>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
                        {subExams.map((e) => {
                          const days = daysBetween(today, e.date);
                          return (
                            <div key={e.id} style={{ padding: 10, background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                <TextInput value={e.name} onChange={(v) => onUpdateExam(e.id, { name: v })} ariaLabel="nom de l'épreuve" style={{ maxWidth: 220 }} />
                                <TextInput type="date" value={e.date} onChange={(v) => onUpdateExam(e.id, { date: v })} ariaLabel="date de l'épreuve" style={{ maxWidth: 160 }} />
                                <Mono style={{ fontSize: 12, color: days < 0 ? C.faint : (days <= settings.examModeThreshold ? C.warn : C.accent) }}>
                                  {days < 0 ? 'passée' : `J−${days}`}
                                </Mono>
                                <div style={{ marginLeft: 'auto' }}>
                                  <IconBtn icon={Trash2} danger title="Supprimer l'épreuve" onClick={() => onDeleteExam(e.id)} />
                                </div>
                              </div>
                              <div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: SANS, fontSize: 11, color: C.faint, marginBottom: 5 }}>
                                  <span>Chapitres couverts ({(e.chapterIds || []).length})</span>
                                  <button type="button" onClick={() => onUpdateExam(e.id, { chapterIds: subChapters.map((c) => c.id) })}
                                    style={{ fontFamily: SANS, fontSize: 10.5, color: C.accent, background: 'transparent', border: 'none', cursor: 'pointer', padding: '1px 4px' }}>
                                    tout
                                  </button>
                                  <span style={{ color: C.line2 }}>·</span>
                                  <button type="button" onClick={() => onUpdateExam(e.id, { chapterIds: [] })}
                                    style={{ fontFamily: SANS, fontSize: 10.5, color: C.dim, background: 'transparent', border: 'none', cursor: 'pointer', padding: '1px 4px' }}>
                                    aucun
                                  </button>
                                </div>
                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                  {subChapters.map((c) => {
                                    const on = (e.chapterIds || []).includes(c.id);
                                    return (
                                      <button key={c.id} onClick={() => onToggleExamChapter(e.id, c.id)} style={{
                                        display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer',
                                        fontFamily: SANS, fontSize: 12, padding: '4px 9px', borderRadius: 999,
                                        border: `1px solid ${on ? 'rgba(94,169,255,.5)' : C.line2}`,
                                        background: on ? 'rgba(94,169,255,.14)' : 'transparent',
                                        color: on ? '#dbeafe' : C.dim,
                                      }}>
                                        {on ? <Check size={12} /> : <Plus size={12} />} {c.name}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <AddExam subjectId={s.id} today={today} onAdd={onAddExam} />
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div style={{ marginTop: 4 }}>
        <AddRow placeholder="Nouvelle matière (ex. Thermodynamique)" cta="Matière" onAdd={onAddSubject} />
      </div>
    </div>
  );
}

function AddExam({ subjectId, today, onAdd }) {
  const [name, setName] = useState('');
  const [date, setDate] = useState(addDays(today, 14));
  const add = () => {
    const n = name.trim();
    if (!n) return;
    onAdd(subjectId, { name: n, date, chapterIds: [] });
    setName('');
    setDate(addDays(today, 14));
  };
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <TextInput value={name} onChange={setName} placeholder="Nouvelle épreuve (ex. CC1, partiel)" style={{ maxWidth: 240 }}
        onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
      <TextInput type="date" value={date} onChange={setDate} style={{ maxWidth: 160 }} />
      <Btn variant="primary" onClick={add}><Plus size={14} /> Épreuve</Btn>
      <span style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>tu choisiras les chapitres couverts ensuite</span>
    </div>
  );
}

/* ================================================================== *
 *  Vue 4 — Progrès (statistiques dérivées du journal)
 * ================================================================== */

function ProgressView({ reviewLog, ranked, today, subjects, settings }) {
  // Révisions par jour (30 derniers jours).
  const days = Array.from({ length: 30 }, (_, i) => addDays(today, i - 29));
  const byDay = {};
  for (const r of reviewLog) byDay[r.date] = (byDay[r.date] || 0) + 1;
  const maxDay = Math.max(1, ...days.map((d) => byDay[d] || 0));

  // Série de jours consécutifs avec au moins une révision.
  let streak = 0;
  for (let i = 0; ; i++) {
    const iso = addDays(today, -i);
    if (byDay[iso]) streak++;
    else if (i === 0) continue; // aujourd'hui pas encore fait ne casse pas la série
    else break;
    if (i > 3650) break;
  }

  const reviewed = ranked.filter((c) => c.R != null);
  const avgR = reviewed.length
    ? reviewed.reduce((a, c) => a + c.R, 0) / reviewed.length : null;
  const fresh = ranked.filter((c) => c.urgency < 1).length;
  const calib = observedRetention(reviewLog);

  const gradeCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const r of reviewLog) gradeCounts[r.grade] = (gradeCounts[r.grade] || 0) + 1;
  const totalGrades = Math.max(1, reviewLog.length);

  // Mémoire moyenne par matière (chapitres déjà revus).
  const bySubject = (subjects || []).filter((s) => s.type === 'core').map((s) => {
    const chs = ranked.filter((c) => c.subjectId === s.id);
    const revued = chs.filter((c) => c.R != null);
    const avg = revued.length ? revued.reduce((a, c) => a + c.R, 0) / revued.length : null;
    const late = chs.filter((c) => c.urgency >= 1).length;
    return { subject: s, avg, late, total: chs.length };
  }).filter((x) => x.total > 0).sort((a, b) => (a.avg ?? 0) - (b.avg ?? 0));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <SectionTitle icon={TrendingUp}>Progrès</SectionTitle>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Stat label="série" value={streak} unit={`jour${streak > 1 ? 's' : ''} d’affilée`} tone={streak > 0 ? C.warn : C.faint} />
        <Stat label="révisions (total)" value={reviewLog.length} unit="notées" tone={C.accent} />
        <Stat label="mémoire moyenne" value={avgR != null ? `${Math.round(avgR * 100)}%` : '—'}
          unit={reviewed.length ? `${reviewed.length} chap.` : 'aucun chapitre revu'} tone={avgR != null ? thermal((1 - avgR) * 4) : C.faint} />
        <Stat label="à jour" value={`${fresh}/${ranked.length}`} unit="chapitres" tone={ranked.length && fresh === ranked.length ? C.good : C.dim} />
        {calib.n >= 5 && (
          <Stat label="rétention observée" value={`${Math.round(calib.rate * 100)}%`}
            unit={`cible ${Math.round((settings?.requestRetention ?? 0.9) * 100)} % · ${calib.n} rév.`}
            tone={calib.rate >= (settings?.requestRetention ?? 0.9) - 0.05 ? C.good : C.warn} />
        )}
      </div>
      {calib.n >= 5 && calib.rate < (settings?.requestRetention ?? 0.9) - 0.07 && (
        <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.warn }}>
          Tu retiens moins que la cible : resserre les révisions (monte la rétention cible)
          ou allège les chapitres trop denses en les découpant.
        </div>
      )}

      <div>
        <SectionTitle icon={Activity}>Révisions des 30 derniers jours</SectionTitle>
        {reviewLog.length === 0 ? (
          <Empty>Encore aucune révision notée. Après chaque séance, note le chapitre (Oublié · Difficile · Bien · Facile) : tout s’enregistre ici.</Empty>
        ) : (
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14 }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 110 }}>
              {days.map((d) => {
                const n = byDay[d] || 0;
                return (
                  <div key={d} title={`${fmtShortDate(d)} : ${n} révision${n > 1 ? 's' : ''}`}
                    style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }}>
                    <div className="cad-bar" style={{
                      height: `${n ? 8 + (n / maxDay) * 92 : 2}%`,
                      background: n ? (d === today ? C.accent : `${C.accent}88`) : C.line,
                      borderRadius: '2px 2px 0 0',
                    }} />
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontFamily: MONO, fontSize: 10.5, color: C.faint }}>
              <span>{fmtShortDate(days[0])}</span>
              <span>aujourd’hui</span>
            </div>
          </div>
        )}
      </div>

      {bySubject.length > 0 && (
        <div>
          <SectionTitle icon={Layers}>Mémoire par matière</SectionTitle>
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {bySubject.map(({ subject, avg, late, total }) => {
              const col = avg != null ? thermal((1 - avg) * 4) : C.faint;
              return (
                <div key={subject.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Pastille color={subject.color} size={8} />
                  <span style={{ fontFamily: SANS, fontSize: 12.5, color: C.text, width: 170, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {subject.name}
                  </span>
                  <div style={{ flex: 1, height: 8, background: C.inset, borderRadius: 4, overflow: 'hidden', border: `1px solid ${C.line}` }}>
                    <div className="cad-bar" style={{ width: `${avg != null ? avg * 100 : 0}%`, height: '100%', background: col, opacity: .8 }} />
                  </div>
                  <Mono style={{ fontSize: 11, color: col, width: 40, textAlign: 'right' }}>
                    {avg != null ? `${Math.round(avg * 100)}%` : '—'}
                  </Mono>
                  <Mono style={{ fontSize: 10.5, color: late ? C.warn : C.faint, width: 70, textAlign: 'right' }}>
                    {late ? `${late} en retard` : 'à jour'}
                  </Mono>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {reviewLog.length > 0 && (
        <div>
          <SectionTitle icon={Check}>Répartition des notes</SectionTitle>
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[1, 2, 3, 4].map((g) => {
              const G = GRADES[g];
              const n = gradeCounts[g] || 0;
              return (
                <div key={g} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontFamily: SANS, fontSize: 12, color: G.color, width: 70, fontWeight: 600 }}>{G.label}</span>
                  <div style={{ flex: 1, height: 9, background: C.inset, borderRadius: 5, overflow: 'hidden', border: `1px solid ${C.line}` }}>
                    <div className="cad-bar" style={{ width: `${(n / totalGrades) * 100}%`, height: '100%', background: G.color, opacity: .75 }} />
                  </div>
                  <Mono style={{ fontSize: 11, color: C.dim, width: 56, textAlign: 'right' }}>
                    {n} · {Math.round((n / totalGrades) * 100)}%
                  </Mono>
                </div>
              );
            })}
            <div style={{ fontFamily: SANS, fontSize: 11, color: C.faint, marginTop: 4 }}>
              Beaucoup de « Facile » ? Espace davantage (baisse la rétention cible). Beaucoup d’« Oublié » ? Resserre (monte-la).
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ================================================================== *
 *  Vue 5 — Réglages
 * ================================================================== */

const SLIDERS = [
  { key: 'requestRetention', label: 'Rétention cible', min: 0.8, max: 0.97, step: 0.01, fmt: (v) => `${Math.round(v * 100)} %`, help: 'tu revois quand il te reste ce niveau en mémoire — plus haut = plus de révisions' },
  { key: 'subjectsPerDay', label: 'Matières par jour', min: 1, max: 6, step: 1, unit: '', help: 'ta capacité quotidienne' },
  { key: 'sessionHours', label: 'Durée d’une séance', min: 1, max: 4, step: 0.5, unit: ' h', help: 'temps par matière' },
  { key: 'minutesPerChapter', label: 'Minutes par chapitre', min: 10, max: 60, step: 5, unit: ' min', help: 'sert à estimer le nombre de chapitres par séance' },
  { key: 'maxExamPressure', label: 'Pression d’examen max', min: 1, max: 10, step: 0.5, unit: '×', help: 'multiplicateur au jour J' },
  { key: 'pressureHorizon', label: 'Horizon de pression', min: 7, max: 90, step: 1, unit: ' j', help: 'au-delà, l’examen n’influe pas' },
  { key: 'examModeThreshold', label: 'Seuil « examen proche »', min: 3, max: 45, step: 1, unit: ' j', help: 'à partir de combien de jours une UE est signalée' },
];

const ADVANCED_SLIDERS = [
  { key: 'minInterval', label: 'Stabilité initiale « Jamais vu »', min: 1, max: 7, step: 1, unit: ' j', help: 'point de départ des nouveaux chapitres' },
  { key: 'maxInterval', label: 'Stabilité initiale « Solide »', min: 7, max: 60, step: 1, unit: ' j', help: 'point de départ d’un chapitre déjà maîtrisé' },
];

function SettingsView({ settings, state, chapters, onUpdate, onImport, onReset, today, listBackups, onRestore }) {
  const fileRef = useRef(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const backups = listBackups ? listBackups() : [];

  // Compromis rétention <-> travail, calculé sur TES chapitres (live).
  const load = chapters?.length ? cruiseLoad(chapters, settings) : null;
  const dailyCap = Math.max(1, Math.round((settings.sessionHours * 60) / settings.minutesPerChapter)) * settings.subjectsPerDay;

  const exportJSON = () => {
    try {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `cadence-${today}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { alert('Export impossible dans cet environnement.'); }
  };
  const onFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try { onImport(JSON.parse(String(reader.result))); }
      catch (err) { alert('Import impossible : JSON invalide.'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // Aperçus live.
  const N = 24;
  const bars = Array.from({ length: N + 1 }, (_, i) => {
    const j = Math.round((settings.pressureHorizon * i) / N);
    return { j, mult: examMultiplier(j, settings) };
  });
  const sampleS = targetInterval(66, settings); // niveau « Moyen »
  const dueAt = optimalInterval(sampleS, settings.requestRetention);
  const fSpan = Math.max(dueAt * 1.9, sampleS * 1.6, 4);
  const fBars = Array.from({ length: 21 }, (_, i) => {
    const t = (fSpan * i) / 20;
    return { t, R: retrievability(t, sampleS) };
  });

  const renderSlider = (sl) => (
    <div key={sl.key}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <span style={{ fontFamily: SANS, fontSize: 13, color: C.text }}>{sl.label}</span>
        <Mono style={{ marginLeft: 'auto', fontSize: 14, color: C.accent }}>
          {sl.fmt ? sl.fmt(settings[sl.key]) : `${settings[sl.key]}${sl.unit}`}
        </Mono>
      </div>
      <Range value={settings[sl.key]} min={sl.min} max={sl.max} step={sl.step}
        ariaLabel={sl.label}
        onChange={(v) => onUpdate(sl.key, v)} />
      <div style={{ fontFamily: SANS, fontSize: 11, color: C.faint, marginTop: 3 }}>{sl.help}</div>
      {sl.key === 'requestRetention' && load != null && (
        <div style={{
          fontFamily: MONO, fontSize: 11.5, marginTop: 5,
          color: load > dailyCap ? C.warn : C.good,
        }}>
          charge de croisière ≈ {load < 0.95 ? round1(load) : Math.round(load)} chap./jour
          <span style={{ color: C.faint }}> · ta capacité : {dailyCap}/jour</span>
          {load > dailyCap ? ' — trop haut, baisse la rétention' : ''}
        </div>
      )}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <SectionTitle icon={Activity}>Affichage</SectionTitle>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: SANS, fontSize: 13, color: C.text }}>Cartes du soir</span>
          <Segmented value={settings.simpleMode ? 'simple' : 'full'} ariaLabel="Affichage des cartes"
            onChange={(v) => onUpdate('simpleMode', v === 'simple')}
            options={[{ value: 'simple', label: 'Simple' }, { value: 'full', label: 'Détaillé' }]} />
          <span style={{ fontFamily: SANS, fontSize: 11.5, color: C.faint, flex: '1 1 240px' }}>
            Simple = jauge, raison et notation. Détaillé = chiffres du moteur toujours visibles.
          </span>
        </div>
        <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.faint, marginTop: 8 }}>
          Astuce clavier : <Mono color={C.dim}>Tab</Mono> pour sélectionner une carte, puis
          <Mono color={C.dim}> 1</Mono>–<Mono color={C.dim}>4</Mono> pour noter
          (Oublié · Difficile · Bien · Facile).
        </div>
      </div>

      <SectionTitle icon={SettingsIcon}>Réglages du moteur</SectionTitle>

      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 320px', minWidth: 280, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {SLIDERS.map(renderSlider)}

          <div>
            <Btn variant="bare" onClick={() => setShowAdvanced((v) => !v)} style={{ color: C.dim, fontSize: 12, paddingLeft: 0 }}>
              <ChevronRight size={14} style={{ transition: 'transform .22s var(--ease)', transform: showAdvanced ? 'rotate(90deg)' : 'none' }} />
              réglages avancés
            </Btn>
            <div className={`cad-collapse${showAdvanced ? ' open' : ''}`}>
              <div className="cad-collapse-in" {...(showAdvanced ? {} : { inert: '' })}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 10 }}>
                  {ADVANCED_SLIDERS.map(renderSlider)}
                  <div style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>
                    Le moteur FSRS ajuste ensuite la stabilité et la difficulté de chaque
                    chapitre à partir de tes notes (Oublié · Difficile · Bien · Facile).
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div style={{ flex: '1 1 320px', minWidth: 280 }}>
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14 }}>
            <div style={{ fontFamily: SANS, fontSize: 12, color: C.dim, marginBottom: 10 }}>
              Multiplicateur d’examen selon les jours restants
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 120 }}>
              {bars.map((b, i) => {
                const denom = Math.max(0.0001, settings.maxExamPressure - 1);
                const h = clamp((b.mult - 1) / denom, 0, 1);
                return (
                  <div key={i} title={`J−${b.j} → ×${f2(b.mult)}`} style={{
                    flex: 1, height: `${6 + h * 94}%`, background: thermal(b.mult),
                    borderRadius: '2px 2px 0 0', opacity: .9,
                    transition: 'height .28s var(--ease), background .28s var(--ease)',
                  }} />
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontFamily: MONO, fontSize: 10.5, color: C.faint }}>
              <span>J−{settings.pressureHorizon}</span>
              <span>J−{Math.round(settings.pressureHorizon / 2)}</span>
              <span>jour J</span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, fontFamily: MONO, fontSize: 11, color: C.dim, flexWrap: 'wrap' }}>
              <span>×{f2(examMultiplier(settings.pressureHorizon, settings))}</span>
              <span>→ ×{f2(examMultiplier(Math.round(settings.pressureHorizon / 2), settings))}</span>
              <span>→ ×{f2(examMultiplier(0, settings))} au jour J</span>
            </div>
          </div>

          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14, marginTop: 12 }}>
            <div style={{ fontFamily: SANS, fontSize: 12, color: C.dim, marginBottom: 10 }}>
              Courbe d’oubli &amp; moment de révision
            </div>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', gap: 2, height: 96 }}>
              {fBars.map((b, i) => (
                <div key={i} title={`${Math.round(b.t)} j → mémoire ${Math.round(b.R * 100)}%`} style={{
                  flex: 1, height: `${4 + b.R * 96}%`, background: thermal((1 - b.R) * 4),
                  borderRadius: '2px 2px 0 0', opacity: 0.9,
                  transition: 'height .28s var(--ease), background .28s var(--ease)',
                }} />
              ))}
              <div title={`révision visée à ~${Math.round(dueAt)} j`} style={{
                position: 'absolute', top: 0, bottom: 0, left: `${clamp((dueAt / fSpan) * 100, 0, 100)}%`,
                borderLeft: `1px dashed ${C.accent}`, transition: 'left .28s var(--ease)',
              }} />
            </div>
            <div style={{ fontFamily: MONO, fontSize: 11, color: C.dim, marginTop: 8 }}>
              révision visée à ~{Math.round(dueAt)} j (mémoire {Math.round(settings.requestRetention * 100)} %),
              solidité {round1(sampleS)} j (niveau « Moyen »)
            </div>
          </div>
        </div>
      </div>

      <div>
        <SectionTitle icon={Download}>Données &amp; sauvegarde</SectionTitle>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Btn onClick={exportJSON}><Download size={14} /> Exporter (JSON)</Btn>
          <Btn onClick={() => fileRef.current?.click()}><Upload size={14} /> Importer (JSON)</Btn>
          <input ref={fileRef} type="file" accept="application/json,.json" onChange={onFile} style={{ display: 'none' }} />
          <Btn variant="danger" onClick={onReset}><RotateCcw size={14} /> Réinitialiser</Btn>
        </div>
        {backups.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontFamily: SANS, fontSize: 12, color: C.dim, marginBottom: 7 }}>
              Sauvegardes automatiques (7 jours glissants) — restaurer :
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {backups.map((d) => (
                <button key={d} type="button" onClick={() => onRestore(d)}
                  title={`Restaurer l'état du ${d}`}
                  style={{
                    fontFamily: MONO, fontSize: 11.5, padding: '4px 10px', borderRadius: 999,
                    cursor: 'pointer', border: `1px solid ${C.line2}`, background: 'transparent',
                    color: d === today ? C.accent : C.dim,
                  }}>
                  {d === today ? `${d} (auj.)` : d}
                </button>
              ))}
            </div>
          </div>
        )}
        <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.faint, marginTop: 10, lineHeight: 1.5, maxWidth: 620 }}>
          Tout est stocké localement sur cet appareil (une seule clé <Mono color={C.dim}>{STORAGE_KEY}</Mono>),
          avec repli en mémoire si le stockage est indisponible — rien n’est envoyé sur un serveur.
          Une sauvegarde automatique est prise chaque jour (7 conservées).
          L’appli est <b>installable</b> (« Ajouter à l’écran d’accueil ») et fonctionne <b>hors-ligne</b>.
          Exporte de temps en temps quand même : c’est ta sauvegarde externe.
        </div>
      </div>
    </div>
  );
}
