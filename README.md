# PixelFlow

PixelFlow est un projet de moteur de traitement d’images auto-hébergé. À terme, déposer une image dans un dossier déclenchera une suite d’opérations locales et la publication de variantes pour le web.

**PixelFlow convertit une image locale en WebP ou traite automatiquement les dépôts d’un dossier surveillé.**

## Installer le service avec Docker Compose

Ce parcours installe le service complet : détourage BEN2, WebP principal, image fortement floue et pixelisée, et miniatures 256/512 px.

### Prérequis

- Linux amd64 ou arm64 ;
- Docker Engine avec BuildKit et le plugin Docker Compose v2 ;
- Node.js 24.14.0 ou plus récent dans la série 24, avec Corepack ;
- au moins 6 Gio de mémoire disponible pour une inférence BEN2 confortable ;
- environ 219 Mo pour le cache BEN2, plus l’espace des images et des sorties.

### Installation

Depuis la racine du dépôt :

```sh
corepack pnpm install --frozen-lockfile
mkdir -p data/input models
corepack pnpm model:prepare ./models
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

Le téléchargement du modèle nécessite une connexion réseau. Après cette étape, le service charge le cache local et son conteneur fonctionne sans réseau.

Le conteneur s’exécute avec l’UID et le GID `1000`. Il doit pouvoir écrire dans `data/` et lire `models/`. Si Docker signale `EACCES`, appliquer les droits à l’arborescence de données avant de redémarrer :

```sh
sudo chown -R 1000:1000 data
sudo chmod -R u+rwX,g+rwX data
sudo chmod -R a+rX models
docker compose up -d --force-recreate
```

Si l’utilisateur hôte doit continuer à écrire directement dans `data/`, utiliser une ACL ou déposer les fichiers avec les droits du propriétaire du répertoire. Ne pas rendre `models/` ou `data/` accessibles à tous sans nécessité.

### Premier traitement

Le dépôt doit se faire dans `data/input/`. Pour éviter qu’une copie longue soit prise en charge trop tôt, utiliser un nom temporaire puis le renommer :

```sh
cp chemin/vers/photo.jpg data/input/photo.jpg.part
mv data/input/photo.jpg.part data/input/photo.jpg
docker compose logs --tail=100 pixelflow
```

Vérifier le service et les sorties :

```sh
docker compose ps
find data/output -type f \( \
  -name image.webp -o \
  -name blurred-pixelated.webp -o \
  -name 'thumbnail-*.webp' \
\) -print
find data/archive -type f -name photo.jpg -print
```

Le statut doit devenir `healthy`. Un job produit, dans son dossier `data/output/<id>/` :

| Fichier                  | Contenu                                          |
| ------------------------ | ------------------------------------------------ |
| `image.webp`             | Image WebP avec détourage BEN2.                  |
| `blurred-pixelated.webp` | Variante fortement floue puis pixelisée.         |
| `thumbnail-256.webp`     | Miniature dont le côté long est limité à 256 px. |
| `thumbnail-512.webp`     | Miniature dont le côté long est limité à 512 px. |

Une petite image n’est pas agrandie : ses miniatures peuvent donc être plus petites que 256 ou 512 px. L’original traité est déplacé dans `data/archive/<id>/`. Un échec conserve l’original et son diagnostic dans `data/failed/<id>/`.

### Commandes quotidiennes

```sh
# Suivre les journaux
docker compose logs -f --tail=100 pixelflow

# Vérifier la santé détaillée
docker compose ps
docker inspect --format '{{json .State.Health}}' "$(docker compose ps -q pixelflow)"

# Arrêter puis reprendre
docker compose stop
docker compose start

# Recréer après une modification de configuration
docker compose up -d --force-recreate
```

Pour arrêter le service sans supprimer les données, utiliser `docker compose stop`. Ne pas supprimer `data/` ni `models/` : ils contiennent respectivement le journal SQLite, les originaux et le modèle.

### Mise à jour et sauvegarde

Après une mise à jour du dépôt ou de l’image Node :

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm model:prepare ./models
docker compose build --pull
docker compose up -d --force-recreate
docker compose ps
```

Avant une migration ou une suppression de fichiers, arrêter le service puis sauvegarder ensemble `data/`, `models/` et `docker/pixelflow.yaml` :

```sh
docker compose stop
tar -czf "pixelflow-backup-$(date +%F).tar.gz" data models docker/pixelflow.yaml
```

