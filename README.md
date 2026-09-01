# CADENCE

CADENCE relie le travail quotidien aux documents cumulatifs, puis fait
réapparaître au bon moment les portions déjà étudiées. Il ne décide pas du
nouveau contenu à travailler et ne fabrique pas de planning journalier.

L'accueil répond à deux besoins seulement :

1. **Continuité quotidienne** — retrouver, pour chaque matière, le chapitre
   courant, le dernier point de reprise et ses liens Drive ;
2. **Consolidations dues** — revoir rapidement les portions antérieures selon
   leur propre courbe d'oubli.

CADENCE est une PWA locale : aucun compte ni serveur CADENCE. Les données
restent dans le navigateur, avec export/import JSON. La
[synchronisation optionnelle](#synchronisation-entre-appareils) utilise un
coffre privé appartenant au compte GitHub de l'utilisateur.

## Modèle de suivi (schéma v8)

Le **chapitre** est un repère stable : il organise le cours et porte les liens
vers les documents cumulatifs. Une **portion quotidienne** est une unité de
rappel interne rattachée à ce chapitre.

Le format suivant crée ou met à jour la portion du jour :

```text
Ajout du jj/mm/aaaa — notion ou section précise
```

Le comportement est volontairement asymétrique :

- le jour de l'ajout, aucune maîtrise n'est demandée ou affichée ;
- le lendemain, la portion apparaît une première fois dans les
  consolidations ;
- après une restitution brève sans document, l'utilisateur choisit
  **À revoir**, **Fragile** ou **Maîtrisé** ;
- cette réponse est enregistrée dans le journal et déclenche la prochaine
  date selon la courbe d'oubli ;
- chaque portion avance indépendamment : ajouter du contenu au même chapitre
  ne remet pas artificiellement tout le chapitre à zéro.

Une correction du libellé le même jour met à jour la même portion, sans
dupliquer ni perdre son historique. Un point libre comme `p. 47`, `unité 5`
ou `exercice 12` reste un simple signet et ne crée aucune fausse révision.

Lors d'une migration v7 → v8, CADENCE peut reconstruire honnêtement la dernière
portion si le point existant respecte le format `Ajout du …`. Il n'invente pas
les portions plus anciennes que l'ancien schéma ne connaissait pas.

## Auto-évaluation et courbe d'oubli

Les trois catégories visibles sont des décisions de reprise, pas des notes
académiques :

| Catégorie | Sens |
| --- | --- |
| **À revoir** | l'essentiel n'a pas été retrouvé sans le document |
| **Fragile** | restitution hésitante ou avec une aide |
| **Maîtrisé** | restitution correcte sans support |

La première échéance est toujours le lendemain de l'ajout. Ensuite, le rappel
utilise les équations FSRS-4.5 avec leurs poids publiés par défaut et un seuil
de rappel réglable. Il s'agit d'une estimation de mémoire, jamais d'une
probabilité de réussir un examen.

La trace est conservée à chaque reprise (`source: self-review`) et se
synchronise comme le reste du journal. L'accueil n'affiche pas une jauge de
maîtrise permanente : la catégorie n'est demandée que lorsqu'une consolidation
est réellement due.

## Annales et épreuves

Les annales restent séparées de l'auto-évaluation des portions. Elles utilisent
quatre résultats objectifs : **Bloqué**, **Partiel**, **Résolu** et **Résolu
proprement dans le temps**.

Pendant trois jours après une épreuve, l'accueil permet aussi d'enregistrer le
résultat réellement constaté, chapitre par chapitre. Ce constat alimente
uniquement l'axe problème/annale ; il ne modifie ni les portions de rappel ni
les exercices.

CADENCE n'invente jamais une note, une maîtrise ou une révision. Les résultats
ne sont enregistrés qu'après une action explicite de l'utilisateur.

## Chapitres, ressources et documents

Une **ressource** est un support durable qui n'est pas forcément un chapitre :
recueil d'exercices, annales, vocabulaire ou formulaire. Son type de reprise
reste configurable.

Les documents sont des références, jamais des fichiers incorporés. Seuls les
liens HTTP/HTTPS sont acceptés ; `javascript:`, `data:` et les autres schémas
actifs sont refusés à la saisie et à l'import. Les liens s'ouvrent avec
`noopener noreferrer` et sont fusionnés sans perte entre appareils.

Supprimer un chapitre supprime aussi ses portions internes, leur journal actif,
leurs reports et leurs références d'épreuve. Des pierres tombales datées
empêchent leur résurrection lors d'une fusion avec un appareil en retard.

## Interface

CADENCE comporte quatre vues :

1. **Aujourd'hui** — continuité par matière, liens Drive, consolidations dues,
   auto-évaluation à trois niveaux et bilans d'épreuve ;
2. **Calendrier** — échéances de consolidation et épreuves à venir ;
3. **Matières** — chapitres stables, ressources, points de reprise, documents
   et épreuves ;
4. **Réglages** — seuil de rappel, paramètres avancés repliés,
   synchronisation, sauvegarde et import/export.

La recherche de chapitres reste accessible depuis l'en-tête (`Ctrl/Cmd+K` ou
`/`) et ignore les accents.

