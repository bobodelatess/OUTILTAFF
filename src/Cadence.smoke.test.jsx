import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Cadence from './Cadence.jsx';

// Rendu côté serveur (sans navigateur) : attrape les erreurs de rendu/JSX.
// Le stockage retombe en mémoire, donc l'état initial = seed (les matières).
describe('Cadence — rendu', () => {
  it('se monte sans erreur et affiche le seed', () => {
    const html = renderToStaticMarkup(React.createElement(Cadence));
    expect(html).toContain('CADENCE');
    expect(html).toContain('Aujourd’hui');
    // bande des minimums hebdo issue du seed (matières parallèles)
    expect(html).toContain('Anglais / TOEIC');
    expect(html).toContain('À tenir cette semaine');
    // état vide invitant à agir
    expect(html).toContain('ajoute tes chapitres');
  });
});
