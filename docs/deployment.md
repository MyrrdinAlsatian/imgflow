# Exploitation avec Docker Compose

Utiliser Docker Engine, BuildKit et le plugin Docker Compose v2 sur Linux amd64 ou arm64. L’image de base suit la branche Node 24 Bookworm slim. Pour mettre à jour cette image lors d’une reconstruction, lancer `docker compose build --pull`. [Image Node officielle](https://hub.docker.com/_/node) · [BuildKit](https://docs.docker.com/build/buildkit/)

## Préparer et démarrer

Depuis la racine du dépôt, créer les répertoires hôte. Le conteneur tourne avec l’UID et le GID 1000. Cet utilisateur doit pouvoir lire et écrire dans `data/`, ainsi que lire `models/` et le fichier YAML monté.

```sh
mkdir -p ./data/input ./models
corepack pnpm model:prepare ./models
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

Si le compte hôte utilise un autre UID, attribuer l’accès à l’UID et au GID 1000 via les droits du système de fichiers. Avec une installation Docker classique, `sudo install -d -m 0750 -o 1000 -g 1000 ./data ./data/input` permet de préparer ces deux dossiers. Les fichiers et les sous-dossiers existants doivent être accessibles eux aussi.

| Montage dans le conteneur       | Source hôte par défaut    | Contenu                                                                  |
| ------------------------------- | ------------------------- | ------------------------------------------------------------------------ |
| `/data`                         | `./data`                  | Entrées, traitements en cours, sorties, archives, échecs et état SQLite. |
| `/models`                       | `./models`                | Cache BEN2 monté en lecture seule.                                       |
| `/etc/pixelflow/pipelines.yaml` | `./docker/pixelflow.yaml` | Configuration montée en lecture seule.                                   |

Les variables `PIXELFLOW_DATA_DIR`, `PIXELFLOW_MODELS_DIR` et `PIXELFLOW_CONFIG_FILE` sélectionnent d’autres chemins hôte. Pour personnaliser les pipelines, copier le fichier fourni, modifier les chemins **dans le conteneur** sous `/data`, puis renseigner `PIXELFLOW_CONFIG_FILE` avant de recréer le service. Conserver `/data/state` comme répertoire d’état. [Schéma YAML](configuration.md)

### Cache BEN2 et variantes publiées

La configuration fournie active `remove-background`. Avant le premier démarrage, `corepack pnpm model:prepare ./models` télécharge le cache BEN2 FP16 (environ 219 Mo) et vérifie les sommes SHA-256. Le conteneur monte ce cache en lecture seule et fonctionne ensuite sans réseau. Il publie `image.webp`, `blurred-pixelated.webp`, `thumbnail-256.webp` et `thumbnail-512.webp`; le détourage est appliqué avant ces variantes.

Le benchmark Windows a mesuré un pic RSS de 4,42 Gio. Un essai d’inférence hors ligne passe aussi sur Linux CPU avec la fixture du dépôt; la qualité sur corpus et le pic RSS à froid restent à mesurer sur l’hôte cible. [Mesures BEN2](benchmarks.md)

## Vérifier le service

Dans la configuration fournie, effectuer un dépôt par renommage dans le dossier d’entrée.

```sh
cp tests/fixtures/oriented.jpg ./data/input/photo.jpg.part
mv ./data/input/photo.jpg.part ./data/input/photo.jpg
docker compose logs --tail=100 pixelflow
find ./data/output -name image.webp
find ./data/archive -name photo.jpg
```

Le statut passe à `healthy` après l’initialisation et le premier scan de chaque dossier. Le service rafraîchit l’indicateur toutes les cinq secondes. Le contrôle échoue si l’indicateur date de plus de 30 secondes, si le service signale une erreur de réconciliation ou d’accès au disque ou au journal, ou si un job actif dépasse la durée maximale. `PIXELFLOW_HEALTH_MAX_JOB_SECONDS` règle cette durée, avec 900 secondes par défaut. Docker relève le statut de santé. La politique de redémarrage s’applique aux arrêts du processus. [Contrôle de santé Compose](https://docs.docker.com/reference/compose-file/services/#healthcheck) · [Politique de redémarrage](https://docs.docker.com/engine/containers/start-containers-automatically/)

```sh
docker compose ps
docker inspect --format '{{json .State.Health}}' "$(docker compose ps -q pixelflow)"
```

## Consulter et relancer des jobs

Utiliser le CLI `admin` dans le conteneur pour lire le journal, consulter les métriques et programmer une relance. [Administration dans le conteneur](administration.md#utiliser-la-cli-dans-le-conteneur)

## Arrêter, recréer et sauvegarder

`docker compose stop` transmet l’arrêt au service et lui laisse jusqu’à deux minutes pour finir le travail engagé. Avec les mêmes montages, `docker compose up -d --force-recreate` retrouve les fichiers, les modèles et le journal. Les dépôts publiés gardent leur identifiant de job.

Pour vérifier la persistance, relever le chemin d’une sortie et celui de son archive, recréer le conteneur, puis vérifier ces mêmes fichiers et `./data/state/jobs.sqlite`. Si BEN2 est activé, vérifier également le chargement depuis le cache monté. Pour sauvegarder l’installation, arrêter le service et copier ensemble les données, le cache des modèles et le YAML.

Lors d’une migration d’un service existant, conserver ses chemins de pipeline tels que le conteneur les voit. Si ces chemins doivent changer, terminer les jobs en cours avant de basculer vers les nouveaux montages. Les jobs persistés référencent leurs emplacements absolus. [Reprise des jobs](adr/0007-durable-watch-jobs.md)
