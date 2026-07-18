import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Minimize2, X } from 'lucide-react';

export default function FocusMode({ sessions, doneByChapter, onExit, renderCard }) {
  const items = useMemo(
    () => sessions.flatMap((session) => session.chapters.map((chapter) => ({
      chapter,
      subject: session.subject,
    }))),
    [sessions],
  );
  const [currentChapterId, setCurrentChapterId] = useState(() => items[0]?.chapter.id || null);
  const lastCursorRef = useRef(0);
  const panelRef = useRef(null);
  const foundIndex = items.findIndex(({ chapter }) => chapter.id === currentChapterId);
  const cursor = foundIndex >= 0 ? foundIndex : 0;

  useEffect(() => {
    if (foundIndex >= 0) {
      lastCursorRef.current = foundIndex;
      return;
    }
    const replacementIndex = Math.min(lastCursorRef.current, Math.max(0, items.length - 1));
    setCurrentChapterId(items[replacementIndex]?.chapter.id || null);
  }, [foundIndex, items]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => panelRef.current?.querySelector('.cad-card')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [currentChapterId]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onExit();
        return;
      }
      if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault();
        setCurrentChapterId(items[Math.max(0, cursor - 1)]?.chapter.id || null);
      }
      if (event.altKey && event.key === 'ArrowRight') {
        event.preventDefault();
        setCurrentChapterId(items[Math.min(items.length - 1, cursor + 1)]?.chapter.id || null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cursor, items, onExit]);

  if (!items.length) {
    return (
      <section className="cad-focus-shell" aria-labelledby="cad-focus-title">
        <div className="cad-focus-complete">
          <Check size={22} />
          <h2 id="cad-focus-title">Plan terminé</h2>
          <p>Il n’y a plus de chapitre dans le plan du jour.</p>
          <button type="button" className="cad-feature-button" onClick={onExit}>Revenir à la journée</button>
        </div>
      </section>
    );
  }

  const current = items[cursor];
  const completed = items.filter(({ chapter }) => Boolean(doneByChapter[chapter.id])).length;
  const currentDone = Boolean(doneByChapter[current.chapter.id]);

  return (
    <section ref={panelRef} id="cad-focus-panel" className="cad-focus-shell" aria-labelledby="cad-focus-title">
      <div className="cad-focus-header">
        <div aria-live="polite" aria-atomic="true">
          <p className="cad-eyebrow"><Minimize2 size={13} /> Mode focus</p>
          <h2 id="cad-focus-title">{current.subject.name}</h2>
          <p>{cursor + 1} sur {items.length} · {completed} terminé{completed > 1 ? 's' : ''}</p>
        </div>
        <button type="button" className="cad-focus-exit" onClick={onExit}>
          <X size={15} /> Quitter le mode focus
        </button>
      </div>

      <div className="cad-focus-progress" aria-hidden="true">
        <span style={{ width: `${((cursor + 1) / items.length) * 100}%` }} />
      </div>

      <div className="cad-focus-card" key={current.chapter.id}>
        {renderCard(current, cursor)}
      </div>

      <div className="cad-focus-navigation">
        <button
          type="button"
          className="cad-feature-button"
          onClick={() => setCurrentChapterId(items[Math.max(0, cursor - 1)]?.chapter.id || null)}
          disabled={cursor === 0}
        >
          <ChevronLeft size={16} /> Précédent
        </button>
        <span role="status" className={currentDone ? 'is-done' : ''}>
          {currentDone ? <><Check size={14} /> Test noté</> : 'Note ton test avant de continuer'}
        </span>
        <button
          type="button"
          className="cad-feature-button cad-feature-button-primary"
          onClick={() => cursor === items.length - 1
            ? onExit()
            : setCurrentChapterId(items[cursor + 1]?.chapter.id || null)}
        >
          {cursor === items.length - 1 ? 'Terminer' : 'Suivant'}
          {cursor < items.length - 1 && <ChevronRight size={16} />}
        </button>
      </div>
      <p className="cad-focus-shortcut">Astuce : Alt + ← ou → pour changer de chapitre.</p>
    </section>
  );
}
