import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CornerDownLeft, Search, X } from 'lucide-react';

function normalized(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('fr-FR');
}

function isTypingTarget(target) {
  return target instanceof HTMLElement
    && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

export default function ChapterSearch({ chapters, subjects, onSelect }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const triggerRef = useRef(null);
  const dialogRef = useRef(null);

  const subjectById = useMemo(
    () => Object.fromEntries(subjects.map((subject) => [subject.id, subject])),
    [subjects],
  );
  const searchableChapterCount = chapters.filter(
    (chapter) => subjectById[chapter.subjectId]?.type === 'core',
  ).length;
  const results = useMemo(() => {
    const needle = normalized(query.trim());
    return chapters
      .filter((chapter) => {
        const subject = subjectById[chapter.subjectId];
        if (subject?.type !== 'core') return false;
        if (!needle) return true;
        return normalized(`${chapter.name} ${subject?.name || ''}`).includes(needle);
      })
      .slice(0, 8);
  }, [chapters, query, subjectById]);

  const close = (restoreFocus = true) => {
    setOpen(false);
    setQuery('');
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const choose = (chapter) => {
    onSelect(chapter);
    close(false);
  };

  useEffect(() => {
    const onShortcut = (event) => {
      const commandK = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k';
      const slash = event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey;
      if (!commandK && !(slash && !isTypingTarget(event.target))) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const onDialogKeyDown = (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowDown' && results.length && document.activeElement === inputRef.current) {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % results.length);
      return;
    }
    if (event.key === 'ArrowUp' && results.length && document.activeElement === inputRef.current) {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + results.length) % results.length);
      return;
    }
    if (event.key === 'Enter' && document.activeElement === inputRef.current && results[activeIndex]) {
      event.preventDefault();
      choose(results[activeIndex]);
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...dialogRef.current.querySelectorAll('button:not([disabled]), input:not([disabled])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="cad-search-trigger"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Rechercher un chapitre (Ctrl K)"
      >
        <Search size={15} />
        <span className="cad-search-label">Rechercher</span>
        <kbd>Ctrl K</kbd>
      </button>

      {open && createPortal((
        <div
          className="cadence cad-search-backdrop"
          onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}
        >
          <div
            ref={dialogRef}
            className="cad-search-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cad-search-title"
            onKeyDown={onDialogKeyDown}
          >
            <div className="cad-search-head">
              <Search size={18} aria-hidden="true" />
              <h2 id="cad-search-title">Trouver un chapitre</h2>
              <button type="button" className="cad-search-close" onClick={() => close()} aria-label="Fermer la recherche">
                <X size={17} />
              </button>
            </div>
            <input
              ref={inputRef}
              className="cad-search-input"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Nom du chapitre ou de la matière…"
              aria-label="Rechercher un chapitre"
              aria-controls="cad-search-results"
            />

            <p className="cad-search-count" role="status" aria-live="polite" aria-atomic="true">
              {results.length} résultat{results.length > 1 ? 's' : ''}
            </p>

            <div id="cad-search-results" className="cad-search-results">
              {results.length ? results.map((chapter, index) => {
                const subject = subjectById[chapter.subjectId];
                return (
                  <button
                    id={`cad-search-result-${chapter.id}`}
                    key={chapter.id}
                    type="button"
                    className="cad-search-result"
                    data-active={index === activeIndex}
                    onMouseEnter={() => setActiveIndex(index)}
                    onFocus={() => setActiveIndex(index)}
                    onClick={() => choose(chapter)}
                  >
                    <span className="cad-search-result-dot" style={{ background: subject?.color || '#5ea9ff' }} />
                    <span>
                      <strong>{chapter.name}</strong>
                      <small>{subject?.name || 'Matière inconnue'}</small>
                    </span>
                    {index === activeIndex && <CornerDownLeft size={15} aria-hidden="true" />}
                  </button>
                );
              }) : (
                <p className="cad-search-empty">
                  {searchableChapterCount ? 'Aucun chapitre ne correspond à cette recherche.' : 'Ajoute d’abord un chapitre planifié pour le retrouver ici.'}
                </p>
              )}
            </div>
            <p className="cad-search-hint">↑ ↓ pour parcourir · Entrée pour ouvrir · Échap pour fermer</p>
          </div>
        </div>
      ), document.body)}
    </>
  );
}
