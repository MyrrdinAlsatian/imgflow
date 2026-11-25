# Architecture

En Phase 0, le seul module applicatif est `src/main.ts`. Il signale le démarrage puis rend la main. Les limites ci-dessous guident l’arrivée des premiers traitements.

| Emplacement cible        | Responsabilité                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/domain/`            | Règles et valeurs métier, indépendantes des fichiers, de la base et des bibliothèques.                                         |
| `src/application/`       | Cas d’utilisation, orchestration et ports dont ils ont besoin. Le moteur exécute les étapes dans l’ordre déclaré.              |
| `src/application/steps/` | Comportement d’une étape et options typées. Un registre associera chaque discriminant YAML validé à sa fabrique.               |
| `src/infrastructure/`    | Accès aux fichiers, décodage et encodage Sharp, surveillance Chokidar, inférence locale et stockage SQLite, au fil des phases. |
| `src/main.ts`            | Composition des adaptateurs et gestion du démarrage et de l’arrêt du processus.                                                |

Une étape appelle un port pour une opération externe. L’adaptateur implémente le port et reçoit ses paramètres à la construction. Cette direction permet de tester le moteur avec un double d’inférence. Les [règles métier](domain.md) fixent les conditions de réussite indépendamment de l’adaptateur.

## Cycle de vie cible sur disque

| Répertoire         | Rôle                                                           |
| ------------------ | -------------------------------------------------------------- |
| `/data/input`      | Dépôts des producteurs, répartis par dossier surveillé.        |
| `/data/processing` | Original pris en charge et travail en cours identifié par job. |
| `/data/output`     | Variantes destinées aux consommateurs.                         |
| `/data/archive`    | Originaux des traitements réussis.                             |
| `/data/failed`     | Originaux en échec et informations de diagnostic.              |
| `/data/state`      | État durable et historique SQLite à partir de la Phase 5.      |
| `/models`          | Poids et fichiers de prétraitement disponibles localement.     |

1. Découvrir les candidats au démarrage et lors des événements. Lorsque le producteur le permet, convenir d’un nom temporaire ignoré, suivi d’un renommage final sur le même volume. Pour une copie directe, observer la stabilité sur plusieurs relevés. Un producteur en pause peut donner les mêmes observations qu’une copie terminée.
2. Réserver un identifiant de job et prendre possession du fichier avant tout traitement. Éviter l’écrasement lors d’une collision. Valider la nature du fichier, sa taille et son décodage. Une image invalide suit le parcours d’échec.
3. Préparer les variantes dans un espace temporaire du volume de sortie. Vérifier l’ensemble puis publier un répertoire de job par renommage sur ce volume. Les consommateurs lisent uniquement les emplacements publiés.
4. Archiver l’original après publication. Pour un transfert entre volumes, copier sous un nom temporaire, vérifier la copie complète, la rendre durable et la publier avant de retirer la source. Conserver la source dès qu’une étape échoue. Au redémarrage, un identifiant commun permettra de réconcilier les copies et une publication déjà effectuée.

La Phase 2 introduira la prise de possession et l’arrêt propre. La Phase 5 ajoutera les tentatives persistées et la réconciliation des fichiers avec SQLite. Un renommage et une transaction SQLite sont deux opérations distinctes. La reprise doit pouvoir vérifier laquelle a abouti.
