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

## Les trois axes (schéma v4)

Savoir un chapitre, ce sont **trois compétences distinctes** — CADENCE les
suit **séparément**, et une note n'affecte JAMAIS un autre axe :

| Axe | Ce qu'il mesure | Modèle | Durée par défaut |
| --- | --- | --- | --- |
| **Rappel** | restituer le cours de tête | équations FSRS‑4.5 (stabilité/difficulté par chapitre, poids publiés, **non personnalisés**) | 15 min |
| **Exercice** | réussir un exercice type en autonomie | **score heuristique transparent** (résultats observés, tentatives, récence, échecs répétés) | 30 min |
| **Problème / annale** | tenir sur un problème complet, conditions réelles | même heuristique, observée sur les annales | 60 min |

Honnêteté : seul le **rappel** a un modèle de mémoire (une *estimation de
rappel*, pas une probabilité de réussite). Les axes exercice/problème
n'utilisent **pas** de probabilité FSRS — leur « maîtrise observée » est un
score heuristique assumé comme tel :

```
score   = moyenne mobile des résultats (α = 0.5, barème 0 / 0.4 / 0.8 / 1)
risque  = (1 − score) + ancienneté (sature à 21 j, poids 0.4)
        + 0.15 × échecs récents (plafond 3)
jamais testé -> risque 1.2, plafonné par le niveau initial déclaré
```

Toutes les constantes sont **nommées et centralisées** dans `src/engine.js`
(`RISK`, `AXIS_MINUTES`, `PRACTICE_GRADE`, `WORTH_RISK`…) — pas de
coefficient caché.

## Priorité et plan du jour

```
risque_rappel   = temps écoulé / intervalle visé      (urgence mémoire)
risque_exercice = déficit observé + ancienneté + échecs (+ jamais testé)
risque_problème = idem, sur les annales
priorité        = max(risques) × pression_d'examen
```

La pression d'examen **multiplie** (elle n'additionne pas), modulée par
l'importance de l'épreuve (`mult = 1 + (base−1)·w`, w ∈ {0.6, 1.0, 1.4}).
La décomposition est affichée sur chaque carte — jamais de boîte noire.

Chaque carte du plan affiche : le chapitre, sa matière, la **durée prévue**
(celle de l'axe proposé), une **étiquette d'axe** (rappel / exercice /
problème‑annale) et une raison courte (« rappel en retard de 3 j »,
« exercices non testés », « annale importante avant Partiel »). L'axe proposé
= l'axe au risque dominant ; **tu peux en changer sur la carte** au moment de
noter, et noter jusqu'aux trois axes le même jour (une note par axe et par
jour ; re-noter le même axe demande confirmation). CADENCE ne prescrit pas le
contenu de la séance — il propose des chapitres, l'axe le plus utile, et
mesure le résultat.

## Des évaluations académiquement valides

Noter = enregistrer le **résultat d'un test sans correction sous les yeux** —
pas le temps passé, pas l'impression d'avoir compris. Les 4 issues s'adaptent
à l'axe :

| Axe | Échec → Réussite |
| --- | --- |
| Rappel sans support | Oublié · Avec effort · Correct · Immédiat |
| Exercice standard | Bloqué · Avec aide · Autonome · Autonome et propre |
| Problème / annale | Bloqué · Partiel · Résolu · Résolu proprement dans le temps |

Chaque note est journalisée avec son `evidenceType` et des instantanés
avant/après de l'axe concerné (annulation exacte possible). Les anciennes
notes migrées portent `legacy` et comptent côté rappel.

## Niveaux initiaux réellement différenciés

Un chapitre jamais testé est calibré par un niveau nommé : **Jamais vu 2.2 ·
Fragile 1.6 · Moyen 1.0 · Solide 0.5** (risque de rappel initial). Le risque
« pratique non testée » (1.2) est **plafonné par ce niveau** : un chapitre
« Solide » n'encombre pas le plan, un « Jamais vu » y entre immédiatement.
Recalibrer un chapitre (avec confirmation) fait repartir **les trois axes**
du niveau choisi ; l'historique est **archivé**, jamais supprimé.

## Capacité réelle & plan en minutes

- **Temps disponible aujourd'hui** réglable sur l'accueil (0 h · 2 h · 4 h ·
  6 h · personnalisé), stocké par date. À 0 h : pas de faux plan, pas de faux
  retard.
- Chaque chapitre porte **une durée par axe** (modifiable : 15/30/45/60/90/120
  min). Le plan se remplit **en minutes** avec la durée de l'axe proposé — un
  chapitre de 90 min n'entre pas dans une capacité de 60 min, et le total
  n'est jamais dépassé.
