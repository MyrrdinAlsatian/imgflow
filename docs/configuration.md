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
