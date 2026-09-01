# CADENCE

CADENCE relie le travail quotidien aux documents cumulatifs, puis fait
réapparaître au bon moment les portions déjà étudiées. Il ne décide pas du
nouveau contenu à travailler et ne fabrique pas de planning journalier.

L'accueil répond à trois besoins seulement :

1. **Continuité quotidienne** — retrouver, pour chaque matière, le chapitre
   courant, le dernier point de reprise et ses liens Drive ;
2. **Consolidations dues** — revoir rapidement les portions antérieures selon
   leur propre courbe d'oubli ;
3. **Rappels de tests de cours** — indiquer seulement quand refaire un test sur
   le même périmètre ; l'utilisateur crée et corrige lui-même les questions,
   puis saisit sa note sur 20.

CADENCE est une PWA locale : aucun compte ni serveur CADENCE. Les données
restent dans le navigateur, avec export/import JSON. La
[synchronisation optionnelle](#synchronisation-entre-appareils) utilise un
coffre privé appartenant au compte GitHub de l'utilisateur.

## Modèle de suivi (schéma v11)

Le **chapitre** est un repère stable : il organise le cours et porte les liens
vers les documents cumulatifs. Une **portion quotidienne** est une unité de
rappel interne rattachée à ce chapitre.

Un chapitre de cours porte un statut explicite : **En cours**, **En
consolidation** ou **Terminé**. Une matière n'a au plus qu'un chapitre en
cours ; modifier un ancien chapitre ne détourne donc plus la continuité de
l'accueil.

Le format suivant crée ou met à jour la portion du jour :

```text
Ajout du jj/mm/aaaa — notion ou section précise
```

Le comportement est volontairement asymétrique :

- le jour de l'ajout, aucune maîtrise n'est demandée ou affichée ;
- le lendemain, la portion apparaît une première fois dans les
  consolidations pour environ 17 minutes ;
- après une restitution brève sans document, l'utilisateur choisit l'un des
  cinq niveaux : **Oublié**, **Très fragile**, **Fragile**, **Maîtrisé** ou
  **Très solide** ;
- cette réponse est enregistrée dans le journal et déclenche la prochaine
  date selon la courbe d'oubli ;
- les rappels espacés suivants durent environ 7 minutes ; un oubli ou un état
  très fragile rouvre un bloc de récupération de 17 minutes ;
- après deux restitutions satisfaisantes successives, la portion est intégrée
  au chapitre : elle ne revient plus isolément et le test cumulatif prend le
  relais ;
- chaque portion avance indépendamment : ajouter du contenu au même chapitre
  ne remet pas artificiellement tout le chapitre à zéro.

Une correction du libellé le même jour met à jour la même portion, sans
dupliquer ni perdre son historique. Un point libre comme `p. 47`, `unité 5`
ou `exercice 12` reste un simple signet et ne crée aucune fausse révision.

Lors d'une migration v7 → v8, CADENCE peut reconstruire honnêtement la dernière
portion si le point existant respecte le format `Ajout du …`. Il n'invente pas
les portions plus anciennes que l'ancien schéma ne connaissait pas.
La migration v8 → v9 ajoute seulement les périmètres et rappels de tests. La
migration v9 → v10 choisit comme chapitre courant le dernier chapitre de cours
réellement mis à jour, sans intégrer rétroactivement les anciennes portions et
sans inventer de résultat.
La migration v10 → v11 ajoute les objectifs de checklist et des journaux vides :
aucun exercice, aucune annale et aucun test n'est déclaré accompli.

## Auto-évaluation et courbe d'oubli

Les cinq catégories visibles sont des décisions de reprise, pas des notes
académiques :

| Catégorie | Sens |
| --- | --- |
| **Oublié** | l'essentiel n'a pas été retrouvé |
| **Très fragile** | quelques bribes ; support indispensable |
| **Fragile** | ensemble retrouvé avec hésitation ou une aide |
| **Maîtrisé** | restitution correcte et autonome sans support |
| **Très solide** | restitution fluide, précise et justifiée sans support |

**Très solide** est volontairement indisponible lors de la première
consolidation. Une réussite immédiate ne suffit pas à justifier l'intervalle le
plus long.

La première échéance est toujours le lendemain de l'ajout. Ensuite, le rappel
utilise les équations FSRS-4.5 avec leurs poids publiés par défaut et un seuil
de rappel réglable. Il s'agit d'une estimation de mémoire, jamais d'une
probabilité de réussir un examen.

La trace est conservée à chaque reprise (`source: self-review`) et se
synchronise comme le reste du journal. L'accueil n'affiche pas une jauge de
maîtrise permanente : la catégorie n'est demandée que lorsqu'une consolidation
est réellement due.

## Épreuves, pression et temps quotidien

Une épreuve peut couvrir des chapitres entiers ou seulement des sections
quotidiennes datées. La pression n'agit que sur ce périmètre : elle rapproche
les consolidations et les rappels de tests concernés, puis module
temporairement la répartition du temps entre matières.

Chaque matière suivie porte une durée normale (120 min par défaut) et un
minimum protégé (60 min par défaut). Le total normal quotidien reste fixe ; la
part flexible va provisoirement vers les matières sous pression. Après
l'épreuve, toutes les durées reviennent automatiquement à leur valeur normale.

Cette durée est une enveloppe totale. L'accueil en déduit les consolidations
dues et la durée indicative d'un éventuel rappel de test, puis affiche seulement
le temps encore disponible pour le nouveau travail. Il ne choisit jamais ce
nouveau travail. En cas de surcharge, aucun élément n'est compté comme réalisé :
les rappels non faits restent dus.

## Tests de cours, annales et épreuves

Un test de cours est un simple rappel stable et récurrent, ciblé sur des
chapitres ou sections. **L'utilisateur compose et corrige toujours lui-même le
test.** CADENCE et le LLM ne génèrent ni énoncé, ni question, ni barème, ni
correction. CADENCE conserve seulement le périmètre, une durée indicative, la
prochaine date et la note sur 20, après confirmation que le test a été réalisé
sans cours, corrigé ni aide.

La prochaine date suit les seuils suivants :

| Note | Prochaine date de base |
| --- | --- |
| 0–9/20 | J+1 |
| 10–13/20 | J+2 |
| 14–15/20 | J+4 |
| 16–17/20 | J+7 |
| 18–20/20 | J+14 |

Deux résultats excellents successifs sur le même périmètre l'écartent à J+30,
puis à J+60 après une nouvelle réussite. Une modification du périmètre remet
cette série à zéro. Une épreuve couvrant réellement le même périmètre peut
resserrer l'intervalle. Le résultat ne modifie jamais l'auto-évaluation des
portions.

À partir de trois nouvelles sections non couvertes d'un même chapitre (ou d'au
moins deux sections dont la plus ancienne date de trois jours), CADENCE propose
d'étendre le rappel existant du chapitre. Il ne propose une nouvelle fiche que
si aucun rappel adapté n'existe. Cette suggestion ne crée aucun contenu et
n'enregistre aucun faux résultat. L'accueil montre au plus un rappel de test
par matière et par jour ; les autres restent dus.

