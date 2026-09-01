/*
 * CADENCE — continuité quotidienne et consolidations espacées.
 *
 * L'accueil retrouve le dernier chapitre et ses liens sans prescrire le
 * travail du jour. Une portion datée apparaît le lendemain, puis suit une
 * courbe d'oubli à partir de l'auto-évaluation réellement saisie.
 *
 * Le moteur, les migrations et la validation d'import vivent dans
 * src/engine.js. Ce fichier porte l'interface React et la persistance.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, CalendarDays, Layers, Settings as SettingsIcon, TrendingUp,
  Plus, Trash2, ChevronDown, ChevronRight, ChevronLeft, Check,
  Download, Upload, RotateCcw, AlertTriangle, Lock, Undo2,
  BookOpen, FlaskConical, Flame, Pencil, Clock3,
  RefreshCw, Cloud, CloudOff, Smartphone, Bookmark, Library, Link2, X,
} from 'lucide-react';

import {
  STORAGE_KEY, LEGACY_KEY, BACKUP_KEY,
  DEFAULT_SETTINGS, GRADES, EVIDENCE, gradeLabel, LEVELS, IMPORTANCE,
  MASTERY_LEVELS,
  AXES, AXIS_KEYS, AXIS_MINUTES, MINUTE_CHOICES, evidenceAxis, closestLevel,
  clamp, uid, parseISO, isoOf, daysBetween, addDays, mondayOf,
  retrievability, optimalInterval, applyEvidence, applySelfAssessment, targetInterval, levelSeed,
  examMultiplier, chapterMetrics, recallInfo, practiceRisk, nextFutureExam,
  annalesModeFor, reasonPhrase, isWorthReviewing, axisMinutes, axisSummary,
  pendingDebriefs,
  defaultDailyMinutes, todayCapacityMinutes, planDay,
  cruiseLoad, observedRetention, forecastDue, examReadiness,
  validateImport, normalize, seedState, newChapter,
  stripChapterIds, recalibrateState, makeStore, markDeleted,
  KINDS, RESOURCE_PRESETS, POSITION_MAX, applicableAxes, normPosition, newResource,
  newDoc, sortedDocs, isSafeDocUrl, normDocs, DOCS_PER_CHAPTER_MAX,
  isReviewUnit, reviewUnitInfo, forecastReviewUnits, additionDateFromPosition,
  upsertReviewUnit,
  allocateSubjectMinutes, dueCourseTests, courseTestSuggestions,
  newCourseTest, nextCourseTestDate, latestCourseTestResult,
  SUBJECT_DAILY_MINUTES, SUBJECT_PROTECTED_MINUTES,
} from './engine.js';
import { stampState, contentSignature, newDeviceId } from './sync.js';
import { getDeviceId } from './remote.js';
import { useSync, useSyncTriggers } from './useSync.js';
import {
  QUARANTINE_KEY,
  deserializeCadenceState,
  loadCadenceState,
  saveCadenceState,
  saveDailyBackup,
} from './storage.js';
import { useCurrentDay } from './useCurrentDay.js';
import ChapterSearch from './ChapterSearch.jsx';
import FocusMode from './FocusMode.jsx';

/* ================================================================== *
 *  Thème & aides d'affichage
 * ================================================================== */

const C = {
  bg: '#0a0e14',
  panel: '#111824',
  panel2: '#0d1320',
  inset: '#0a0f18',
  line: '#1e2735',
  line2: '#2b3645',
  text: '#cdd8e6',
  dim: '#7c8a9e',
  faint: '#738196',
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

const round1 = (x) => Math.round(x * 10) / 10;
const f2 = (x) => x.toFixed(2);
const fmtMinutes = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60}` : ''}` : `${m} min`);

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
          <button key={o.value} type="button" aria-pressed={active} onClick={() => onChange(o.value)} style={{
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
 *  Visuels : anneaux SVG (progression du jour, jauge de rappel)
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

// Jauge de rappel estimé : R (%) en anneau thermique. Tiret si jamais testé.
function MemGauge({ R, size = 30 }) {
  const stroke = 3.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  if (R == null) {
    return (
      <svg width={size} height={size} role="img" aria-label="jamais testé" style={{ flex: '0 0 auto' }}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke={C.line2} strokeWidth={stroke}
          fill="none" strokeDasharray="3 4" />
        <text x="50%" y="54%" dominantBaseline="middle" textAnchor="middle"
          style={{ fontFamily: MONO, fontSize: 9, fill: C.faint }}>–</text>
      </svg>
    );
  }
  const col = thermal((1 - R) * 4);
  return (
    <svg width={size} height={size} role="img" aria-label={`rappel estimé ${Math.round(R * 100)} %`}
      title={`rappel estimé ~${Math.round(R * 100)} %`} style={{ flex: '0 0 auto' }}>
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
  const axisLabel = AXES[m.dominant]?.label.toLowerCase() || 'risque';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: compact ? 8 : 10, flexWrap: 'wrap',
      fontFamily: MONO, fontSize: compact ? 11 : 12,
    }}>
      <span title="priorité = risque de l'axe dominant × pression d'examen" style={{
        color: col, fontWeight: 700, fontSize: compact ? 13 : 15,
      }}>
        ▲ {f2(m.priority)}
      </span>
      <span style={{ color: C.dim }}>
        {f2(m.baseRisk)}<span style={{ color: C.faint }}> {axisLabel}</span>
        {' × '}
        {f2(m.factor)}<span style={{ color: C.faint }}> exam</span>
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
  // `m` porte déjà l'élément enrichi (kind inclus) : la formulation s'adapte.
  const r = reasonPhrase(m, m.raw ?? m);
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

// Les libellés des 4 issues dépendent de l'axe (rappel / exercice / annale).
// La note décrit le RÉSULTAT d'un test sans correction sous les yeux — pas le
// temps passé ni l'impression d'avoir compris.
function GradeButtons({ onGrade, titleFor, evidenceType = 'recall', compact }) {
  const ev = EVIDENCE[evidenceType] || EVIDENCE.recall;
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {[1, 2, 3, 4].map((g) => {
        const G = GRADES[g];
        const label = ev.grades[g];
        const title = titleFor ? titleFor(g) : 'résultat du test';
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
            {label}
          </button>
        );
      })}
    </div>
  );
}

