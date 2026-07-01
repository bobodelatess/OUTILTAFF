# CADENCE

Planificateur d'étude **piloté par les examens** — répétition espacée au niveau
**chapitre** (et non carte), moteur **FSRS‑4.5**, plan du jour borné par ta
capacité, calendrier avec prévision de charge et statistiques. Outil quotidien
privé : ~2 min le soir pour noter ce qui a été revu.

> 100 % côté client, aucune dépendance backend. Données locales (localStorage),
> export / import JSON.

## Idée centrale

La priorité d'un chapitre combine deux signaux, et la pression d'examen
**multiplie** au lieu d'additionner :

```
priorité = urgence_de_péremption × pression_d'examen
```

Un chapitre **fragile dont l'examen approche** explose ; un chapitre **déjà
solide** ne monte qu'un peu. La décomposition est toujours affichée
(`urgence × multiplicateur`, l'épreuve qui la déclenche, J−x) — jamais de
boîte noire.

## Le moteur (FSRS‑4.5)

Chaque chapitre porte un état mémoire **(stabilité S, difficulté D)** mis à
jour par l'algorithme **FSRS‑4.5** (poids par défaut publiés, 17 paramètres) à
chaque révision notée **Oublié · Difficile · Bien · Facile** :

- **Courbe d'oubli en loi de puissance** `R(t) = (1 + F·t/S)^−0.5`, calée pour
  `R(S) = 90 %` (Wixted ; FSRS).
- **Succès** : `S' = S·(1 + e^{w8}·(11−D)·S^{−w9}·(e^{w10(1−R)}−1)·pénalité/bonus)` —
  intervalles expansifs, gain maximal près du seuil d'oubli (effet
  d'espacement, Cepeda/Bjork), modulé par la difficulté.
- **Oubli** : la stabilité **chute** (`w11·D^{−w12}·((S+1)^{w13}−1)·e^{w14(1−R)}`,
  plafonnée à S) et la difficulté monte.
- **Rétention cible** réglable (80–97 %) : on planifie la révision quand `R` y
  retombe.
- Chapitre sans historique : niveau nommé (« Jamais vu → Solide ») qui seed
  S et D ; ensuite les notes pilotent tout.
- **Journal des révisions** : chaque note est archivée (annulable), alimente
  les statistiques et la stabilité du plan du jour.

## Capacité & plan du jour

`subjectsPerDay` matières par jour (3 par défaut), chacune en séance de
`sessionHours` h (2 h) : les matières les plus sous pression d'abord, les autres
remontent naturellement les jours suivants. Le plan du jour est **stable** :
noter un chapitre ne réorganise pas la liste (il passe simplement à « fait »,
annulable).

## Les cinq vues

1. **Aujourd'hui** — anneau de progression, séances par matière, cartes avec
   **jauge mémoire** (R %), raison en clair, notation à 4 boutons, annulation
   (toast), détails repliables, minimums hebdo protégés.
2. **Calendrier** — épreuves, fenêtres « examen proche » ombrées, **prévision
   de charge** (chapitres à échéance par jour, dans la grille et sur 14 j).
3. **Matières** — CRUD des UE, chapitres (niveau nommé, jauge, prochaine
   échéance) et épreuves (date + chapitres couverts).
4. **Progrès** — série de jours, total de révisions, mémoire moyenne,
   chapitres à jour, histogramme 30 j, répartition des notes.
5. **Réglages** — rétention cible, capacité, pression d'examen, avancé
   (stabilités initiales), aperçus live (courbe d'oubli + multiplicateur),
   export / import / réinitialisation.

## Lancer

```bash
npm install
npm run dev      # serveur de dev Vite
npm run build    # build de production -> dist/
npm test         # tests du moteur (FSRS, priorité, plan, prévision, migration)
```

## Architecture

- **Un seul fichier** : `src/Cadence.jsx` (composant + moteur en exports nommés
  purs, testés).
- **Persistance** : clé `cadence.v2` (localStorage → repli mémoire), migration
  automatique depuis `cadence.v1` (maîtrise → difficulté).
- Déploiement continu sur GitHub Pages (workflow `deploy.yml`).

Réglages par défaut : `requestRetention=0.90`, `subjectsPerDay=3`,
`sessionHours=2`, `minutesPerChapter=30`, `maxExamPressure=5`,
`pressureHorizon=35`, `examModeThreshold=21`.