Les annales restent séparées de l'auto-évaluation des portions. Elles utilisent
quatre résultats objectifs : **Bloqué**, **Partiel**, **Résolu** et **Résolu
proprement dans le temps**.

Pendant trois jours après une épreuve, l'accueil permet aussi d'enregistrer le
résultat réellement constaté, chapitre par chapitre. Ce constat alimente
uniquement l'axe problème/annale ; il ne modifie ni les portions de rappel ni
les exercices.

CADENCE n'invente jamais une note, une maîtrise ou une révision. Les résultats
ne sont enregistrés qu'après une action explicite de l'utilisateur.

## Checklist de production et entretien

La vue **Checklist** sépare deux choses qui ne doivent pas être confondues avec
la maîtrise :

- des compteurs ajustables par matière : cinq exercices terminés par jour et
  deux annales complètes par semaine par défaut ;
- un objectif de trois tests de connaissances par semaine, calculé uniquement
  à partir des tests réellement enregistrés avec une note sur 20. Il n'existe
  aucun bouton permettant de remplir artificiellement ce compteur ;
- une rotation d'entretien configurable : poly de Fermat, exercices de
  concours, exercices originaux créés avec ChatGPT, livres précis,
  démonstrations, exercices de tête et quiz.

Une routine d'entretien porte une fréquence et une dernière réalisation. Elle
redevient due automatiquement : elle n'est jamais cochée définitivement. Les
éléments proposés ne sont pas activés partout par défaut, car une source peut
être pertinente en mathématiques et absurde dans une autre matière. Pour les
livres, une routine distincte par ouvrage donne un suivi vérifiable.

Les compteurs et routines ne modifient ni FSRS, ni les niveaux de maîtrise, ni
les axes exercice/annale. Ils attestent seulement une quantité explicitement
saisie par l'utilisateur.

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

CADENCE comporte cinq vues :

1. **Aujourd'hui** — continuité par matière, éventuel rééquilibrage temporaire,
   enveloppe restante, consolidations dues, auto-évaluation à cinq niveaux,
   rappels de tests et bilans ;
2. **Calendrier** — consolidations, rappels de tests et épreuves à venir ;
3. **Checklist** — production quantitative réelle et rotation d'entretien par
   matière ;
4. **Matières** — chapitres stables, ressources, points de reprise, documents
   et épreuves ;
5. **Réglages** — seuil de rappel, paramètres avancés repliés,
   synchronisation, sauvegarde et import/export.

La recherche de chapitres reste accessible depuis l'en-tête (`Ctrl/Cmd+K` ou
`/`) et ignore les accents.

Les anciennes notions de classement automatique, plan de contenu et écran de
progrès global ne sont plus dans le parcours actif. CADENCE ne décide jamais
du nouveau contenu. Il soustrait seulement l'entretien réellement dû de
l'enveloppe quotidienne, avec un rééquilibrage temporaire et à total fixe avant
les épreuves renseignées.

Une portion compte environ dix-sept minutes lors de la consolidation du
lendemain, puis sept minutes lors des rappels espacés. Ces durées sont des
repères de charge, pas une nouvelle séance de cours.

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

- Clé locale stable `cadence.v2`, schéma interne versionné v11.
- Migration automatique des schémas v1 à v11 ; toute version future inconnue
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
- Une auto-catégorisation reste une déclaration utilisateur ; seuls un test de
  cours noté, une annale ou une épreuve fournissent un résultat objectif.
- Aucun indicateur n'est une prédiction de réussite à l'examen.
- CADENCE ne stocke pas les PDF, ne rédige pas les notes et ne remplace pas un
  agenda, Anki ou un gestionnaire de tâches.
- Le prompt quotidien de référence se trouve dans
  [`PROMPT_RECAP_QUOTIDIEN.md`](PROMPT_RECAP_QUOTIDIEN.md).

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
