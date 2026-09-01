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
    // les matières du seed apparaissent comme points de continuité
    expect(html).toContain('Continuité quotidienne');
    expect(html).toContain('Algèbre linéaire 2');
    // les habitudes parallèles ne polluent plus l'accueil quotidien
    expect(html).not.toContain('Anglais / TOEIC');
    expect(html).not.toContain('Minimums hebdo — à protéger si possible');
    expect(html).not.toContain('Temps disponible aujourd’hui');
    expect(html).toContain('Rien à consolider aujourd’hui');
  });
});
