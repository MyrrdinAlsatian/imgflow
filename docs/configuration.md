# Configuration YAML

Enregistrer cet exemple dans `pixelflow.yaml`, puis exécuter `node dist/main.js watch --config ./pixelflow.yaml`. Les chemins relatifs partent du répertoire de ce fichier. Les cinq dossiers d’un pipeline et ceux des autres pipelines doivent être disjoints. Le service crée les dossiers manquants après avoir validé toute la configuration.

```yaml
version: 1
settings:
  concurrency: 1
  stabilityMs: 2000
  maxRetries: 3
  scanIntervalSeconds: 60
  logLevel: info
pipelines:
  photos:
    watch: ./data/input/photos
    output: ./data/output/photos
    archive: ./data/archive/photos
    failed: ./data/failed/photos
    steps:
      - type: normalize
      - type: resize
        width: 1200
        height: 800
        fit: inside
      - type: export
        variants:
          - format: webp
          - format: webp
            name: blurred-pixelated
            effects:
              blurSigma: 40
              pixelBlockSize: 32
          - format: webp
            name: thumbnail-256
            resize:
              width: 256
              height: 256
          - format: avif
            quality: 65
          - format: jpeg
            name: preview
            background: "#ffffff"
  icons:
    watch: ./data/input/icons
    output: ./data/output/icons
    archive: ./data/archive/icons
    failed: ./data/failed/icons
    steps:
      - type: trim
        padding: 0.05
      - type: resize
        width: 256
        height: 256
        fit: contain
        background: transparent
      - type: export
        variants:
          - format: png
```

## Exemples pour Docker Compose

| Configuration                                               | Usage                                                                                                                                                           | Fichiers dans `data/output/<id-de-job>/`                                           | Cache BEN2 |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------- |
| [Images web](../docker/pixelflow.yaml)                      | Détourer une image, puis produire des miniatures et une variante floue et pixelisée.                                                                            | `image.webp`, `blurred-pixelated.webp`, `thumbnail-256.webp`, `thumbnail-512.webp` | Requis     |
| [Réseaux sociaux](../docker/examples/social.yaml)           | Recadrer au centre pour remplir un carré de 1080 × 1080 px, puis en tirer une miniature.                                                                        | `social-square.jpg`, `thumbnail-320.webp`                                          | Facultatif |
| [Catalogue produit](../docker/examples/catalog.yaml)        | Détourer le produit, resserrer le cadre autour du sujet, puis le centrer sur un carré de 1200 × 1200 px.                                                        | `product-transparent.png`, `product-white.jpg`, `thumbnail-320.avif`               | Requis     |
| [Galerie photo](../docker/examples/gallery.yaml)            | Conserver le cadrage d’origine pour la vue agrandie (1 920 px max.), la grille (960 px max.) et la miniature (400 px max.).                                     | `lightbox.webp`, `gallery-960.webp`, `thumbnail-400.webp`                          | Non        |
| [Diffusion vidéo](../docker/examples/video-thumbnails.yaml) | Recadrer une image de couverture en 16:9 pour obtenir une affiche de 1 280 × 720 px et des miniatures de 640 × 360 et 320 × 180 px.                             | `poster-1280.jpg`, `thumbnail-640.webp`, `thumbnail-320.webp`                      | Non        |
| [Site de recettes](../docker/examples/recipes.yaml)         | Recadrer la photo du plat en 4:3 pour la fiche recette (1 200 × 900 px) et la carte du sommaire (600 × 450 px).                                                 | `recipe-hero.avif`, `recipe-hero.jpg`, `recipe-card.webp`                          | Non        |
| [Site de formation](../docker/examples/training.yaml)       | Conserver tout le cadre d’une capture ou d’un schéma. Publier un PNG détaillé (1 920 px max.), un visuel de cours (960 px max.) et une miniature (480 px max.). | `lesson-detail.png`, `lesson-inline.webp`, `lesson-thumbnail.webp`                 | Non        |

Pour la diffusion vidéo, déposer une image de couverture ou une image extraite en amont de la vidéo, au format JPEG, PNG ou WebP.

