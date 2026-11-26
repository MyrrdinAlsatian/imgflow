# Exploitation avec Docker Compose

Pour activer l’envoi par API ou formulaire, suivre le [guide du connecteur HTTP](http.md). Compose reste sans réseau par défaut.

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

## Dépannage courant

### Le conteneur redémarre avec `EACCES`

Le service tourne avec l’UID et le GID `1000`. Vérifier les droits du volume :

```sh
stat -c '%u:%g %a %n' data data/input models
docker compose logs --tail=100 pixelflow
```

Le conteneur doit écrire dans `data/` et lire `models/`. Corriger uniquement les répertoires de l’installation :

```sh
sudo chown -R 1000:1000 data
sudo chmod -R u+rwX,g+rwX data
sudo chmod -R a+rX models
docker compose up -d --force-recreate
```

Pour conserver l’écriture directe par le compte hôte, configurer une ACL plutôt que d’ouvrir les droits à tous les utilisateurs.

### Le conteneur reste `unhealthy`

Lire les journaux et le détail du contrôle :

```sh
docker compose ps
docker compose logs --tail=200 pixelflow
docker inspect --format '{{json .State.Health}}' "$(docker compose ps -q pixelflow)"
```

Le contrôle échoue si le fichier de santé est périmé, si un dossier n’est plus accessible, si SQLite ne peut pas ouvrir une transaction ou si un job dépasse `PIXELFLOW_HEALTH_MAX_JOB_SECONDS`. Corriger la cause indiquée, puis recréer le service.

### BEN2 ne se charge pas

Vérifier la présence et la somme du cache depuis l’hôte :

```sh
test -s models/ben2/config.json
test -s models/ben2/preprocessor_config.json
test -s models/ben2/onnx/model_fp16.onnx
corepack pnpm model:prepare ./models
docker compose up -d --force-recreate
```

La commande `model:prepare` doit être exécutée avec Node 24 et une connexion réseau lors de la première installation. Le conteneur ne télécharge aucun fichier et monte `/models` en lecture seule.

### Une image n’est pas traitée

Vérifier que le fichier est directement dans `data/input/`, qu’il n’est ni caché ni dans un sous-dossier, et qu’il utilise le contenu d’un JPEG, PNG ou WebP à une seule image. Pour une copie longue, terminer par `.part` ou `.tmp`, puis renommer :

```sh
mv data/input/photo.jpg.part data/input/photo.jpg
docker compose logs --tail=100 pixelflow
```

Un fichier déplacé dans `data/processing/` est pris en charge. Un traitement réussi termine dans `data/archive/`; un traitement épuisé termine dans `data/failed/` avec `error.json`.

### Le traitement consomme beaucoup de mémoire

BEN2 utilise le CPU et peut consommer plusieurs Gio de mémoire pendant l’inférence. Le benchmark de référence a observé un pic de 4,42 Gio sur Windows. Éviter de limiter le conteneur sous cette valeur sans validation et surveiller la consommation :

```sh
docker compose stats --no-stream pixelflow
free -h
```

## Consulter et relancer des jobs

Utiliser le CLI `admin` dans le conteneur pour lire le journal, consulter les métriques et programmer une relance. [Administration dans le conteneur](administration.md#utiliser-la-cli-dans-le-conteneur)

## Arrêter, recréer et sauvegarder

`docker compose stop` transmet l’arrêt au service et lui laisse jusqu’à deux minutes pour finir le travail engagé. Avec les mêmes montages, `docker compose up -d --force-recreate` retrouve les fichiers, les modèles et le journal. Les dépôts publiés gardent leur identifiant de job.

Pour vérifier la persistance, relever le chemin d’une sortie et celui de son archive, recréer le conteneur, puis vérifier ces mêmes fichiers et `./data/state/jobs.sqlite`. Si BEN2 est activé, vérifier également le chargement depuis le cache monté. Pour sauvegarder l’installation, arrêter le service et copier ensemble les données, le cache des modèles et le YAML.

Lors d’une migration d’un service existant, conserver ses chemins de pipeline tels que le conteneur les voit. Si ces chemins doivent changer, terminer les jobs en cours avant de basculer vers les nouveaux montages. Les jobs persistés référencent leurs emplacements absolus. [Reprise des jobs](adr/0007-durable-watch-jobs.md)
