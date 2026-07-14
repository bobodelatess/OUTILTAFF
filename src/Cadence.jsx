/*
 * CADENCE — planificateur d'étude piloté par les examens (interface).
 *
 * Répond à une seule question : « parmi mes unités académiques, lesquelles
 * travailler ou retester aujourd'hui, compte tenu de mon niveau constaté,
 * des examens et du temps réellement disponible ? »
 *
 * Tout le moteur (modèle de rappel inspiré des équations FSRS-4.5, priorité,
 * plan en minutes, migrations v1→v2→v3, validation d'import) vit dans
 * src/engine.js — fonctions pures, testées. Ce fichier ne contient que
 * l'interface React et la persistance locale (PWA, hors-ligne).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, CalendarDays, Layers, Settings as SettingsIcon, TrendingUp,
  Plus, Trash2, ChevronDown, ChevronRight, ChevronLeft, Check,
  Download, Upload, RotateCcw, AlertTriangle, Lock, Undo2,
  BookOpen, FlaskConical, Flame, Pencil, Clock3,
} from 'lucide-react';

import {
  STORAGE_KEY, LEGACY_KEY, BACKUP_KEY,
  DEFAULT_SETTINGS, GRADES, EVIDENCE, gradeLabel, LEVELS, IMPORTANCE,
  AXES, AXIS_KEYS, AXIS_MINUTES, MINUTE_CHOICES, evidenceAxis, closestLevel,
  clamp, uid, parseISO, isoOf, todayISO, daysBetween, addDays, mondayOf,
  retrievability, optimalInterval, applyEvidence, targetInterval, levelSeed,
  examMultiplier, chapterMetrics, recallInfo, practiceRisk, nextFutureExam,
  annalesModeFor, reasonPhrase, isWorthReviewing, axisMinutes, axisSummary,
  defaultDailyMinutes, todayCapacityMinutes, planDay,
  cruiseLoad, observedRetention, forecastDue, examReadiness,
  pruneBackups, validateImport, normalize, migrateV1, seedState, newChapter,
  stripChapterIds, recalibrateState, makeStore,
} from './engine.js';

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
function AxisPicker({ ch, axis, onPick, doneAxes }) {
  return (
    <div role="group" aria-label="Axe à travailler" style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
      {AXIS_KEYS.map((ax) => {
        const on = ax === axis;
        const done = doneAxes.has(ax);
        const info = ch.axisInfo[ax];
        const col = info.pct != null ? thermal((1 - info.pct / 100) * 4) : C.faint;
        return (
          <button key={ax} type="button" onClick={() => onPick(ax)}
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
function QueueCard({ idx, ch, subject, simpleMode, done, today, settings, onGrade, onUndo, onSkip }) {
  const [expanded, setExpanded] = useState(false);
  const doneEntries = done || [];
  const doneAxes = useMemo(
    () => new Set(doneEntries.map((d) => d.axis || evidenceAxis(d.evidenceType))), [doneEntries]);
  // Axe par défaut : l'axe dominant, ou le premier axe non encore noté aujourd'hui.
  const preferred = !doneAxes.has(ch.dominant)
    ? ch.dominant : (AXIS_KEYS.find((a) => !doneAxes.has(a)) || ch.dominant);
  const [axis, setAxis] = useState(preferred);
  // Si l'axe choisi vient d'être noté, avancer vers un axe restant.
  useEffect(() => {
    if (doneAxes.has(axis)) {
      const next = AXIS_KEYS.find((a) => !doneAxes.has(a));
      if (next) setAxis(next);
    }
  }, [doneAxes]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = !simpleMode || expanded;
  const tcol = thermal(ch.priority);
  const axisDone = doneAxes.has(axis);
  const allDone = AXIS_KEYS.every((a) => doneAxes.has(a));
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

  const onKey = (e) => {
    if (e.target !== e.currentTarget) return;
    if (['1', '2', '3', '4'].includes(e.key) && !axisDone) { onGrade(ch.id, axis, Number(e.key)); e.preventDefault(); }
  };

  const rec = ch.recall; // info rappel : { risk, ti, since, R, dueIn, tested }

  return (
    <div className={`cad-card${allDone ? ' cad-done' : ''}`} tabIndex={0} onKeyDown={onKey}
      title={allDone ? undefined : 'Tab pour sélectionner · touches 1–4 pour noter l’axe choisi'}
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
      </div>

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
  const [state, setState] = useState(() => {
    try {
      const raw = store.getItem(STORAGE_KEY);
      if (raw) return normalize(JSON.parse(raw)); // migre v1/v2 -> v3 sans perte
      const legacy = store.getItem(LEGACY_KEY);
      if (legacy) return normalize(migrateV1(JSON.parse(legacy)));
    } catch (e) { /* ignore */ }
    return seedState();
  });

  useEffect(() => {
    try { store.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
    // Instantané local quotidien (même appareil — pas une sauvegarde externe).
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
  const {
    subjects, chapters, exams, settings, parallelLog, reviewLog, skips,
    capacityOverrides, lastExportAt,
  } = state;

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

  const addChapter = (subjectId, name, level) => patch((p) => ({
    ...p, chapters: [...p.chapters, newChapter(subjectId, name, level || LEVELS[0], p.settings)],
  }));
  // Ajout groupé : un chapitre par ligne (niveau + durées par défaut).
  const addChaptersBulk = (subjectId, names, level) => patch((p) => ({
    ...p, chapters: [...p.chapters, ...names.map((n) => newChapter(subjectId, n, level || LEVELS[0], p.settings))],
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
  const gradeEvidence = (id, evidenceType, grade) => {
    const axis = evidenceAxis(evidenceType);
    const existing = reviewLog.find((r) => r.chapterId === id && r.date === today
      && evidenceAxis(r.evidenceType) === axis);
    if (existing && !confirm(
      `Tu as déjà noté l'axe « ${AXES[axis].label} » pour ce chapitre aujourd'hui.\nRemplacer par cette nouvelle note ?`)) return;
    const entryId = uid();
    patch((p) => {
      const ch = p.chapters.find((c) => c.id === id);
      if (!ch) return p;
      const { chapter, before, after } = applyEvidence(ch, evidenceType, grade, today);
      // Remplace une note existante du même axe/jour (après confirmation).
      const log = p.reviewLog.filter((r) => !(r.chapterId === id && r.date === today && evidenceAxis(r.evidenceType) === axis));
      const entry = { id: entryId, chapterId: id, date: today, grade, evidenceType, axis, before, after };
      return {
        ...p,
        chapters: p.chapters.map((c) => (c.id === id ? chapter : c)),
        reviewLog: [...log, entry],
      };
    });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text: `${AXES[axis].label} : « ${gradeLabel(evidenceType, grade)} »`, entryId });
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
    ...p, exams: [...p.exams, {
      id: uid(), subjectId, name: exam.name, date: exam.date,
      chapterIds: exam.chapterIds || [], importance: exam.importance || 'normal',
    }],
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

  // Import : validation stricte (liste d'erreurs) + confirmation avant
  // écrasement. En cas d'erreur, AUCUNE donnée existante n'est modifiée.
  const importState = (obj) => {
    const v = validateImport(obj);
    if (!v.ok) {
      const list = v.errors.slice(0, 8).map((e) => `• ${e}`).join('\n');
      const more = v.errors.length > 8 ? `\n…(+${v.errors.length - 8} autres)` : '';
      alert(`Import refusé — le fichier n'a pas été appliqué.\n\n${list}${more}`);
      return;
    }
    const nb = (obj.chapters || []).length;
    if (!confirm(`Remplacer les données actuelles par ce fichier ?\n(${(obj.subjects || []).length} matières, ${nb} chapitres — l'état actuel sera écrasé.)`)) return;
    setState(normalize(obj));
  };
  const markExported = () => patch((p) => ({ ...p, lastExportAt: today }));
  const resetAll = () => {
    if (confirm('Réinitialiser CADENCE ? Tes chapitres, épreuves, historique et réglages seront effacés.')) setState(seedState());
  };

  // Capacité réelle du jour (dérogation datée ; null = revenir au défaut).
  const setTodayCapacity = (minutes) => patch((p) => {
    const overrides = { ...(p.capacityOverrides || {}) };
    if (minutes == null) delete overrides[today];
    else overrides[today] = Math.max(0, Math.round(minutes / 30) * 30);
    return { ...p, capacityOverrides: overrides };
  });

  /* ----- Données dérivées ----- */
  const subjectById = useMemo(
    () => Object.fromEntries(subjects.map((s) => [s.id, s])), [subjects]);
  const coreSubjects = useMemo(() => subjects.filter((s) => s.type === 'core'), [subjects]);
  const parallelSubjects = useMemo(() => subjects.filter((s) => s.type === 'parallel'), [subjects]);

  // Notes du jour, groupées par chapitre (un chapitre peut avoir jusqu'à 3
  // axes notés le même jour). Sert à l'état « fait » et à la stabilité du plan.
  const todayEntries = useMemo(
    () => reviewLog.filter((r) => r.date === today), [reviewLog, today]);
  const doneByChapter = useMemo(() => {
    const m = {};
    for (const r of todayEntries) (m[r.chapterId] ||= []).push(r);
    return m;
  }, [todayEntries]);

  // Classement courant (post-notes), métriques multi-axes.
  const ranked = useMemo(() => chapters
    .map((ch) => enrichChapter(ch, exams, settings, today))
    .sort((a, b) => b.priority - a.priority), [chapters, exams, settings, today]);

  // Plan du jour STABLE : on planifie sur l'état d'AVANT les notes du jour
  // (chaque axe noté aujourd'hui est temporairement rollback à son `before`),
  // pour que noter un chapitre ne réorganise pas la liste. Les chapitres
  // reportés aujourd'hui sortent du plan.
  const skippedToday = useMemo(
    () => Object.entries(skips || {}).filter(([, d]) => d === today).map(([id]) => id),
    [skips, today]);
  const planningRanked = useMemo(() => chapters
    .filter((ch) => skips?.[ch.id] !== today)
    .map((ch) => {
      let base = ch;
      for (const e of doneByChapter[ch.id] || []) {
        const axis = e.axis || evidenceAxis(e.evidenceType);
        base = { ...base, [axis]: { ...e.before } };
      }
      return enrichChapter(base, exams, settings, today);
    })
    .sort((a, b) => b.priority - a.priority), [chapters, skips, doneByChapter, exams, settings, today]);

  // Capacité réelle du jour, en minutes (dérogation datée sinon défaut).
  const todayMinutes = todayCapacityMinutes(settings, capacityOverrides, today);
  const defaultMinutes = defaultDailyMinutes(settings);
  // Plan honnête : uniquement les chapitres qui valent la peine aujourd'hui.
  const worthToday = useMemo(
    () => planningRanked.filter((c) => isWorthReviewing(c) || doneByChapter[c.id]),
    [planningRanked, doneByChapter]);
  // Backlog = travail réellement dû aujourd'hui (en minutes, par axe dominant).
  const backlogList = worthToday.filter((c) => !doneByChapter[c.id]);
  const overdue = backlogList.length;
  const overdueMinutes = backlogList.reduce((a, c) => a + c.minutes, 0);
  const sessions = useMemo(
    () => planDay(worthToday, subjects, {
      subjectsPerDay: settings.subjectsPerDay,
      sessionMinutes: Math.round(settings.sessionHours * 60),
      totalMinutes: todayMinutes,
      settings,
    }),
    [worthToday, subjects, settings, todayMinutes]);
  const plannedCount = sessions.reduce((a, s) => a + s.chapters.length, 0);
  const plannedMinutes = sessions.reduce((a, s) => a + s.minutes, 0);
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

  // Préparation d'examen : rappel estimé le jour J par épreuve à venir.
  // Rappel d'export discret : jamais exporté (ou > 21 j) avec un historique réel.
  const exportStale = reviewLog.length >= 20 &&
    (!lastExportAt || daysBetween(lastExportAt, today) > 21);
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
              today={today} overdue={overdue} overdueMinutes={overdueMinutes}
              nextExam={nextExam} subjectById={subjectById}
              annalesBanners={annalesBanners} sessions={sessions} ranked={ranked}
              plannedCount={plannedCount} plannedMinutes={plannedMinutes}
              doneCount={doneCount} doneByChapter={doneByChapter}
              skippedToday={skippedToday} readinessByExam={readinessByExam}
              todayMinutes={todayMinutes} defaultMinutes={defaultMinutes}
              hasCoreChapters={hasCoreChapters} exportStale={exportStale}
              parallelSubjects={parallelSubjects} parallelLog={parallelLog} settings={settings}
              onGrade={gradeEvidence} onUndo={undoReview} onSkip={skipChapter} onUnskip={unskipToday}
              onSetTodayCapacity={setTodayCapacity}
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
              onAddChapter={addChapter} onAddChaptersBulk={addChaptersBulk}
              onUpdateChapter={updateChapter} onDeleteChapter={deleteChapter}
              onSetLevel={setChapterLevel} onSetAxisMinutes={setChapterAxisMinutes}
              onAddExam={addExam} onUpdateExam={updateExam} onDeleteExam={deleteExam}
              onToggleExamChapter={toggleExamChapter}
            />
          )}
          {tab === 'progress' && (
            <ProgressView reviewLog={reviewLog} ranked={ranked} today={today}
              subjects={subjects} settings={settings} chapters={chapters} />
          )}
          {tab === 'settings' && (
            <SettingsView settings={settings} state={state} chapters={chapters}
              onUpdate={updateSetting} lastExportAt={lastExportAt} onExported={markExported}
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

const CAPACITY_PRESETS = [0, 120, 240, 360];

function TodayView({
  today, overdue, overdueMinutes, nextExam, subjectById, annalesBanners, sessions, ranked,
  plannedCount, plannedMinutes, doneCount, doneByChapter, skippedToday, readinessByExam,
  todayMinutes, defaultMinutes, hasCoreChapters, exportStale,
  parallelSubjects, parallelLog, settings,
  onGrade, onUndo, onSkip, onUnskip, onSetTodayCapacity,
  onAdjustParallel, onGoSubjects, onSetSimpleMode,
}) {
  const [showAll, setShowAll] = useState(false);
  const [customCap, setCustomCap] = useState(false);
  const wk = mondayOf(today);
  const isOverride = todayMinutes !== defaultMinutes;
  const isPreset = CAPACITY_PRESETS.includes(todayMinutes);

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
          <button type="button" onClick={() => setCustomCap((v) => !v)}
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
            <Chip color={C.warn} title="Chapitres couverts par l'épreuve mais jamais testés — à traiter en priorité.">
              <AlertTriangle size={11} /> {readinessByExam[info.exam.id].untested.length} jamais testé{readinessByExam[info.exam.id].untested.length > 1 ? 's' : ''}
            </Chip>
          )}
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
            <Btn variant="bare" onClick={() => setShowAll((v) => !v)} style={{ color: C.dim, fontSize: 12 }}>
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
          hasCoreChapters ? (
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
            <Empty>Tes chapitres sont dans des matières « parallèle ». Passe une UE en « core » (onglet Matières) pour qu’elle entre dans le plan.</Empty>
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
              <div style={{ flex: 1 }} />
              <ThermalLegend />
            </div>
            <div style={{ fontFamily: SANS, fontSize: 11, color: C.faint, margin: '0 0 14px' }}>
              Sur chaque carte : choisis l’<b>axe</b> à travailler (rappel · exercice · problème/annale),
              teste-toi <b>sans correction</b>, puis note le résultat. Chaque axe est indépendant — tu peux en noter plusieurs le même jour.
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
            const cell0 = dueForecast[iso] || { count: 0, minutes: 0 };
            const dueMin = cell0.minutes;
            const dueCount = cell0.count;
            const titleParts = [
              ...dayExams.map((e) => `${e.name} (${(e.chapterIds || []).length} chap.)`),
              dueMin ? `${dueCount} chapitre${dueCount > 1 ? 's' : ''} à revoir · ~${fmtMinutes(dueMin)} de rappel` : null,
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
                    <Mono style={{ fontSize: 9, color: thermal((dueMin / maxDue) * 4) }} title={`${dueCount} chap.`}>{dueCount}</Mono>
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
            <span style={{ width: 18, height: 4, borderRadius: 2, background: thermal(2.5) }} /> minutes de rappel dues ce jour-là
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
                      <Chip color={e.importance === 'major' ? C.bad : e.importance === 'minor' ? C.faint : C.dim}
                        title="Importance de l'épreuve (module la pression d'examen)">
                        {IMPORTANCE[e.importance || 'normal'].label.toLowerCase()}
                      </Chip>
                      {annales && <Chip color={C.warn}><CalendarDays size={11} /> examen proche</Chip>}
                    </div>
                    {readinessByExam?.[e.id] && (() => {
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
                                    le plus fragile : {r.per[0].chapter.name} (~{Math.round(r.per[0].projR * 100)} %)
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
          <SectionTitle icon={TrendingUp}>Charge de rappel à venir (14 j)</SectionTitle>
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
  onAddChapter, onAddChaptersBulk, onUpdateChapter, onDeleteChapter, onSetLevel, onSetAxisMinutes,
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
                      const since = c.recall?.lastReviewed
                        ? (m.since === 0 ? 'rappel revu aujourd’hui' : `rappel revu il y a ${m.since} j`)
                        : 'rappel jamais testé';
                      const info = axisInfoOf(m, c);
                      return (
                        <div key={c.id} className="cad-card" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, background: C.panel2, border: `1px solid ${C.line}`, borderLeft: `3px solid ${tcol}`, borderRadius: 8 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <MemGauge R={m.R} size={26} />
                            <TextInput value={c.name} onChange={(v) => onUpdateChapter(c.id, { name: v })} ariaLabel="nom du chapitre" />
                            <IconBtn icon={Trash2} danger title="Supprimer le chapitre" onClick={() => onDeleteChapter(c.id)} />
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', paddingLeft: 34 }}>
                            <Pencil size={12} color={C.faint} />
                            <span style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}
                              title="Recalibrer : le chapitre repart de ce niveau sur les trois axes (dates de test effacées, historique archivé).">
                              niveau
                            </span>
                            <LevelPicker compact current={c.recall?.difficulty ?? 5} onPick={(l) => onSetLevel(c.id, l)} />
                            <Mono style={{ fontSize: 11, color: C.faint }}>
                              · {since} · prochain test {m.dueIn <= 0 ? 'auj.' : `dans ~${m.dueIn} j`} · solidité {round1(c.recall?.stability ?? 0)} j
                            </Mono>
                          </div>
                          {/* Maîtrise observée des axes pratiques (score heuristique, pas une proba) */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingLeft: 34 }}>
                            {['exercise', 'problem'].map((ax) => (
                              <Chip key={ax} color={info[ax].tested ? thermal((1 - info[ax].pct / 100) * 4) : C.faint}
                                title={`${AXES[ax].long} : maîtrise observée (score heuristique)`}>
                                {AXES[ax].label} {info[ax].tested ? `${info[ax].pct} %` : 'non testé'}
                              </Chip>
                            ))}
                          </div>
                          {/* Durées estimées PAR AXE (min) — le plan utilise la durée de l'axe travaillé */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', paddingLeft: 34 }}>
                            <Clock3 size={12} color={C.faint} />
                            <span style={{ fontFamily: SANS, fontSize: 11, color: C.faint }}>durées</span>
                            {AXIS_KEYS.map((ax) => (
                              <label key={ax} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <span style={{ fontFamily: SANS, fontSize: 10.5, color: C.faint }}>{AXES[ax].label}</span>
                                <select value={c.minutes?.[ax] ?? AXIS_MINUTES[ax]}
                                  aria-label={`durée ${AXES[ax].long}`}
                                  onChange={(e) => onSetAxisMinutes(c.id, ax, Number(e.target.value))}
                                  style={{ fontFamily: MONO, fontSize: 11, color: C.text, background: C.inset, border: `1px solid ${C.line2}`, borderRadius: 6, padding: '3px 5px', cursor: 'pointer' }}>
                                  {MINUTE_CHOICES.map((mn) => (
                                    <option key={mn} value={mn}>{fmtMinutes(mn)}</option>
                                  ))}
                                </select>
                              </label>
                            ))}
                          </div>
                          <div style={{ paddingLeft: 34 }}>
                            <PriorityReader m={m} compact />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <ChapterAdder onAdd={(name) => onAddChapter(s.id, name)}
                    onAddMany={(names) => onAddChaptersBulk(s.id, names)} />
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

// Ajout de chapitres : un par un, ou EN LOT (un nom par ligne). Les chapitres
// créés partent au niveau « Jamais vu » (recalibrables ensuite) avec les
// durées par défaut par axe.
function ChapterAdder({ onAdd, onAddMany }) {
  const [bulk, setBulk] = useState(false);
  const [text, setText] = useState('');
  const names = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const addBulk = () => {
    if (!names.length) return;
    onAddMany(names);
    setText('');
    setBulk(false);
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
              niveau « Jamais vu » par défaut — recalibre ensuite ceux que tu connais déjà
            </span>
          </div>
        </>
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
 *  Vue 5 — Réglages
 * ================================================================== */

// Réglages VISIBLES : ce que l'utilisateur comprend et décide vraiment
// (capacité par défaut + rétention cible). Le reste est expert.
const SLIDERS = [
  { key: 'requestRetention', label: 'Rétention cible', min: 0.8, max: 0.97, step: 0.01, fmt: (v) => `${Math.round(v * 100)} %`, help: 'tu retestes quand le rappel estimé retombe à ce niveau — plus haut = plus de travail' },
  { key: 'subjectsPerDay', label: 'Matières par jour (défaut)', min: 1, max: 6, step: 1, unit: '', help: 'capacité par défaut — ajustable chaque jour depuis l’accueil' },
  { key: 'sessionHours', label: 'Durée d’une séance (défaut)', min: 1, max: 4, step: 0.5, unit: ' h', help: 'temps par matière, par défaut' },
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

function SettingsView({ settings, state, chapters, onUpdate, onImport, onReset, today, listBackups, onRestore, lastExportAt, onExported }) {
  const fileRef = useRef(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const backups = listBackups ? listBackups() : [];

  // Compromis rétention <-> travail, calculé sur TES chapitres (live).
  // cruiseLoad = minutes de RAPPEL par jour en régime de croisière.
  const load = chapters?.length ? cruiseLoad(chapters, settings) : null;
  const dailyCap = defaultDailyMinutes(settings);

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
          entretien du rappel ≈ {load < 10 ? round1(load) : Math.round(load)} min/jour
          <span style={{ color: C.faint }}> · ta capacité par défaut : {fmtMinutes(dailyCap)}/jour (exercices et annales en plus)</span>
          {load > dailyCap ? ' — dépasse ta capacité : réduis le périmètre ou augmente le temps ; baisser la cible reste un compromis conscient' : ''}
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
          <Mono color={C.dim}> 1</Mono>–<Mono color={C.dim}>4</Mono> pour noter.
        </div>
        <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.dim, marginTop: 10, lineHeight: 1.55, maxWidth: 640 }}>
          <b>Comment noter :</b> la note décrit le <b>résultat d’un test sans correction sous
          les yeux</b> (rappel de tête, exercice ou annale selon l’<b>axe choisi sur la carte</b>)
          — jamais le temps passé ni l’impression d’avoir compris. Relire passivement n’est pas
          un test. Chaque axe est indépendant : noter un exercice ne change pas le rappel.
        </div>
      </div>

      <SectionTitle icon={SettingsIcon}>Réglages du moteur</SectionTitle>

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

      <div>
        <SectionTitle icon={Download}>Données &amp; sauvegarde</SectionTitle>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Btn onClick={exportJSON}><Download size={14} /> Exporter (JSON)</Btn>
          <Btn onClick={() => fileRef.current?.click()}><Upload size={14} /> Importer (JSON)</Btn>
          <input ref={fileRef} type="file" accept="application/json,.json" onChange={onFile} style={{ display: 'none' }} />
          <Btn variant="danger" onClick={onReset}><RotateCcw size={14} /> Réinitialiser</Btn>
        </div>
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
          Tout est stocké localement sur cet appareil (une seule clé <Mono color={C.dim}>{STORAGE_KEY}</Mono>),
          avec repli en mémoire si le stockage est indisponible — rien n’est envoyé sur un serveur.
          Les <b>instantanés locaux</b> quotidiens vivent dans le même stockage : ils réparent
          une fausse manip, pas la perte de l’appareil. Ta seule vraie sauvegarde externe,
          c’est <b>Exporter (JSON)</b>. L’appli est installable (« Ajouter à l’écran d’accueil »)
          et fonctionne hors-ligne.
        </div>
      </div>
    </div>
  );
}
