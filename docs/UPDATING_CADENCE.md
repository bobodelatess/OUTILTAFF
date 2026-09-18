# Publier un récapitulatif quotidien

Le site est hébergé sur GitHub Pages. Son propriétaire a autorisé la lecture
publique du suivi ; l'écriture du coffre reste protégée par GitHub. Ne jamais
demander un jeton dans une conversation ni le placer dans un fichier du dépôt.

1. Lire la configuration de `src/sharedUpdates.js`, puis le fichier
   `cadence-sync.json` du gist indiqué. Vérifier son propriétaire et valider le
   JSON avec `validateImport`. Lire aussi `public/study-updates.json` : des ajouts
   déjà publiés peuvent ne pas encore avoir été enregistrés par un appareil.
2. Appliquer les ajouts déjà publiés en mémoire avec `applyStudyUpdates` pour
   retrouver les vrais identifiants des matières et chapitres. Ne jamais
   reconstruire le suivi depuis un état vierge ni inventer une activité passée.
3. Compléter les documents Drive, conserver leurs identifiants et vérifier leurs
   liens, conformément au prompt de l'utilisateur.
4. Ajouter au tableau `updates` du flux un objet par chapitre et date étudiés :
   `id` stable, `date` ISO, `subjectId`, `chapterId`, `chapterName`, `label` au
   format `Ajout du jj/mm/aaaa — notion`, et `docs` contenant des objets
   `{ id, label, url }`. Réutiliser les identifiants existants. Un chapitre créé
   reçoit un identifiant stable ; sa portion utilise `reviewUnitId(chapterId, date)`.
5. Chaque entrée publiée est immuable. Une correction reçoit un nouvel `id`
   (par exemple suffixe `v2`) en gardant le même `chapterId` et la même `date` :
   elle corrige la portion existante sans perdre son historique ni créer un
   second rappel. Les reçus `appliedStudyUpdates` empêchent de rejouer l'entrée.
6. Vérifier le nouvel état avec `validateImport` et le rappel à J+1 avec
   `reviewUnitInfo`. Les résultats, journaux, réglages et suppressions existants
   doivent rester intacts. Les ajouts anciens ne doivent pas remplacer un
   point de reprise plus récent.
7. Publier le flux via la connexion GitHub autorisée, sans forcer une branche.
   Attendre le déploiement Pages et vérifier le site en consultation. Ne pas
   prétendre avoir écrit le gist : l'enregistrement effectif est effectué par
   un appareil déjà autorisé, lorsqu'il ouvre le site ou se synchronise.

Le flux est cumulatif. Ne pas enlever une ancienne entrée pour corriger une
erreur : un appareil peut déjà l'avoir appliquée. Le flux sert aux ajouts de
travail et à leurs liens ; aucune entrée ne contient de maîtrise, de note ou
de validation fictive. Les sections détaillées du cours restent dans Drive.