Après avoir préparé les [répertoires hôte et leurs droits](deployment.md#préparer-et-démarrer), sélectionner un fichier depuis la racine du dépôt. Par exemple, sous un shell Linux :

```sh
export PIXELFLOW_CONFIG_FILE=./docker/examples/gallery.yaml
docker compose up -d --build --force-recreate
```

Déposer les images dans `data/input/`. Le modèle doit être préparé pour les exemples qui utilisent BEN2. Pour les autres exemples, un dossier `models/` vide suffit au montage Compose. Pour valider un fichier avant de démarrer le service, utiliser `node dist/main.js admin validate <fichier.yaml>` après compilation.

### Exécuter plusieurs pipelines en parallèle

L’[exemple parallèle](../docker/examples/parallel.yaml) fait tourner la galerie photo et les miniatures vidéo dans le même service. Les deux pipelines partagent le journal et la limite globale de deux jobs simultanés (`settings.concurrency: 2`). Chaque pipeline a ses propres dossiers.

Depuis la racine du dépôt, sélectionner ce YAML avec Compose :

```sh
export PIXELFLOW_CONFIG_FILE=./docker/examples/parallel.yaml
docker compose up -d --build --force-recreate
```

| Dépôt sur l’hôte                                     | Lot publié sur l’hôte                       |
| ---------------------------------------------------- | ------------------------------------------- |
| Photo dans `data/input/gallery/`                     | `data/output/gallery/<id-de-job>/`          |
| Couverture vidéo dans `data/input/video-thumbnails/` | `data/output/video-thumbnails/<id-de-job>/` |

PixelFlow crée les sous-dossiers au démarrage. Si tu changes la configuration d’un service existant, laisse d’abord se terminer les jobs en cours.

## Réglages

| Champ                          | Effet                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`                      | Version du schéma. La valeur actuelle est `1`.                                                                                                                     |
| `settings.concurrency`         | Nombre de jobs simultanés, partagé entre tous les dossiers. Par défaut, `1`. Une seule inférence BEN2 s’exécute à la fois.                                         |
| `settings.stabilityMs`         | Durée d’observation d’un dépôt, en millisecondes. Par défaut, `2000`.                                                                                              |
| `settings.modelCache`          | Répertoire contenant les fichiers BEN2, par défaut `./models`. Le modèle est chargé au démarrage dès qu’un pipeline le demande.                                    |
| `settings.logLevel`            | Niveau des journaux. Valeurs acceptées `trace`, `debug`, `info`, `warn`, `error`, `fatal` et `silent`. Par défaut, `info`.                                         |
| `settings.stateDirectory`      | Répertoire local qui contient `jobs.sqlite` et le verrou du service. Par défaut, `./data/state`. Il doit être disjoint des dossiers de pipeline.                   |
| `settings.maxRetries`          | Nombre de nouvelles tentatives après le premier essai, par défaut `3`. Avec `0`, le premier échec termine le job. Une tentative interrompue compte dans ce budget. |
| `settings.scanIntervalSeconds` | Intervalle du scan de réconciliation, en secondes. Valeur par défaut `60`. Un premier scan a lieu au démarrage.                                                    |
| `pipelines.<id>.processing`    | Répertoire de prise en charge. Par défaut, `./data/processing/<id>`.                                                                                               |

Les identifiants de pipeline et les noms de variante acceptent jusqu’à 64 caractères alphanumériques, tirets ou tirets bas. Ils commencent par un caractère alphanumérique. Les noms réservés sous Windows sont rejetés.

## Étapes

Les étapes sont exécutées dans l’ordre du YAML. `normalize`, lorsqu’elle est présente, vient en premier. Chaque pipeline se termine par un seul `export`.

| Étape               | Comportement                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `normalize`         | Applique l’orientation EXIF. Les encodeurs retirent les métadonnées de la source.                                                                                                                                                                                                                                                                  |
| `remove-background` | Combine le masque du premier plan avec l’alpha existant. Indiquer `model: ben2` et préparer le cache avant de démarrer. [Préparation de BEN2](../README.md#détourer-une-image-avec-ben2)                                                                                                                                                           |
| `trim`              | Recadre autour des pixels dont l’alpha atteint 16 sur 255. `padding` ajoute une marge relative de 0 à 1 sur chaque côté, dans les limites de l’image. La valeur par défaut est 0. Une image entièrement transparente conserve ses dimensions.                                                                                                      |
| `resize`            | `width` et `height` vont de 1 à 16 383. Avec `inside` (par défaut), l’image tient dans ces limites sans agrandissement. `contain` complète le cadre et `cover` recadre pour remplir les dimensions exactes. Ces deux modes acceptent jusqu’à 64 millions de pixels. La couleur de fond de `contain` vaut `transparent` ou une couleur `"#RRGGBB"`. |
| `export`            | Encode toutes les variantes dans un répertoire temporaire avant de publier le lot sous `output/<id-de-job>/`.                                                                                                                                                                                                                                      |

Les variantes partent de l’image produite par les étapes communes et peuvent préciser leurs propres options :

| Option                           | Effet                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `resize.width` / `resize.height` | Limites maximales, de 1 à 16 383 pixels. Conserve les proportions, ne recadre pas et n’agrandit pas l’image. |
| `effects.blurSigma`              | Flou gaussien, sigma de 0,3 à 100. Une valeur élevée produit un flou plus fort.                              |
| `effects.pixelBlockSize`         | Taille maximale des blocs de pixelisation, entier de 2 à 512 pixels.                                         |

Pour une variante, les opérations s’appliquent après les étapes communes, dans cet ordre : redimensionnement, flou, pixelisation. Le nom par défaut est `image`. Utiliser des noms distincts pour sortir plusieurs variantes d’un même format, par exemple `hero.webp` et `compact.webp`. JPEG utilise l’extension `.jpg`. WebP, AVIF et JPEG acceptent une qualité de 1 à 100, respectivement 85, 65 et 85 par défaut. PNG accepte un `compressionLevel` de 0 à 9, avec 6 par défaut. JPEG aplatit la transparence sur `background`, blanc par défaut.

Une clé inconnue, une étape mal placée ou une valeur invalide interrompt le démarrage avec le chemin du champ concerné, par exemple `pipelines.photos.steps[1].width`. Si un encodeur échoue, le service retire les variantes temporaires puis réessaie selon le budget. Lorsque le budget est épuisé, il conserve l’original et son diagnostic dans `failed/`.

Conserver le même répertoire d’état et les mêmes chemins de pipeline tant que des jobs sont en cours. Lors d’une reprise, les nouvelles tentatives utilisent les étapes configurées au redémarrage. Exécuter un seul service par arborescence de données et par répertoire d’état. [Décision de persistance](adr/0007-durable-watch-jobs.md)

## Consulter le journal

Ouvrir `jobs.sqlite` en lecture seule dans un client SQLite. La table `jobs` contient l’état courant, les chemins et le nombre de tentatives. La table `job_attempts` contient le résultat et l’erreur éventuelle de chaque tentative.

```sql
SELECT id, name, status, attempts, last_error, output_path, result_path
FROM jobs
ORDER BY created_at DESC;
```