- Le retard, la charge de croisière (entretien du rappel) et la prévision du
  calendrier s'affichent **en minutes/heures d'abord**, en nombre de chapitres
  ensuite. L'estimation « jours pour résorber » suppose la capacité par défaut
  (c'est écrit dessus).
- En surcharge, CADENCE propose de **réduire le périmètre ou d'augmenter le
  temps** ; baisser la rétention cible reste possible mais est présenté comme
  un compromis conscient — jamais un conseil automatique.
- Matières classées par un **score robuste** (priorité max + moyenne du top
  3) : saucissonner une matière ne lui donne aucun avantage.

## Indicateurs honnêtes (Progrès)

Trois indicateurs **séparés** — jamais fondus en une « probabilité de
réussite » unique :

1. **Rappel du cours** — rappel moyen estimé sur les chapitres testés, et
   combien n'ont *jamais* été testés ;
2. **Exercices — autonomie** — maîtrise observée moyenne (heuristique) ;
3. **Problèmes/annales — transfert** — idem sur les annales.

Les « non testés » sont toujours une catégorie explicite, jamais dans une
moyenne. La répartition des notes est **séparée par type de preuve**. Pas de
« série de jours » : rien qui pousse à multiplier des tests faciles pour
entretenir un compteur.

## Les cinq vues

1. **Aujourd'hui** — capacité du jour, plan par séances (minutes réelles),
   axe proposé + choix d'axe par carte, notation 4 issues, annulation,
   reporter, clavier (Tab puis 1–4), minimums hebdo *à protéger si possible*.
2. **Calendrier** — épreuves (importance), rappel estimé le jour J *sans
   nouvelle révision* (testés seulement), **couverture des trois axes** par
   épreuve, prévision de charge de rappel **en minutes**.
3. **Matières** — UE, chapitres (niveau, maîtrise observée par axe, durées
   par axe), ajout **en lot** (un par ligne), épreuves (date, importance,
   chapitres couverts).
4. **Progrès** — les trois indicateurs ci-dessus, rétention observée vs cible
   (rappel uniquement), histogramme des tests, répartition par preuve.
5. **Réglages** — capacité par défaut, rétention cible (avec charge
   d'entretien du rappel en min/jour calculée sur tes chapitres), mode
   simple/détaillé, paramètres du modèle repliés en section **experte**,
   export/import validé, instantanés locaux (7 j).

## Données, migration v3 → v4, fiabilité

- Une seule clé de stockage (`cadence.v2`), **schéma v4 versionné** ; les
  données v1/v2/v3 sont migrées automatiquement, y compris par import JSON.
- Migration v3 → v4 **déterministe et non destructive** : le journal est
  intégralement conservé (les notes sans type deviennent `legacy` = rappel).
  L'état de rappel est **reconstruit en rejouant uniquement les événements de
  rappel** depuis le niveau initial (v3 mélangeait tous les types dans un seul
  état FSRS ; le rejeu nettoie cette pollution). Les axes exercice/problème
  sont construits depuis leurs propres événements. Sans événement exploitable,
  l'état v3 est conservé tel quel, marqué `source: 'legacy'` — on n'invente
  pas de précision. Durées : rappel `min(30, ancienne)`, exercice `ancienne`,
  problème `max(60, ancienne)`.
- Import JSON **strictement validé** avant tout remplacement : version
  connue, identifiants présents et uniques, références chapitre→matière et
  épreuve→chapitres valides, dates ISO réelles, notes/scores/durées bornés,
  nombres finis (NaN refusé). En cas d'erreur : **liste lisible des
  problèmes, aucune donnée existante modifiée**.
- Rappel discret d'export si aucun export récent. Repli en mémoire si le
  stockage est indisponible. Hors-ligne via service worker ; installable.

## Limites assumées

- Les poids FSRS sont les valeurs publiées par défaut, **non ajustés** à
  l'utilisateur ; l'« estimation de rappel » n'est pas une garantie.
- Les scores exercice/problème sont des **heuristiques transparentes**, pas
  des modèles validés scientifiquement.
- **Aucun chiffre de CADENCE n'est une prédiction de réussite à un examen** :
  réussir dépend aussi du transfert, de la rédaction, du barème, du jour J.
- Hors périmètre (volontairement) : agenda universel, notes, fichiers,
  Pomodoro, cartes Anki, IA générative.

## Lancer

```bash
npm install
npm run dev      # serveur de dev Vite
npm run build    # build de production -> dist/
npm test         # 87 tests : moteur (FSRS, heuristiques, plan, migrations,
                 # validation d'import) + interactions réelles (RTL + jsdom)
```

## Architecture

- `src/engine.js` — **fonctions pures** : modèle de rappel (axe rappel),
  heuristiques pratiques (axes exercice/problème), `applyEvidence` (un axe à
  la fois), priorité multi-axes, plan en minutes, préparation d'examen,
  migrations v1→v2→v3→v4, validation d'import, recalibrage. Testé directement.
- `src/Cadence.jsx` — interface React (un composant par vue) + persistance.
- `src/Cadence.test.js` — tests du moteur ; `src/Cadence.ui.test.jsx` — tests
  d'interaction (React Testing Library + jsdom) ; `src/Cadence.smoke.test.jsx`
  — rendu SSR.
- Déploiement continu GitHub Pages (`.github/workflows/deploy.yml`).

Défauts : `requestRetention=0.90`, `subjectsPerDay=3`, `sessionHours=2`,
durées par axe 15/30/60 min, `maxExamPressure=5`, `pressureHorizon=35`,
`examModeThreshold=21`.