Le [guide d’exploitation Docker](docs/deployment.md) décrit les montages, les permissions et le dépannage.

### Envoyer une image par API ou formulaire web

Le [connecteur HTTP facultatif](docs/http.md) permet d’envoyer une image, de suivre son traitement et de télécharger les variantes. Le dossier surveillé reste utilisable. Pour un accès distant, placer le connecteur derrière un proxy HTTPS et protéger les appels par un jeton.

## Utiliser le traitement local

Utiliser Node.js 24 LTS (24.14.0 minimum) avec Corepack. Depuis la racine du dépôt, lancer les commandes suivantes. Corepack lit le champ `packageManager` pour sélectionner pnpm 10.34.9. Le premier téléchargement des outils nécessite un accès au registre npm.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm start process "photo.jpg" "photo.webp" --width 1200 --height 800 --quality 85
```

Sous Windows avec PowerShell, utiliser `corepack.cmd pnpm` si les scripts PowerShell sont bloqués. Si un ancien lanceur renvoie `MODULE_NOT_FOUND`, `Get-Command corepack.cmd -All` liste les installations. Utiliser le lanceur situé à côté de `node.exe` dans l’installation de Node 24.

La commande accepte les JPEG, PNG et WebP à une seule image, jusqu’à 64 millions de pixels. Elle détecte le format d’après le contenu, applique l’orientation EXIF, conserve les proportions et la transparence, puis retire les métadonnées du WebP. Les limites de largeur et de hauteur acceptent des entiers de 1 à 16 383 et valent 1600 pixels par défaut. La commande réduit les grandes images sans agrandir les petites. La qualité vaut 85 par défaut et accepte les entiers de 1 à 100.

Indiquer un chemin de sortie `.webp` dans un répertoire existant sur un système de fichiers qui accepte les liens physiques. PixelFlow publie le fichier complet sans écraser une destination existante et conserve l’original. Une entrée invalide ou un échec de publication renvoie un code de sortie de 1.

Après l’installation des dépendances et la compilation, `node dist/main.js process photo.jpg photo.webp` fonctionne hors ligne. Les chemins relatifs partent du répertoire courant. L’option `--help` affiche la syntaxe et le lancement sans argument affiche le message de démarrage.

### Diagnostiquer une conversion

| Message                                             | Action                                                                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `Output already exists`                             | Choisir un autre chemin de sortie. Le fichier déjà présent est conservé.                                                         |
| `Could not read image` ou `Could not convert image` | Lire le détail qui suit le message. Vérifier que l’image est complète et que le répertoire de sortie est accessible en écriture. |
| `Input must be a single-frame JPEG, PNG or WebP`    | Fournir une image fixe dans un des formats acceptés. La commande se base sur le contenu du fichier.                              |

## Surveiller un dossier

Après la compilation, lancer PixelFlow avec un répertoire de données. Par défaut, la commande utilise `./data`.

```sh
node dist/main.js watch ./data --width 1200 --height 800 --quality 85 --stability-ms 2000
```

Déposer les fichiers directement dans `data/input/`. Le service traite un fichier à la fois, y compris ceux présents au démarrage. Pour une copie longue, écrire sous un nom terminé par `.part` ou `.tmp` dans `input/`, puis renommer le fichier une fois la copie terminée. PixelFlow ignore les noms commençant par un point, les liens symboliques et le contenu des sous-dossiers. Pour un dépôt direct, PixelFlow attend une période sans changement observable. Une copie interrompue plus longtemps que cette période peut être prise en charge avant sa fin.

| Chemin                       | Contenu                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `processing/<id>/<nom>`      | Original pris en charge par le service.                                                           |
| `output/<id>/image.webp`     | WebP complet publié par PixelFlow.                                                                |
| `archive/<id>/<nom>`         | Original d’une conversion réussie.                                                                |
| `failed/<id>/original/<nom>` | Original dont le traitement a échoué. Le fichier `failed/<id>/error.json` contient le diagnostic. |

Les journaux JSON sur la sortie standard indiquent l’identifiant du job et les chemins utiles. Pour arrêter le service, utiliser Ctrl+C ou envoyer SIGTERM sous Linux. Le travail en cours se termine et les dépôts en attente restent dans `input/`. Après un arrêt brutal, relancer la même commande avec le même répertoire d’état et les mêmes chemins de données. PixelFlow récupère les jobs dans `processing/` et termine l’archivage des lots déjà publiés.

Par défaut, une conversion échouée peut être relancée trois fois. Chaque tentative, y compris celle interrompue pendant l’encodage, est inscrite dans `data/state/jobs.sqlite`. Les détails d’un job qui a épuisé son budget sont conservés avec l’original dans `failed/`. [Réglages de fiabilité](docs/configuration.md#réglages)

## Définir plusieurs pipelines en YAML

Enregistrer l’[exemple YAML](docs/configuration.md) dans `pixelflow.yaml` puis lancer le service.

```sh
node dist/main.js watch --config ./pixelflow.yaml
```

Chaque dossier d’entrée applique ses propres étapes et peut publier des variantes WebP, AVIF, PNG et JPEG. Les chemins relatifs partent du répertoire du fichier YAML. Chaque lot apparaît dans le dossier de sortie une fois toutes ses variantes encodées. Une erreur dans le YAML indique le champ concerné avant le démarrage des dossiers surveillés.

## Détourer une image avec BEN2

Préparer le cache une fois sur une machine connectée. Cette commande télécharge l’export BEN2 FP16 épinglé (219 Mo) et vérifie la somme SHA-256 de chaque fichier. On peut ensuite copier le dossier `models/ben2/` sur une autre machine.

```sh
corepack pnpm model:prepare
node dist/main.js process photo.jpg photo.webp --remove-background
node dist/main.js watch ./data --remove-background --model-cache ./models
```

Le détourage est activé par `--remove-background`. Le cache par défaut est `./models`. Le modèle travaille sur CPU avec le backend natif d’ONNX Runtime et lit uniquement les fichiers locaux. Le dossier surveillé réutilise la même session pour tous ses dépôts. Le WebP conserve les dimensions prévues pour la conversion et combine le masque de premier plan avec la transparence déjà présente. Si le cache est incomplet, la commande indique le chemin manquant.

Les mesures de temps et de mémoire se reproduisent avec `corepack pnpm bench:ben2 photo.jpg`. [Protocole et résultats](docs/benchmarks.md)

## Déployer avec Docker Compose

Sur Linux, Compose construit l’image et démarre le service avec l’utilisateur `node`. Le YAML fourni détourne les dépôts de `data/input` avec BEN2, puis publie le WebP principal, une variante floue et pixelisée et des miniatures 256/512 px dans `data/output`. Préparer d’abord le cache BEN2 de 219 Mo. [Guide d’exploitation](docs/deployment.md)

## Administrer le service

La commande `admin` permet de valider un YAML, consulter l’historique et les métriques, puis relancer un job en échec. Les commandes écrivent leurs résultats en JSON.

```sh
node dist/main.js admin validate ./pixelflow.yaml
node dist/main.js admin jobs --config ./pixelflow.yaml --status failed
node dist/main.js admin metrics --config ./pixelflow.yaml
```

Le guide décrit la relance à partir de l’original conservé et les commandes utilisables dans le conteneur. [Administration](docs/administration.md)

## Commandes de développement

Utiliser `corepack pnpm <script>`, ou `pnpm <script>` si le lanceur pnpm utilise la version épinglée.

| Script                   | Effet                                                                          |
| ------------------------ | ------------------------------------------------------------------------------ |
| `dev`                    | Lance le TypeScript avec Node et relance le processus lors d’une modification. |
| `typecheck`              | Vérifie les types des sources et des tests.                                    |
| `build`, `start`         | Compile les sources dans `dist/`, puis permet de lancer le JavaScript produit. |
| `lint`                   | Analyse les sources et les tests avec Oxlint.                                  |
| `format`, `format:check` | Applique le formatage Oxfmt ou signale les écarts en lecture seule.            |
| `test`, `test:watch`     | Exécute Vitest une fois ou en surveillance.                                    |
| `check`                  | Vérifie le format, le lint et les types, compile, teste et lance le build.     |

## Documentation

- [Vision du produit](docs/vision.md) et [jalons et critères d’acceptation](docs/roadmap.md)
- [Architecture](docs/architecture.md), [domaine](docs/domain.md) et [décisions d’architecture](docs/adr/)
- [Configuration YAML cible](docs/configuration.md) et [protocole de benchmark](docs/benchmarks.md)
- [Instructions pour contribuer avec un agent](AGENTS.md)
