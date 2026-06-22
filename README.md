# CADENCE

Planificateur d'étude **piloté par les examens** — répétition espacée au niveau
**chapitre** (et non carte), avec une couche examens + calendrier + interleaving.
Outil quotidien privé, pensé pour un usage du soir : ~2 min pour cocher ce qui a
été fait, ~15 min le dimanche.

> Coût d'usage cible bas, par construction. Tout vit côté client, aucune
> dépendance backend.

## Idée centrale

La priorité d'un chapitre combine deux signaux, et la pression d'examen
**multiplie** au lieu d'additionner :

```
priorité = urgence_de_péremption × pression_d'examen
```

Conséquence voulue : un chapitre **faible dont l'examen approche** explose ; un
chapitre **déjà solide** ne monte qu'un peu. La priorité est toujours affichée de
façon transparente (`valeur = urgence × multiplicateur`, plus quelle épreuve la
déclenche et dans combien de jours) — jamais de boîte noire.

## Les quatre vues

1. **Aujourd'hui** — file interleavée du jour (rotation des matières), action
   recommandée + livrable concret par bloc, lecteur de priorité transparent,
   bouton « J'ai travaillé », bannières mode annales, bande des planchers
   hebdomadaires (minimums protégés).
2. **Calendrier** — grille mensuelle, épreuves en marqueurs couleur, fenêtres
   mode annales ombrées, liste des épreuves à venir.
3. **Matières** — CRUD des UE, chapitres (curseur de maîtrise) et épreuves
   (date + sélection des chapitres couverts).
4. **Réglages** — six curseurs avec aperçu live de la courbe du multiplicateur
   d'examen ; export / import JSON ; réinitialisation.

## Lancer

```bash
npm install
npm run dev      # serveur de dev Vite
npm run build    # build de production -> dist/
npm test         # tests d'acceptation du moteur de priorité
```

## Architecture

- **Un seul fichier** pour l'application : `src/Cadence.jsx` (composant
  fonctionnel + hooks, export par défaut, sans props requises). Le moteur de
  priorité y est exposé en exports nommés (fonctions pures) afin d'être testé.
- **Persistance** : tout l'état dans une seule clé (`cadence.v1`).
  `window.storage` si présent (environnement d'artefact), sinon `localStorage`,
  sinon repli **en mémoire** — l'app fonctionne même sans stockage.
- `src/Cadence.test.js` vérifie les formules et l'ordre clé du barème ;
  `src/Cadence.smoke.test.jsx` vérifie le montage du composant.

## Moteur de priorité (résumé)

| Étape | Formule |
| --- | --- |
| Intervalle cible | `minInterval × (maxInterval / minInterval)^(m/100)` |
| Urgence | `joursDepuis / targetInterval(m)` (jamais révisé ⇒ `targetInterval × 2.2`) |
| Multiplicateur d'examen | `1 + (maxExamPressure − 1) × ((horizon − j)/horizon)²` |
| Facteur d'examen | max du multiplicateur sur les épreuves futures couvrant le chapitre |
| Priorité | `urgence × facteur` |

Réglages par défaut : `minInterval=2`, `maxInterval=30`, `maxExamPressure=5`,
`pressureHorizon=35`, `examModeThreshold=21`, `blocksPerDay=5`.
