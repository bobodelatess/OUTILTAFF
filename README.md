# CADENCE

Outil d'étude **spécialisé** qui répond à une seule question :

> « Parmi mes unités académiques, lesquelles dois-je travailler ou retester
> aujourd'hui, compte tenu de mon niveau constaté, des examens et du temps
> réellement disponible ? »

Répétition espacée au niveau **chapitre** (maths / physique), pilotée par les
examens et bornée par la capacité réelle du jour. PWA 100 % locale : aucun
backend, aucune authentification, données sur l'appareil (export/import JSON).

CADENCE n'est volontairement **pas** : un emploi du temps, un gestionnaire
d'habitudes ou de tâches, une prise de notes, un clone d'Anki, un Pomodoro.

## Idée centrale

```
priorité = urgence_de_péremption × pression_d'examen
```

La pression d'examen **multiplie** (elle n'additionne pas) : un chapitre
fragile dont l'épreuve approche explose, un chapitre solide monte peu. La
décomposition est toujours affichée — jamais de boîte noire.

## Le modèle de rappel (honnêteté)

CADENCE utilise un **modèle de rappel inspiré des équations FSRS‑4.5, appliqué
au niveau chapitre** (stabilité + difficulté par chapitre, courbe d'oubli en
loi de puissance, poids par défaut publiés — **non personnalisés**).

Ce que le modèle fournit est une **estimation de rappel** (« rappel estimé »),
pas une probabilité de réussir un examen : réussir une épreuve dépend aussi du
transfert, de la rédaction, du temps, du barème. L'interface le rappelle
partout où un pourcentage apparaît, et sépare systématiquement les chapitres
**testés** (moyenne calculée) des chapitres **jamais testés** (catégorie
prioritaire, jamais fondue dans une moyenne).

## Des évaluations académiquement valides

Noter un chapitre = enregistrer le **résultat d'un test sans correction sous
les yeux** — pas le temps passé, pas l'impression d'avoir compris. Avant de
noter, on choisit le **type de preuve** :

| Preuve | Échec → Réussite |
| --- | --- |
| Rappel sans support | Oublié · Avec effort · Correct · Immédiat |
| Exercice standard | Bloqué · Avec aide · Autonome · Autonome et propre |
| Problème / annale | Bloqué · Partiel · Résolu · Résolu proprement dans le temps |

Chaque note est journalisée avec son `evidenceType` (les anciennes révisions
migrées portent `legacy`) — ce qui permettra plus tard de distinguer rappel,
exercice et transfert dans le modèle.

## Niveaux initiaux réellement différenciés

Un chapitre jamais testé est calibré par un niveau nommé, qui fixe son urgence
initiale : **Jamais vu 2.2 · Fragile 1.6 · Moyen 1.0 · Solide 0.5**. Un
chapitre « Solide » jamais testé n'encombre pas le plan du jour ; un « Jamais
vu » y entre immédiatement. Recalibrer un chapitre (avec confirmation) le fait
repartir du niveau choisi : date de test effacée, historique **archivé** —
jamais d'état contradictoire.

## Capacité réelle & plan en minutes

- **Temps disponible aujourd'hui** réglable sur l'accueil (0 h · 2 h · 4 h ·
  6 h · personnalisé par pas de 30 min), stocké par date (`capacityOverrides`).
  À 0 h : pas de faux plan, pas de faux retard, classement consultable.
- Chaque chapitre porte une **taille estimée** (15/30/60/90 min). Le plan
  remplit la capacité **en minutes** (jamais de dépassement) et affiche le
  temps par séance, le nombre d'unités et le total.
- Les matières sont classées par un **score robuste** (priorité max + moyenne
  du top 3) : saucissonner une matière en petits chapitres ne lui donne aucun
  avantage.

## Importance des épreuves

Chaque épreuve est **Mineure / Normale / Majeure**. L'importance module la
pression d'examen sans l'exploser :

```
mult = 1 + (mult_base − 1) × w      w ∈ {0.6, 1.0, 1.4}
```

Borne : `mult ≤ 1 + (maxExamPressure − 1) × 1.4` (≤ 6.6 par défaut). À date et
couverture identiques : majeure > normale > mineure (testé).

## Les cinq vues

1. **Aujourd'hui** — capacité du jour, plan par séances (minutes réelles),
   type de preuve, notation 4 issues adaptées, annulation, reporter, clavier
   (Tab puis 1–4), minimums hebdo *à protéger si possible*.
2. **Calendrier** — épreuves (avec importance), rappel estimé le jour J *sans
   nouvelle révision* (testés seulement, non-testés signalés à part),
   prévision de charge.
3. **Matières** — UE, chapitres (niveau, taille, prochain test), épreuves
   (date, importance, chapitres couverts).
4. **Progrès** — rappel moyen estimé **sur les chapitres testés**, couverture
   `X/Y testés`, non-testés, rétention observée vs cible, histogramme,
   répartition des notes.
5. **Réglages** — capacité par défaut, rétention cible (avec charge de
   croisière calculée sur tes chapitres), mode simple/détaillé ; paramètres du
   modèle repliés dans une section **experte** (les déplacer ne « calibre »
   rien) ; export/import validé ; **instantanés locaux** quotidiens (7 j,
   même appareil — la seule sauvegarde externe est l'export JSON).

## Données & fiabilité

- Une seule clé de stockage (`cadence.v2`), **schéma v3 versionné** ; les
  données v1/v2 sont migrées automatiquement, sans perte (matières, chapitres,
  examens, réglages, historique, reports, instantanés).
- Import JSON **validé strictement** (message d'erreur clair, confirmation
  avant écrasement). Rappel discret d'export si aucun export récent.
- Repli en mémoire si le stockage est indisponible. Hors-ligne via service
  worker ; installable (« Ajouter à l'écran d'accueil »).

## Lancer

```bash
npm install
npm run dev      # serveur de dev Vite
npm run build    # build de production -> dist/
npm test         # tests du moteur (45+) : modèle, plan, migrations, imports
```

## Architecture

- `src/engine.js` — **fonctions pures** : modèle de rappel, priorité, plan en
  minutes, préparation d'examen, migrations v1→v2→v3, validation d'import,
  recalibrage. Testé directement.
- `src/Cadence.jsx` — interface React (un composant par vue) + persistance.
- Déploiement continu GitHub Pages (`.github/workflows/deploy.yml`).

Défauts : `requestRetention=0.90`, `subjectsPerDay=3`, `sessionHours=2`,
chapitre = 30 min, `maxExamPressure=5`, `pressureHorizon=35`,
`examModeThreshold=21`.
