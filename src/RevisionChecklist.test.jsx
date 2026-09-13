// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import RevisionChecklist, { PortionRevisionLists, RevisionText } from './RevisionChecklist.jsx';

afterEach(cleanup);
const point = (category, text, id = category) => ({
  id, category, text, order: 0, updatedAt: 100, deleted: false,
});
const unit = {
  id: 'u1', name: 'Ajout du 13/09/2026 — diagonalisation', introducedAt: '2026-09-13',
  revisionPoints: [
    point('course', 'Diagonalisation : $A=PDP^{-1}$. Blocage : ne pas inverser les bases.'),
    point('methods', 'Calculer les espaces propres puis vérifier leur somme directe.'),
    point('proofs', 'Montrer que des vecteurs propres de valeurs distinctes sont libres.'),
  ],
};

describe('listes de révision lisibles', () => {
  it('affiche trois listes, les formules et les blocages au point concerné', () => {
    const { container } = render(<RevisionChecklist unit={unit} onSave={vi.fn()} />);
    expect(screen.getAllByRole('heading').map((h) => h.textContent))
      .toEqual(['Cours', 'Méthodes d’exercices', 'Démonstrations']);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(container.querySelectorAll('.katex')).toHaveLength(1);
    expect(container.querySelector('.cad-revision-blocker').textContent).toContain('Blocage');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('masque le contenu pour se tester sans enregistrer de résultat', () => {
    const onSave = vi.fn();
    render(<RevisionChecklist unit={unit} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Masquer pour me tester' }));
    expect(screen.queryByRole('list')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Afficher les listes' }));
    expect(screen.getAllByRole('list')).toHaveLength(3);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('propose exactement trois champs et sauvegarde le brouillon avec sa base', () => {
    const onSave = vi.fn();
    render(<RevisionChecklist unit={unit} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Modifier les listes' }));
    expect(screen.getAllByRole('textbox')).toHaveLength(3);
    fireEvent.change(screen.getByRole('textbox', { name: 'Cours' }), { target: { value: '$A=PDP^{-1}$' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer les listes' }));
    expect(onSave).toHaveBeenCalledWith('u1', unit.revisionPoints, {
      course: '$A=PDP^{-1}$', methods: unit.revisionPoints[1].text, proofs: unit.revisionPoints[2].text,
    });
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('annule sans enregistrer et affiche une erreur sans fermer le brouillon', () => {
    const onSave = vi.fn(() => { throw new Error('La portion n’existe plus.'); });
    render(<RevisionChecklist unit={unit} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Modifier les listes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Modifier les listes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer les listes' }));
    expect(screen.getByRole('alert').textContent).toContain('La portion n’existe plus');
    expect(screen.getAllByRole('textbox')).toHaveLength(3);
  });

  it('n’invente pas de contenu pour les anciennes portions et cache les rubriques vides', () => {
    const { rerender } = render(<RevisionChecklist unit={{ ...unit, revisionPoints: [] }} onSave={vi.fn()} />);
    expect(screen.getByText(/Listes non renseignées/)).toBeTruthy();
    expect(screen.queryByRole('heading')).toBeNull();
    rerender(<RevisionChecklist unit={{ ...unit, revisionPoints: [point('methods', 'Une seule méthode')] }} onSave={vi.fn()} />);
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    expect(screen.getByRole('heading').textContent).toBe('Méthodes d’exercices');
  });

  it('permet de retrouver une ancienne portion déjà intégrée au chapitre', () => {
    const older = { ...unit, id: 'older', name: 'Ajout du 01/09/2026 — noyau', introducedAt: '2026-09-01', integratedAt: '2026-09-10', revisionPoints: [point('course', 'Ancienne notion')] };
    render(<PortionRevisionLists units={[older, unit]} onSave={vi.fn()} />);
    expect(screen.getByRole('combobox').value).toBe(unit.id);
    fireEvent.change(screen.getByRole('combobox', { name: 'Portion à revoir' }), { target: { value: 'older' } });
    const olderSection = screen.getByRole('region', { name: `Listes de révision — ${older.name}` });
    expect(within(olderSection).getByText('Ancienne notion')).toBeTruthy();
  });
});

describe('LaTeX sûr', () => {
  it('prend en charge les quatre délimiteurs sans interpréter le HTML des notes', () => {
    const { container } = render(<RevisionText text={'$x^2$ puis \\(x+y\\), $$A^{-1}$$ et \\[\\frac{1}{2}\\]. <img src=x onerror=alert(1)>'} />);
    expect(container.querySelectorAll('.katex')).toHaveLength(4);
    expect(container.querySelectorAll('.katex-display')).toHaveLength(2);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('ne transforme pas des commandes non fiables en liens ou images', () => {
    const { container } = render(<RevisionText text={'$\\href{javascript:alert(1)}{x}$ et $\\includegraphics{https://example.com/tracker}$'} />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('garde les délimiteurs incomplets visibles et survit à une formule invalide', () => {
    const { container, rerender } = render(<RevisionText text="$$incomplet" />);
    expect(container.textContent).toBe('$$incomplet');
    rerender(<RevisionText text={'$\\frac{$'} />);
    expect(container.textContent.length).toBeGreaterThan(0);
  });
});
