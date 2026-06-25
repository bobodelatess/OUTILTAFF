/*
 * CADENCE — planificateur d'étude piloté par les examens.
 *
 * Répétition espacée au niveau CHAPITRE (pas carte), avec une couche
 * examens + calendrier + interleaving. Outil quotidien privé.
 *
 * Idée centrale : priorité = urgence_de_péremption × pression_d'examen.
 * La pression d'examen MULTIPLIE (un chapitre faible dont l'examen approche
 * explose ; un chapitre solide ne monte qu'un peu).
 *
 * Un seul fichier. Le moteur de priorité est exporté (fonctions pures) pour
 * être testé ; le composant par défaut est l'application.
 *
 * Modèle de données
 *   Subject  = { id, name, color, type: 'core' | 'parallel', weeklyFloor? }
 *   Chapter  = { id, subjectId, name, mastery: 0..100, lastReviewed: ISODate|null,
 *                stability?: number }   // stabilité de mémoire (jours), grandit aux révisions
 *   Exam     = { id, subjectId, name, date: ISODate, chapterIds: string[] }
 *   Settings = { minInterval, maxInterval, maxExamPressure, pressureHorizon,
 *                examModeThreshold, requestRetention, subjectsPerDay,
 *                sessionHours, minutesPerChapter, simpleMode }
 *   State    = { subjects, chapters, exams, settings, parallelLog }
 *   parallelLog : { [lundiISO]: { [subjectId]: nbSéances } }
 *
 * Espacement (science) : courbe d'oubli en loi de puissance + stabilité de
 * mémoire qui grandit à chaque révision (intervalles expansifs), gain modulé
 * par l'effet d'espacement (réviser près du seuil d'oubli) et la maîtrise.
 * Plan du jour borné par la capacité (N matières × H heures).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, CalendarDays, Layers, Settings as SettingsIcon,
  Plus, Trash2, ChevronDown, ChevronRight, ChevronLeft, Check,
  Download, Upload, RotateCcw, AlertTriangle, Lock,
  BookOpen, FlaskConical, Flame, Pencil,
} from 'lucide-react';

/* ------------------------------------------------------------------ *
 *  Constantes
 * ------------------------------------------------------------------ */

const STORAGE_KEY = 'cadence.v1';

export const DEFAULT_SETTINGS = {
  minInterval: 2,
  maxInterval: 30,
  maxExamPressure: 5,
  pressureHorizon: 35,
  examModeThreshold: 21,
  requestRetention: 0.9, // rétention cible : on revoit quand R retombe à ce niveau
  subjectsPerDay: 3,     // capacité : nombre de matières par jour
  sessionHours: 2,       // durée d'une séance par matière
  minutesPerChapter: 30, // estimation -> nb de chapitres par séance
  simpleMode: true,      // cartes du soir épurées (chiffres derrière « détails »)
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

// Rampe thermique : froid (calme/maîtrisé) -> ambre -> rouge (urgent).
const RAMP = [
  [0.0, [56, 189, 248]],
  [0.3, [45, 212, 191]],
  [0.55, [250, 204, 21]],
  [0.8, [251, 146, 60]],
  [1.0, [239, 68, 68]],
];

/* ------------------------------------------------------------------ *
 *  Utilitaires
 * ------------------------------------------------------------------ */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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
export function todayISO() {
  return isoOf(new Date());
}
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
  const offset = (d.getDay() + 6) % 7; // lundi = 0 … dimanche = 6
  d.setDate(d.getDate() - offset);
  return isoOf(d);
}

const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const f2 = (x) => x.toFixed(2);

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

/* ------------------------------------------------------------------ *
 *  Moteur de priorité (fonctions pures, testées)
 * ------------------------------------------------------------------ */

// 1. Stabilité de mémoire initiale (jours) selon la maîtrise auto-évaluée :
//    interpolation géométrique. Point de départ ; la stabilité grandit ensuite
//    à chaque révision réussie (intervalles expansifs).
export function targetInterval(mastery, s) {
  const m = clamp(mastery, 0, 100);
  return s.minInterval * Math.pow(s.maxInterval / s.minInterval, m / 100);
}

// Courbe d'oubli en loi de puissance (Wixted ; FSRS) — meilleur ajustement que
// l'exponentielle. R(t) = (1 + FACTOR·t/S)^DECAY, calée pour que R(S) = 90 %.
const DECAY = -0.5;
const FACTOR = 0.9 ** (1 / DECAY) - 1; // ≈ 0.2345

// Rétrievabilité : probabilité de te rappeler le chapitre après t jours.
export function retrievability(daysSince, stability) {
  if (stability <= 0) return 0;
  return Math.pow(1 + FACTOR * Math.max(0, daysSince) / stability, DECAY);
}

// Intervalle optimal pour viser une rétention cible (ex. 90 %).
// R(I) = RT  ⇒  I = S·(RT^(1/DECAY) − 1)/FACTOR. À 90 %, I = S.
export function optimalInterval(stability, requestRetention) {
  const rt = clamp(requestRetention ?? 0.9, 0.5, 0.99);
  return stability * (Math.pow(rt, 1 / DECAY) - 1) / FACTOR;
}