// Petit sélecteur d'axe (rappel / exercice / problème) DANS une carte.
// Chaque axe montre son état (rappel estimé ou maîtrise observée, ou « non
// testé ») et sa durée. Un axe déjà noté aujourd'hui est coché.
// Seuls les axes déclarés par l'élément sont proposés : une liste de
// vocabulaire n'a pas d'onglet « annales ». Un seul axe -> pas de sélecteur.
function AxisPicker({ ch, axis, onPick, doneAxes }) {
  const axes = ch.axes || AXIS_KEYS;
  if (axes.length <= 1) return null;
  return (
    <div role="group" aria-label="Axe à travailler" style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
      {axes.map((ax) => {
        const on = ax === axis;
        const done = doneAxes.has(ax);
        const info = ch.axisInfo[ax];
        const col = info.pct != null ? thermal((1 - info.pct / 100) * 4) : C.faint;
        return (
          <button key={ax} type="button" aria-pressed={on} onClick={() => onPick(ax)}
            title={`${AXES[ax].long} · ${info.tested ? `${info.pct} %` : 'non testé'} · ~${fmtMinutes(info.minutes)}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
              fontFamily: SANS, fontSize: 11.5, padding: '4px 9px', borderRadius: 999,
              border: `1px solid ${on ? 'rgba(94,169,255,.55)' : C.line2}`,
              background: on ? 'rgba(94,169,255,.14)' : 'transparent',
              color: on ? '#dbeafe' : C.dim,
            }}>
            {done && <Check size={11} color={C.good} />}
            {AXES[ax].label}
            <span style={{ fontFamily: MONO, fontSize: 10.5, color: info.tested ? col : C.faint }}>
              {info.tested ? `${info.pct}%` : '—'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Carte d'un chapitre dans le plan du jour.
// Trois axes indépendants : on choisit l'axe (défaut = axe dominant), on note
// le RÉSULTAT du test ; seul cet axe est modifié. On peut noter plusieurs axes
// le même jour. Clavier : Tab pour sélectionner la carte, 1–4 pour noter.
// Point de reprise : « où j'en étais quand je me suis arrêté ». Un repère
// court, modifiable en un clic. Il n'entre dans aucun calcul — c'est une note
// pour toi, pas une donnée du modèle.
function PositionField({ value, onSave, compact }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');
  useEffect(() => { setDraft(value || ''); }, [value]);

  const commit = () => { onSave(draft); setEditing(false); };
  const cancel = () => { setDraft(value || ''); setEditing(false); };

  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)}
        title={value ? `Reprendre à : ${value} — cliquer pour modifier` : 'Noter où tu t’arrêtes (ex. « p. 47 », « unité 5 »)'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer',
          fontFamily: SANS, fontSize: compact ? 10.5 : 11, padding: '3px 8px', borderRadius: 999,
          border: `1px dashed ${value ? C.line2 : C.line}`, background: 'transparent',
          color: value ? C.text : C.faint,
        }}>
        <Bookmark size={11} color={value ? C.accent : C.faint} />
        {value ? <span style={{ fontFamily: MONO, fontSize: 10.5 }}>{value}</span> : 'où j’en suis'}
      </button>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <Bookmark size={11} color={C.accent} />
      <input autoFocus value={draft} maxLength={POSITION_MAX}
        aria-label="point de reprise"
        placeholder="ex. p. 47, unité 5, exercice 12"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit(); e.preventDefault(); }
          if (e.key === 'Escape') { cancel(); e.preventDefault(); }
        }}
        onBlur={commit}
        style={{
          fontFamily: MONO, fontSize: 11, color: C.text, background: C.inset,
          border: `1px solid ${C.line2}`, borderRadius: 6, padding: '3px 6px', width: 160,
        }} />
    </span>
  );
}

// Documents attachés à un élément : des RÉFÉRENCES (liens), jamais des
// fichiers — le contenu ne doit pas entrer dans l'état synchronisé. On les
// retrouve tels quels à la session suivante, le plus récemment ouvert d'abord.
function DocsRow({ chapter, today, onAddDoc, onUseDoc, onRemoveDoc, compact }) {
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [dropping, setDropping] = useState(false);
  const [notice, setNotice] = useState(null);
  const docs = sortedDocs(chapter);
  const full = docs.length >= DOCS_PER_CHAPTER_MAX;

  const commit = () => {
    const u = url.trim();
    if (u && !isSafeDocUrl(u)) { setNotice('Lien non valide (http ou https uniquement).'); return; }
    if (!u && !label.trim()) { setAdding(false); return; }
    onAddDoc(chapter.id, label.trim(), u || null);
    setUrl(''); setLabel(''); setAdding(false); setNotice(null);
  };

  // Glisser-déposer : un lien devient un document. Un FICHIER ne peut pas être
  // stocké, mais son nom est conservé comme repère de ce qui a été vu.
  const onDrop = (e) => {
    e.preventDefault();
    setDropping(false);
    const uri = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain') || '';
    const dropped = uri.split('\n').map((x) => x.trim()).filter(Boolean).find(isSafeDocUrl);
    if (dropped) { onAddDoc(chapter.id, '', dropped); return; }
    const file = e.dataTransfer?.files?.[0];
    if (file?.name) {
      onAddDoc(chapter.id, file.name, null);
      setNotice('Fichier non stocké : seul son nom est gardé comme repère. Ajoute son lien pour l’ouvrir d’ici.');
      setTimeout(() => setNotice(null), 8000);
      return;
    }
    setNotice('Rien d’exploitable dans ce dépôt.');
    setTimeout(() => setNotice(null), 5000);
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
        padding: dropping ? '4px 6px' : 0, borderRadius: 7,
        border: `1px dashed ${dropping ? C.accent : 'transparent'}`,
        background: dropping ? 'rgba(94,169,255,.08)' : 'transparent',
      }}>
      {docs.map((d) => {
        const used = d.lastUsedAt === today;
        const common = {
          title: d.url
            ? `${d.url}\n${d.lastUsedAt ? `dernière ouverture : ${d.lastUsedAt}` : 'jamais ouvert d’ici'}`
            : 'Repère de document (aucun lien enregistré)',
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 5,
            fontFamily: SANS, fontSize: compact ? 10.5 : 11, padding: '3px 8px', borderRadius: 999,
            border: `1px solid ${used ? 'rgba(52,211,153,.4)' : C.line2}`,
            background: used ? 'rgba(52,211,153,.08)' : 'transparent',
            color: d.url ? C.text : C.dim, textDecoration: 'none', maxWidth: 220,
          },
        };
        const inner = (
          <>
            <Link2 size={11} color={d.url ? C.accent : C.faint} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label}</span>
            {d.lastUsedAt && (
              <Mono style={{ fontSize: 9.5, color: used ? C.good : C.faint }}>
                {used ? 'auj.' : d.lastUsedAt.slice(5)}
              </Mono>
            )}
          </>
        );
        return (
          <span key={d.id} style={{ display: 'inline-flex', alignItems: 'center' }}>
            {d.url ? (
              <a href={d.url} target="_blank" rel="noopener noreferrer"
                onClick={() => onUseDoc(chapter.id, d.id)} {...common}>{inner}</a>
            ) : (
              <span {...common}>{inner}</span>
            )}
            {onRemoveDoc && (
              <button type="button" onClick={() => onRemoveDoc(chapter.id, d.id)}
                aria-label={`Retirer le document ${d.label}`} title="Retirer ce document"
                style={{ background: 'transparent', border: 'none', color: C.faint, cursor: 'pointer', padding: '0 2px', display: 'inline-flex' }}>
                <X size={11} />
              </button>
            )}
          </span>
        );
      })}

      {!adding ? (
        <button type="button" onClick={() => setAdding(true)} disabled={full}
          title={full ? `Maximum ${DOCS_PER_CHAPTER_MAX} documents` : 'Ajouter un document (lien) — tu peux aussi en déposer un ici'}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, cursor: full ? 'not-allowed' : 'pointer',
            fontFamily: SANS, fontSize: compact ? 10.5 : 11, padding: '3px 8px', borderRadius: 999,
            border: `1px dashed ${C.line}`, background: 'transparent', color: C.faint,
          }}>
          <Link2 size={11} /> document
        </button>
      ) : (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
          <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)}
            aria-label="lien du document" placeholder="https://… (Drive, iCloud, une page)"
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setAdding(false); setNotice(null); } }}
            style={{ fontFamily: MONO, fontSize: 11, color: C.text, background: C.inset, border: `1px solid ${C.line2}`, borderRadius: 6, padding: '3px 6px', width: 210 }} />
          <input value={label} onChange={(e) => setLabel(e.target.value)}
            aria-label="nom du document" placeholder="nom (facultatif)"
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setAdding(false); setNotice(null); } }}
            style={{ fontFamily: SANS, fontSize: 11, color: C.text, background: C.inset, border: `1px solid ${C.line2}`, borderRadius: 6, padding: '3px 6px', width: 130 }} />
          <Btn variant="bare" onClick={commit} style={{ color: C.accent, fontSize: 11 }}>ajouter</Btn>
          <Btn variant="bare" onClick={() => { setAdding(false); setNotice(null); }} style={{ color: C.faint, fontSize: 11 }}>annuler</Btn>
        </span>
      )}
      {notice && (
        <span role="status" style={{ fontFamily: SANS, fontSize: 10.5, color: C.warn, flex: '1 1 100%' }}>{notice}</span>
      )}
    </div>
  );
}

function QueueCard({ idx, ch, subject, simpleMode, done, today, settings, onGrade, onUndo, onSkip, onSetAxisMinutes, onSetPosition, onAddDoc, onUseDoc, onRemoveDoc }) {
  const [expanded, setExpanded] = useState(false);
  const doneEntries = done || [];
  const doneAxes = useMemo(
    () => new Set(doneEntries.map((d) => d.axis || evidenceAxis(d.evidenceType))), [doneEntries]);
  // Seuls les axes déclarés par l'élément entrent en jeu.
  const axes = ch.axes || AXIS_KEYS;
  // Axe par défaut : l'axe dominant, ou le premier axe non encore noté aujourd'hui.
  const preferred = !doneAxes.has(ch.dominant)
    ? ch.dominant : (axes.find((a) => !doneAxes.has(a)) || ch.dominant);
  const [axis, setAxis] = useState(preferred);
  // Si l'axe choisi vient d'être noté, avancer vers un axe restant.
  useEffect(() => {
    if (doneAxes.has(axis)) {
      const next = axes.find((a) => !doneAxes.has(a));
      if (next) setAxis(next);
    }
  }, [doneAxes]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = !simpleMode || expanded;
  const tcol = thermal(ch.priority);
  const axisDone = doneAxes.has(axis);
  const allDone = axes.every((a) => doneAxes.has(a));
  const accent = doneEntries.length ? C.good : tcol;

  // Aperçu de l'effet de la note sur l'axe choisi (jours pour le rappel,
  // maîtrise observée pour les axes pratiques).
  const titleFor = (g) => {
    const { after, axis: ax } = applyEvidence(ch.raw, axis, g, today);
    if (ax === 'recall') {
      const d = Math.max(1, Math.round(optimalInterval(after.stability, settings.requestRetention)));
      return `résultat du test → retester le rappel dans ~${d} j`;
    }
    return `résultat du test → maîtrise observée ~${Math.round(after.score * 100)} %`;
  };

  // Clavier : 1–4 note l'axe choisi ; r / e / p change d'axe.
  const AXIS_KEYBOARD = { r: 'recall', e: 'exercise', p: 'problem' };
  const canUse = (ax) => axes.includes(ax);
  const GRADE_KEYBOARD = {
    Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4,
    Numpad1: 1, Numpad2: 2, Numpad3: 3, Numpad4: 4,
  };
  const onKey = (e) => {
    if (e.target !== e.currentTarget) return;
    if (GRADE_KEYBOARD[e.code] && !axisDone) { onGrade(ch.id, axis, GRADE_KEYBOARD[e.code]); e.preventDefault(); }
    else if (canUse(AXIS_KEYBOARD[e.key?.toLowerCase()])) { setAxis(AXIS_KEYBOARD[e.key.toLowerCase()]); e.preventDefault(); }
  };

  const rec = ch.recall; // info rappel : { risk, ti, since, R, dueIn, tested }

  return (
    <div className={`cad-card${allDone ? ' cad-done' : ''}`} tabIndex={0} role="group"
      aria-label={`${ch.name} — ${AXES[axis].long}`} onKeyDown={onKey}
      title={allDone ? undefined : 'Tab pour sélectionner · 1–4 pour noter · r/e/p pour changer d’axe'}
      style={{
      background: C.panel, border: `1px solid ${doneEntries.length ? `${accent}44` : C.line}`,
      borderLeft: `3px solid ${accent}`,
      borderRadius: 10, padding: 13, display: 'flex', flexDirection: 'column', gap: 9,
      opacity: allDone ? 0.82 : 1,
    }}>
      {/* Quel chapitre + jauge de rappel estimé + axe prioritaire */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Mono style={{ color: C.faint, fontSize: 12, width: 16 }}>{idx + 1}</Mono>
        <MemGauge R={rec.R} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span style={{
              fontFamily: SANS, fontSize: 15.5, color: C.text, fontWeight: 600,
              textDecoration: allDone ? 'line-through' : 'none',
              textDecorationColor: allDone ? `${accent}88` : undefined,
            }}>{ch.name}</span>
            <span style={{ fontFamily: SANS, fontSize: 11, color: C.dim }}>{subject.name}</span>
          </div>
          <div style={{ marginTop: 3, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Chip color={C.accent} title={`axe prioritaire : ${AXES[ch.dominant].long}`}>
              {AXES[ch.dominant].label}
            </Chip>
            <ReasonLine m={ch} size={12.5} />
          </div>
        </div>
        <Pastille color={subject.color} />
      </div>

      {/* Choix de l'axe à travailler + durée estimée de l'axe choisi */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 26, flexWrap: 'wrap' }}>
        <AxisPicker ch={ch} axis={axis} onPick={setAxis} doneAxes={doneAxes} />
        <Mono style={{ fontSize: 11, color: C.faint }}>
          ~{fmtMinutes(ch.axisInfo[axis].minutes)}
        </Mono>
        {onSetPosition && (
          <PositionField value={ch.position} onSave={(v) => onSetPosition(ch.id, v)} />
        )}
      </div>

      {/* Ce qui a été vu : on le retrouve tel quel à la session suivante. */}
      {onAddDoc && (
        <div style={{ paddingLeft: 26 }}>
          <DocsRow chapter={ch.raw ?? ch} today={today}
            onAddDoc={onAddDoc} onUseDoc={onUseDoc} onRemoveDoc={onRemoveDoc} />
        </div>
      )}

      {/* Détails (repliés en mode simple) : chiffres transparents, par axe */}
      <div className={`cad-collapse${open ? ' open' : ''}`}>
        <div className="cad-collapse-in" {...(open ? {} : { inert: '' })}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7, paddingLeft: 26, paddingTop: 4 }}>
            <Mono style={{ color: C.faint, fontSize: 11 }}>
              {axis === 'recall' ? (
                rec.tested
                  ? `rappel testé il y a ${rec.since} j · estimé ~${Math.round(rec.R * 100)} % · solidité ${round1(ch.raw.recall.stability)} j · prochain test ${rec.dueIn <= 0 ? 'auj.' : `~${rec.dueIn} j`}`
                  : 'rappel jamais testé'
              ) : (
                ch.axisInfo[axis].tested
                  ? `${AXES[axis].long} : maîtrise observée ~${ch.axisInfo[axis].pct} % · ${ch.raw[axis].attempts} test${ch.raw[axis].attempts > 1 ? 's' : ''}${ch.raw[axis].recentFails ? ` · ${ch.raw[axis].recentFails} échec(s) récent(s)` : ''}`
                  : `${AXES[axis].long} : jamais testé (score heuristique, pas une probabilité)`
              )}
            </Mono>
            {onSetAxisMinutes && (
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}
                  title="Si cet axe te prend en réalité plus ou moins de temps, ajuste ici : le plan utilisera la durée corrigée.">
                  durée réelle de cet axe
                </span>
                <select value={ch.axisInfo[axis].minutes}
                  aria-label={`durée ${AXES[axis].long}`}
                  onChange={(e) => onSetAxisMinutes(ch.id, axis, Number(e.target.value))}
                  style={{ fontFamily: MONO, fontSize: 11, color: C.text, background: C.inset, border: `1px solid ${C.line2}`, borderRadius: 6, padding: '3px 5px', cursor: 'pointer' }}>
                  {MINUTE_CHOICES.map((mn) => (
                    <option key={mn} value={mn}>{fmtMinutes(mn)}</option>
                  ))}
                </select>
              </label>
            )}
            <PriorityReader m={ch} compact />
          </div>
        </div>
      </div>

      {/* Notation de l'axe choisi + états déjà faits aujourd'hui */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 26, flexWrap: 'wrap' }}>
        {doneEntries.map((d) => {
          const ax = d.axis || evidenceAxis(d.evidenceType);
          const G = GRADES[d.grade];
          return (
            <Chip key={d.id} color={G.color} bg={`${G.color}18`} style={{ fontWeight: 700 }}
              title={`${AXES[ax].long} · ${EVIDENCE[d.evidenceType]?.label || ''}`}>
              <Check size={12} className="cad-pop" /> {AXES[ax].label} : {gradeLabel(d.evidenceType, d.grade)}
              <button type="button" onClick={() => onUndo(d.id)} aria-label="annuler"
                title="Annuler ce test"
                style={{ background: 'transparent', border: 'none', color: C.faint, cursor: 'pointer', padding: 0, marginLeft: 2, display: 'inline-flex' }}>
                <Undo2 size={12} />
              </button>
            </Chip>
          );
        })}
        {!axisDone && (
          <GradeButtons evidenceType={axis} titleFor={titleFor}
            onGrade={(g) => onGrade(ch.id, axis, g)} />
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 }}>
          {!allDone && onSkip && (
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
      <Chip color={C.dim} title={`axe prioritaire : ${AXES[ch.dominant].long} · ~${fmtMinutes(ch.minutes)}`}>
        {AXES[ch.dominant].label}
      </Chip>
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

/* ------------------------------------------------------------------ *
 *  Synchronisation : pastille d'état (en-tête)
 * ------------------------------------------------------------------ */

const SYNC_LOOK = {
  ok: { icon: Cloud, color: C.good, label: 'à jour' },
  sync: { icon: RefreshCw, color: C.accent, label: 'synchronisation…' },
  offline: { icon: CloudOff, color: C.dim, label: 'hors-ligne' },
  error: { icon: CloudOff, color: C.bad, label: 'erreur de synchro' },
  idle: { icon: Cloud, color: C.faint, label: 'à jour' },
};

function fmtClock(ts) {
  if (!ts) return null;
  try { return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return null; }
}

function SyncBadge({ sync, onOpenSettings }) {
  if (!sync?.configured) return null;
  const state = sync.pending && sync.status === 'ok' ? 'sync' : sync.status;
  const look = SYNC_LOOK[state] || SYNC_LOOK.idle;
  const Icon = look.icon;
  const at = fmtClock(sync.lastSyncAt);
  const title = sync.error
    ? `Synchronisation : ${sync.error}`
    : `Synchronisation ${look.label}${at ? ` · dernier échange à ${at}` : ''} — cliquer pour synchroniser maintenant`;
  return (
    <button type="button" onClick={() => sync.syncNow()} onDoubleClick={onOpenSettings}
      title={title} aria-label={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
        fontFamily: SANS, fontSize: 11.5, padding: '5px 9px', borderRadius: 999,
        border: `1px solid ${state === 'error' ? 'rgba(248,113,113,.4)' : C.line}`,
        background: 'transparent', color: look.color,
      }}>
      <Icon size={13} className={state === 'sync' ? 'cad-spin' : undefined} />
      <span className="cad-sync-label">{sync.pending && sync.status !== 'sync' ? 'à envoyer' : look.label}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ *
 *  Synchronisation : réglages (activation, second appareil, état)
 * ------------------------------------------------------------------ */

const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=gist&description=CADENCE';

function SyncSettings({ sync }) {
  const [mode, setMode] = useState(null); // null | 'create' | 'join'
  const [token, setToken] = useState('');
  const [gistId, setGistId] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const run = async (fn) => {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (res?.ok) { setToken(''); setGistId(''); setMode(null); }
  };

  const copyVaultId = async () => {
    try {
      await navigator.clipboard.writeText(sync.config.gistId);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch (e) { alert(`Identifiant du coffre : ${sync.config.gistId}`); }
  };

  const at = fmtClock(sync.lastSyncAt);

  return (
    <div>
      <SectionTitle icon={Smartphone}>Synchronisation entre appareils</SectionTitle>

      {sync.configured ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Chip color={sync.status === 'error' ? C.bad : sync.status === 'offline' ? C.dim : C.good}
              bg={sync.status === 'error' ? 'rgba(248,113,113,.1)' : 'rgba(52,211,153,.1)'}>
              {sync.status === 'error' ? <AlertTriangle size={11} /> : <Cloud size={11} />}
              {sync.status === 'error' ? 'erreur' : sync.status === 'offline' ? 'hors-ligne' : 'active'}
            </Chip>
            <span style={{ fontFamily: SANS, fontSize: 12, color: C.dim }}>
              {sync.pending ? 'modifications à envoyer' : at ? `dernier échange à ${at}` : 'en attente du premier échange'}
            </span>
            <Btn onClick={() => sync.syncNow()} disabled={sync.status === 'sync'}>
              <RefreshCw size={13} className={sync.status === 'sync' ? 'cad-spin' : undefined} /> Synchroniser maintenant
            </Btn>
          </div>

          {sync.error && (
            <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.bad, lineHeight: 1.5 }}>{sync.error}</div>
          )}

          <div style={{
            padding: 11, borderRadius: 9, background: C.panel2, border: `1px solid ${C.line}`,
            display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            <div style={{ fontFamily: SANS, fontSize: 12, color: C.text, fontWeight: 600 }}>
              Ajouter un autre appareil
            </div>
            <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.dim, lineHeight: 1.5 }}>
              Sur ton téléphone : ouvre CADENCE → Réglages → « J’ai déjà un coffre »,
              puis colle ton jeton et cet identifiant de coffre.
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Mono style={{ fontSize: 11.5, color: C.accent, wordBreak: 'break-all' }}>{sync.config.gistId}</Mono>
              <Btn variant="bare" onClick={copyVaultId} style={{ color: copied ? C.good : C.dim, fontSize: 12 }}>
                {copied ? <Check size={13} /> : <Download size={13} />} {copied ? 'copié' : 'copier'}
              </Btn>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <Btn variant="danger" onClick={() => {
              if (confirm('Détacher CET appareil de la synchronisation ?\nTes données restent ici et dans le coffre — seul le lien est coupé.')) sync.disconnect();
            }}>
              <CloudOff size={13} /> Détacher cet appareil
            </Btn>
            <span style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>
              appareil « {sync.deviceId} »
            </span>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontFamily: SANS, fontSize: 12.5, color: C.dim, lineHeight: 1.6, maxWidth: 640 }}>
            Garde les mêmes données sur ton téléphone et ton ordinateur. CADENCE n’a
            toujours <b>aucun serveur</b> : tes données sont déposées dans un
            <b> gist privé de ton propre compte GitHub</b> — tu peux le consulter,
            le révoquer ou le supprimer quand tu veux. Le jeton reste sur cet
            appareil et n’est <b>jamais</b> inclus dans un export JSON.
          </div>

          {!mode && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Btn variant="primary" onClick={() => setMode('create')}>
                <Cloud size={14} /> Activer la synchronisation
              </Btn>
              <Btn onClick={() => setMode('join')}>
                <Smartphone size={14} /> J’ai déjà un coffre
              </Btn>
            </div>
          )}

          {mode && (
            <div className="cad-in" style={{
              padding: 12, borderRadius: 9, background: C.panel2,
              border: `1px solid ${C.line}`, display: 'flex', flexDirection: 'column', gap: 9,
            }}>
              <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.dim, lineHeight: 1.6 }}>
                1. Crée un jeton GitHub avec la <b>seule</b> portée « gist » :{' '}
                <a href={TOKEN_URL} target="_blank" rel="noreferrer" style={{ color: C.accent }}>
                  ouvrir la page GitHub
                </a>{' '}
                (aucun accès à ton code n’est demandé).<br />
                2. Colle-le ici. Il reste sur cet appareil.
              </div>
              <input type="password" value={token} onChange={(e) => setToken(e.target.value)}
                aria-label="jeton GitHub" placeholder="ghp_… ou github_pat_…"
                autoComplete="off" spellCheck={false}
                style={{
                  fontFamily: MONO, fontSize: 12, color: C.text, background: C.inset,
                  border: `1px solid ${C.line2}`, borderRadius: 7, padding: '8px 10px', width: '100%', boxSizing: 'border-box',
                }} />
              {mode === 'join' && (
                <input type="text" value={gistId} onChange={(e) => setGistId(e.target.value)}
                  aria-label="identifiant du coffre" placeholder="identifiant du coffre (copié depuis l’autre appareil)"
                  autoComplete="off" spellCheck={false}
                  style={{
                    fontFamily: MONO, fontSize: 12, color: C.text, background: C.inset,
                    border: `1px solid ${C.line2}`, borderRadius: 7, padding: '8px 10px', width: '100%', boxSizing: 'border-box',
                  }} />
              )}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Btn variant="primary" disabled={busy || !token.trim() || (mode === 'join' && !gistId.trim())}
                  onClick={() => run(() => (mode === 'create'
                    ? sync.connect(token.trim())
                    : sync.join(token.trim(), gistId.trim())))}>
                  {busy ? <RefreshCw size={14} className="cad-spin" /> : <Cloud size={14} />}
                  {mode === 'create' ? 'Créer mon coffre privé' : 'Rejoindre le coffre'}
                </Btn>
                <Btn variant="bare" onClick={() => { setMode(null); setToken(''); setGistId(''); }}
                  style={{ color: C.faint, fontSize: 12 }}>annuler</Btn>
              </div>
              {sync.error && (
                <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.bad, lineHeight: 1.5 }}>{sync.error}</div>
              )}
              {mode === 'join' && (
                <div style={{ fontFamily: SANS, fontSize: 11, color: C.faint, lineHeight: 1.5 }}>
                  Les données des deux appareils sont <b>fusionnées</b>, jamais écrasées :
                  aucun test noté ne peut être perdu.
                </div>
              )}
            </div>
          )}
        </div>
      )}
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
    -webkit-appearance: none; appearance: none; height: 28px;
    background: linear-gradient(${C.line}, ${C.line}) center / 100% 4px no-repeat;
    border-radius: 2px; outline: none; cursor: pointer;
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
  @keyframes cad-spin { to { transform: rotate(360deg); } }
  .cad-spin { animation: cad-spin 1.1s linear infinite; }
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

  .cad-eyebrow {
    margin: 0 0 5px; display: flex; align-items: center; gap: 6px;
    color: ${C.accent}; font: 700 10.5px/1.2 ${MONO};
    letter-spacing: .08em; text-transform: uppercase;
  }
  .cad-feature-button {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    flex: 0 0 auto; border: 1px solid ${C.line2}; border-radius: 8px;
    padding: 7px 11px; color: ${C.text}; background: ${C.panel2};
    cursor: pointer; font: 600 12px/1.25 ${SANS};
  }
  .cad-feature-button-primary {
    border-color: rgba(94,169,255,.52); color: #dbeafe; background: rgba(94,169,255,.14);
  }
  .cad-feature-button:disabled { opacity: .42; cursor: not-allowed; filter: none; }

  .cad-focus-progress span {
    display: block; height: 100%; border-radius: inherit; background: ${C.accent};
    transition: width .3s var(--ease);
  }

  .cad-search-trigger {
    display: inline-flex; align-items: center; gap: 7px; min-height: 34px;
    padding: 6px 8px 6px 10px; border: 1px solid ${C.line2}; border-radius: 8px;
    color: ${C.dim}; background: rgba(17,24,36,.78); cursor: pointer;
  }
  .cad-search-trigger kbd {
    padding: 2px 5px; border: 1px solid ${C.line2}; border-radius: 4px;
    color: ${C.faint}; background: ${C.inset}; font: 10px ${MONO};
  }
  .cad-search-backdrop {
    position: fixed; inset: 0; z-index: 100; display: grid; place-items: start center;
    padding: min(14vh, 120px) 16px 24px; background: rgba(3,6,11,.72); backdrop-filter: blur(5px);
  }
  .cad-search-dialog {
    width: min(620px, 100%); max-height: min(680px, 78vh); overflow: hidden;
    border: 1px solid ${C.line2}; border-radius: 13px; color: ${C.text}; background: #111824;
    box-shadow: 0 28px 80px -20px rgba(0,0,0,.9); animation: cad-fade-up .2s var(--ease) both;
  }
  .cad-search-dialog *:focus-visible { outline: 2px solid ${C.accent}; outline-offset: 2px; border-radius: 4px; }
  .cad-search-head { display: flex; align-items: center; gap: 9px; padding: 13px 14px 8px; color: ${C.dim}; }
  .cad-search-head h2 { flex: 1; margin: 0; color: ${C.text}; font: 700 14px ${SANS}; }
  .cad-search-close {
    display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px;
    border: 1px solid transparent; border-radius: 7px; color: ${C.dim}; background: transparent; cursor: pointer;
  }
  .cad-search-input {
    width: calc(100% - 28px); margin: 0 14px 10px; padding: 11px 12px;
    border: 1px solid ${C.line2}; border-radius: 8px; color: ${C.text}; background: ${C.inset};
    font: 14px ${SANS};
  }
  .cad-search-count { margin: -2px 16px 6px; color: ${C.faint}; font: 10.5px ${MONO}; }
  .cad-search-results { max-height: min(390px, 48vh); overflow-y: auto; padding: 0 8px; }
  .cad-search-result {
    display: flex; align-items: center; gap: 10px; width: 100%; min-height: 52px;
    padding: 8px 10px; border: 1px solid transparent; border-radius: 8px;
    color: ${C.text}; background: transparent; cursor: pointer; text-align: left;
  }
  .cad-search-result[data-active="true"] { border-color: rgba(94,169,255,.32); background: rgba(94,169,255,.1); }
  .cad-search-result-dot { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; }
  .cad-search-result > span:nth-child(2) { display: grid; min-width: 0; flex: 1; }
  .cad-search-result strong { overflow: hidden; color: ${C.text}; font: 650 13px ${SANS}; text-overflow: ellipsis; white-space: nowrap; }
  .cad-search-result small { margin-top: 2px; color: ${C.faint}; font: 11.5px ${SANS}; }
  .cad-search-empty { margin: 6px 0; padding: 24px 14px; color: ${C.dim}; text-align: center; font: 13px/1.5 ${SANS}; }
  .cad-search-hint { margin: 8px 14px 12px; color: ${C.faint}; font: 10.5px ${MONO}; text-align: center; }

  .cad-focus-shell {
    padding: 16px; border: 1px solid rgba(94,169,255,.34); border-radius: 12px;
    background: linear-gradient(145deg, rgba(94,169,255,.08), ${C.panel} 45%);
  }
  .cad-focus-header { display: flex; align-items: start; gap: 14px; }
  .cad-focus-header > div { flex: 1; min-width: 0; }
  .cad-focus-header h2 { margin: 0; color: ${C.text}; font: 700 18px/1.3 ${SANS}; }
  .cad-focus-header > div > p:last-child { margin: 4px 0 0; color: ${C.dim}; font: 11.5px ${MONO}; }
  .cad-focus-exit {
    display: inline-flex; align-items: center; gap: 6px; padding: 7px 9px;
    border: 1px solid ${C.line2}; border-radius: 8px; color: ${C.dim}; background: transparent; cursor: pointer;
    font: 12px ${SANS};
  }
  .cad-focus-progress { height: 4px; margin: 12px 0 16px; overflow: hidden; border-radius: 999px; background: ${C.line}; }
  .cad-focus-card { animation: cad-fade-up .22s var(--ease) both; }
  .cad-focus-navigation { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
  .cad-focus-navigation > span {
    display: inline-flex; align-items: center; justify-content: center; gap: 5px;
    flex: 1; color: ${C.faint}; font: 11.5px ${SANS}; text-align: center;
  }
  .cad-focus-navigation > span.is-done { color: ${C.good}; }
  .cad-focus-shortcut { margin: 9px 0 0; color: ${C.faint}; font: 10.5px ${MONO}; text-align: center; }
  .cad-focus-complete { padding: 22px; color: ${C.good}; text-align: center; }
  .cad-focus-complete h2 { margin: 8px 0 3px; color: ${C.text}; font: 700 18px ${SANS}; }
  .cad-focus-complete p { margin: 0 0 13px; color: ${C.dim}; font: 13px ${SANS}; }
  .cad-target { animation: cad-target 1.35s var(--ease) both; }
  @keyframes cad-target { 0%, 100% { box-shadow: none; } 35% { box-shadow: 0 0 0 3px rgba(94,169,255,.28); } }

  @media (max-width: 760px) {
    .cad-search-trigger { margin-left: auto; }
    .cad-search-label, .cad-search-trigger kbd, .cad-sync-label { display: none; }
    .cad-focus-header { flex-wrap: wrap; }
    .cad-focus-navigation { flex-wrap: wrap; }
    .cad-focus-navigation > span { order: -1; flex-basis: 100%; }
    .cad-focus-navigation .cad-feature-button { flex: 1; }
  }
  @media (max-width: 640px) { .cad-tab-label { display: none; } }
  @media (pointer: coarse) {
    .cadence button { min-width: 44px; min-height: 44px; }
    .cadence input[type=range] { min-height: 44px; }
    .cad-search-dialog button { min-width: 44px; min-height: 44px; }
  }

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
  { id: 'settings', label: 'Réglages', icon: SettingsIcon },
];

// État par axe, prêt pour l'affichage (jamais testé -> pct null).
function axisInfoOf(m, raw) {
  return {
    recall: {
      tested: m.recall.tested,
      pct: m.recall.R != null ? Math.round(m.recall.R * 100) : null,
      minutes: raw.minutes?.recall ?? AXIS_MINUTES.recall,
    },
    exercise: {
      tested: (raw.exercise?.attempts || 0) > 0,
      pct: raw.exercise?.score != null ? Math.round(raw.exercise.score * 100) : null,
      minutes: raw.minutes?.exercise ?? AXIS_MINUTES.exercise,
    },
    problem: {
      tested: (raw.problem?.attempts || 0) > 0,
      pct: raw.problem?.score != null ? Math.round(raw.problem.score * 100) : null,
      minutes: raw.minutes?.problem ?? AXIS_MINUTES.problem,
    },
  };
}

// Enrichit un chapitre avec ses métriques multi-axes, en préservant l'état brut
// (`raw`) car le spread des métriques masque les axes FSRS/heuristiques bruts.
function enrichChapter(raw, exams, settings, today) {
  const m = chapterMetrics(raw, exams, settings, today);
  return { ...raw, ...m, raw, axisInfo: axisInfoOf(m, raw) };
}

export default function Cadence() {
  const store = useMemo(() => makeStore(), []);
  const initialLoad = useMemo(() => loadCadenceState(store), [store]);
  const [state, setState] = useState(initialLoad.state);
  const stateRef = useRef(initialLoad.state);
  const persistenceBlocked = useRef(initialLoad.writeBlocked);
  const externalWritePending = useRef(false);
  const recoveryRef = useRef(initialLoad.recovery || null);
  const [storageNotice, setStorageNotice] = useState(initialLoad.notice);
  const [externalState, setExternalState] = useState(null);

  const replaceState = (next) => {
    stateRef.current = next;
    setState(next);
  };

  // Identifiant de CET appareil : local, stable, jamais mêlé aux données.
  const deviceIdRef = useRef(null);
  if (deviceIdRef.current === null) deviceIdRef.current = getDeviceId(store, newDeviceId);

  // Synchronisation multi-appareils (inactive tant qu'elle n'est pas activée).
  // Les deux rappels sont stables : sinon `syncNow` changerait d'identité à
  // chaque rendu et réarmerait sans cesse la minuterie d'envoi.
  const getSyncState = useCallback(() => stateRef.current, []);
  // Un état venu de la fusion garde SON horodatage : il ne doit pas être
  // re-marqué comme une modification locale, sinon les appareils se
  // renverraient indéfiniment le même contenu.
  const applyMergedState = useCallback((merged) => {
    stateRef.current = merged;
    setState(merged);
  }, []);
  const sync = useSync({ store, getState: getSyncState, applyMerged: applyMergedState });
  useSyncTriggers({
    configured: sync.configured,
    signature: contentSignature(state),
    syncNow: sync.syncNow,
    markPending: sync.markPending,
  });

  // Écriture vérifiée : une erreur de quota ou de navigateur privé devient
  // visible et les mutations restent exportables depuis l'état React courant.
  useEffect(() => {
    stateRef.current = state;
    if (persistenceBlocked.current || externalWritePending.current) return;
    const saved = saveCadenceState(store, state);
    if (!saved.ok) {
      setStorageNotice({
        kind: 'error', code: 'write',
        text: `Sauvegarde locale impossible (${saved.error}). Exporte tes données avant de fermer la page.`,
      });
    } else {
      setStorageNotice((current) => (current?.code === 'write' ? null : current));
    }
  }, [state, store]);

  const [tab, setTab] = useState('today');
  const [subjectFocus, setSubjectFocus] = useState(null);
  const subjectFocusSequence = useRef(0);
  const [toast, setToast] = useState(null); // { text, entryId }
  const toastTimer = useRef(null);
  const today = useCurrentDay();

  // L'instantané est pris au début de chaque journée, pas à chaque frappe.
  useEffect(() => {
    if (persistenceBlocked.current || externalWritePending.current) return;
    const backup = saveDailyBackup(store, stateRef.current, today);
    if (!backup.ok) {
      setStorageNotice((current) => current?.kind === 'error' ? current : {
        kind: 'warning', code: 'backup',
        text: `L’état principal est enregistré, mais l’instantané quotidien a échoué (${backup.error}).`,
      });
    }
  }, [store, today]);

  // Deux onglets ne doivent plus s'écraser en silence. L'écriture locale est
  // suspendue jusqu'à ce que l'utilisateur choisisse quelle version garder.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      if (event.newValue === JSON.stringify(stateRef.current)) return;
      try {
        externalWritePending.current = true;
        setExternalState(deserializeCadenceState(event.newValue));
      } catch (error) {
        setStorageNotice({
          kind: 'error', code: 'external-invalid',
          text: 'Une autre fenêtre a écrit des données incompatibles. Les écritures sont suspendues : exporte cette version ou recharge la page.',
        });
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const {
    subjects, chapters, exams, courseTests = [], courseTestLog = [],
    settings, reviewLog, examDebriefs, lastExportAt,
  } = state;
  const studyChapters = useMemo(() => chapters.filter((c) => !isReviewUnit(c)), [chapters]);
  const reviewUnits = useMemo(() => chapters.filter(isReviewUnit), [chapters]);

  const goToSubjects = ({ subjectId = null, chapterId = null, target = 'subject' } = {}) => {
    setSubjectFocus({ subjectId, chapterId, target, token: ++subjectFocusSequence.current });
    setTab('subjects');
  };

  const useExternalState = () => {
    if (!externalState) return;
    externalWritePending.current = false;
    replaceState(externalState);
    setExternalState(null);
    setStorageNotice(null);
  };
  const keepCurrentState = () => {
    externalWritePending.current = false;
    setExternalState(null);
    const saved = saveCadenceState(store, stateRef.current);
    setStorageNotice(saved.ok ? null : {
      kind: 'error', code: 'write',
      text: `Impossible de conserver cette version (${saved.error}). Exporte tes données avant de fermer la page.`,
    });
  };
  const downloadRecovery = () => {
    const raw = recoveryRef.current?.raw;
    if (!raw) return;
    const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `cadence-donnees-illisibles-${today}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const startFreshAfterCorruption = () => {
    if (!confirm('Créer un nouvel état CADENCE ? Le contenu illisible reste disponible dans le fichier de secours.')) return;
    try { store.removeItem(STORAGE_KEY); } catch (error) { /* l'écriture vérifiée signalera le problème */ }
    persistenceBlocked.current = false;
    const next = seedState();
    replaceState(next);
    setStorageNotice({
      kind: 'warning', code: 'fresh-after-corruption',
      text: 'Un nouvel état a été créé. Le contenu illisible reste conservé comme secours local.',
    });
  };

  /* ----- Mutations ----- */
  // Chaque modification faite ici est horodatée : c'est ce qui permet à la
  // fusion multi-appareils de départager deux versions d'un même élément.
  const patch = (fn) => setState((prev) => {
    const next = stampState(fn(prev), deviceIdRef.current);
    stateRef.current = next;
    return next;
  });

  const addSubject = (name) => patch((p) => ({
    ...p, subjects: [...p.subjects, {
      id: uid(), name, color: '#7c9cf5', type: 'core',
      dailyMinutes: SUBJECT_DAILY_MINUTES, minimumMinutes: SUBJECT_PROTECTED_MINUTES,
    }],
  }));
  const updateSubject = (id, up) => patch((p) => ({
    ...p, subjects: p.subjects.map((s) => (s.id === id ? { ...s, ...up } : s)),
  }));
  const deleteSubject = (id) => patch((p) => {
    const chapIds = p.chapters.filter((c) => c.subjectId === id).map((c) => c.id);
    const idSet = new Set(chapIds);
    const examIds = new Set(p.exams.filter((e) => e.subjectId === id).map((e) => e.id));
    const courseTestIds = new Set((p.courseTests || []).filter((test) => test.subjectId === id).map((test) => test.id));
    return {
      ...p,
      subjects: p.subjects.filter((s) => s.id !== id),
      chapters: p.chapters.filter((c) => c.subjectId !== id),
      exams: stripChapterIds(p.exams.filter((e) => e.subjectId !== id), chapIds),
      courseTests: (p.courseTests || []).filter((test) => !courseTestIds.has(test.id)),
      courseTestLog: (p.courseTestLog || []).filter((entry) => !courseTestIds.has(entry.testId)),
      reviewLog: p.reviewLog.filter((r) => !idSet.has(r.chapterId)),
      archivedReviews: (p.archivedReviews || []).filter((r) => !idSet.has(r.chapterId)),
      skips: Object.fromEntries(Object.entries(p.skips || {}).filter(([chapterId]) => !idSet.has(chapterId))),
      parallelLog: Object.fromEntries(Object.entries(p.parallelLog || {}).map(([week, values]) => [
        week, Object.fromEntries(Object.entries(values || {}).filter(([subjectId]) => subjectId !== id)),
      ])),
      examDebriefs: Object.fromEntries(Object.entries(p.examDebriefs || {}).filter(([examId]) => !examIds.has(examId))),
      // Traces de suppression : sans elles, un autre appareil ressusciterait
      // la matière (et son contenu) à la prochaine synchronisation.
      deleted: markDeleted(markDeleted(
        markDeleted(markDeleted(p.deleted, 'subjects', [id], today), 'chapters', chapIds, today),
        'exams', [...examIds], today), 'courseTests', [...courseTestIds], today),
    };
  });

  const addChapter = (subjectId, name, level) => patch((p) => ({
    ...p, chapters: [...p.chapters, newChapter(subjectId, name, level || LEVELS[0], p.settings)],
  }));
  // Ajout groupé : un chapitre par ligne (niveau + durées par défaut).
  const addChaptersBulk = (subjectId, names, level) => patch((p) => ({
    ...p, chapters: [...p.chapters, ...names.map((n) => newChapter(subjectId, n, level || LEVELS[0], p.settings))],
  }));
  // Ressource : tout ce qui se révise sans être un chapitre de cours
  // (vocabulaire, recueil d'exercices, annales…). Seuls les axes choisis
  // s'appliquent — sinon elle réclamerait éternellement des tests hors sujet.
  const addResource = (subjectId, name, axes) => patch((p) => ({
    ...p, chapters: [...p.chapters, newResource(subjectId, name, axes, p.settings)],
  }));
  const updateChapter = (id, up) => patch((p) => ({
    ...p, chapters: p.chapters.map((c) => (c.id === id ? { ...c, ...up } : c)),
  }));
  // Documents : des RÉFÉRENCES attachées à un élément. Le contenu des fichiers
  // n'est jamais stocké — il ferait exploser l'état synchronisé.
  const addChapterDoc = (id, label, url) => patch((p) => ({
    ...p,
    chapters: p.chapters.map((c) => {
      if (c.id !== id) return c;
      const doc = newDoc(label, url, today);
      if (!doc || normDocs(c.docs).length >= DOCS_PER_CHAPTER_MAX) return c;
      return { ...c, docs: normDocs([...(c.docs || []), doc]) };
    }),
  }));
  // Ouvrir un document = l'avoir utilisé aujourd'hui. C'est ce qui le fait
  // remonter en tête à la session suivante.
  const useChapterDoc = (id, docId) => patch((p) => ({
    ...p,
    chapters: p.chapters.map((c) => (c.id === id
      ? { ...c, docs: normDocs((c.docs || []).map((d) => (d.id === docId ? { ...d, lastUsedAt: today } : d))) }
      : c)),
  }));
  const removeChapterDoc = (id, docId) => patch((p) => ({
    ...p,
    chapters: p.chapters.map((c) => (c.id === id
      ? { ...c, docs: normDocs((c.docs || []).filter((d) => d.id !== docId)) } : c)),
  }));

  // Le point reste un signet. Quand il suit le format quotidien « Ajout du
  // jj/mm/aaaa — notion », une unité de reprise invisible est créée. Elle ne
  // demandera aucune maîtrise le jour même et apparaîtra à partir du lendemain.
  const setChapterPosition = (id, value) => patch((p) => {
    const position = normPosition(value);
    const positionUpdatedAt = additionDateFromPosition(position) || today;
    const updated = p.chapters.map((c) => (c.id === id
      ? { ...c, position, positionUpdatedAt } : c));
    return { ...p, chapters: upsertReviewUnit(updated, id, position, p.settings) };
  });
  // Axes applicables : au moins un, sinon l'élément ne serait jamais planifiable.
  const setChapterAxes = (id, axes) => patch((p) => ({
    ...p,
    chapters: p.chapters.map((c) => {
      if (c.id !== id) return c;
      const kept = AXIS_KEYS.filter((a) => axes.includes(a));
      return kept.length ? { ...c, axes: kept } : c;
    }),
  }));
  const deleteChapter = (id) => patch((p) => {
    const ids = [id, ...p.chapters.filter((c) => c.parentChapterId === id).map((c) => c.id)];
    const set = new Set(ids);
    return {
      ...p,
      chapters: p.chapters.filter((c) => !set.has(c.id)),
      exams: stripChapterIds(p.exams, ids),
      courseTests: stripChapterIds(p.courseTests || [], ids),
      courseTestLog: (p.courseTestLog || []).map((entry) => ({
        ...entry,
        chapterIds: (entry.chapterIds || []).filter((chapterId) => !set.has(chapterId)),
        portionIds: (entry.portionIds || []).filter((chapterId) => !set.has(chapterId)),
      })),
      reviewLog: p.reviewLog.filter((r) => !set.has(r.chapterId)),
      archivedReviews: (p.archivedReviews || []).filter((r) => !set.has(r.chapterId)),
      skips: Object.fromEntries(Object.entries(p.skips || {}).filter(([chapterId]) => !set.has(chapterId))),
      deleted: markDeleted(p.deleted, 'chapters', ids, today),
    };
  });
  // Recalibrer : confirmation, puis les 3 axes repartent du niveau + historique
  // du chapitre archivé (cohérence garantie entre niveau, dates et journal).
  const setChapterLevel = (id, level) => {
    const ch = chapters.find((c) => c.id === id);
    const hasHistory = ch?.recall?.lastReviewed || ch?.exercise?.attempts || ch?.problem?.attempts
      || reviewLog.some((r) => r.chapterId === id);
    if (hasHistory && !confirm(
      `Recalibrer « ${ch?.name} » sur « ${level.label} » ?\n` +
      'Le chapitre repart de ce niveau sur les trois axes : dates de test effacées, historique archivé.')) return;
    patch((p) => recalibrateState(p, id, level.key));
  };

  // Durée estimée d'un axe pour un chapitre (minutes).
  const setChapterAxisMinutes = (id, axis, minutes) => patch((p) => ({
    ...p, chapters: p.chapters.map((c) => (c.id === id
      ? { ...c, minutes: { ...c.minutes, [axis]: minutes } } : c)),
  }));

  // Noter un TEST sur UN AXE : ne modifie que cet axe. Une note par axe et par
  // jour ; une seconde du même axe le même jour demande confirmation.
  const gradeEvidence = (id, evidenceType, grade, options = {}) => {
    const axis = evidenceAxis(evidenceType);
    const evidenceDate = options.date || today;
    const sameSlot = (r) => r.chapterId === id && evidenceAxis(r.evidenceType) === axis
      && (options.examId ? r.examId === options.examId : !r.examId && r.date === evidenceDate);
    const existing = reviewLog.find(sameSlot);
    if (existing && !confirm(
      `Tu as déjà noté l'axe « ${AXES[axis].label} » pour ce test.\nRemplacer par cette nouvelle note ?`)) return;
    const entryId = uid();
    patch((p) => {
      const ch = p.chapters.find((c) => c.id === id);
      if (!ch) return p;
      const prior = p.reviewLog.find(sameSlot);
      // Un remplacement repart de l'état AVANT la preuve remplacée : il ne
      // cumule pas deux transitions dont une disparaîtrait du journal.
      const base = prior ? { ...ch, [axis]: { ...prior.before } } : ch;
      const result = options.source === 'self-review' && Number.isInteger(options.masteryLevel)
        ? applySelfAssessment(base, options.masteryLevel, evidenceDate, p.settings)
        : applyEvidence(base, evidenceType, grade, evidenceDate);
      const { chapter, before, after } = result;
      const storedGrade = result.grade ?? grade;
      const log = p.reviewLog.filter((r) => !sameSlot(r));
      const entry = {
        id: entryId, chapterId: id, date: evidenceDate, grade: storedGrade, evidenceType, axis, before, after,
        ...(Number.isInteger(options.masteryLevel) ? { masteryLevel: options.masteryLevel } : {}),
        ...(options.source ? { source: options.source } : {}),
        ...(options.examId ? { examId: options.examId } : {}),
        ...(options.examId ? { recordedAt: today } : {}),
      };
      return {
        ...p,
        chapters: p.chapters.map((c) => (c.id === id ? chapter : c)),
        reviewLog: [...log, entry],
      };
    });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    const selfLabel = options.source === 'self-review'
      ? (SELF_ASSESSMENTS.find((x) => x.level === options.masteryLevel)?.label || gradeLabel(evidenceType, grade))
      : gradeLabel(evidenceType, grade);
    setToast({ text: `${options.source === 'self-review' ? 'Consolidation' : AXES[axis].label} : « ${selfLabel} »`, entryId });
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  };

  // Annuler une note : restaure l'état de l'axe concerné, retire l'entrée.
  const undoReview = (entryId) => {
    patch((p) => {
      const entry = p.reviewLog.find((r) => r.id === entryId);
      if (!entry) return p;
      const axis = entry.axis || evidenceAxis(entry.evidenceType);
      return {
        ...p,
        chapters: p.chapters.map((c) => (c.id === entry.chapterId
          ? { ...c, [axis]: { ...entry.before } } : c)),
        reviewLog: p.reviewLog.filter((r) => r.id !== entryId),
      };
    });
    setToast(null);
  };

  // Masquer le bilan d'une épreuve passée (il expire de lui-même après 3 j).
  const dismissDebrief = (examId) => patch((p) => ({
    ...p, examDebriefs: { ...(p.examDebriefs || {}), [examId]: today },
  }));

  // Restauration d'une sauvegarde quotidienne.
  const restoreBackup = (date) => {
    try {
      const raw = store.getItem(BACKUP_KEY);
      const backups = raw ? JSON.parse(raw) : {};
      if (!backups[date]) return;
      if (confirm(`Restaurer la sauvegarde du ${date} ? L'état actuel sera remplacé.`)) {
        replaceState(normalize(backups[date]));
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
    ...p, exams: [...p.exams, {
      id: uid(), subjectId, name: exam.name, date: exam.date,
      chapterIds: exam.chapterIds || [], portionIds: exam.portionIds || [],
      importance: exam.importance || 'normal',
    }],
  }));
  const updateExam = (id, up) => patch((p) => ({
    ...p, exams: p.exams.map((e) => (e.id === id ? { ...e, ...up } : e)),
  }));
  const deleteExam = (id) => patch((p) => ({
    ...p,
    exams: p.exams.filter((e) => e.id !== id),
    examDebriefs: Object.fromEntries(Object.entries(p.examDebriefs || {}).filter(([examId]) => examId !== id)),
    deleted: markDeleted(p.deleted, 'exams', [id], today),
  }));
  const toggleExamChapter = (examId, chapterId) => patch((p) => ({
    ...p,
    exams: p.exams.map((e) => {
      if (e.id !== examId) return e;
      const has = (e.chapterIds || []).includes(chapterId);
      return {
        ...e,
        chapterIds: has ? e.chapterIds.filter((x) => x !== chapterId) : [...(e.chapterIds || []), chapterId],
        portionIds: has ? (e.portionIds || []) : (e.portionIds || []).filter((portionId) => {
          const portion = p.chapters.find((chapter) => chapter.id === portionId);
          return portion?.parentChapterId !== chapterId;
        }),
      };
    }),
  }));
  const toggleExamPortion = (examId, portionId) => patch((p) => ({
    ...p,
    exams: p.exams.map((e) => {
      if (e.id !== examId) return e;
      const has = (e.portionIds || []).includes(portionId);
      return { ...e, portionIds: has
        ? (e.portionIds || []).filter((x) => x !== portionId)
        : [...(e.portionIds || []), portionId] };
    }),
  }));

  const addCourseTest = (subjectId, test) => patch((p) => ({
    ...p,
    courseTests: [...(p.courseTests || []), newCourseTest(
      subjectId, test.name, test.scheduledFor,
      test.chapterIds || [], test.portionIds || [], today,
    )],
  }));
  const updateCourseTest = (id, up) => patch((p) => ({
    ...p,
    courseTests: (p.courseTests || []).map((test) => (test.id === id ? { ...test, ...up } : test)),
  }));
  const deleteCourseTest = (id) => patch((p) => ({
    ...p,
    courseTests: (p.courseTests || []).filter((test) => test.id !== id),
    courseTestLog: (p.courseTestLog || []).filter((entry) => entry.testId !== id),
    deleted: markDeleted(p.deleted, 'courseTests', [id], today),
  }));
  const recordCourseTest = (testId, score, maxScore, closedBook) => {
    if (!closedBook || !Number.isFinite(score) || !Number.isFinite(maxScore)
      || maxScore <= 0 || score < 0 || score > maxScore) return;
    const currentTest = courseTests.find((item) => item.id === testId);
    if (!currentTest) return;
    const ratio = score / maxScore;
    const next = nextCourseTestDate(currentTest, ratio, exams, settings, today, chapters);
    patch((p) => {
      const test = (p.courseTests || []).find((item) => item.id === testId);
      if (!test) return p;
      const entry = {
        id: uid(), testId, date: today, score, maxScore, ratio, closedBook: true,
        chapterIds: [...(test.chapterIds || [])], portionIds: [...(test.portionIds || [])],
        nextScheduledFor: next.date,
      };
      return {
        ...p,
        courseTests: (p.courseTests || []).map((item) => (item.id === testId
          ? { ...item, scheduledFor: next.date } : item)),
        courseTestLog: [...(p.courseTestLog || []), entry],
      };
    });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text: `Test noté : ${score}/${maxScore} · prochain le ${next.date.split('-').reverse().join('/')}` });
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  };

  const updateSetting = (key, value) => patch((p) => ({ ...p, settings: { ...p.settings, [key]: value } }));

  // Import : validation stricte (liste d'erreurs) + confirmation avant
  // écrasement. En cas d'erreur, AUCUNE donnée existante n'est modifiée.
  const importState = (obj) => {
    const v = validateImport(obj);
    if (!v.ok) {
      const list = v.errors.slice(0, 8).map((e) => `• ${e}`).join('\n');
      const more = v.errors.length > 8 ? `\n…(+${v.errors.length - 8} autres)` : '';
      alert(`Import refusé — le fichier n'a pas été appliqué.\n\n${list}${more}`);
      return false;
    }
    const nb = (obj.chapters || []).length;
    if (!confirm(`Remplacer les données actuelles par ce fichier ?\n(${(obj.subjects || []).length} matières, ${nb} chapitres — l'état actuel sera écrasé.)`)) return false;
    replaceState(normalize(obj));
    return true;
  };
  const markExported = () => patch((p) => ({ ...p, lastExportAt: today }));
  const resetAll = () => {
    if (!confirm('Réinitialiser CADENCE ? Tes chapitres, épreuves, historique, sauvegardes et réglages seront effacés.')) return;
    try {
      [STORAGE_KEY, LEGACY_KEY, BACKUP_KEY, QUARANTINE_KEY].forEach((key) => store.removeItem(key));
    } catch (error) { /* la prochaine écriture vérifiée affichera l'erreur */ }
    persistenceBlocked.current = false;
    recoveryRef.current = null;
    replaceState(seedState());
    setStorageNotice(null);
  };

  /* ----- Données dérivées ----- */
  const subjectById = useMemo(
    () => Object.fromEntries(subjects.map((s) => [s.id, s])), [subjects]);
  const coreSubjects = useMemo(() => subjects.filter((s) => s.type === 'core'), [subjects]);

  const annalesBanners = useMemo(() => coreSubjects
    .map((s) => ({ subject: s, info: annalesModeFor(s.id, exams, settings, today) }))
    .filter((x) => x.info), [coreSubjects, exams, settings, today]);

  // Épreuves récemment passées à débriefer (constat = axe problème/annale).
  const debriefs = useMemo(
    () => pendingDebriefs(exams, chapters, reviewLog, examDebriefs, today),
    [exams, chapters, reviewLog, examDebriefs, today]);

  const upcomingExams = useMemo(() => exams
    .map((e) => ({ ...e, days: daysBetween(today, e.date) }))
    .filter((e) => e.days >= 0)
    .sort((a, b) => a.days - b.days), [exams, today]);
  const nextExam = upcomingExams[0] || null;

  const dueForecast = useMemo(
    () => forecastReviewUnits(reviewUnits, settings, today, 35, exams),
    [reviewUnits, settings, today, exams]);

  // Rappel d'export discret : jamais exporté (ou > 21 j) avec un historique réel.
  const exportStale = reviewLog.length >= 20 &&
    (!lastExportAt || daysBetween(lastExportAt, today) > 21);
  // Continuité : un seul chapitre courant par matière, choisi par la date du
  // dernier ajout. Cela guide vers le document sans décider du nouveau travail.
  const currentBySubject = useMemo(() => {
    const map = {};
    for (const chapter of studyChapters) {
      const previous = map[chapter.subjectId];
      const date = chapter.positionUpdatedAt || additionDateFromPosition(chapter.position) || '';
      const previousDate = previous?.positionUpdatedAt || additionDateFromPosition(previous?.position) || '';
      if (!previous || date >= previousDate) map[chapter.subjectId] = chapter;
    }
    return map;
  }, [studyChapters]);
  const parentById = useMemo(
    () => Object.fromEntries(studyChapters.map((c) => [c.id, c])), [studyChapters]);
  const dueReviewUnits = useMemo(() => reviewUnits
    .map((unit) => ({ unit, info: reviewUnitInfo(unit, settings, today, exams) }))
    .filter(({ info }) => info.due)
    .sort((a, b) => a.info.dueAt.localeCompare(b.info.dueAt)
      || a.unit.introducedAt.localeCompare(b.unit.introducedAt)),
  [reviewUnits, settings, today, exams]);
  const selfReviewsToday = useMemo(
    () => reviewLog.filter((r) => r.date === today && r.source === 'self-review').length,
    [reviewLog, today]);
  const timeAllocations = useMemo(
    () => allocateSubjectMinutes(subjects, exams, settings, today),
    [subjects, exams, settings, today]);
  const courseTestsDue = useMemo(
    () => dueCourseTests(courseTests, today), [courseTests, today]);
  const testSuggestions = useMemo(
    () => courseTestSuggestions(subjects, chapters, courseTests, today),
    [subjects, chapters, courseTests, today]);

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
          <ChapterSearch
            chapters={studyChapters}
            subjects={subjects}
            onSelect={(chapter) => goToSubjects({
              subjectId: chapter.subjectId,
              chapterId: chapter.id,
              target: 'chapter',
            })}
          />
          <SyncBadge sync={sync} onOpenSettings={() => setTab('settings')} />
          <nav aria-label="Navigation principale" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginLeft: 'auto' }}>
            {TABS.map((t) => {
              const active = tab === t.id;
              return (
                <button key={t.id} onClick={() => setTab(t.id)} title={t.label}
                  aria-current={active ? 'page' : undefined} style={{
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

      {externalState && (
        <div role="alert" style={{
          maxWidth: 1000, margin: '12px auto 0', padding: '10px 14px',
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          border: '1px solid rgba(251,191,36,.45)', borderRadius: 9,
          background: 'rgba(251,191,36,.09)', color: C.text, fontFamily: SANS, fontSize: 13,
        }}>
          <AlertTriangle size={17} color={C.warn} />
          <span style={{ flex: '1 1 360px' }}>
            <b>Une autre fenêtre a modifié CADENCE.</b> Les écritures sont suspendues pour éviter un écrasement silencieux.
          </span>
          <Btn onClick={useExternalState}>Charger l’autre version</Btn>
          <Btn variant="primary" onClick={keepCurrentState}>Garder cette version</Btn>
        </div>
      )}

      {storageNotice && (
        <div role={storageNotice.kind === 'error' ? 'alert' : 'status'} style={{
          maxWidth: 1000, margin: '12px auto 0', padding: '10px 14px',
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          border: `1px solid ${storageNotice.kind === 'error' ? 'rgba(248,113,113,.45)' : 'rgba(251,191,36,.4)'}`,
          borderRadius: 9,
          background: storageNotice.kind === 'error' ? 'rgba(248,113,113,.08)' : 'rgba(251,191,36,.07)',
          color: C.text, fontFamily: SANS, fontSize: 13,
        }}>
          <AlertTriangle size={17} color={storageNotice.kind === 'error' ? C.bad : C.warn} />
          <span style={{ flex: '1 1 360px' }}>{storageNotice.text}</span>
          {recoveryRef.current?.raw && (
            <Btn onClick={downloadRecovery}><Download size={14} /> Fichier de secours</Btn>
          )}
          {storageNotice.code === 'corrupt' && (
            <Btn variant="danger" onClick={startFreshAfterCorruption}>Créer un état neuf</Btn>
          )}
          {['volatile', 'write'].includes(storageNotice.code) && (
            <Btn variant="primary" onClick={() => setTab('settings')}>Exporter maintenant</Btn>
          )}
          {storageNotice.code === 'external-invalid' && (
            <>
              <Btn variant="primary" onClick={() => setTab('settings')}>Exporter cette version</Btn>
              <Btn onClick={() => window.location.reload()}>Recharger la page</Btn>
            </>
          )}
          {!['corrupt', 'volatile', 'write', 'external-invalid'].includes(storageNotice.code) && (
            <Btn variant="bare" onClick={() => setStorageNotice(null)}>Fermer</Btn>
          )}
        </div>
      )}

      <main style={{ maxWidth: 1000, margin: '0 auto', padding: '18px 16px 72px' }}>
        <div key={tab} className="cad-view">
          {tab === 'today' && (
            <TodayView
              today={today} coreSubjects={coreSubjects} currentBySubject={currentBySubject}
              dueReviewUnits={dueReviewUnits} parentById={parentById}
              subjectById={subjectById} selfReviewsToday={selfReviewsToday}
              timeAllocations={timeAllocations}
              courseTestsDue={courseTestsDue} courseTestLog={courseTestLog}
              testSuggestions={testSuggestions}
              nextExam={nextExam} annalesBanners={annalesBanners} debriefs={debriefs}
              exportStale={exportStale}
              onGrade={gradeEvidence} onDismissDebrief={dismissDebrief}
              onRecordCourseTest={recordCourseTest}
              onSetPosition={setChapterPosition}
              onUseDoc={useChapterDoc}
              onGoSubjects={goToSubjects}
            />
          )}
          {tab === 'calendar' && (
            <CalendarView today={today} exams={exams} subjectById={subjectById}
              courseTests={courseTests} settings={settings}
              upcomingExams={upcomingExams} dueForecast={dueForecast} />
          )}
          {tab === 'subjects' && (
            <SubjectsView
              subjects={subjects} chapters={studyChapters} reviewUnits={reviewUnits}
              exams={exams} courseTests={courseTests} courseTestLog={courseTestLog}
              settings={settings} today={today}
              onAddSubject={addSubject} onUpdateSubject={updateSubject} onDeleteSubject={deleteSubject}
              onAddChapter={addChapter} onAddChaptersBulk={addChaptersBulk}
              onAddResource={addResource} onSetPosition={setChapterPosition} onSetAxes={setChapterAxes}
              onAddDoc={addChapterDoc} onUseDoc={useChapterDoc} onRemoveDoc={removeChapterDoc}
              onUpdateChapter={updateChapter} onDeleteChapter={deleteChapter}
              onSetLevel={setChapterLevel} onSetAxisMinutes={setChapterAxisMinutes}
              onAddExam={addExam} onUpdateExam={updateExam} onDeleteExam={deleteExam}
              onToggleExamChapter={toggleExamChapter} onToggleExamPortion={toggleExamPortion}
              onAddCourseTest={addCourseTest} onUpdateCourseTest={updateCourseTest}
              onDeleteCourseTest={deleteCourseTest}
              focusRequest={subjectFocus}
              onFocusHandled={setSubjectFocus}
            />
          )}
          {tab === 'settings' && (
            <SettingsView settings={settings} state={state} chapters={reviewUnits}
              onUpdate={updateSetting} lastExportAt={lastExportAt} onExported={markExported}
              onImport={importState} onReset={resetAll} today={today}
              listBackups={listBackups} onRestore={restoreBackup} sync={sync} />
          )}
        </div>
      </main>

      {toast && (
        <div className="cad-toast" role="status">
          <Check size={15} color={C.good} />
          <span style={{ fontFamily: SANS, fontSize: 13 }}>{toast.text}</span>
          {toast.entryId && (
            <Btn variant="bare" onClick={() => undoReview(toast.entryId)} style={{ color: C.accent, fontSize: 13 }}>
              <Undo2 size={13} /> Annuler
            </Btn>
          )}
        </div>
      )}
    </div>
  );
}

/* ================================================================== *
 *  Vue 1 — Aujourd'hui
 * ================================================================== */

const SELF_ASSESSMENT_HINTS = [
  'je n’ai pas retrouvé l’essentiel sans le document',
  'quelques bribes seulement ; le support reste indispensable',
  'l’ensemble revient, mais avec hésitation ou une aide',
  'restitution correcte et autonome, sans support',
  'restitution fluide, précise et justifiée, sans support',
];
const SELF_ASSESSMENT_COLORS = [C.bad, '#fb923c', C.warn, C.good, '#38bdf8'];
const SELF_ASSESSMENTS = MASTERY_LEVELS.map((item) => ({
  ...item,
  color: SELF_ASSESSMENT_COLORS[item.level],
  hint: SELF_ASSESSMENT_HINTS[item.level],
}));

function SelfAssessmentButtons({ onGrade }) {
  return (
    <div role="group" aria-label="Maîtrise après reprise" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {SELF_ASSESSMENTS.map((option) => (
        <button key={option.level} type="button" onClick={() => onGrade(option.grade, option.level)}
          title={option.hint} style={{
            fontFamily: SANS, fontSize: 12, fontWeight: 650, padding: '6px 11px', borderRadius: 8,
            cursor: 'pointer', border: `1px solid ${option.color}66`,
            color: option.color, background: `${option.color}12`,
          }}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ReadOnlyDocs({ chapter, onUseDoc }) {
  const docs = sortedDocs(chapter);
  if (!docs.length) return (
    <span style={{ fontFamily: SANS, fontSize: 11.5, color: C.faint }}>aucun document lié</span>
  );
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {docs.map((doc) => doc.url ? (
        <a key={doc.id} href={doc.url} target="_blank" rel="noopener noreferrer"
          onClick={() => onUseDoc(chapter.id, doc.id)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: SANS,
            fontSize: 11.5, color: '#dbeafe', textDecoration: 'none', padding: '5px 9px',
            borderRadius: 7, border: '1px solid rgba(94,169,255,.42)', background: 'rgba(94,169,255,.09)',
          }}>
          <Link2 size={12} /> {doc.label}
        </a>
      ) : (
        <span key={doc.id} style={{ fontFamily: SANS, fontSize: 11.5, color: C.dim }}>{doc.label}</span>
      ))}
    </div>
  );
}

function ContinuityCard({ subject, chapter, allocation, today, onSetPosition, onUseDoc, onGoSubjects }) {
  if (!chapter) {
    return (
      <div className="cad-card" style={{
        background: C.panel, border: `1px solid ${C.line}`, borderLeft: `3px solid ${subject.color}`,
        borderRadius: 10, padding: 13, display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <Pastille color={subject.color} />
        <span style={{ fontFamily: SANS, fontWeight: 650 }}>{subject.name}</span>
        <span style={{ fontFamily: SANS, fontSize: 12, color: C.faint }}>aucun chapitre actif</span>
        <Btn variant="bare" onClick={() => onGoSubjects({ subjectId: subject.id })}
          style={{ marginLeft: 'auto', color: C.accent, fontSize: 12 }}>configurer</Btn>
      </div>
    );
  }
  const additionDate = additionDateFromPosition(chapter.position);
  return (
    <div className="cad-card" role="group" aria-label={`${chapter.name} — continuité`} style={{
      background: C.panel, border: `1px solid ${C.line}`, borderLeft: `3px solid ${subject.color}`,
      borderRadius: 10, padding: 13, display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
        <Pastille color={subject.color} />
        <span style={{ fontFamily: SANS, fontSize: 14.5, fontWeight: 700 }}>{subject.name}</span>
        <span style={{ fontFamily: SANS, fontSize: 12.5, color: C.dim }}>{chapter.name}</span>
        {additionDate === today && <Chip color={C.accent}>ajout du jour</Chip>}
        {allocation?.changed && (
          <Chip color={allocation.minutes > allocation.base ? C.warn : C.dim}
            title={`${allocation.exam?.name || 'Examen'} · pression ×${f2(allocation.factor)} · retour automatique à ${fmtMinutes(allocation.base)} après l’épreuve`}>
            aujourd’hui {fmtMinutes(allocation.minutes)} · normal {fmtMinutes(allocation.base)}
          </Chip>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <PositionField value={chapter.position} onSave={(value) => onSetPosition(chapter.id, value)} />
        <Btn variant="bare" onClick={() => onGoSubjects({ subjectId: subject.id, chapterId: chapter.id, target: 'chapter' })}
          style={{ color: C.faint, fontSize: 11.5 }}>modifier</Btn>
      </div>
      <ReadOnlyDocs chapter={chapter} onUseDoc={onUseDoc} />
    </div>
  );
}

function CourseTestCard({ test, subject, latestResult, today, onRecord }) {
  const [scoreText, setScoreText] = useState('');
  const [maxText, setMaxText] = useState('20');
  const [closedBook, setClosedBook] = useState(false);
  const score = Number(scoreText);
  const maxScore = Number(maxText);
  const valid = scoreText !== '' && maxText !== '' && Number.isFinite(score)
    && Number.isFinite(maxScore) && maxScore > 0 && score >= 0 && score <= maxScore && closedBook;
  const overdue = Math.max(0, daysBetween(test.scheduledFor, today));
  return (
    <div className="cad-card" role="group" aria-label={`${test.name} — test de cours`} style={{
      background: C.panel, border: '1px solid rgba(167,139,250,.34)',
      borderLeft: '3px solid #a78bfa', borderRadius: 10, padding: 13,
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <FlaskConical size={16} color="#a78bfa" />
        {subject && <Pastille color={subject.color} />}
        <span style={{ fontFamily: SANS, fontSize: 13.5, fontWeight: 700 }}>{test.name}</span>
        <Chip color={overdue ? C.warn : '#c4b5fd'} style={{ marginLeft: 'auto' }}>
          {overdue ? `en retard de ${overdue} j` : 'à faire aujourd’hui'}
        </Chip>
      </div>
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
        <Chip color={C.dim}>{(test.chapterIds || []).length} chapitre{(test.chapterIds || []).length > 1 ? 's' : ''}</Chip>
        <Chip color={C.dim}>{(test.portionIds || []).length} section{(test.portionIds || []).length > 1 ? 's' : ''}</Chip>
        {latestResult && (
          <Chip color={C.faint}>dernier : {latestResult.score}/{latestResult.maxScore} le {latestResult.date.split('-').reverse().join('/')}</Chip>
        )}
      </div>
      <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.faint }}>
        Fais le test sans cours ni correction, puis saisis seulement le résultat réel.
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="number" min="0" step="0.25" value={scoreText} onChange={(event) => setScoreText(event.target.value)}
          aria-label={`note obtenue pour ${test.name}`} placeholder="note" style={{
            width: 76, fontFamily: MONO, fontSize: 13, color: C.text, background: C.inset,
            border: `1px solid ${C.line2}`, borderRadius: 7, padding: '7px 8px',
          }} />
        <span style={{ color: C.faint }}>/</span>
        <input type="number" min="0.25" step="0.25" value={maxText} onChange={(event) => setMaxText(event.target.value)}
          aria-label={`barème pour ${test.name}`} style={{
            width: 76, fontFamily: MONO, fontSize: 13, color: C.text, background: C.inset,
            border: `1px solid ${C.line2}`, borderRadius: 7, padding: '7px 8px',
          }} />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: SANS, fontSize: 12, color: C.dim }}>
          <input type="checkbox" checked={closedBook} onChange={(event) => setClosedBook(event.target.checked)} />
          sans cours ni corrigé
        </label>
        <Btn variant="primary" disabled={!valid} onClick={() => onRecord(test.id, score, maxScore, closedBook)}>
          <Check size={14} /> Enregistrer la note
        </Btn>
      </div>
    </div>
  );
}

function ReviewUnitCard({ item, subject, parent, today, onGrade, onUseDoc }) {
  const { unit, info } = item;
  const first = !info.tested;
  const timing = first
    ? (info.overdueDays ? `consolidation en retard de ${info.overdueDays} j` : 'consolidation du lendemain')
    : (info.overdueDays ? `révision espacée en retard de ${info.overdueDays} j` : 'révision espacée due');
  return (
    <div className="cad-card" role="group" aria-label={`${unit.name} — consolidation`} style={{
      background: C.panel, border: `1px solid ${C.line}`, borderLeft: `3px solid ${info.overdueDays ? C.warn : C.accent}`,
      borderRadius: 10, padding: 13, display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {subject && <Pastille color={subject.color} />}
        <span style={{ fontFamily: SANS, fontSize: 13.5, fontWeight: 700 }}>{subject?.name}</span>
        <span style={{ fontFamily: SANS, fontSize: 12, color: C.dim }}>{parent?.name}</span>
        {info.pressureFactor > 1 && <Chip color={C.warn}>pression {info.exam?.name} ×{f2(info.pressureFactor)}</Chip>}
        <Chip color={info.overdueDays ? C.warn : C.accent} style={{ marginLeft: 'auto' }}>{timing}</Chip>
      </div>
      <div style={{ fontFamily: MONO, fontSize: 12, color: C.text }}>{unit.name}</div>
      {parent && <ReadOnlyDocs chapter={parent} onUseDoc={onUseDoc} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: SANS, fontSize: 11.5, color: C.faint }}>
          Après l’avoir restitué sans support :
        </span>
        <SelfAssessmentButtons onGrade={(grade, masteryLevel) => onGrade(unit.id, 'recall', grade, {
          source: 'self-review', masteryLevel,
        })} />
      </div>
    </div>
  );
}

function TodayView({
  today, coreSubjects, currentBySubject, dueReviewUnits, parentById, subjectById,
  selfReviewsToday, timeAllocations, courseTestsDue, courseTestLog, testSuggestions,
  debriefs, annalesBanners, nextExam, exportStale,
  onGrade, onRecordCourseTest, onDismissDebrief, onSetPosition, onUseDoc,
  onGoSubjects,
}) {
  const allocationBySubject = Object.fromEntries((timeAllocations || []).map((row) => [row.subject.id, row]));
  const adjusted = (timeAllocations || []).filter((row) => row.changed);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <Mono style={{ fontSize: 22, color: C.text, textTransform: 'capitalize' }}>{fmtLongDate(today)}</Mono>
          <div style={{ fontFamily: SANS, fontSize: 12, color: C.faint, marginTop: 3 }}>
            Retrouve ton dernier travail, puis ne note que ce que tu as réellement revu.
          </div>
        </div>
        {nextExam && <Chip color={C.accent} style={{ marginLeft: 'auto' }}>{nextExam.name} · J−{nextExam.days}</Chip>}
      </div>

      <section>
        <SectionTitle icon={BookOpen}>Continuité quotidienne</SectionTitle>
        <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.faint, margin: '-3px 0 10px' }}>
          CADENCE ouvre le chapitre et le document ; il ne choisit pas le nouveau contenu à ta place.
        </div>
        {adjusted.length > 0 && (
          <div style={{
            marginBottom: 10, padding: '8px 11px', borderRadius: 8,
            border: '1px solid rgba(251,191,36,.25)', background: 'rgba(251,191,36,.05)',
            fontFamily: SANS, fontSize: 11.5, color: C.dim,
          }}>
            Rééquilibrage temporaire d’examen : le total quotidien reste fixe, les minimums sont protégés,
            puis les durées normales reviennent automatiquement après l’épreuve.
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 10 }}>
          {coreSubjects.map((subject) => (
            <ContinuityCard key={subject.id} subject={subject} chapter={currentBySubject[subject.id]}
              allocation={allocationBySubject[subject.id]}
              today={today} onSetPosition={onSetPosition} onUseDoc={onUseDoc}
              onGoSubjects={onGoSubjects} />
          ))}
        </div>
      </section>

      <section>
        <SectionTitle icon={RefreshCw} right={selfReviewsToday ? <Chip color={C.good}>{selfReviewsToday} faite{selfReviewsToday > 1 ? 's' : ''}</Chip> : null}>
          Consolidations dues
        </SectionTitle>
        {dueReviewUnits.length === 0 ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '14px 15px',
            border: `1px solid rgba(52,211,153,.3)`, borderRadius: 9, background: 'rgba(52,211,153,.05)',
          }}>
            <Check size={17} color={C.good} />
            <span style={{ fontFamily: SANS, fontSize: 13, color: C.dim }}>Rien à consolider aujourd’hui.</span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {dueReviewUnits.map((item) => {
              const parent = parentById[item.unit.parentChapterId];
              return (
                <ReviewUnitCard key={item.unit.id} item={item} parent={parent}
                  subject={subjectById[item.unit.subjectId]} today={today}
                  onGrade={onGrade} onUseDoc={onUseDoc} />
              );
            })}
          </div>
        )}
      </section>

      <section>
        <SectionTitle icon={FlaskConical}>Tests de cours</SectionTitle>
        {(courseTestsDue || []).length === 0 && (testSuggestions || []).length === 0 ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '14px 15px',
            border: `1px solid rgba(52,211,153,.3)`, borderRadius: 9, background: 'rgba(52,211,153,.05)',
          }}>
            <Check size={17} color={C.good} />
            <span style={{ fontFamily: SANS, fontSize: 13, color: C.dim }}>Aucun test de cours dû aujourd’hui.</span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(courseTestsDue || []).map((test) => (
              <CourseTestCard key={test.id} test={test} subject={subjectById[test.subjectId]}
                latestResult={latestCourseTestResult(test.id, courseTestLog)} today={today}
                onRecord={onRecordCourseTest} />
            ))}
            {(testSuggestions || []).map((suggestion) => (
              <div key={suggestion.subject.id} style={{
                display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', padding: '10px 12px',
                border: `1px dashed ${C.line2}`, borderRadius: 9, background: C.panel2,
              }}>
                <Pastille color={suggestion.subject.color} />
                <span style={{ fontFamily: SANS, fontSize: 12.5 }}>
                  <b>{suggestion.subject.name}</b> · {suggestion.count} nouvelles sections sans test noté
                </span>
                <Btn variant="bare" onClick={() => onGoSubjects({ subjectId: suggestion.subject.id, target: 'test-add' })}
                  style={{ marginLeft: 'auto', color: C.accent, fontSize: 12 }}>
                  Planifier un test
                </Btn>
              </div>
            ))}
          </div>
        )}
      </section>

      {annalesBanners.map(({ subject, info }) => (
        <div key={subject.id} style={{
          display: 'flex', alignItems: 'center', gap: 9, padding: '9px 12px', borderRadius: 9,
          background: 'rgba(251,191,36,.07)', border: '1px solid rgba(251,191,36,.28)',
        }}>
          <CalendarDays size={15} color={C.warn} /><Pastille color={subject.color} />
          <span style={{ fontFamily: SANS, fontSize: 12.5 }}><b>{subject.name}</b> · {info.exam.name}</span>
          <Mono style={{ marginLeft: 'auto', color: C.warn, fontSize: 12 }}>J−{info.days}</Mono>
        </div>
      ))}

      {debriefs.map(({ exam, daysAgo, items }) => {
        const sub = subjectById[exam.subjectId];
        return (
          <div key={exam.id} className="cad-card" style={{
            display: 'flex', flexDirection: 'column', gap: 10, padding: 13, borderRadius: 9,
            background: 'rgba(94,169,255,.06)', border: '1px solid rgba(94,169,255,.28)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
              <FlaskConical size={16} color={C.accent} />{sub && <Pastille color={sub.color} />}
              <span style={{ fontFamily: SANS, fontSize: 13 }}>
                <b>{exam.name}</b> passée {daysAgo === 1 ? 'hier' : `il y a ${daysAgo} j`} — résultat réellement constaté
              </span>
              <Btn variant="bare" onClick={() => onDismissDebrief(exam.id)}
                style={{ marginLeft: 'auto', color: C.faint, fontSize: 11.5 }}>masquer</Btn>
            </div>
            {items.map(({ chapter, done }) => (
              <div key={chapter.id} style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', paddingLeft: 24 }}>
                <span style={{ fontFamily: SANS, fontSize: 12.5 }}>{chapter.name}</span>
                {done ? <Chip color={C.good}><Check size={11} /> noté</Chip> : (
                  <GradeButtons compact evidenceType="problem" onGrade={(grade) => onGrade(chapter.id, 'problem', grade, {
                    date: exam.date, source: 'exam-debrief', examId: exam.id,
                  })} />
                )}
              </div>
            ))}
          </div>
        );
      })}

      {exportStale && (
        <div style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>
          Aucun export récent des données — sauvegarde disponible dans Réglages.
        </div>
      )}
    </div>
  );
}

const CAPACITY_PRESETS = [0, 120, 240, 360];

function LegacyTodayView({
  today, overdue, overdueMinutes, shortestDueMinutes, nextExam, subjectById, annalesBanners, debriefs, sessions, ranked,
  plannedCount, plannedMinutes, doneCount, doneByChapter, skippedToday, readinessByExam,
  todayMinutes, defaultMinutes, hasCoreChapters, exportStale,
  parallelSubjects, parallelLog, settings,
  onGrade, onUndo, onSkip, onUnskip, onDismissDebrief, onSetTodayCapacity, onSetAxisMinutes,
  onSetPosition, onAddDoc, onUseDoc, onRemoveDoc,
  onAdjustParallel, onGoSubjects, onSetSimpleMode,
}) {
  const [showAll, setShowAll] = useState(false);
  const [customCap, setCustomCap] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const focusToggleRef = useRef(null);
  const wk = mondayOf(today);
  const isOverride = todayMinutes !== defaultMinutes;
  const isPreset = CAPACITY_PRESETS.includes(todayMinutes);
  const enterFocusMode = () => {
    setShowAll(false);
    setFocusMode(true);
  };
  const exitFocusMode = () => {
    setFocusMode(false);
    requestAnimationFrame(() => focusToggleRef.current?.focus());
  };
  const toggleRanking = () => {
    const next = !showAll;
    setShowAll(next);
    if (next) setFocusMode(false);
  };

  useEffect(() => {
    if (focusMode && sessions.length === 0) setFocusMode(false);
  }, [focusMode, sessions.length]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* En-tête : date + anneau de progression + métriques */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        {plannedCount > 0 && <Ring value={doneCount} total={plannedCount} label="progression du jour" />}
        <div>
          <Mono style={{ fontSize: 22, color: C.text, textTransform: 'capitalize' }}>{fmtLongDate(today)}</Mono>
          <div style={{ fontFamily: SANS, fontSize: 12, color: C.faint, marginTop: 2 }}>
            Travaille, teste-toi <b>sans correction sous les yeux</b>, puis note le résultat du test.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginLeft: 'auto', flexWrap: 'wrap' }}>
          <Stat label="en retard" value={overdue ? `~${fmtMinutes(overdueMinutes)}` : '0'}
            unit={`${overdue} chap.`} tone={overdue ? C.warn : C.good} />
          {nextExam ? (
            <Stat label="prochaine épreuve" value={`J−${nextExam.days}`} unit={nextExam.name} tone={C.accent} />
          ) : (
            <Stat label="prochaine épreuve" value="—" unit="aucune" tone={C.faint} />
          )}
        </div>
      </div>

      {/* Capacité réelle du jour */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
        <Clock3 size={14} color={C.dim} />
        <span style={{ fontFamily: SANS, fontSize: 12.5, color: C.dim }}>Temps disponible aujourd’hui</span>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {CAPACITY_PRESETS.map((m) => {
            const on = !customCap && todayMinutes === m;
            return (
              <button key={m} type="button"
                aria-pressed={on}
                onClick={() => { setCustomCap(false); onSetTodayCapacity(m === defaultMinutes ? null : m); }}
                style={{
                  fontFamily: MONO, fontSize: 12, padding: '4px 11px', borderRadius: 999, cursor: 'pointer',
                  border: `1px solid ${on ? 'rgba(94,169,255,.5)' : C.line2}`,
                  background: on ? 'rgba(94,169,255,.14)' : 'transparent',
                  color: on ? '#dbeafe' : C.dim,
                }}>
                {m === 0 ? '0 h' : fmtMinutes(m)}
              </button>
            );
          })}
          <button type="button" aria-pressed={customCap || (!isPreset && isOverride)}
            onClick={() => setCustomCap((v) => !v)}
            style={{
              fontFamily: SANS, fontSize: 12, padding: '4px 11px', borderRadius: 999, cursor: 'pointer',
              border: `1px solid ${customCap || (!isPreset && isOverride) ? 'rgba(94,169,255,.5)' : C.line2}`,
              background: customCap || (!isPreset && isOverride) ? 'rgba(94,169,255,.14)' : 'transparent',
              color: customCap || (!isPreset && isOverride) ? '#dbeafe' : C.dim,
            }}>
            personnalisé
          </button>
        </div>
        {customCap && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="number" min={0} max={720} step={30} value={todayMinutes}
              aria-label="minutes disponibles aujourd'hui"
              onChange={(e) => onSetTodayCapacity(Number(e.target.value) || 0)}
              style={{ width: 70, fontFamily: MONO, fontSize: 13, color: C.text, background: C.inset, border: `1px solid ${C.line2}`, borderRadius: 6, padding: '4px 6px' }} />
            <span style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>min (pas de 30)</span>
          </div>
        )}
        {isOverride && (
          <Btn variant="bare" onClick={() => { setCustomCap(false); onSetTodayCapacity(null); }}
            style={{ color: C.faint, fontSize: 11.5 }}>
            revenir au défaut ({fmtMinutes(defaultMinutes)})
          </Btn>
        )}
      </div>

      {/* Bilan d'épreuve : une épreuve vient de passer — c'était un test en
          conditions réelles. Noter le constat par chapitre (axe problème). */}
      {debriefs.map(({ exam, daysAgo, items }) => {
        const sub = subjectById[exam.subjectId];
        const left = items.filter((it) => !it.done).length;
        return (
          <div key={exam.id} className="cad-in cad-card" style={{
            display: 'flex', flexDirection: 'column', gap: 9, padding: '11px 13px', borderRadius: 9,
            background: 'rgba(94,169,255,.07)', border: '1px solid rgba(94,169,255,.3)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <FlaskConical size={16} color={C.accent} />
              {sub && <Pastille color={sub.color} />}
              <span style={{ fontFamily: SANS, fontSize: 13.5 }}>
                <b>{exam.name}</b> passée {daysAgo === 1 ? 'hier' : `il y a ${daysAgo} j`} —
                {' '}note ce que tu as <b>constaté</b> pendant l’épreuve
              </span>
              <Chip color={C.dim} title="Une épreuve est le test en conditions réelles le plus fiable : le constat alimente l'axe problème/annale du chapitre — rappel et exercices ne bougent pas.">
                axe problème/annale · {left} à noter
              </Chip>
              <Btn variant="bare" onClick={() => onDismissDebrief(exam.id)}
                title="Masquer ce bilan (il disparaît de lui-même après 3 jours)"
                style={{ marginLeft: 'auto', color: C.faint, fontSize: 12 }}>
                masquer
              </Btn>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, paddingLeft: 26 }}>
              {items.map(({ chapter, done }) => (
                <div key={chapter.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: SANS, fontSize: 12.5, color: C.text, minWidth: 140 }}>{chapter.name}</span>
                  {done ? (
                    <Chip color={C.good} bg="rgba(52,211,153,.12)"><Check size={11} /> constat noté</Chip>
                  ) : (
                    <GradeButtons compact evidenceType="problem"
                      onGrade={(g) => onGrade(chapter.id, 'problem', g, {
                        date: exam.date, source: 'exam-debrief', examId: exam.id,
                      })} />
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}

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
          {readinessByExam[info.exam.id]?.avgR != null && (
            <Chip color={thermal((1 - readinessByExam[info.exam.id].avgR) * 4)}
              title="Rappel moyen estimé le jour J sans nouvelle révision — estimation de rappel, pas une probabilité de réussite à l'examen. Chapitres testés uniquement.">
              rappel estimé le jour J ~{Math.round(readinessByExam[info.exam.id].avgR * 100)} %
            </Chip>
          )}
          {readinessByExam[info.exam.id]?.untested.length > 0 && (
            <Chip color={C.warn} title="Chapitres couverts par l'épreuve mais dont le rappel n'a jamais été testé — à traiter en priorité.">
              <AlertTriangle size={11} /> {readinessByExam[info.exam.id].untested.length} rappel{readinessByExam[info.exam.id].untested.length > 1 ? 's' : ''} jamais testé{readinessByExam[info.exam.id].untested.length > 1 ? 's' : ''}
            </Chip>
          )}
          {readinessByExam[info.exam.id] && (() => {
            const cov = readinessByExam[info.exam.id].coverage;
            return (
              <Chip color={cov.problem.untested ? C.warn : C.good}
                title={`Couverture des axes pratiques sur les chapitres de l'épreuve — exercices : ${cov.exercise.tested}/${cov.exercise.total} testés, problèmes/annales : ${cov.problem.tested}/${cov.problem.total}.`}>
                exos {cov.exercise.tested}/{cov.exercise.total} · annales {cov.problem.tested}/{cov.problem.total}
              </Chip>
            );
          })()}
          <Mono style={{ marginLeft: 'auto', color: C.warn, fontSize: 12 }}>
            {info.exam.name} · J−{info.days}
          </Mono>
        </div>
      ))}

      {/* Alerte de surcharge : le retard (en minutes) dépasse la capacité */}
      {todayMinutes > 0 && overdueMinutes > todayMinutes && (
        <div className="cad-in cad-card" style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 13px', borderRadius: 9,
          background: 'rgba(248,113,113,.08)', border: '1px solid rgba(248,113,113,.35)', flexWrap: 'wrap',
        }}>
          <AlertTriangle size={16} color={C.bad} />
          <span style={{ fontFamily: SANS, fontSize: 13 }}>
            <b>Surcharge</b> · ~{fmtMinutes(overdueMinutes)} de retard ({overdue} chap.)
            pour {fmtMinutes(todayMinutes)} aujourd’hui
            (≈ {Math.ceil(overdueMinutes / Math.max(30, defaultMinutes))} j à capacité par défaut pour résorber)
          </span>
          <span style={{ fontFamily: SANS, fontSize: 11.5, color: C.dim, marginLeft: 'auto', flex: '1 1 260px' }}>
            Tout ne tiendra pas : <b>reporte les moins urgents</b> ou <b>augmente le temps</b> quelques jours.
            Baisser la rétention cible reste possible, mais c’est un compromis conscient (Réglages), pas un réglage à subir.
          </span>
        </div>
      )}

      {/* Plan du jour */}
      <div>
        <SectionTitle icon={Activity} right={
          ranked.length > 0 ? (
            <Btn variant="bare" onClick={toggleRanking} style={{ color: C.dim, fontSize: 12 }}>
              {showAll ? 'voir le plan du jour' : 'voir tout le classement'}
              {showAll ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </Btn>
          ) : null
        }>
          Plan du jour
          <Chip color={C.faint} style={{ marginLeft: 8 }} title="Capacité réelle du jour (réglable ci-dessus) — les matières les plus sous pression d'abord, les autres remontent les jours suivants.">
            {fmtMinutes(todayMinutes)} aujourd’hui{isOverride ? ' (ajusté)' : ''}
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
        ) : todayMinutes <= 0 ? (
          <div className="cad-in" style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '18px 16px',
            border: `1px solid ${C.line2}`, borderRadius: 9, background: C.panel2,
          }}>
            <Clock3 size={18} color={C.dim} />
            <div style={{ fontFamily: SANS, fontSize: 13.5, lineHeight: 1.5 }}>
              <b>Pas de séance prévue aujourd’hui (0 h disponible).</b>
              <div style={{ color: C.dim, fontSize: 12.5 }}>
                Aucun faux retard n’est créé : les échéances suivent leur cours.
                Le classement reste consultable via « voir tout le classement ».
              </div>
            </div>
          </div>
        ) : sessions.length === 0 ? (
          overdue > 0 ? (
            <div className="cad-in" style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '18px 16px',
              border: `1px solid rgba(251,191,36,.4)`, borderRadius: 9, background: 'rgba(251,191,36,.07)',
            }}>
              <AlertTriangle size={18} color={C.warn} />
              <div style={{ fontFamily: SANS, fontSize: 13.5, lineHeight: 1.5 }}>
                <b style={{ color: C.warn }}>Du travail est dû, mais aucun bloc ne tient dans tes réglages.</b>
                <div style={{ color: C.dim, fontSize: 12.5 }}>
                  Le plus court demande {fmtMinutes(shortestDueMinutes)}. Augmente la durée d’une séance ou ajuste la durée de l’axe depuis « voir tout le classement ».
                </div>
              </div>
            </div>
          ) : hasCoreChapters ? (
            <div className="cad-in" style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '18px 16px',
              border: `1px solid rgba(52,211,153,.35)`, borderRadius: 9, background: 'rgba(52,211,153,.06)',
            }}>
              <Check size={18} color={C.good} />
              <div style={{ fontFamily: SANS, fontSize: 13.5, lineHeight: 1.5 }}>
                <b style={{ color: C.good }}>Rien d’urgent aujourd’hui — tout est à jour.</b>
                <div style={{ color: C.dim, fontSize: 12.5 }}>
                  Retester en avance consolide peu : profites-en pour avancer sur les nouvelles notions.
                  La file se remplira toute seule quand des chapitres approcheront de leur échéance.
                </div>
              </div>
            </div>
          ) : (
            <Empty>Tes chapitres sont dans des matières « minimum hebdo ». Passe une UE en « planifiée » (onglet Matières) pour qu’elle entre dans le plan.</Empty>
          )
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '2px 0 8px', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>affichage</span>
              <Segmented value={settings.simpleMode ? 'simple' : 'full'} ariaLabel="Affichage des cartes"
                onChange={(v) => onSetSimpleMode(v === 'simple')}
                options={[{ value: 'simple', label: 'Simple' }, { value: 'full', label: 'Détaillé' }]} />
              <Mono style={{ fontSize: 11, color: C.dim }}>
                plan ≈ {fmtMinutes(plannedMinutes)} / {fmtMinutes(todayMinutes)}
              </Mono>
              <button
                ref={focusToggleRef}
                type="button"
                className={focusMode ? 'cad-feature-button cad-feature-button-primary' : 'cad-feature-button'}
                aria-pressed={focusMode}
                aria-controls="cad-focus-panel"
                onClick={() => {
                  if (focusMode) exitFocusMode();
                  else enterFocusMode();
                }}
              >
                {focusMode ? 'Quitter le focus' : 'Mode focus'}
              </button>
              <div style={{ flex: 1 }} />
              <ThermalLegend />
            </div>
            <div style={{ fontFamily: SANS, fontSize: 11, color: C.faint, margin: '0 0 14px' }}>
              Sur chaque carte : choisis l’<b>axe</b> à travailler (rappel · exercice · problème/annale),
              teste-toi <b>sans correction</b>, puis note le résultat. Chaque axe est indépendant — tu peux en noter plusieurs le même jour.
            </div>
            {!showAll ? (
              focusMode ? (
                <FocusMode
                  sessions={sessions}
                  doneByChapter={doneByChapter}
                  onExit={exitFocusMode}
                  renderCard={({ chapter, subject }, index) => (
                    <QueueCard key={chapter.id} idx={index} ch={chapter} subject={subject}
                      simpleMode={settings.simpleMode} done={doneByChapter[chapter.id]}
                      today={today} settings={settings}
                      onGrade={onGrade} onUndo={onUndo} onSkip={onSkip}
                      onSetAxisMinutes={onSetAxisMinutes} onSetPosition={onSetPosition}
                      onAddDoc={onAddDoc} onUseDoc={onUseDoc} onRemoveDoc={onRemoveDoc} />
                  )}
                />
              ) : (
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
                        <Chip color={C.dim} title={`${session.chapters.length} unité${session.chapters.length > 1 ? 's' : ''}, temps estimé`}>
                          ≈ {fmtMinutes(session.minutes)} · {session.chapters.length} unité{session.chapters.length > 1 ? 's' : ''}
                        </Chip>
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
                            onGrade={onGrade} onUndo={onUndo} onSkip={onSkip}
                            onSetAxisMinutes={onSetAxisMinutes} onSetPosition={onSetPosition}
                            onAddDoc={onAddDoc} onUseDoc={onUseDoc} onRemoveDoc={onRemoveDoc} />
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
              )
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

      {/* Minimums hebdo (matières parallèles) */}
      {parallelSubjects.length > 0 && (
        <div>
          <SectionTitle icon={Lock}>Minimums hebdo — à protéger si possible</SectionTitle>
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
            Des minimums à protéger si possible — une semaine d’examen majeur ou une
            capacité réduite peuvent légitimement passer devant.
          </div>
        </div>
      )}

      {exportStale && (
        <div style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>
          💾 Aucun export récent de tes données — pense à <b>Réglages → Exporter (JSON)</b> (les instantanés locaux ne survivent pas à ce navigateur).
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

function CalendarView({ today, exams, courseTests, subjectById, settings, upcomingExams, dueForecast }) {
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
  const testsByDay = useMemo(() => {
    const map = {};
    for (const test of courseTests || []) (map[test.scheduledFor] ||= []).push(test);
    return map;
  }, [courseTests]);
  const upcomingTests = useMemo(() => (courseTests || [])
    .map((test) => ({ ...test, days: daysBetween(today, test.scheduledFor) }))
    .filter((test) => test.days >= 0)
    .sort((a, b) => a.days - b.days || a.name.localeCompare(b.name)), [courseTests, today]);

  const maxDue = Math.max(1, ...Object.values(dueForecast).map((v) => v.minutes || 0));

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

  // Charge des 14 prochains jours (liste latérale) — en minutes de rappel.
  const nextDays = Array.from({ length: 14 }, (_, i) => {
    const iso = addDays(today, i);
    const cell = dueForecast[iso] || { count: 0, minutes: 0 };
    return { iso, count: cell.count, minutes: cell.minutes };
  });
  const maxNext = Math.max(1, ...nextDays.map((d) => d.minutes));

  return (
    <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <div style={{ flex: '1 1 380px', minWidth: 0, width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
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
            const dayTests = testsByDay[iso] || [];
            const shade = annalesShade(iso);
            const cell0 = dueForecast[iso] || { count: 0, minutes: 0 };
            const dueMin = cell0.minutes;
            const dueCount = cell0.count;
            const titleParts = [
              ...dayExams.map((e) => `${e.name} (${(e.chapterIds || []).length} chap.)`),
              ...dayTests.map((test) => `${test.name} — test de cours noté`),
              dueMin ? `${dueCount} consolidation${dueCount > 1 ? 's' : ''} · ~${fmtMinutes(dueMin)}` : null,
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
                  {dueMin > 0 && (
                    <Mono style={{ fontSize: 9, color: thermal((dueMin / maxDue) * 4) }} title={`${dueCount} consolidation${dueCount > 1 ? 's' : ''}`}>{dueCount}</Mono>
                  )}
                  <Mono style={{
                    fontSize: 11, color: isToday ? C.accent : C.dim, marginLeft: 'auto',
                    fontWeight: isToday ? 700 : 400,
                  }}>{cell.getDate()}</Mono>
                </div>
                <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {dueMin > 0 && (
                    <div style={{ height: 3, borderRadius: 2, background: C.inset, overflow: 'hidden' }}>
                      <div className="cad-bar" style={{
                        width: `${clamp((dueMin / maxDue) * 100, 8, 100)}%`, height: '100%',
                        background: thermal((dueMin / maxDue) * 4), opacity: .85,
                      }} />
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                    {dayTests.map((test) => (
                      <span key={test.id} style={{
                        width: 6, height: 6, borderRadius: '50%', background: '#a78bfa',
                      }} />
                    ))}
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
            <span style={{ width: 18, height: 4, borderRadius: 2, background: thermal(2.5) }} /> consolidations prévues
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#a78bfa' }} /> test de cours
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
                      {(e.portionIds || []).length > 0 && <Chip color="#c4b5fd">{e.portionIds.length} section{e.portionIds.length > 1 ? 's' : ''}</Chip>}
                      <Chip color={e.importance === 'major' ? C.bad : e.importance === 'minor' ? C.faint : C.dim}
                        title="Importance de l'épreuve (module la pression d'examen)">
                        {IMPORTANCE[e.importance || 'normal'].label.toLowerCase()}
                      </Chip>
                      {annales && <Chip color={C.warn}><CalendarDays size={11} /> examen proche</Chip>}
                    </div>
                    {false && (() => {
                      const r = readinessByExam[e.id];
                      return (
                        <div title="Rappel moyen estimé le jour J sans nouvelle révision — estimation de rappel, pas une probabilité de réussir l'épreuve."
                          style={{ marginTop: 8 }}>
                          {/* Les jamais-testés d'abord : catégorie prioritaire, jamais fondue dans la moyenne */}
                          {r.untested.length > 0 && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
                              <AlertTriangle size={12} color={C.warn} />
                              <span style={{ fontFamily: SANS, fontSize: 11.5, color: C.warn, fontWeight: 600 }}>
                                {r.untested.length} chapitre{r.untested.length > 1 ? 's' : ''} jamais testé{r.untested.length > 1 ? 's' : ''} — priorité
                              </span>
                              <span style={{ fontFamily: SANS, fontSize: 10.5, color: C.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {r.untested.map((c) => c.name).join(', ')}
                              </span>
                            </div>
                          )}
                          {/* Couverture honnête des trois axes (testé / total) */}
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                            {AXIS_KEYS.map((ax) => {
                              const cov = r.coverage[ax];
                              const full = cov.tested === cov.total;
                              return (
                                <Chip key={ax} color={full ? C.good : cov.tested ? C.dim : C.warn}
                                  title={`${AXES[ax].long} : ${cov.tested}/${cov.total} chapitres testés`}>
                                  {AXES[ax].label} {cov.tested}/{cov.total}
                                </Chip>
                              );
                            })}
                          </div>
                          {r.avgR != null ? (() => {
                            const col = thermal((1 - r.avgR) * 4);
                            return (
                              <>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <span style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>
                                    rappel estimé le jour J · {r.testedCount}/{r.coveredCount} testés
                                  </span>
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
                                    les plus fragiles : {r.per.slice(0, Math.min(3, r.weak))
                                      .map((x) => `${x.chapter.name} (~${Math.round(x.projR * 100)} %)`).join(' · ')}
                                  </div>
                                )}
                              </>
                            );
                          })() : (
                            <div style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>
                              aucun chapitre couvert encore testé — pas d’estimation de rappel
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
          <SectionTitle icon={FlaskConical}>Tests de cours planifiés</SectionTitle>
          {upcomingTests.length === 0 ? (
            <Empty>Aucun test planifié. Ils se créent dans Matières et sont replanifiés après chaque note réelle.</Empty>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {upcomingTests.map((test) => (
                <div key={test.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px',
                  borderRadius: 8, border: `1px solid ${C.line}`, background: C.panel,
                }}>
                  <Pastille color={subjectById[test.subjectId]?.color || C.dim} />
                  <span style={{ fontFamily: SANS, fontSize: 12.5 }}>{test.name}</span>
                  <Mono style={{ marginLeft: 'auto', fontSize: 12, color: test.days <= 3 ? C.warn : '#c4b5fd' }}>
                    {test.days === 0 ? 'auj.' : `J−${test.days}`}
                  </Mono>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <SectionTitle icon={TrendingUp}>Consolidations à venir (14 j)</SectionTitle>
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 5 }}>
            {nextDays.map((d, i) => (
              <div key={d.iso} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Mono style={{ fontSize: 10.5, color: i === 0 ? C.accent : C.faint, width: 64 }}>
                  {i === 0 ? 'auj.' : fmtShortDate(d.iso)}
                </Mono>
                <div style={{ flex: 1, height: 7, background: C.inset, borderRadius: 4, overflow: 'hidden', border: `1px solid ${C.line}` }}
                  title={d.count ? `${d.count} chap.` : ''}>
                  <div className="cad-bar" style={{
                    width: `${(d.minutes / maxNext) * 100}%`, height: '100%',
                    background: d.minutes ? thermal((d.minutes / maxNext) * 4) : 'transparent', opacity: .85,
                  }} />
                </div>
                <Mono style={{ fontSize: 10.5, color: d.minutes ? C.dim : C.faint, width: 52, textAlign: 'right' }}>
                  {d.minutes ? fmtMinutes(d.minutes) : '·'}
                </Mono>
              </div>
            ))}
          </div>
          <div style={{ fontFamily: SANS, fontSize: 11, color: C.faint, marginTop: 7 }}>
            Minutes de rappel qui arrivent à échéance chaque jour (rétention cible {Math.round(settings.requestRetention * 100)} %).
            Le travail d’exercices et d’annales, lui, est piloté par les épreuves — pas par un cycle périodique.
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
          <button key={l.key} type="button" aria-pressed={on} onClick={() => onPick(l)}
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

function ScopeSelector({ chapters, units, chapterIds, portionIds, onToggleChapter, onTogglePortion, onAll, onNone }) {
  const whole = new Set(chapterIds || []);
  const portions = new Set(portionIds || []);
  const shortPortion = (unit) => unit.name.replace(/^Ajout du\s+\d{1,2}\/\d{1,2}\/\d{4}\s*[—-]\s*/i, '');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', fontFamily: SANS, fontSize: 11, color: C.faint }}>
        <span>Périmètre : {whole.size} chapitre{whole.size > 1 ? 's' : ''} entier{whole.size > 1 ? 's' : ''} · {portions.size} section{portions.size > 1 ? 's' : ''}</span>
        {whole.size + portions.size === 0 && <Chip color={C.warn}>aucune pression ni planification</Chip>}
        <button type="button" onClick={onAll} style={{ fontFamily: SANS, fontSize: 10.5, color: C.accent, background: 'transparent', border: 'none', cursor: 'pointer' }}>tout</button>
        <span style={{ color: C.line2 }}>·</span>
        <button type="button" onClick={onNone} style={{ fontFamily: SANS, fontSize: 10.5, color: C.dim, background: 'transparent', border: 'none', cursor: 'pointer' }}>aucun</button>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {(chapters || []).map((chapter) => {
          const active = whole.has(chapter.id);
          return (
            <button key={chapter.id} type="button" aria-pressed={active} onClick={() => onToggleChapter(chapter.id)} style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer',
              fontFamily: SANS, fontSize: 12, padding: '4px 9px', borderRadius: 999,
              border: `1px solid ${active ? 'rgba(94,169,255,.5)' : C.line2}`,
              background: active ? 'rgba(94,169,255,.14)' : 'transparent',
              color: active ? '#dbeafe' : C.dim,
            }}>
              {active ? <Check size={12} /> : <Plus size={12} />} {chapter.name}
            </button>
          );
        })}
      </div>
      {(units || []).length > 0 && (
        <details>
          <summary style={{ fontFamily: SANS, fontSize: 11.5, color: C.dim, cursor: 'pointer' }}>
            Sections quotidiennes ({units.length})
          </summary>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', paddingTop: 7 }}>
            {units.map((unit) => {
              const inherited = whole.has(unit.parentChapterId);
              const active = inherited || portions.has(unit.id);
              return (
                <button key={unit.id} type="button" aria-pressed={active} disabled={inherited}
                  title={inherited ? 'déjà couverte par le chapitre entier' : unit.name}
                  onClick={() => onTogglePortion(unit.id)} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    cursor: inherited ? 'not-allowed' : 'pointer', opacity: inherited ? .55 : 1,
                    fontFamily: SANS, fontSize: 11, padding: '4px 8px', borderRadius: 999,
                    border: `1px solid ${active ? 'rgba(167,139,250,.5)' : C.line2}`,
                    background: active ? 'rgba(167,139,250,.12)' : 'transparent',
                    color: active ? '#ddd6fe' : C.faint,
                  }}>
                  {active ? <Check size={11} /> : <Plus size={11} />} {shortPortion(unit)}
                </button>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}

function SubjectsView({
  subjects, chapters, reviewUnits, exams, courseTests, courseTestLog, settings, today,
  onAddSubject, onUpdateSubject, onDeleteSubject,
  onAddChapter, onAddChaptersBulk, onAddResource, onUpdateChapter, onDeleteChapter,
  onSetLevel, onSetAxisMinutes, onSetPosition, onSetAxes,
  onAddDoc, onUseDoc, onRemoveDoc,
  onAddExam, onUpdateExam, onDeleteExam, onToggleExamChapter, onToggleExamPortion,
  onAddCourseTest, onUpdateCourseTest, onDeleteCourseTest,
  focusRequest, onFocusHandled,
}) {
  const [open, setOpen] = useState({});
  const toggle = (id) => setOpen((o) => ({ ...o, [id]: !o[id] }));

  useEffect(() => {
    if (!focusRequest) return undefined;
    if (focusRequest.subjectId) {
      setOpen((current) => ({ ...current, [focusRequest.subjectId]: true }));
    }

    let highlightTimer;
    let highlightedTarget;
    let handled = false;
    const markHandled = () => {
      if (handled) return;
      handled = true;
      onFocusHandled?.((current) => current?.token === focusRequest.token ? null : current);
    };
    const focusTimer = window.setTimeout(() => {
      let targetId = 'subject-adder';
      if (focusRequest.subjectId) {
        if (focusRequest.target === 'chapter' && focusRequest.chapterId) targetId = `chapter-${focusRequest.chapterId}`;
        else if (focusRequest.target === 'chapter-add') targetId = `chapter-adder-${focusRequest.subjectId}`;
        else if (focusRequest.target === 'exam-add') targetId = `exam-adder-${focusRequest.subjectId}`;
        else if (focusRequest.target === 'test-add') targetId = `test-adder-${focusRequest.subjectId}`;
        else targetId = `subject-${focusRequest.subjectId}`;
      }
      const target = document.getElementById(targetId)
        || (focusRequest.subjectId ? document.getElementById(`subject-${focusRequest.subjectId}`) : null);
      if (!target) {
        markHandled();
        return;
      }
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView?.({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
      const focusable = target.querySelector('input[type="text"], input:not([type="color"]), button');
      focusable?.focus({ preventScroll: true });
      target.classList.add('cad-target');
      highlightedTarget = target;
      highlightTimer = window.setTimeout(() => {
        target.classList.remove('cad-target');
        markHandled();
      }, 1400);
    }, 0);

    return () => {
      window.clearTimeout(focusTimer);
      if (highlightTimer) window.clearTimeout(highlightTimer);
      highlightedTarget?.classList.remove('cad-target');
      markHandled();
    };
  }, [focusRequest, onFocusHandled]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionTitle icon={Layers}>Matières et habitudes</SectionTitle>

      {subjects.map((s, sidx) => {
        const isCore = s.type === 'core';
        const subChapters = chapters.filter((c) => c.subjectId === s.id);
        const subUnits = (reviewUnits || []).filter((unit) => unit.subjectId === s.id);
        const subExams = exams.filter((e) => e.subjectId === s.id);
        const subTests = (courseTests || []).filter((test) => test.subjectId === s.id);
        const expanded = !!open[s.id];
        return (
          <div id={`subject-${s.id}`} key={s.id} className="cad-in" style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, animationDelay: `${Math.min(sidx, 8) * 40}ms` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, flexWrap: 'wrap' }}>
              {isCore ? (
                <button id={`subject-toggle-${s.id}`} onClick={() => toggle(s.id)} aria-expanded={expanded}
                  aria-controls={`subject-panel-${s.id}`}
                  aria-label={`${expanded ? 'Replier' : 'Déplier'} ${s.name}`} style={{
                  background: 'transparent', border: 'none', cursor: 'pointer', color: C.dim, display: 'flex', padding: 2,
                }}>
                  <ChevronRight size={18} style={{ transition: 'transform .22s var(--ease)', transform: expanded ? 'rotate(90deg)' : 'none' }} />
                </button>
              ) : <span style={{ width: 22 }} />}

              <input type="color" value={s.color} aria-label={`Couleur de ${s.name}`}
                onChange={(e) => onUpdateSubject(s.id, { color: e.target.value })}
                style={{ width: 26, height: 26, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }} />

              <TextInput value={s.name} onChange={(v) => onUpdateSubject(s.id, { name: v })}
                ariaLabel={`Nom de la matière ${s.name}`} style={{ maxWidth: 280 }} />

              {isCore && subChapters.length > 0 && (
                <Chip color={C.dim} title="chapitres">{subChapters.length} chap.</Chip>
              )}

              <button onClick={() => onUpdateSubject(s.id, { type: isCore ? 'parallel' : 'core', weeklyFloor: isCore ? 4 : undefined })}
                title="Matière = chapitre et document suivis · habitude = simple compteur hebdomadaire"
                style={{ background: 'transparent', border: `1px solid ${C.line}`, color: C.faint, borderRadius: 7, fontSize: 11, padding: '4px 7px', cursor: 'pointer', fontFamily: SANS }}>
                ↔ {isCore ? 'passer en habitude' : 'passer en matière'}
              </button>

              {isCore && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: SANS, fontSize: 10.5, color: C.faint }}>normal</span>
                  <input type="number" min={0} max={720} step={15} value={s.dailyMinutes ?? SUBJECT_DAILY_MINUTES}
                    onChange={(event) => {
                      const dailyMinutes = clamp(Number(event.target.value) || 0, 0, 720);
                      onUpdateSubject(s.id, {
                        dailyMinutes,
                        minimumMinutes: Math.min(s.minimumMinutes ?? SUBJECT_PROTECTED_MINUTES, dailyMinutes),
                      });
                    }}
                    aria-label={`Durée quotidienne normale pour ${s.name}`}
                    style={{ width: 60, fontFamily: MONO, fontSize: 12, color: C.text, background: C.inset, border: `1px solid ${C.line2}`, borderRadius: 6, padding: '4px 5px' }} />
                  <span style={{ fontFamily: SANS, fontSize: 10.5, color: C.faint }}>min</span>
                  <input type="number" min={0} max={s.dailyMinutes ?? SUBJECT_DAILY_MINUTES} step={15}
                    value={s.minimumMinutes ?? SUBJECT_PROTECTED_MINUTES}
                    onChange={(event) => onUpdateSubject(s.id, {
                      minimumMinutes: clamp(Number(event.target.value) || 0, 0, s.dailyMinutes ?? SUBJECT_DAILY_MINUTES),
                    })}
                    aria-label={`Minimum quotidien protégé pour ${s.name}`}
                    style={{ width: 60, fontFamily: MONO, fontSize: 12, color: C.text, background: C.inset, border: `1px solid ${C.line2}`, borderRadius: 6, padding: '4px 5px' }} />
                  <span style={{ fontFamily: SANS, fontSize: 10.5, color: C.faint }}>min/j</span>
                </div>
              )}

              {!isCore && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>minimum</span>
                  <input type="number" min={0} max={20} value={s.weeklyFloor ?? 0}
                    onChange={(e) => onUpdateSubject(s.id, { weeklyFloor: clamp(Number(e.target.value) || 0, 0, 20) })}
                    aria-label={`Minimum hebdomadaire pour ${s.name}`}
                    style={{ width: 52, fontFamily: MONO, fontSize: 13, color: C.text, background: C.inset, border: `1px solid ${C.line2}`, borderRadius: 6, padding: '5px 6px' }} />
                  <span style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>/sem</span>
                </div>
              )}

              <div style={{ marginLeft: 'auto' }}>
              <IconBtn icon={Trash2} danger title={`Supprimer la matière ${s.name}`}
                  onClick={() => { if (confirm(`Supprimer « ${s.name} » et tout son contenu ?`)) onDeleteSubject(s.id); }} />
              </div>
            </div>

            {!isCore && (
              <div style={{
                borderTop: `1px solid ${C.line}`, padding: '10px 12px',
                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              }}>
                <span style={{ fontFamily: SANS, fontSize: 11.5, color: C.faint, flex: '1 1 320px', lineHeight: 1.5 }}>
                  <b>Habitude hebdomadaire</b> : simple compteur, sans chapitre ni consolidation.
                  Passe-la en matière si elle doit ouvrir un document cumulatif et suivre des portions datées.
                </span>
                <Btn onClick={() => onUpdateSubject(s.id, { type: 'core', weeklyFloor: undefined })}
                  title={`Transformer ${s.name} en matière suivie`}>
                  <Layers size={13} /> Passer en matière
                </Btn>
              </div>
            )}

            {isCore && expanded && (
              <div id={`subject-panel-${s.id}`} role="region" aria-labelledby={`subject-toggle-${s.id}`}
                style={{ borderTop: `1px solid ${C.line}`, padding: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
                {/* Chapitres */}
                <div>
                  <SectionTitle icon={BookOpen}>Chapitres</SectionTitle>
                  {subChapters.length === 0 && (
                    <Empty>Aucun chapitre. Ajoute le chapitre actuel ou une ressource durable.</Empty>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
                    {subChapters.map((c) => (
                      <div id={`chapter-${c.id}`} key={c.id} className="cad-card" style={{
                        display: 'flex', flexDirection: 'column', gap: 9, padding: 11,
                        background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 8,
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <TextInput value={c.name} onChange={(value) => onUpdateChapter(c.id, { name: value })}
                            ariaLabel={`Nom du chapitre ${c.name}`} />
                          {c.kind === 'resource' && <Chip color={C.dim}><Library size={11} /> ressource</Chip>}
                          <IconBtn icon={Trash2} danger title={`Supprimer le chapitre ${c.name}`}
                            onClick={() => {
                              if (confirm(`Supprimer « ${c.name} » ? Son historique et ses références d’épreuve seront aussi supprimés.`)) onDeleteChapter(c.id);
                            }} />
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <PositionField value={c.position} onSave={(value) => onSetPosition(c.id, value)} compact />
                          {c.positionUpdatedAt && <Chip color={C.faint}>mis à jour le {c.positionUpdatedAt.split('-').reverse().join('/')}</Chip>}
                        </div>
                        <DocsRow chapter={c} today={today} compact
                          onAddDoc={onAddDoc} onUseDoc={onUseDoc} onRemoveDoc={onRemoveDoc} />
                        {c.kind === 'resource' && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <span style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>type de reprise</span>
                            {AXIS_KEYS.map((axis) => {
                              const active = applicableAxes(c).includes(axis);
                              const last = active && applicableAxes(c).length === 1;
                              return (
                                <button key={axis} type="button" aria-pressed={active} disabled={last}
                                  aria-label={last ? `${AXES[axis].long} : au moins un axe doit rester actif` : `${active ? 'Retirer' : 'Ajouter'} ${AXES[axis].long}`}
                                  onClick={() => onSetAxes(c.id, active
                                    ? applicableAxes(c).filter((item) => item !== axis)
                                    : [...applicableAxes(c), axis])}
                                  style={{
                                    fontFamily: SANS, fontSize: 11, padding: '3px 8px', borderRadius: 999,
                                    cursor: last ? 'not-allowed' : 'pointer',
                                    border: `1px solid ${active ? 'rgba(94,169,255,.5)' : C.line2}`,
                                    background: active ? 'rgba(94,169,255,.12)' : 'transparent',
                                    color: active ? '#dbeafe' : C.faint,
                                  }}>
                                  {AXES[axis].label}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <div id={`chapter-adder-${s.id}`}>
                    <ChapterAdder onAdd={(name) => onAddChapter(s.id, name)}
                      onAddMany={(names) => onAddChaptersBulk(s.id, names)}
                      onAddResource={(name, axes) => onAddResource(s.id, name, axes)} />
                  </div>
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
                                <TextInput type="date" value={e.date}
                                  onChange={(v) => { if (v) onUpdateExam(e.id, { date: v }); }}
                                  ariaLabel={`Date de l'épreuve ${e.name}`} style={{ maxWidth: 160 }} />
                                <Segmented value={e.importance || 'normal'} ariaLabel="importance de l'épreuve"
                                  onChange={(v) => onUpdateExam(e.id, { importance: v })}
                                  options={[
                                    { value: 'minor', label: 'Mineure' },
                                    { value: 'normal', label: 'Normale' },
                                    { value: 'major', label: 'Majeure' },
                                  ]} />
                                <Mono style={{ fontSize: 12, color: days < 0 ? C.faint : (days <= settings.examModeThreshold ? C.warn : C.accent) }}>
                                  {days < 0 ? 'passée' : `J−${days}`}
                                </Mono>
                                <div style={{ marginLeft: 'auto' }}>
                                  <IconBtn icon={Trash2} danger title={`Supprimer l'épreuve ${e.name}`}
                                    onClick={() => { if (confirm(`Supprimer l’épreuve « ${e.name} » ?`)) onDeleteExam(e.id); }} />
                                </div>
                              </div>
                              <ScopeSelector chapters={subChapters} units={subUnits}
                                chapterIds={e.chapterIds || []} portionIds={e.portionIds || []}
                                onToggleChapter={(id) => onToggleExamChapter(e.id, id)}
                                onTogglePortion={(id) => onToggleExamPortion(e.id, id)}
                                onAll={() => onUpdateExam(e.id, {
                                  chapterIds: subChapters.map((chapter) => chapter.id), portionIds: [],
                                })}
                                onNone={() => onUpdateExam(e.id, { chapterIds: [], portionIds: [] })} />
                            </div>
                          );
                        })}
                      </div>
                      <div id={`exam-adder-${s.id}`}>
                        <AddExam subjectId={s.id} today={today} onAdd={onAddExam} />
                      </div>
                    </>
                  )}
                </div>

                {/* Tests de cours : un élément stable, replanifié après chaque note. */}
                <div>
                  <SectionTitle icon={RefreshCw}>Tests de cours notés</SectionTitle>
                  <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.faint, margin: '-3px 0 9px' }}>
                    Le même test est réutilisé : une note réelle sans support fixe sa prochaine date. Elle ne remplace pas l’auto-évaluation des portions.
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
                    {subTests.map((test) => {
                      const latest = latestCourseTestResult(test.id, courseTestLog);
                      return (
                        <div key={test.id} style={{ padding: 10, background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <TextInput value={test.name} onChange={(name) => onUpdateCourseTest(test.id, { name })}
                              ariaLabel={`Nom du test ${test.name}`} style={{ maxWidth: 240 }} />
                            <TextInput type="date" value={test.scheduledFor}
                              onChange={(scheduledFor) => { if (scheduledFor) onUpdateCourseTest(test.id, { scheduledFor }); }}
                              ariaLabel={`Prochaine date du test ${test.name}`} style={{ maxWidth: 160 }} />
                            {latest && <Chip color={C.good}>dernier {latest.score}/{latest.maxScore}</Chip>}
                            <div style={{ marginLeft: 'auto' }}>
                              <IconBtn icon={Trash2} danger title={`Supprimer le test ${test.name}`}
                                onClick={() => { if (confirm(`Supprimer le test « ${test.name} » et son historique ?`)) onDeleteCourseTest(test.id); }} />
                            </div>
                          </div>
                          <ScopeSelector chapters={subChapters} units={subUnits}
                            chapterIds={test.chapterIds || []} portionIds={test.portionIds || []}
                            onToggleChapter={(id) => {
                              const active = (test.chapterIds || []).includes(id);
                              onUpdateCourseTest(test.id, {
                                chapterIds: active
                                  ? (test.chapterIds || []).filter((value) => value !== id)
                                  : [...(test.chapterIds || []), id],
                                portionIds: active ? (test.portionIds || []) : (test.portionIds || [])
                                  .filter((portionId) => subUnits.find((unit) => unit.id === portionId)?.parentChapterId !== id),
                              });
                            }}
                            onTogglePortion={(id) => onUpdateCourseTest(test.id, {
                              portionIds: (test.portionIds || []).includes(id)
                                ? (test.portionIds || []).filter((value) => value !== id)
                                : [...(test.portionIds || []), id],
                            })}
                            onAll={() => onUpdateCourseTest(test.id, {
                              chapterIds: subChapters.map((chapter) => chapter.id), portionIds: [],
                            })}
                            onNone={() => onUpdateCourseTest(test.id, { chapterIds: [], portionIds: [] })} />
                        </div>
                      );
                    })}
                  </div>
                  <div id={`test-adder-${s.id}`}>
                    <AddCourseTest subjectId={s.id} today={today} chapters={subChapters} units={subUnits}
                      onAdd={onAddCourseTest} />
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div id="subject-adder" style={{ marginTop: 4 }}>
        <AddRow placeholder="Nouvelle matière (ex. Thermodynamique)" cta="Matière" onAdd={onAddSubject} />
      </div>
    </div>
  );
}

// Ajout de chapitres : un par un ou en lot. La maîtrise n'est volontairement
// pas demandée à la création : elle ne sera saisie qu'après une reprise réelle.
function ChapterAdder({ onAdd, onAddMany, onAddResource }) {
  const [bulk, setBulk] = useState(false);
  const [text, setText] = useState('');
  const [resourceOpen, setResourceOpen] = useState(false);
  const [resourceName, setResourceName] = useState('');
  const [preset, setPreset] = useState(RESOURCE_PRESETS[0]);
  const names = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const addBulk = () => {
    if (!names.length) return;
    onAddMany(names);
    setText('');
    setBulk(false);
  };
  const addResource = () => {
    const n = resourceName.trim();
    if (!n) return;
    onAddResource(n, preset.axes);
    setResourceName('');
    setResourceOpen(false);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {!bulk ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 260px' }}>
            <AddRow placeholder="Nouveau chapitre (ex. Réduction des endomorphismes)" cta="Chapitre" onAdd={onAdd} />
          </div>
          <Btn variant="bare" onClick={() => setBulk(true)} style={{ color: C.dim, fontSize: 12 }}>
            <Plus size={13} /> en lot (un par ligne)
          </Btn>
          {onAddResource && (
            <Btn variant="bare" onClick={() => setResourceOpen((v) => !v)} style={{ color: C.dim, fontSize: 12 }}>
              <Library size={13} /> ressource
            </Btn>
          )}
        </div>
      ) : (
        <>
          <textarea value={text} onChange={(e) => setText(e.target.value)}
            aria-label="chapitres en lot (un par ligne)" rows={5}
            placeholder={'Un chapitre par ligne, ex. :\nEspaces vectoriels\nRéduction des endomorphismes\nDéterminants'}
            style={{
              fontFamily: SANS, fontSize: 13, color: C.text, background: C.inset,
              border: `1px solid ${C.line2}`, borderRadius: 7, padding: '8px 10px',
              width: '100%', boxSizing: 'border-box', resize: 'vertical',
            }} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Btn variant="primary" onClick={addBulk} disabled={!names.length}>
              <Plus size={14} /> Ajouter {names.length || ''} chapitre{names.length > 1 ? 's' : ''}
            </Btn>
            <Btn variant="bare" onClick={() => setBulk(false)} style={{ color: C.faint, fontSize: 12 }}>annuler</Btn>
            <span style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>
              aucune maîtrise demandée à la création
            </span>
          </div>
        </>
      )}

      {/* Ressource : tout ce qui se révise sans être un chapitre de cours.
          Le profil choisit les axes qui s'appliquent — ils restent modifiables. */}
      {resourceOpen && (
        <div className="cad-in" style={{
          padding: 12, borderRadius: 9, background: C.panel2,
          border: `1px solid ${C.line}`, display: 'flex', flexDirection: 'column', gap: 9,
        }}>
          <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.dim, lineHeight: 1.5 }}>
            Une <b>ressource</b> est un support durable (recueil, annales, vocabulaire).
            Tu peux lui associer un document et noter <b>où tu t’arrêtes</b>.
          </div>
          <TextInput value={resourceName} onChange={setResourceName}
            ariaLabel="nom de la ressource"
            placeholder="ex. Vocabulaire TOEIC, Annales de mécanique, Recueil d’exos"
            onKeyDown={(e) => { if (e.key === 'Enter') addResource(); }} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {RESOURCE_PRESETS.map((p) => {
              const on = p.key === preset.key;
              return (
                <button key={p.key} type="button" onClick={() => setPreset(p)} aria-pressed={on}
                  title={`${p.hint} — axes : ${p.axes.map((a) => AXES[a].label).join(', ')}`}
                  style={{
                    fontFamily: SANS, fontSize: 11.5, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
                    border: `1px solid ${on ? 'rgba(94,169,255,.5)' : C.line2}`,
                    background: on ? 'rgba(94,169,255,.14)' : 'transparent',
                    color: on ? '#dbeafe' : C.dim,
                  }}>
                  {p.label}
                </button>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Btn variant="primary" onClick={addResource} disabled={!resourceName.trim()}>
              <Library size={14} /> Ajouter la ressource
            </Btn>
            <Btn variant="bare" onClick={() => setResourceOpen(false)} style={{ color: C.faint, fontSize: 12 }}>annuler</Btn>
            <span style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>
              {preset.hint} · {preset.axes.map((a) => AXES[a].label).join(' + ')}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function AddExam({ subjectId, today, onAdd }) {
  const [name, setName] = useState('');
  const [date, setDate] = useState(addDays(today, 14));
  const add = () => {
    const n = name.trim();
    if (!n) return;
    onAdd(subjectId, { name: n, date, chapterIds: [], portionIds: [] });
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

function AddCourseTest({ subjectId, today, chapters, units, onAdd }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('Test de cours');
  const [scheduledFor, setScheduledFor] = useState(addDays(today, 1));
  const [chapterIds, setChapterIds] = useState([]);
  const [portionIds, setPortionIds] = useState([]);
  const toggle = (list, setList, id) => setList(list.includes(id)
    ? list.filter((value) => value !== id) : [...list, id]);
  const add = () => {
    const clean = name.trim();
    if (!clean || chapterIds.length + portionIds.length === 0) return;
    onAdd(subjectId, { name: clean, scheduledFor, chapterIds, portionIds });
    setName('Test de cours');
    setScheduledFor(addDays(today, 1));
    setChapterIds([]);
    setPortionIds([]);
    setOpen(false);
  };
  if (!open) return (
    <Btn variant="bare" onClick={() => setOpen(true)} style={{ color: C.accent, paddingLeft: 0 }}>
      <Plus size={14} /> Planifier un test de cours
    </Btn>
  );
  return (
    <div style={{ padding: 10, background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <TextInput value={name} onChange={setName} ariaLabel="nom du nouveau test de cours" style={{ maxWidth: 240 }} />
        <TextInput type="date" value={scheduledFor} onChange={setScheduledFor}
          ariaLabel="date du nouveau test de cours" style={{ maxWidth: 160 }} />
      </div>
      <ScopeSelector chapters={chapters} units={units} chapterIds={chapterIds} portionIds={portionIds}
        onToggleChapter={(id) => {
          const active = chapterIds.includes(id);
          toggle(chapterIds, setChapterIds, id);
          if (!active) setPortionIds((current) => current
            .filter((portionId) => units.find((unit) => unit.id === portionId)?.parentChapterId !== id));
        }}
        onTogglePortion={(id) => toggle(portionIds, setPortionIds, id)}
        onAll={() => { setChapterIds(chapters.map((chapter) => chapter.id)); setPortionIds([]); }}
        onNone={() => { setChapterIds([]); setPortionIds([]); }} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Btn variant="primary" onClick={add} disabled={!name.trim() || chapterIds.length + portionIds.length === 0}>
          <Plus size={14} /> Créer le test
        </Btn>
        <Btn variant="bare" onClick={() => setOpen(false)} style={{ color: C.faint }}>annuler</Btn>
      </div>
    </div>
  );
}

/* ================================================================== *
 *  Vue 4 — Progrès (statistiques dérivées du journal)
 * ================================================================== */

function ProgressView({ reviewLog, ranked, today, subjects, settings, chapters }) {
  // Révisions par jour (30 derniers jours).
  const days = Array.from({ length: 30 }, (_, i) => addDays(today, i - 29));
  const byDay = {};
  for (const r of reviewLog) byDay[r.date] = (byDay[r.date] || 0) + 1;
  const maxDay = Math.max(1, ...days.map((d) => byDay[d] || 0));

  // Trois axes SÉPARÉS — jamais fondus en un « score de réussite » unique.
  const axes = axisSummary(chapters || [], settings, today);
  const calib = observedRetention(reviewLog);

  // Notes par axe (rappel + legacy comptés ensemble côté rappel).
  const byAxis = { recall: { 1: 0, 2: 0, 3: 0, 4: 0, n: 0 }, exercise: { 1: 0, 2: 0, 3: 0, 4: 0, n: 0 }, problem: { 1: 0, 2: 0, 3: 0, 4: 0, n: 0 } };
  for (const r of reviewLog) {
    const ax = evidenceAxis(r.evidenceType || 'legacy');
    if (byAxis[ax] && r.grade >= 1 && r.grade <= 4) { byAxis[ax][r.grade]++; byAxis[ax].n++; }
  }

  const fresh = ranked.filter((c) => c.risks.recall < 1).length;

  // Rappel moyen estimé par matière (chapitres au rappel testé).
  const bySubject = (subjects || []).filter((s) => s.type === 'core').map((s) => {
    const chs = ranked.filter((c) => c.subjectId === s.id);
    const revued = chs.filter((c) => c.R != null);
    const avg = revued.length ? revued.reduce((a, c) => a + c.R, 0) / revued.length : null;
    const late = chs.filter((c) => c.risks.recall >= 1).length;
    return { subject: s, avg, late, total: chs.length };
  }).filter((x) => x.total > 0).sort((a, b) => (a.avg ?? 0) - (b.avg ?? 0));

  const AXIS_CARDS = [
    {
      ax: 'recall', title: 'Rappel du cours', desc: 'rappel moyen estimé (modèle) sur les chapitres testés',
      icon: BookOpen,
    },
    {
      ax: 'exercise', title: 'Exercices — autonomie', desc: 'maîtrise observée (score heuristique, pas une probabilité)',
      icon: Pencil,
    },
    {
      ax: 'problem', title: 'Problèmes / annales — transfert', desc: 'maîtrise observée (score heuristique, pas une probabilité)',
      icon: FlaskConical,
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <SectionTitle icon={TrendingUp}>Progrès</SectionTitle>

      {/* Trois indicateurs SÉPARÉS — pas de « probabilité de réussite » unique */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {AXIS_CARDS.map(({ ax, title, desc, icon: Icon }) => {
          const a = axes[ax];
          const col = a.avg != null ? thermal((1 - a.avg) * 4) : C.faint;
          return (
            <div key={ax} className="cad-card" style={{
              flex: '1 1 220px', minWidth: 210, background: C.panel,
              border: `1px solid ${C.line}`, borderRadius: 10, padding: 13,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <Icon size={13} color={C.dim} />
                <span style={{ fontFamily: SANS, fontSize: 12, fontWeight: 600, color: C.text }}>{title}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8 }}>
                <Mono style={{ fontSize: 22, color: col }}>
                  {a.avg != null ? `${Math.round(a.avg * 100)}%` : '—'}
                </Mono>
                <span style={{ fontFamily: SANS, fontSize: 11, color: C.dim }}>
                  {a.tested}/{a.total} testé{a.tested > 1 ? 's' : ''}
                </span>
              </div>
              <div style={{ height: 5, background: C.inset, borderRadius: 3, margin: '8px 0 6px', overflow: 'hidden', border: `1px solid ${C.line}` }}>
                <div className="cad-bar" style={{ width: `${a.avg != null ? a.avg * 100 : 0}%`, height: '100%', background: col, opacity: .8 }} />
              </div>
              <div style={{ fontFamily: SANS, fontSize: 10.5, color: a.untested ? C.warn : C.faint }}>
                {a.untested > 0 ? `${a.untested} jamais testé${a.untested > 1 ? 's' : ''} sur cet axe` : 'tous testés sur cet axe'}
              </div>
              <div style={{ fontFamily: SANS, fontSize: 10, color: C.faint, marginTop: 4 }}>{desc}</div>
            </div>
          );
        })}
      </div>
      <div style={{ fontFamily: SANS, fontSize: 10.5, color: C.faint, marginTop: -8 }}>
        Trois axes indépendants : savoir son cours, réussir les exercices types, tenir sur une annale.
        Aucun de ces chiffres n’est une probabilité de réussir un examen.
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Stat label="tests (total)" value={reviewLog.length} unit="notés, tous axes" tone={C.accent} />
        <Stat label="rappel à jour" value={`${fresh}/${ranked.length}`} unit="chapitres" tone={ranked.length && fresh === ranked.length ? C.good : C.dim} />
        {calib.n >= 5 && (
          <Stat label="rétention observée" value={`${Math.round(calib.rate * 100)}%`}
            unit={`cible ${Math.round((settings?.requestRetention ?? 0.9) * 100)} % · ${calib.n} tests de rappel`}
            tone={calib.rate >= (settings?.requestRetention ?? 0.9) - 0.05 ? C.good : C.warn} />
        )}
      </div>
      {calib.n >= 5 && calib.rate < (settings?.requestRetention ?? 0.9) - 0.07 && (
        <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.warn }}>
          Tu retiens moins que la cible (calculé sur les seuls tests de rappel) : resserre les
          révisions (monte la rétention cible) ou découpe les chapitres trop denses.
        </div>
      )}

      <div>
        <SectionTitle icon={Activity}>Tests des 30 derniers jours</SectionTitle>
        {reviewLog.length === 0 ? (
          <Empty>Encore aucun test noté. Après chaque séance, teste-toi sans correction puis note le résultat : tout s’enregistre ici.</Empty>
        ) : (
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14 }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 110 }}>
              {days.map((d) => {
                const n = byDay[d] || 0;
                return (
                  <div key={d} title={`${fmtShortDate(d)} : ${n} test${n > 1 ? 's' : ''}`}
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
          <SectionTitle icon={Layers}>Rappel estimé par matière (chapitres testés)</SectionTitle>
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
          <SectionTitle icon={Check}>Répartition des notes — par type de preuve</SectionTitle>
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {AXIS_KEYS.map((ax) => {
              const dist = byAxis[ax];
              if (!dist.n) {
                return (
                  <div key={ax} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontFamily: SANS, fontSize: 12, color: C.dim, width: 130, fontWeight: 600 }}>{AXES[ax].label}</span>
                    <span style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>aucun test noté sur cet axe</span>
                  </div>
                );
              }
              return (
                <div key={ax} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontFamily: SANS, fontSize: 12, color: C.text, width: 130, fontWeight: 600 }}>
                    {AXES[ax].label}
                    <Mono style={{ fontSize: 10.5, color: C.faint }}> · {dist.n}</Mono>
                  </span>
                  <div style={{ flex: 1, display: 'flex', height: 10, background: C.inset, borderRadius: 5, overflow: 'hidden', border: `1px solid ${C.line}` }}
                    title={[1, 2, 3, 4].map((g) => `${gradeLabel(ax, g)} : ${dist[g]}`).join(' · ')}>
                    {[1, 2, 3, 4].map((g) => (
                      <div key={g} className="cad-bar" style={{ width: `${(dist[g] / dist.n) * 100}%`, height: '100%', background: GRADES[g].color, opacity: .75 }} />
                    ))}
                  </div>
                  <Mono style={{ fontSize: 10.5, color: C.dim, width: 88, textAlign: 'right' }}
                    title="part de réussites (notes 3–4)">
                    {Math.round(((dist[3] + dist[4]) / dist.n) * 100)}% réussis
                  </Mono>
                </div>
              );
            })}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 2 }}>
              {[1, 2, 3, 4].map((g) => (
                <span key={g} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: SANS, fontSize: 10.5, color: C.faint }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: GRADES[g].color, opacity: .75 }} />
                  {GRADES[g].label}
                </span>
              ))}
              <span style={{ fontFamily: SANS, fontSize: 10.5, color: C.faint, marginLeft: 'auto' }}>
                les anciennes notes (avant la séparation des axes) comptent côté rappel
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ================================================================== *
 *  Vue 4 — Réglages
 * ================================================================== */

// Un seul réglage courant : le seuil qui déclenche la prochaine consolidation.
// Les paramètres historiques restent disponibles, mais uniquement en avancé.
const SLIDERS = [
  { key: 'requestRetention', label: 'Seuil de rappel', min: 0.8, max: 0.97, step: 0.01, fmt: (v) => `${Math.round(v * 100)} %`, help: 'une portion déjà consolidée réapparaît quand son rappel estimé atteint ce seuil — plus haut = rappels plus rapprochés' },
];

// Réglages EXPERTS : paramètres du modèle, arbitraires ou scientifiques.
// Les déplacer ne « calibre » rien — n'y touche que si tu sais pourquoi.
const ADVANCED_SLIDERS = [
  { key: 'maxExamPressure', label: 'Pression d’examen max', min: 1, max: 10, step: 0.5, unit: '×', help: 'multiplicateur au jour J (épreuve normale)' },
  { key: 'pressureHorizon', label: 'Horizon de pression', min: 7, max: 90, step: 1, unit: ' j', help: 'au-delà, l’examen n’influe pas' },
  { key: 'examModeThreshold', label: 'Seuil « examen proche »', min: 3, max: 45, step: 1, unit: ' j', help: 'à partir de combien de jours une UE est signalée' },
  { key: 'minInterval', label: 'Stabilité initiale « Jamais vu »', min: 1, max: 7, step: 1, unit: ' j', help: 'point de départ des nouveaux chapitres' },
  { key: 'maxInterval', label: 'Stabilité initiale « Solide »', min: 7, max: 60, step: 1, unit: ' j', help: 'point de départ d’un chapitre déjà maîtrisé' },
];

function SettingsView({ settings, state, chapters, onUpdate, onImport, onReset, today, listBackups, onRestore, lastExportAt, onExported, sync }) {
  const fileRef = useRef(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const backups = listBackups ? listBackups() : [];

  // Charge indicative des seules portions quotidiennes déjà créées.
  const load = chapters?.length ? cruiseLoad(chapters, settings) : null;

  const exportJSON = () => {
    try {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `cadence-${today}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      onExported?.();
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

  // Voie fiable sur PWA mobile (où le téléchargement de fichier échoue
  // parfois en silence) : copier l'export dans le presse-papiers.
  const copyJSON = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(state));
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
      onExported?.();
    } catch (e) {
      alert('Copie impossible dans cet environnement — utilise « Exporter (JSON) ».');
    }
  };
  const importPaste = () => {
    let obj;
    try { obj = JSON.parse(pasteText); }
    catch (e) { alert('Import impossible : le texte collé n’est pas du JSON valide.'); return; }
    if (onImport(obj)) { setPasteText(''); setPasteOpen(false); }
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
          color: C.dim,
        }}>
          charge indicative ≈ {load < 10 ? round1(load) : Math.round(load)} min/jour
          <span style={{ color: C.faint }}> · {chapters.length} portion{chapters.length > 1 ? 's' : ''} suivie{chapters.length > 1 ? 's' : ''}</span>
        </div>
      )}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <SectionTitle icon={Activity}>Principe</SectionTitle>
        <div style={{ fontFamily: SANS, fontSize: 12.5, color: C.dim, lineHeight: 1.6, maxWidth: 680 }}>
          Une portion nouvelle n’a pas de niveau. Dès le lendemain, restitue-la brièvement sans
          le document, puis choisis l’un des cinq niveaux, d’<b>Oublié</b> à <b>Très solide</b>.
          Cette réponse déclenche sa prochaine date selon la courbe d’oubli. Les tests de cours
          notés et les annales conservent leurs résultats objectifs séparés.
        </div>
      </div>

      <SectionTitle icon={SettingsIcon}>Courbe d’oubli</SectionTitle>

      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 320px', minWidth: 280, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {SLIDERS.map(renderSlider)}

          <div>
            <Btn variant="bare" onClick={() => setShowAdvanced((v) => !v)} style={{ color: C.dim, fontSize: 12, paddingLeft: 0 }}>
              <ChevronRight size={14} style={{ transition: 'transform .22s var(--ease)', transform: showAdvanced ? 'rotate(90deg)' : 'none' }} />
              réglages experts (paramètres du modèle)
            </Btn>
            <div className={`cad-collapse${showAdvanced ? ' open' : ''}`}>
              <div className="cad-collapse-in" {...(showAdvanced ? {} : { inert: '' })}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 10 }}>
                  <div style={{ fontFamily: SANS, fontSize: 11, color: C.warn }}>
                    Paramètres internes du modèle. Les déplacer ne « calibre » rien
                    scientifiquement — les valeurs par défaut conviennent dans la
                    quasi-totalité des cas.
                  </div>
                  {ADVANCED_SLIDERS.map(renderSlider)}
                  <div style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>
                    Le modèle de rappel (équations FSRS-4.5, poids par défaut publiés,
                    non personnalisés) n’ajuste que l’axe <b>rappel</b>, à partir de tes
                    notes de rappel. Les axes exercice et problème utilisent un score
                    heuristique transparent (résultats observés, récence, échecs répétés)
                    — pas une probabilité FSRS.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div style={{ flex: '1 1 320px', minWidth: 280, display: showAdvanced ? 'block' : 'none' }}>
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
                <div key={i} title={`${Math.round(b.t)} j → rappel estimé ${Math.round(b.R * 100)}%`} style={{
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
              test visé à ~{Math.round(dueAt)} j (rappel estimé {Math.round(settings.requestRetention * 100)} %),
              solidité {round1(sampleS)} j (niveau « Moyen »)
            </div>
          </div>
        </div>
      </div>

      {sync && <SyncSettings sync={sync} />}

      <div>
        <SectionTitle icon={Download}>Données &amp; sauvegarde</SectionTitle>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <Btn onClick={exportJSON}><Download size={14} /> Exporter (JSON)</Btn>
          <Btn onClick={copyJSON} title="Copie l'export JSON dans le presse-papiers — la voie fiable sur téléphone (colle-le dans une note ou un mail).">
            {copied ? <Check size={14} color={C.good} /> : <Download size={14} />} {copied ? 'Copié ✓' : 'Copier l’export'}
          </Btn>
          <Btn onClick={() => fileRef.current?.click()}><Upload size={14} /> Importer (JSON)</Btn>
          <Btn onClick={() => setPasteOpen((v) => !v)} title="Importer en collant le contenu d'un export JSON — pratique sur téléphone.">
            <Upload size={14} /> Importer par collage
          </Btn>
          <input ref={fileRef} type="file" accept="application/json,.json" onChange={onFile} style={{ display: 'none' }} />
          <Btn variant="danger" onClick={onReset}><RotateCcw size={14} /> Réinitialiser</Btn>
        </div>
        {pasteOpen && (
          <div className="cad-in" style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={5}
              aria-label="export JSON à coller"
              placeholder='Colle ici le contenu d’un export CADENCE ({"version":9,"subjects":[…]}). Validation stricte avant tout remplacement.'
              style={{
                fontFamily: MONO, fontSize: 11.5, color: C.text, background: C.inset,
                border: `1px solid ${C.line2}`, borderRadius: 7, padding: '8px 10px',
                width: '100%', boxSizing: 'border-box', resize: 'vertical',
              }} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Btn variant="primary" onClick={importPaste} disabled={!pasteText.trim()}>
                <Upload size={14} /> Valider l’import
              </Btn>
              <span style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>
                mêmes règles que le fichier : validation stricte, confirmation, rien n’est modifié en cas d’erreur
              </span>
            </div>
          </div>
        )}
        <div style={{ marginTop: 10, fontFamily: SANS, fontSize: 11.5 }}>
          <span style={{ color: C.dim }}>Dernier export : </span>
          {lastExportAt ? (
            <Mono style={{ fontSize: 11.5, color: daysBetween(lastExportAt, today) > 14 ? C.warn : C.good }}>
              {lastExportAt}{daysBetween(lastExportAt, today) > 14 ? ' — pense à réexporter' : ''}
            </Mono>
          ) : (
            <Mono style={{ fontSize: 11.5, color: C.warn }}>jamais — pense à exporter une fois tes données saisies</Mono>
          )}
        </div>
        {backups.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontFamily: SANS, fontSize: 12, color: C.dim, marginBottom: 7 }}
              title="Instantanés pris chaque jour dans le stockage de CE navigateur — ils ne protègent pas contre la perte de l'appareil ou l'effacement du navigateur.">
              Instantanés locaux (7 jours glissants, même appareil) — restaurer :
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
          Tout est stocké localement sur cet appareil (une seule clé <Mono color={C.dim}>{STORAGE_KEY}</Mono>,
          schéma v{state?.version ?? 9}), avec repli en mémoire si le stockage est indisponible.
          La synchronisation GitHub n’envoie ces données que lorsqu’elle est activée dans CADENCE.
          Les <b>instantanés locaux</b> quotidiens vivent dans le même stockage : ils réparent
          une fausse manip, pas la perte de l’appareil. Ta seule vraie sauvegarde externe,
          c’est <b>Exporter (JSON)</b>. L’appli est installable (« Ajouter à l’écran d’accueil »)
          et fonctionne hors-ligne.
        </div>
      </div>
    </div>
  );
}
