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

## Espacement (fondé sur la recherche)

- **Courbe d'oubli en loi de puissance** `R(t) = (1 + FACTOR·t/S)^DECAY`
  (Wixted ; FSRS) — meilleur ajustement que l'exponentielle.
- **Stabilité de mémoire `S`** par chapitre, qui **grandit à chaque révision**
  (intervalles expansifs ; Landauer & Bjork, SM‑2, FSRS).
- **Effet d'espacement** : le gain de stabilité est maximal quand on révise
  **près du seuil d'oubli** (R bas), minimal quand on bachote (Cepeda et al. ;
  Bjork, *desirable difficulties*).
- **Rétention cible** : on planifie la révision quand `R` retombe au niveau visé
  (90 % par défaut) — `intervalle = optimalInterval(S, rétention)`.
- La **maîtrise** (auto‑évaluée) joue le rôle de *facilité* : elle module la
  vitesse de consolidation et fixe la stabilité de départ.

> Avec une rétention de 90 % et sans historique, le modèle se réduit exactement
> à l'ancien (intervalle = `targetInterval(maîtrise)`) — d'où la continuité.

## Capacité (plan du jour)

CADENCE planifie **`subjectsPerDay` matières par jour** (3 par défaut), chacune
sur une **séance de `sessionHours` h** (2 h). Les matières les plus sous pression
passent en premier ; les autres montent d'elles‑mêmes en priorité les jours
suivants. Le nombre de chapitres par séance est estimé via `minutesPerChapter`.

## Les quatre vues

1. **Aujourd'hui** — plan du jour en **séances par matière** (chapitre + raison
   en clair + « J'ai travaillé »), détails repliables (maîtrise, mémoire,
   intervalle), bannières « examen proche », minimums hebdo.
2. **Calendrier** — grille mensuelle, épreuves en marqueurs couleur, fenêtres
   « examen proche » ombrées, liste des épreuves à venir.
3. **Matières** — CRUD des UE, chapitres (curseur de maîtrise) et épreuves
   (date + sélection des chapitres couverts).
4. **Réglages** — curseurs (rétention cible, capacité, intervalles, pression
   d'examen) avec aperçu live de la **courbe d'oubli** et du **multiplicateur
   d'examen** ; export / import JSON ; réinitialisation.

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
| Stabilité de départ | `minInterval × (maxInterval / minInterval)^(m/100)` |
| Courbe d'oubli | `R(t) = (1 + FACTOR·t/S)^DECAY`, calée pour `R(S) = 90 %` |
| Intervalle visé | `optimalInterval(S, rétention)` (= `S` à 90 %) |
| Urgence | `joursDepuis / intervalle` (jamais révisé ⇒ `× 2.2`) |
| Gain de stabilité | `S × (1 + facilité(m) · espacement(R))` à chaque révision |
| Multiplicateur d'examen | `1 + (maxExamPressure − 1) × ((horizon − j)/horizon)²` |
| Priorité | `urgence × facteur d'examen` |

Réglages par défaut : `requestRetention=0.90`, `subjectsPerDay=3`,
`sessionHours=2`, `minutesPerChapter=30`, `minInterval=2`, `maxInterval=30`,
`maxExamPressure=5`, `pressureHorizon=35`, `examModeThreshold=21`.
