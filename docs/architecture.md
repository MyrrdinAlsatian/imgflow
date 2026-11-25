# Architecture

## Parcours de conversion en Phase 1

1. Le point d’entrée lit les chemins et les options de la commande `process`, puis injecte l’adaptateur Sharp. [Point d’entrée](../src/main.ts)
2. Le cas d’utilisation vérifie les bornes numériques avant tout accès à l’image. Le port `WebpConverter` reçoit la requête et renvoie les dimensions réelles du WebP publié. Pour tester cette validation isolément, on peut injecter une fonction sans accès au disque. [Contrat de conversion](../src/application/process-image.ts)
3. L’adaptateur lit les en-têtes pour vérifier le format et le nombre d’images. L’encodage déclenche le décodage des pixels, qui peut encore échouer si l’image est tronquée. Après orientation EXIF, le redimensionnement respecte les deux bornes et peut produire une image plus petite que chacune d’elles. [Adaptateur Sharp](../src/infrastructure/sharp-webp.ts)
4. Le WebP est encodé dans un dossier temporaire sur le volume de sortie, puis publié sous son nom final. Le dossier temporaire est retiré à la fin du traitement. Une interruption brutale peut le laisser sur disque. [Décision de publication](adr/0003-webp-conversion.md)

## Dossier surveillé en Phase 2

Chokidar signale les dépôts existants et nouveaux dans `input/`. L’adaptateur compare deux observations de l’identité, de la taille et des dates du fichier avant son admission. Il revérifie ces données au moment de la prise en charge. P-Queue limite le traitement à un job à la fois, tandis que Pino journalise ses transitions et les emplacements des fichiers.

Le cas d’utilisation `processWatchJob` réutilise le port WebP. Le port de stockage publie un dossier par job et archive l’original, ou le conserve dans `failed/` avec un diagnostic. Un échec d’archivage après publication conserve l’original pour inspection. [Prise en charge et transfert](adr/0004-watch-folder.md)

## Détourage local en Phase 3

Le point d’entrée compose le convertisseur Sharp avec le port `BackgroundRemover` quand le détourage est demandé. Sharp oriente et redimensionne l’image, puis transmet une vue RGB de 1024 pixels au plus sur le côté long. Le port retourne un octet d’opacité par pixel de cette vue. Sharp remet le masque aux dimensions du WebP et multiplie ses valeurs par l’alpha de l’original.

L’adaptateur BEN2 charge une session CPU depuis le cache local et la libère à la fin de la commande. Une erreur du modèle suit le traitement d’erreur habituel. Dans un dossier surveillé, l’original et le diagnostic sont conservés dans `failed/`. [Export retenu et fonctionnement hors ligne](adr/0005-local-ben2.md)

## Pipelines déclaratives en Phase 4

Le chargeur YAML interprète une union discriminée d’étapes avec Valibot et vérifie les chemins avant de lancer les dossiers surveillés. Les types de pipeline sont indépendants des bibliothèques. L’adaptateur Sharp associe chaque transformation à une fonction dans un registre typé. Il termine chaque opération avant d’entamer la suivante pour respecter l’ordre du YAML.

Les dossiers partagent une file d’attente. Le port de stockage reçoit toutes les variantes à publier. Il renomme le répertoire temporaire seulement quand l’encodage du lot complet a réussi. [Décision d’architecture](adr/0006-declarative-pipelines.md)

## Responsabilités

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

La Phase 5 ajoutera les tentatives persistées et la réconciliation des fichiers avec SQLite. Un renommage et une transaction SQLite sont deux opérations distinctes. La reprise doit pouvoir vérifier laquelle a abouti.
