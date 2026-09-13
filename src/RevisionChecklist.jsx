import React, { useMemo, useState } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import './revisionChecklist.css';
import {
  REVISION_SECTIONS, visibleRevisionPoints, revisionDraft, parseRevisionDraft,
} from './revisionPoints.js';

// Aucun HTML fourni par les notes n'est interprété. Seul le rendu KaTeX,
// avec trust:false et des limites explicites, produit du balisage.
export function RevisionText({ text }) {
  const parts = useMemo(() => {
    const pattern = /(?<!\\)(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n]+?\$)/g;
    return String(text || '').split(pattern).map((part, index) => {
      if (index % 2 === 0) return <React.Fragment key={index}>{part}</React.Fragment>;
      const display = part.startsWith('$$') || part.startsWith('\\[');
      const width = part.startsWith('$') && !display ? 1 : 2;
      try {
        const html = katex.renderToString(part.slice(width, -width), {
          displayMode: display, throwOnError: false, trust: false,
          strict: 'ignore', maxExpand: 200, maxSize: 10,
        });
        return <span key={index} dangerouslySetInnerHTML={{ __html: html }} />;
      } catch {
        return <span key={index}>{part}</span>;
      }
    });
  }, [text]);
  return <span className="cad-revision-text">{parts}</span>;
}

export default function RevisionChecklist({ unit, onSave }) {
  const [draft, setDraft] = useState(null);
  const [baseline, setBaseline] = useState([]);
  const [error, setError] = useState('');
  const [hidden, setHidden] = useState(false);
  const count = visibleRevisionPoints(unit.revisionPoints).length;
  const startEditing = () => {
    setBaseline(unit.revisionPoints || []);
    setDraft(revisionDraft(unit.revisionPoints));
    setError('');
  };
  const save = () => {
    try {
      parseRevisionDraft(draft);
      onSave(unit.id, baseline, draft);
      setDraft(null); setError('');
    } catch (problem) { setError(problem.message); }
  };
  return (
    <section className="cad-revision" aria-label={`Listes de révision — ${unit.name}`}>
      <div className="cad-revision-actions">
        {count > 0 && !draft && (
          <button type="button" aria-expanded={!hidden} onClick={() => setHidden(!hidden)}>
            {hidden ? 'Afficher les listes' : 'Masquer pour me tester'}
          </button>
        )}
        {onSave && !draft && (
          <button type="button" onClick={startEditing}>
            {count ? 'Modifier les listes' : 'Renseigner les listes'}
          </button>
        )}
      </div>
      {draft ? (
        <form onSubmit={(event) => { event.preventDefault(); save(); }}>
          <p className="cad-revision-help">Un point par ligne. Formules entre $…$. Ajoute « Blocage : … » au point concerné.</p>
          {REVISION_SECTIONS.map(({ key, label, hint }) => (
            <label key={key} className="cad-revision-field">
              <strong>{label}</strong>
              <textarea aria-label={label} rows={4} value={draft[key]} placeholder={hint}
                onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
            </label>
          ))}
          {error && <p className="cad-revision-error" role="alert">{error}</p>}
          <div className="cad-revision-actions">
            <button type="submit">Enregistrer les listes</button>
            <button type="button" onClick={() => { setDraft(null); setError(''); }}>Annuler</button>
          </div>
        </form>
      ) : !hidden && (count ? REVISION_SECTIONS.map(({ key, label }) => {
        const points = visibleRevisionPoints(unit.revisionPoints, key);
        if (!points.length) return null;
        return (
          <div key={key} className="cad-revision-section">
            <h4>{label}</h4>
            <ul>{points.map((point) => (
              <li key={point.id} className={/blocage\s*:|⚠/i.test(point.text) ? 'cad-revision-blocker' : ''}>
                <RevisionText text={point.text} />
              </li>
            ))}</ul>
          </div>
        );
      }) : <p className="cad-revision-help">Listes non renseignées. Le document lié reste disponible.</p>)}
    </section>
  );
}

export function PortionRevisionLists({ units, onSave }) {
  const [selectedId, setSelectedId] = useState('');
  const sorted = useMemo(() => [...units].sort((a, b) =>
    b.introducedAt.localeCompare(a.introducedAt)), [units]);
  const selected = sorted.find((unit) => unit.id === selectedId) || sorted[0];
  if (!selected) return null;
  return (
    <div className="cad-revision-portion">
      <label>À revoir
        <select aria-label="Portion à revoir" value={selected.id}
          onChange={(event) => setSelectedId(event.target.value)}>
          {sorted.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
        </select>
      </label>
      <RevisionChecklist key={selected.id} unit={selected} onSave={onSave} />
    </div>
  );
}

// Conservation des notes déjà saisies, sans imposer les rubriques du PDF
// à l'accueil ni demander de nouvelles listes lors du récapitulatif du soir.
export function SavedRevisionNotes({ units, onSave }) {
  const [open, setOpen] = useState(false);
  const recorded = units.filter((unit) => visibleRevisionPoints(unit.revisionPoints).length > 0);
  if (!recorded.length) return null;
  return (
    <div className="cad-revision">
      <div className="cad-revision-actions">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Masquer les notes enregistrées' : 'Notes enregistrées'}
        </button>
      </div>
      {open && <PortionRevisionLists units={recorded} onSave={onSave} />}
    </div>
  );
}
