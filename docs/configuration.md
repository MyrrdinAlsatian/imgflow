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

L’étape [`auto-crop`](#recadrage-automatique-du-sujet) cadre le sujet avec un ratio et une marge, en agrandissant le canevas si nécessaire.

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

## Copyright et filigrane

Ajouter ces étapes avant `export`, après les recadrages et redimensionnements communs.

```yaml
- type: copyright
  text: "© 2026 Atelier Exemple"
- type: watermark
  image: ./logo.png
  position: bottom-right
  widthRatio: 0.2
  opacity: 0.8
  margin: 12
```

- `copyright` ajoute la mention dans le champ XMP `dc:rights` de chaque variante PNG, WebP, JPEG ou AVIF. Elle reste disponible après les transformations. Si plusieurs mentions sont configurées, la dernière s’applique.
- `watermark` incruste un logo PNG, WebP ou JPEG. Le chemin est relatif au fichier YAML. Les positions possibles sont `top-left`, `top-right`, `bottom-left`, `bottom-right` et `center`. La largeur relative est strictement positive, au plus `1`. L’opacité va de `0` à `1` et la marge est exprimée en pixels. Les valeurs montrées sont celles par défaut. Le logo conserve ses proportions et sa transparence, et son cadre s’adapte aux petites images.
- Les redimensionnements et effets propres aux variantes s’appliquent ensuite à l’image filigranée. Une opacité de `0` désactive le filigrane.

## Recadrage automatique du sujet

Ajouter `auto-crop` après `remove-background` et avant le redimensionnement final. Pour des images déjà transparentes ou prises sur fond blanc, l’étape fonctionne directement après `normalize`.

```yaml
steps:
  - type: normalize
  - type: remove-background
    model: ben2
  - type: auto-crop
    aspectRatio: "4:5"
    padding: 0.1
  - type: resize
    width: 1200
    height: 1500
    fit: inside
  - type: export
    variants:
      - format: webp
```

| Paramètre               | Défaut        | Effet                                                                                                                                                                                                                                                                      |
| ----------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`               | `true`        | Avec `false`, l’étape transmet l’image directement.                                                                                                                                                                                                                        |
| `detectionMode`         | `auto`        | `alpha` détecte le sujet par opacité. `white` le détecte par écart au blanc en ignorant les pixels entièrement transparents. `auto` utilise l’alpha si au moins un pixel est sous le seuil d’opacité. Sinon, il utilise la détection du blanc.                             |
| `alphaThreshold`        | `15`          | Opacité minimale incluse, de 1 à 255. Diminuez-la pour inclure des contours plus diffus dans la détection.                                                                                                                                                                 |
| `colorTolerance`        | `20`          | Tolérance de 0 à 255 par canal RVB. Un pixel est considéré comme blanc si ses trois canaux sont supérieurs ou égaux à `255 - colorTolerance`.                                                                                                                              |
| `aspectRatio`           | `"1:1"`       | Rapport largeur:hauteur donné sous forme de chaîne. Chaque terme est un entier positif de 1 à 99 999. Exemples `"4:5"`, `"16:9"`.                                                                                                                                          |
| `padding`               | `0.1`         | Marge minimale de 0 à 1, commune aux quatre côtés ou définie avec `top`, `right`, `bottom` et `left`. Les côtés omis valent 0,1. Chaque marge est proportionnelle à l’axe correspondant du sujet détecté et arrondie au pixel supérieur.                                   |
| `alignment`             | `center`      | Répartit l’espace vertical supplémentaire après application de la marge minimale. Avec `top`, cet espace est placé sous le sujet. Avec `bottom`, il est placé au-dessus. L’espace horizontal supplémentaire se répartit de part et d’autre du sujet et de ses marges.      |
| `background`            | `transparent` | Couleur des pixels ajoutés hors de l’image d’origine. Accepte `transparent` ou une couleur `"#RRGGBB"`. Le fond déjà présent dans la zone conservée garde ses pixels.                                                                                                      |
| `analysisResolution`    | `1024`        | Nombre maximal de cellules sur le côté long du masque d’analyse, de 1 à 2 048.                                                                                                                                                                                             |
| `removeArtifacts`       | `true`        | Écarte du calcul du cadre les petites composantes isolées. Les pixels d’un artefact situé dans le cadre final restent visibles.                                                                                                                                            |
| `minComponentAreaRatio` | `0.001`       | Surface minimale d’une composante en proportion du masque entier, de 0 à 1. Si aucune composante n’atteint ce seuil, la plus grande est retenue. En cas d’égalité, la première dans l’ordre de lecture est retenue. Avec `0`, toutes les composantes contribuent au cadre. |

Pour définir une marge différente sur chaque côté, remplacer le nombre par un objet. Dans cet exemple, le bas reçoit une marge proportionnelle nulle et l’espace vertical ajouté pour respecter le ratio est placé au-dessus du sujet.

```yaml
- type: auto-crop
  aspectRatio: "1:1"
  alignment: bottom
  padding:
    top: 0.15
    right: 0.05
    bottom: 0
    left: 0.1
```

Une cellule du masque est active dès qu’elle contient un pixel du sujet. Le filtrage examine les composantes connexes en incluant les diagonales et conserve l’union des composantes significatives. Les limites sont reportées dans l’image d’origine avec une cellule de sécurité de chaque côté, même si la marge configurée vaut zéro. Les pixels retenus, y compris semi-transparents, gardent leur résolution et leur opacité.

Une image entièrement transparente ou sans sujet détecté poursuit la pipeline telle quelle. En mode `white`, une zone blanche isolée du sujet peut se confondre avec le fond. Un masque à faible résolution peut fusionner des composantes proches. Les contours diffus sous le seuil d’opacité peuvent être exclus s’ils dépassent la marge de sécurité et le cadre calculé.

Le canevas respecte exactement le ratio demandé en pixels entiers. Si le ratio minimal ou le canevas requis dépasse 16 383 px par côté ou 64 millions de pixels, PixelFlow signale une erreur. Un redimensionnement ultérieur peut arrondir les dimensions au pixel. [Décision d’architecture](adr/0011-auto-crop.md)

## Consulter le journal

Ouvrir `jobs.sqlite` en lecture seule dans un client SQLite. La table `jobs` contient l’état courant, les chemins et le nombre de tentatives. La table `job_attempts` contient le résultat et l’erreur éventuelle de chaque tentative.

```sql
SELECT id, name, status, attempts, last_error, output_path, result_path
FROM jobs
ORDER BY created_at DESC;
```