// Stabilité courante (mémorisée si dispo, sinon dérivée de la maîtrise).
export function chapterStability(chapter, s) {
  return chapter.stability != null ? chapter.stability : targetInterval(chapter.mastery, s);
}

// Mise à jour de la stabilité après une révision réussie (« J'ai travaillé »).
// Effet d'espacement : gain maximal quand on révise près du seuil d'oubli
// (R bas) ; minimal quand on révise trop tôt (R haut). La maîtrise (≈ facilité)
// module la vitesse de consolidation. Intervalles expansifs garantis.
export function nextStability(stability, mastery, rOld, s) {
  const rt = clamp(s.requestRetention ?? 0.9, 0.5, 0.99);
  const ease = 0.3 + 1.5 * clamp(mastery, 0, 100) / 100;     // 0.3 … 1.8
  const spacing = clamp((1 - rOld) / (1 - rt), 0.25, 2.5);   // effet d'espacement
  return clamp(stability * (1 + ease * spacing), s.minInterval, 365);
}

// 2. Urgence de péremption (>= 1 ⇒ il te reste moins que la rétention cible ;
//    jamais révisé ⇒ urgent).
export function baseUrgency(chapter, s, today) {
  const due = optimalInterval(chapterStability(chapter, s), s.requestRetention);
  const days = chapter.lastReviewed ? daysBetween(chapter.lastReviewed, today) : due * 2.2;
  return Math.max(0, days) / due;
}

// 3. Multiplicateur d'examen (≈1 quand loin, monte au carré jusqu'au jour J).
export function examMultiplier(j, s) {
  if (j < 0 || j > s.pressureHorizon) return 1;
  const x = (s.pressureHorizon - j) / s.pressureHorizon;
  return 1 + (s.maxExamPressure - 1) * x * x;
}

// 4. Facteur d'examen d'un chapitre : max du multiplicateur sur toutes les
//    épreuves FUTURES qui couvrent ce chapitre. Vaut 1 si aucune.
export function chapterExamFactor(chapter, exams, s, today) {
  let factor = 1, exam = null, examDays = null;
  for (const ex of exams) {
    if (!ex.chapterIds || !ex.chapterIds.includes(chapter.id)) continue;
    const j = daysBetween(today, ex.date);
    if (j < 0) continue; // épreuve passée
    const mult = examMultiplier(j, s);
    if (mult > factor) { factor = mult; exam = ex; examDays = j; }
  }
  return { factor, exam, examDays };
}

// 5. Priorité finale + décomposition transparente.
export function chapterMetrics(chapter, exams, s, today) {
  const stability = chapterStability(chapter, s);
  const ti = optimalInterval(stability, s.requestRetention); // intervalle de révision visé
  const since = chapter.lastReviewed ? daysBetween(chapter.lastReviewed, today) : null;
  const days = since != null ? since : ti * 2.2;
  const urgency = Math.max(0, days) / ti;
  const R = since != null ? retrievability(since, stability) : null;
  const { factor, exam, examDays } = chapterExamFactor(chapter, exams, s, today);
  return { ti, stability, since, R, urgency, factor, exam, examDays, priority: urgency * factor };
}

// Prochaine épreuve future d'une matière.
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

// Mode annales d'une matière : si la prochaine épreuve est à <= examModeThreshold.
export function annalesModeFor(subjectId, exams, s, today) {
  const n = nextFutureExam(subjectId, exams, today);
  return n && n.days <= s.examModeThreshold ? n : null;
}

// Raison en langage clair (pas de formule) : pourquoi ce chapitre, là, maintenant.
// Renvoie { text, tone } avec tone ∈ 'exam' | 'late' | 'calm'.
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

// Plan du jour sous contrainte de capacité : on retient les `subjectsPerDay`
// matières (core) les plus sous pression, chacune avec ses `chaptersPerSession`
// chapitres les plus prioritaires (une séance ≈ sessionHours h). Les matières
// non faites aujourd'hui montent d'elles-mêmes en priorité les jours suivants.
export function planDay(ranked, subjects, subjectsPerDay, chaptersPerSession) {
  const core = new Map(subjects.filter((s) => s.type === 'core').map((s) => [s.id, s]));
  const bySubject = new Map();
  for (const ch of ranked) { // ranked déjà trié par priorité décroissante
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

/* ------------------------------------------------------------------ *
 *  Rampe thermique
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 *  Persistance (window.storage -> localStorage -> mémoire)
 * ------------------------------------------------------------------ */

function makeStore() {
  try {
    if (typeof window !== 'undefined' && window.storage &&
        typeof window.storage.getItem === 'function') {
      return window.storage;
    }
  } catch (e) { /* ignore */ }
  try {
    if (typeof localStorage !== 'undefined') {
      const k = '__cadence_probe__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return localStorage;
    }
  } catch (e) { /* ignore */ }
  // Repli gracieux en mémoire : l'app fonctionne sans stockage.
  const mem = {};
  return {
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: (k) => { delete mem[k]; },
  };
}

function normalize(s) {
  return {
    subjects: Array.isArray(s?.subjects) ? s.subjects : [],
    chapters: Array.isArray(s?.chapters) ? s.chapters : [],
    exams: Array.isArray(s?.exams) ? s.exams : [],
    settings: { ...DEFAULT_SETTINGS, ...(s?.settings || {}) },
    parallelLog: s?.parallelLog && typeof s.parallelLog === 'object' ? s.parallelLog : {},
  };
}

// Données de départ : seulement les matières (aucun chapitre, aucune épreuve).
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
    subjects: [...core, ...parallel],
    chapters: [],
    exams: [],
    settings: { ...DEFAULT_SETTINGS },
    parallelLog: {},
  };
}