Les anciennes notions de capacité du jour, classement automatique, plan en
minutes et écran de progrès global ne sont plus dans le parcours actif. Le
temps quotidien appartient à l'utilisateur ; CADENCE ne prescrit que les
consolidations issues de données réellement enregistrées.

Une portion compte environ cinq minutes dans le calendrier et la charge
indicative : c'est un rappel bref, pas une nouvelle séance de cours.

## Synchronisation entre appareils

Téléphone et ordinateur peuvent partager les mêmes données dans un **gist
privé** du compte GitHub de l'utilisateur.

- Le jeton demandé n'a besoin que de la portée `gists`. Il vit dans une clé de
  stockage séparée et n'entre jamais dans l'état exportable.
- Un appareil neuf adopte le coffre existant au lieu d'y mélanger les matières
  d'exemple.
- La synchronisation suit toujours : lire → valider → fusionner → appliquer →
  réécrire.
- Le journal est réuni par identifiant ; deux auto-évaluations effectuées sur
  des appareils différents ne sont pas perdues.
- Les documents sont réunis, les suppressions respectées et les états de
  rappel rejoués depuis le journal fusionné.
- Un coffre illisible, un jeton refusé ou une panne réseau ne remplace jamais
  l'état local.

Le coffre peut être détaché d'un appareil sans supprimer les données locales
ni le gist. Les suppressions sont retenues 180 jours ; un appareil resté
hors-ligne plus longtemps pourrait ressusciter un ancien élément.

## Données et fiabilité

- Clé locale stable `cadence.v2`, schéma interne versionné v8.
- Migration automatique des schémas v1 à v7 ; toute version future inconnue
  est refusée.
- Validation stricte des imports : identifiants, relations, dates ISO, enums,
  notes, bornes numériques, documents et références des portions.
- État illisible mis en quarantaine, avec restauration du dernier instantané
  quotidien valide lorsque possible.
- Écritures relues et vérifiées ; conflit entre onglets détecté avant tout
  écrasement.
- Sept instantanés locaux quotidiens, export par fichier ou presse-papiers,
  import par fichier ou collage.
- Service worker généré au build pour l'utilisation hors ligne.

## Limites assumées

- Les poids FSRS ne sont pas personnalisés à l'utilisateur.
- Une auto-catégorisation reste une déclaration utilisateur ; seule une annale
  ou une épreuve fournit un résultat académique objectif.
- Aucun indicateur n'est une prédiction de réussite à l'examen.
- CADENCE ne stocke pas les PDF, ne rédige pas les notes et ne remplace pas un
  agenda, Anki ou un gestionnaire de tâches.

## Développement

Prérequis : Node.js 22.12+ ou Node.js 24 LTS.

```bash
npm ci
npm run dev
npm test
npm run build
```

Principaux modules :

- `src/engine.js` — modèle de rappel, portions quotidiennes, migrations,
  validation, annales et fonctions pures ;
- `src/Cadence.jsx` — interface, mutations et intégration du stockage ;
- `src/storage.js` — chargement sûr, quarantaine et instantanés ;
- `src/sync.js` — fusion convergente de deux états ;
- `src/remote.js` et `src/useSync.js` — transport et orchestration du coffre
  privé ;
- `src/review-units.test.js` et `src/Cadence.continuity.test.jsx` — invariants
  du nouveau modèle et parcours utilisateur ;
- `src/Cadence.sync.test.jsx` — synchronisation de bout en bout entre deux
  appareils simulés.

La CI GitHub Pages exécute les tests et le build avant déploiement.