function stripChapterIds(exams, ids) {
  const set = new Set(ids);
  return exams.map((e) => ({
    ...e,
    chapterIds: (e.chapterIds || []).filter((cid) => !set.has(cid)),
  }));
}

/* ------------------------------------------------------------------ *
 *  Petits composants de présentation
 * ------------------------------------------------------------------ */

const Mono = ({ children, style, color }) => (
  <span style={{ fontFamily: MONO, color, ...style }}>{children}</span>
);

const Pastille = ({ color, size = 10 }) => (
  <span style={{
    width: size, height: size, borderRadius: '50%', background: color,
    display: 'inline-block', flex: '0 0 auto', boxShadow: `0 0 0 1px rgba(0,0,0,.35)`,
  }} />
);

function MasteryBar({ value, color }) {
  return (
    <div title={`maîtrise ${Math.round(value)} / 100`} style={{
      height: 5, background: C.inset, borderRadius: 3, overflow: 'hidden',
      border: `1px solid ${C.line}`,
    }}>
      <div className="cad-bar" style={{
        width: `${clamp(value, 0, 100)}%`, height: '100%',
        background: color, opacity: 0.55, borderRadius: 3,
      }} />
    </div>
  );
}

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
    opacity: disabled ? 0.45 : 1, transition: 'background .12s, border-color .12s',
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

// Lecteur de priorité transparent : valeur + urgence × mult + épreuve/jours.
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

// Raison en langage clair, colorée par la rampe thermique.
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

// Bascule à deux états (Simple / Détaillé, etc.).
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

// Carte de la file du jour. En mode simple : l'essentiel + « détails » repliable.
function QueueCard({ idx, ch, subject, simpleMode, onWorked, onMastery }) {
  const [flash, setFlash] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const open = !simpleMode || expanded;
  const tcol = thermal(ch.priority);
  const sinceLabel = ch.since == null ? 'jamais révisé'
    : ch.since === 0 ? 'révisé aujourd’hui' : `il y a ${ch.since} j`;

  return (
    <div className={`cad-card${flash ? ' cad-ring' : ''}`} style={{
      background: C.panel, border: `1px solid ${flash ? 'rgba(52,211,153,.5)' : C.line}`, borderLeft: `3px solid ${tcol}`,
      borderRadius: 10, padding: 13, display: 'flex', flexDirection: 'column', gap: 9,
    }}>
      {/* Quel chapitre */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <Mono style={{ color: C.faint, fontSize: 12, marginTop: 2, width: 18 }}>{idx + 1}</Mono>
        <Pastille color={subject.color} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: SANS, fontSize: 15.5, color: C.text, fontWeight: 600 }}>{ch.name}</span>
            <span style={{ fontFamily: SANS, fontSize: 11, color: C.dim }}>{subject.name}</span>
          </div>
        </div>
      </div>

      {/* Pourquoi : une phrase claire (tu décides quoi faire) */}
      <div style={{ paddingLeft: 28 }}>
        <ReasonLine m={ch} />
      </div>

      {/* Détails (repliés en mode simple) : maîtrise + chiffres transparents */}
      <div className={`cad-collapse${open ? ' open' : ''}`}>
        <div className="cad-collapse-in" {...(open ? {} : { inert: '' })}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 28, paddingTop: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 150px', minWidth: 120 }}>
                <MasteryBar value={ch.mastery} color={subject.color} />
              </div>
              <Mono style={{ color: C.dim, fontSize: 11 }}>{Math.round(ch.mastery)}/100</Mono>
              <Mono style={{ color: C.faint, fontSize: 11 }}>
                · {sinceLabel}{ch.R != null ? ` · mémoire ~${Math.round(ch.R * 100)}%` : ''} · revoir ~tous les {Math.round(ch.ti)} j
              </Mono>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Pencil size={12} color={C.faint} />
              <span style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>ajuster la maîtrise</span>
              <div style={{ flex: 1, minWidth: 90 }}>
                <Range value={ch.mastery} min={0} max={100} ariaLabel={`maîtrise ${ch.name}`}
                  onChange={(v) => onMastery(ch.id, v)} />
              </div>
            </div>
            <PriorityReader m={ch} compact />
          </div>
        </div>
      </div>

      {/* Action : valider + (en mode simple) ouvrir les détails */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 28 }}>
        <Btn variant={flash ? 'ghost' : 'primary'}
          onClick={() => { onWorked(ch.id); setFlash(true); setTimeout(() => setFlash(false), 1200); }}>
          {flash
            ? <><Check size={14} className="cad-pop" color={C.good} /> <span style={{ color: C.good }}>enregistré</span></>
            : <><Check size={14} /> J’ai travaillé</>}
        </Btn>
        {simpleMode && (
          <Btn variant="bare" onClick={() => setExpanded((v) => !v)} style={{ marginLeft: 'auto', color: C.faint, fontSize: 12 }}>
            détails <ChevronRight size={14} style={{ transition: 'transform .22s var(--ease)', transform: expanded ? 'rotate(90deg)' : 'none' }} />
          </Btn>
        )}
      </div>
    </div>
  );
}

// Ligne compacte pour « voir toute la file ».
function RankRow({ idx, ch, subject }) {
  const tcol = thermal(ch.priority);
  return (
    <div className="cad-card" style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
      borderLeft: `3px solid ${tcol}`, background: C.panel2, border: `1px solid ${C.line}`,
      borderLeftWidth: 3, borderRadius: 7,
    }}>
      <Mono style={{ color: C.faint, fontSize: 11, width: 18 }}>{idx + 1}</Mono>
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

// Petit ajout texte (nom) avec bouton +.
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
 *  Styles globaux (injectés une fois — composant auto-suffisant)
 * ------------------------------------------------------------------ */

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

  /* Boutons : transitions douces (les changements de style inline s'animent) */
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

  /* Cartes : survol qui soulève */
  .cad-card { transition: transform .18s var(--ease), box-shadow .22s var(--ease), border-color .22s var(--ease); }
  .cad-card:hover { transform: translateY(-2px); box-shadow: 0 12px 30px -10px rgba(0,0,0,.6); }

  /* Cellules calendrier */
  .cad-cell { transition: background .15s var(--ease), border-color .15s var(--ease), transform .12s var(--ease); }
  .cad-cell:hover { background: rgba(255,255,255,.05); transform: translateY(-1px); }

  /* Barres animées (maîtrise, planchers, jauges) */
  .cad-bar { transition: width .35s var(--ease), background .25s var(--ease); }

  /* Repli/dépli fluide (grille 0fr -> 1fr) */
  .cad-collapse { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .26s var(--ease), opacity .2s var(--ease); opacity: .4; }
  .cad-collapse.open { grid-template-rows: 1fr; opacity: 1; }
  .cad-collapse > .cad-collapse-in { overflow: hidden; min-height: 0; }

  /* Entrées en scène */
  @keyframes cad-fade-up { from { opacity: 0; transform: translateY(9px); } to { opacity: 1; transform: none; } }
  @keyframes cad-fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  @keyframes cad-pop { 0% { transform: scale(.5); opacity: .3; } 60% { transform: scale(1.18); } 100% { transform: scale(1); opacity: 1; } }
  @keyframes cad-ring { 0% { box-shadow: 0 0 0 0 rgba(52,211,153,.55); } 100% { box-shadow: 0 0 0 16px rgba(52,211,153,0); } }
  .cad-in { animation: cad-fade-up .36s var(--ease) both; }
  .cad-view { animation: cad-fade .24s var(--ease) both; }
  .cad-pop { animation: cad-pop .32s var(--ease); }
  .cad-ring { animation: cad-ring .75s ease-out; }

  .cadence ::-webkit-scrollbar { width: 10px; height: 10px; }
  .cadence ::-webkit-scrollbar-thumb { background: #26303d; border-radius: 5px; }
  .cadence ::-webkit-scrollbar-thumb:hover { background: #344150; }
  .cadence ::-webkit-scrollbar-track { background: transparent; }
  .cadence input::placeholder { color: ${C.faint}; }

  @media (prefers-reduced-motion: reduce) {
    .cadence *, .cad-card, .cad-in, .cad-view, .cad-collapse, .cad-pop, .cad-ring {
      animation: none !important; transition: none !important;
    }
    .cad-collapse { opacity: 1; }
  }
`;

/* ------------------------------------------------------------------ *
 *  Application
 * ------------------------------------------------------------------ */

const TABS = [
  { id: 'today', label: 'Aujourd’hui', icon: Activity },
  { id: 'calendar', label: 'Calendrier', icon: CalendarDays },
  { id: 'subjects', label: 'Matières', icon: Layers },
  { id: 'settings', label: 'Réglages', icon: SettingsIcon },
];

export default function Cadence() {
  const store = useMemo(() => makeStore(), []);
  const [state, setState] = useState(() => {
    try {
      const raw = store.getItem(STORAGE_KEY);
      if (raw) return normalize(JSON.parse(raw));
    } catch (e) { /* ignore */ }
    return seedState();
  });

  // Sauvegarde à chaque mutation.
  useEffect(() => {
    try { store.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }, [state, store]);

  const [tab, setTab] = useState('today');
  const today = todayISO();
  const { subjects, chapters, exams, settings, parallelLog } = state;

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
    return {
      ...p,
      subjects: p.subjects.filter((s) => s.id !== id),
      chapters: p.chapters.filter((c) => c.subjectId !== id),
      exams: stripChapterIds(p.exams.filter((e) => e.subjectId !== id), chapIds),
    };
  });

  const addChapter = (subjectId, name) => patch((p) => ({
    ...p, chapters: [...p.chapters, {
      id: uid(), subjectId, name, mastery: 50, lastReviewed: null,
      stability: targetInterval(50, p.settings),
    }],
  }));
  const updateChapter = (id, up) => patch((p) => ({
    ...p, chapters: p.chapters.map((c) => (c.id === id ? { ...c, ...up } : c)),
  }));
  const deleteChapter = (id) => patch((p) => ({
    ...p,
    chapters: p.chapters.filter((c) => c.id !== id),
    exams: stripChapterIds(p.exams, [id]),
  }));
  // « J'ai travaillé » : révision réussie -> la stabilité grandit (intervalle
  // expansif), gain modulé par l'effet d'espacement et la maîtrise.
  const markWorked = (id) => patch((p) => ({
    ...p, chapters: p.chapters.map((c) => {
      if (c.id !== id) return c;
      const stability = chapterStability(c, p.settings);
      const since = c.lastReviewed ? daysBetween(c.lastReviewed, today) : stability;
      const rOld = retrievability(since, stability);
      return { ...c, lastReviewed: today, stability: nextStability(stability, c.mastery, rOld, p.settings) };
    }),
  }));
  // Ajuster la maîtrise = recalibrer où tu en es : la stabilité repart de cette
  // auto-évaluation (utile après un examen blanc noté).
  const setMastery = (id, v) => patch((p) => {
    const m = clamp(Math.round(v), 0, 100);
    return { ...p, chapters: p.chapters.map((c) => (c.id === id
      ? { ...c, mastery: m, stability: targetInterval(m, p.settings) } : c)) };
  });

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
  const resetAll = () => { if (confirm('Réinitialiser CADENCE ? Tes chapitres, épreuves et réglages seront effacés.')) setState(seedState()); };

  /* ----- Données dérivées ----- */
  const subjectById = useMemo(
    () => Object.fromEntries(subjects.map((s) => [s.id, s])), [subjects]);
  const coreSubjects = useMemo(() => subjects.filter((s) => s.type === 'core'), [subjects]);
  const parallelSubjects = useMemo(() => subjects.filter((s) => s.type === 'parallel'), [subjects]);

  const ranked = useMemo(() => chapters
    .map((ch) => ({ ...ch, ...chapterMetrics(ch, exams, settings, today) }))
    .sort((a, b) => b.priority - a.priority), [chapters, exams, settings, today]);

  const overdue = ranked.filter((c) => c.urgency >= 1).length;
  const chaptersPerSession = Math.max(1, Math.round((settings.sessionHours * 60) / settings.minutesPerChapter));
  const sessions = useMemo(
    () => planDay(ranked, subjects, settings.subjectsPerDay, chaptersPerSession),
    [ranked, subjects, settings.subjectsPerDay, chaptersPerSession]);
  const plannedCount = sessions.reduce((a, s) => a + s.chapters.length, 0);

  const annalesBanners = useMemo(() => coreSubjects
    .map((s) => ({ subject: s, info: annalesModeFor(s.id, exams, settings, today) }))
    .filter((x) => x.info), [coreSubjects, exams, settings, today]);

  const upcomingExams = useMemo(() => exams
    .map((e) => ({ ...e, days: daysBetween(today, e.date) }))
    .filter((e) => e.days >= 0)
    .sort((a, b) => a.days - b.days), [exams, today]);
  const nextExam = upcomingExams[0] || null;

  return (
    <div className="cadence" style={{
      minHeight: '100%', background: C.bg, color: C.text, fontFamily: SANS,
      WebkitFontSmoothing: 'antialiased',
    }}>
      <style>{GLOBAL_CSS}</style>

      {/* Barre supérieure */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 10, background: 'rgba(10,14,20,.86)',
        backdropFilter: 'blur(8px)', borderBottom: `1px solid ${C.line}`,
      }}>
        <div style={{ maxWidth: 980, margin: '0 auto', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Flame size={18} color={C.accent} />
            <span style={{ fontFamily: MONO, fontWeight: 700, letterSpacing: '.22em', fontSize: 16 }}>CADENCE</span>
          </div>
          <nav style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginLeft: 'auto' }}>
            {TABS.map((t) => {
              const active = tab === t.id;
              return (
                <button key={t.id} onClick={() => setTab(t.id)} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer',
                  fontFamily: SANS, fontSize: 13, padding: '7px 12px', borderRadius: 8,
                  border: `1px solid ${active ? 'rgba(94,169,255,.5)' : 'transparent'}`,
                  background: active ? 'rgba(94,169,255,.14)' : 'transparent',
                  color: active ? '#dbeafe' : C.dim,
                }}>
                  <t.icon size={15} /> {t.label}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main style={{ maxWidth: 980, margin: '0 auto', padding: '18px 16px 64px' }}>
        <div key={tab} className="cad-view">
        {tab === 'today' && (
          <TodayView
            today={today} overdue={overdue} nextExam={nextExam} subjectById={subjectById}
            annalesBanners={annalesBanners} sessions={sessions} plannedCount={plannedCount} ranked={ranked}
            parallelSubjects={parallelSubjects} parallelLog={parallelLog} settings={settings}
            onWorked={markWorked} onMastery={setMastery} onAdjustParallel={adjustParallel}
            onGoSubjects={() => setTab('subjects')}
            onSetSimpleMode={(v) => updateSetting('simpleMode', v)}
          />
        )}
        {tab === 'calendar' && (
          <CalendarView today={today} exams={exams} subjectById={subjectById}
            settings={settings} upcomingExams={upcomingExams} onGoSubjects={() => setTab('subjects')} />
        )}
        {tab === 'subjects' && (
          <SubjectsView
            subjects={subjects} chapters={chapters} exams={exams} settings={settings} today={today}
            onAddSubject={addSubject} onUpdateSubject={updateSubject} onDeleteSubject={deleteSubject}
            onAddChapter={addChapter} onUpdateChapter={updateChapter} onDeleteChapter={deleteChapter}
            onAddExam={addExam} onUpdateExam={updateExam} onDeleteExam={deleteExam}
            onToggleExamChapter={toggleExamChapter}
          />
        )}
        {tab === 'settings' && (
          <SettingsView settings={settings} state={state} store={store}
            onUpdate={updateSetting} onImport={importState} onReset={resetAll} today={today} />
        )}
        </div>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Vue 1 — Aujourd'hui
 * ------------------------------------------------------------------ */

function TodayView({
  today, overdue, nextExam, subjectById, annalesBanners, sessions, plannedCount, ranked,
  parallelSubjects, parallelLog, settings, onWorked, onMastery, onAdjustParallel, onGoSubjects,
  onSetSimpleMode,
}) {
  const [showAll, setShowAll] = useState(false);
  const wk = mondayOf(today);
  const hrs = settings.sessionHours;
  const hLabel = Number.isInteger(hrs) ? `${hrs} h` : `${hrs} h`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* En-tête : date + métriques */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <Mono style={{ fontSize: 22, color: C.text, textTransform: 'capitalize' }}>{fmtLongDate(today)}</Mono>
          <div style={{ fontFamily: SANS, fontSize: 12, color: C.faint, marginTop: 2 }}>
            Révisions espacées, à ta capacité · coche ce qui est fait
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

      {/* Bannières « examen proche » (simple alerte, pas de consigne) */}
      {annalesBanners.map(({ subject, info }, bi) => (
        <div key={subject.id} className="cad-in cad-card" style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 13px', borderRadius: 9,
          background: 'rgba(251,191,36,.08)', border: `1px solid rgba(251,191,36,.32)`,
          animationDelay: `${bi * 50}ms`,
        }}>
          <CalendarDays size={16} color={C.warn} />
          <Pastille color={subject.color} />
          <span style={{ fontFamily: SANS, fontSize: 13.5 }}>
            <b>{subject.name}</b> · examen proche
          </span>
          <Mono style={{ marginLeft: 'auto', color: C.warn, fontSize: 12 }}>
            {info.exam.name} · J−{info.days}
          </Mono>
        </div>
      ))}

      {/* Plan du jour : matières sous contrainte de capacité */}
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
          <Empty>Tes chapitres sont dans des matières « parallèle ». Passe une UE en « core » (onglet Matières) pour qu’elle entre dans le plan.</Empty>
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
                {sessions.map((session, si) => (
                  <div key={session.subject.id} className="cad-in" style={{ animationDelay: `${si * 70}ms` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 9 }}>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 22, height: 22, borderRadius: 6, background: `${session.subject.color}22`,
                        color: session.subject.color, fontFamily: MONO, fontSize: 12, fontWeight: 700,
                      }}>{si + 1}</span>
                      <span style={{ fontFamily: SANS, fontSize: 15.5, fontWeight: 700, color: C.text }}>{session.subject.name}</span>
                      <Chip color={C.dim}>séance ≈ {hLabel}</Chip>
                      <Mono style={{ marginLeft: 'auto', color: C.faint, fontSize: 11 }}>
                        {session.chapters.length} chap.{session.total > session.chapters.length ? ` · +${session.total - session.chapters.length} en attente` : ''}
                      </Mono>
                    </div>
                    <div style={{
                      display: 'flex', flexDirection: 'column', gap: 10,
                      paddingLeft: 11, borderLeft: `2px solid ${session.subject.color}33`,
                    }}>
                      {session.chapters.map((ch, i) => (
                        <QueueCard key={ch.id} idx={i} ch={ch} subject={session.subject}
                          simpleMode={settings.simpleMode} onWorked={onWorked} onMastery={onMastery} />
                      ))}
                    </div>
                  </div>
                ))}
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

      {/* Minimums hebdo (matières en parallèle — à tenir quoi qu'il arrive) */}
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

function Stat({ label, value, unit, tone }) {
  return (
    <div className="cad-card" style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 9, padding: '8px 13px', minWidth: 110 }}>
      <div style={{ fontFamily: SANS, fontSize: 10.5, color: C.faint, textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <Mono style={{ fontSize: 19, color: tone || C.text }}>{value}</Mono>
        {unit != null && <span style={{ fontFamily: SANS, fontSize: 11, color: C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>{unit}</span>}
      </div>
    </div>
  );
}

function ThermalLegend() {
  const grad = `linear-gradient(90deg, ${thermal(0)}, ${thermal(1.2)}, ${thermal(2.2)}, ${thermal(4)})`;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0 12px' }}>
      <span style={{ fontFamily: SANS, fontSize: 10.5, color: C.faint }}>calme</span>
      <div style={{ flex: '0 1 180px', height: 5, borderRadius: 3, background: grad, border: `1px solid ${C.line}` }} />
      <span style={{ fontFamily: SANS, fontSize: 10.5, color: C.faint }}>urgent</span>
      <span style={{ fontFamily: SANS, fontSize: 10.5, color: C.faint, marginLeft: 6 }}>
        — la couleur = l’urgence
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Vue 2 — Calendrier
 * ------------------------------------------------------------------ */

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

function CalendarView({ today, exams, subjectById, settings, upcomingExams, onGoSubjects }) {
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

  // Une date est en fenêtre annales si une épreuve la couvre dans [date−seuil, date].
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

  return (
    <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <div style={{ flex: '1 1 360px', minWidth: 300 }}>
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
            return (
              <div key={i} className="cad-cell" title={dayExams.map((e) => `${e.name} (${(e.chapterIds || []).length} chap.)`).join('\n')}
                style={{
                  aspectRatio: '1 / 1', borderRadius: 7, padding: 5,
                  background: shade ? `${shade.color}1f` : C.panel2,
                  border: `1px solid ${isToday ? C.accent : C.line}`,
                  display: 'flex', flexDirection: 'column', gap: 3, position: 'relative', overflow: 'hidden',
                }}>
                <Mono style={{
                  fontSize: 11, color: isToday ? C.accent : C.dim, alignSelf: 'flex-end',
                  fontWeight: isToday ? 700 : 400,
                }}>{cell.getDate()}</Mono>
                <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 'auto' }}>
                  {dayExams.map((e) => (
                    <span key={e.id} style={{
                      height: 6, minWidth: 6, flex: dayExams.length > 1 ? '1 1 auto' : '0 0 auto',
                      borderRadius: 3, background: subjectById[e.subjectId]?.color || C.dim,
                    }} />
                  ))}
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
            <span style={{ width: 10, height: 10, borderRadius: 3, border: `1px solid ${C.accent}` }} /> aujourd’hui
          </span>
        </div>
      </div>

      {/* Liste latérale */}
      <div style={{ flex: '1 1 240px', minWidth: 240 }}>
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
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Vue 3 — Matières
 * ------------------------------------------------------------------ */

const PALETTE = ['#7c9cf5', '#a78bfa', '#38bdf8', '#fbbf24', '#f472b6', '#34d399', '#5eead4', '#fca5a5', '#f59e0b', '#22d3ee'];

function SubjectsView({
  subjects, chapters, exams, settings, today,
  onAddSubject, onUpdateSubject, onDeleteSubject,
  onAddChapter, onUpdateChapter, onDeleteChapter,
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12 }}>
              {isCore ? (
                <button onClick={() => toggle(s.id)} aria-label="déplier" style={{
                  background: 'transparent', border: 'none', cursor: 'pointer', color: C.dim, display: 'flex', padding: 2,
                }}>
                  {expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                </button>
              ) : <span style={{ width: 22 }} />}

              <input type="color" value={s.color} aria-label="couleur"
                onChange={(e) => onUpdateSubject(s.id, { color: e.target.value })}
                style={{ width: 26, height: 26, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }} />

              <TextInput value={s.name} onChange={(v) => onUpdateSubject(s.id, { name: v })} ariaLabel="nom de la matière" style={{ maxWidth: 280 }} />

              <Chip color={isCore ? C.accent : C.good} title="type de matière">
                {isCore ? 'core' : 'parallèle'}
              </Chip>

              <button onClick={() => onUpdateSubject(s.id, { type: isCore ? 'parallel' : 'core', weeklyFloor: isCore ? 4 : undefined })}
                style={{ background: 'transparent', border: `1px solid ${C.line}`, color: C.faint, borderRadius: 7, fontSize: 11, padding: '4px 7px', cursor: 'pointer', fontFamily: SANS }}>
                ↔ {isCore ? 'parallèle' : 'core'}
              </button>

              {!isCore && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>minimum</span>
                  <input type="number" min={0} max={20} value={s.weeklyFloor ?? 0}
                    onChange={(e) => onUpdateSubject(s.id, { weeklyFloor: Math.max(0, Number(e.target.value) || 0) })}
                    aria-label="plancher hebdo"
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
                    <Empty>Aucun chapitre. Ajoute-les ci-dessous, puis règle la maîtrise au curseur.</Empty>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
                    {subChapters.map((c) => {
                      const m = chapterMetrics(c, exams, settings, today);
                      const tcol = thermal(m.priority);
                      const since = c.lastReviewed ? `il y a ${m.since} j` : 'jamais révisé';
                      return (
                        <div key={c.id} style={{ display: 'flex', flexDirection: 'column', gap: 7, padding: 10, background: C.panel2, border: `1px solid ${C.line}`, borderLeft: `3px solid ${tcol}`, borderRadius: 8 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <TextInput value={c.name} onChange={(v) => onUpdateChapter(c.id, { name: v })} ariaLabel="nom du chapitre" />
                            <IconBtn icon={Trash2} danger title="Supprimer le chapitre" onClick={() => onDeleteChapter(c.id)} />
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <span style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>maîtrise</span>
                            <div style={{ flex: '1 1 140px', minWidth: 120 }}>
                              <Range value={c.mastery} min={0} max={100} ariaLabel={`maîtrise ${c.name}`} onChange={(v) => onUpdateChapter(c.id, { mastery: Math.round(v) })} />
                            </div>
                            <Mono style={{ fontSize: 12, color: C.dim }}>{Math.round(c.mastery)}/100</Mono>
                            <Mono style={{ fontSize: 11, color: C.faint }}>· {since} · cible {round1(m.ti)} j</Mono>
                            <Btn variant="bare" style={{ fontSize: 11, color: C.dim }} onClick={() => onUpdateChapter(c.id, { lastReviewed: today })}>
                              <Check size={12} /> révisé aujourd’hui
                            </Btn>
                          </div>
                          <PriorityReader m={m} compact />
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
                                <div style={{ fontFamily: SANS, fontSize: 11, color: C.faint, marginBottom: 5 }}>
                                  Chapitres couverts ({(e.chapterIds || []).length})
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

/* ------------------------------------------------------------------ *
 *  Vue 4 — Réglages
 * ------------------------------------------------------------------ */

const SLIDERS = [
  { key: 'requestRetention', label: 'Rétention cible', min: 0.8, max: 0.97, step: 0.01, fmt: (v) => `${Math.round(v * 100)} %`, help: 'tu revois quand il te reste ce niveau en mémoire — plus haut = plus de révisions' },
  { key: 'subjectsPerDay', label: 'Matières par jour', min: 1, max: 6, step: 1, unit: '', help: 'ta capacité quotidienne' },
  { key: 'sessionHours', label: 'Durée d’une séance', min: 1, max: 4, step: 0.5, unit: ' h', help: 'temps par matière' },
  { key: 'minutesPerChapter', label: 'Minutes par chapitre', min: 10, max: 60, step: 5, unit: ' min', help: 'sert à estimer le nombre de chapitres par séance' },
  { key: 'minInterval', label: 'Intervalle min', min: 1, max: 7, step: 1, unit: ' j', help: 'stabilité de départ à maîtrise 0' },
  { key: 'maxInterval', label: 'Intervalle max', min: 7, max: 60, step: 1, unit: ' j', help: 'stabilité de départ à maîtrise 100' },
  { key: 'maxExamPressure', label: 'Pression d’examen max', min: 1, max: 10, step: 0.5, unit: '×', help: 'multiplicateur au jour J' },
  { key: 'pressureHorizon', label: 'Horizon de pression', min: 7, max: 90, step: 1, unit: ' j', help: 'au-delà, l’examen n’influe pas' },
  { key: 'examModeThreshold', label: 'Seuil « examen proche »', min: 3, max: 45, step: 1, unit: ' j', help: 'à partir de combien de jours une UE est signalée' },
];

function SettingsView({ settings, state, store, onUpdate, onImport, onReset, today }) {
  const fileRef = useRef(null);

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

  // Aperçu live de la courbe du multiplicateur.
  const N = 24;
  const bars = Array.from({ length: N + 1 }, (_, i) => {
    const j = Math.round((settings.pressureHorizon * i) / N);
    return { j, mult: examMultiplier(j, settings) };
  });
  const ti = (m) => round1(targetInterval(m, settings));

  // Aperçu de la courbe d'oubli pour une stabilité type (maîtrise 50).
  const sampleS = targetInterval(50, settings);
  const dueAt = optimalInterval(sampleS, settings.requestRetention);
  const fSpan = Math.max(dueAt * 1.9, sampleS * 1.6, 4);
  const fBars = Array.from({ length: 21 }, (_, i) => {
    const t = (fSpan * i) / 20;
    return { t, R: retrievability(t, sampleS) };
  });

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
            Simple = juste quoi faire + « J’ai travaillé ». Détaillé = chiffres et maîtrise toujours visibles.
          </span>
        </div>
      </div>

      <SectionTitle icon={SettingsIcon}>Réglages du moteur</SectionTitle>

      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 320px', minWidth: 280, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {SLIDERS.map((sl) => (
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
            </div>
          ))}
        </div>

        {/* Aperçu courbe + intervalle cible */}
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
              Courbe d’oubli & moment de révision
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
              révision visée à ~{Math.round(dueAt)} j (mémoire {Math.round(settings.requestRetention * 100)}%),
              stabilité {round1(sampleS)} j
            </div>
            <div style={{ display: 'flex', gap: 14, marginTop: 8, fontFamily: MONO, fontSize: 12, color: C.faint }}>
              <span>stab. départ — m0 <b style={{ color: C.text }}>{ti(0)} j</b></span>
              <span>m50 <b style={{ color: C.text }}>{ti(50)} j</b></span>
              <span>m100 <b style={{ color: C.text }}>{ti(100)} j</b></span>
            </div>
          </div>
        </div>
      </div>

      {/* Sauvegarde / données */}
      <div>
        <SectionTitle icon={Download}>Données &amp; sauvegarde</SectionTitle>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Btn onClick={exportJSON}><Download size={14} /> Exporter (JSON)</Btn>
          <Btn onClick={() => fileRef.current?.click()}><Upload size={14} /> Importer (JSON)</Btn>
          <input ref={fileRef} type="file" accept="application/json,.json" onChange={onFile} style={{ display: 'none' }} />
          <Btn variant="danger" onClick={onReset}><RotateCcw size={14} /> Réinitialiser</Btn>
        </div>
        <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.faint, marginTop: 10, lineHeight: 1.5, maxWidth: 620 }}>
          Tout est stocké localement sur cet appareil (une seule clé <Mono color={C.dim}>{STORAGE_KEY}</Mono>),
          avec repli en mémoire si le stockage est indisponible — rien n’est envoyé sur un serveur.
          Exporte de temps en temps : c’est ta seule sauvegarde.
        </div>
      </div>
    </div>
  );
}
