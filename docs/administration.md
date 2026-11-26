# Administrer PixelFlow

Depuis la racine du projet compilé, utiliser `node dist/main.js admin --help` pour afficher les commandes. La sortie standard est en JSON pour les résultats et la sortie d’erreur contient le diagnostic avec un code de sortie non nul.

## Valider et consulter

```sh
node dist/main.js admin validate ./pixelflow.yaml
node dist/main.js admin jobs --config ./pixelflow.yaml --status failed --limit 20
node dist/main.js admin job "$JOB_ID" --config ./pixelflow.yaml
```

`validate` vérifie le YAML et les chemins avec le chargeur utilisé au démarrage. La commande retourne les identifiants de pipeline et le répertoire d’état sans ouvrir de watcher ni charger BEN2. Les erreurs de validation indiquent le champ concerné. [Schéma YAML](configuration.md)

Les commandes d’historique, de relance et de métriques utilisent `./data/state` par défaut. Passer `--config <fichier>` pour lire le répertoire d’état du service ou `--state-directory <dossier>` pour viser directement un journal. `jobs` liste 50 entrées par défaut, avec `--status` pour filtrer, `--limit` pour ajuster la taille de page et `--offset` pour avancer dans la liste. `job` affiche le dernier diagnostic, les chemins et chaque tentative. Les dates sont exprimées en millisecondes depuis l’époque Unix.

## Relancer un job en échec

Renseigner `JOB_ID` avec l’identifiant obtenu dans `jobs` ou `job`, puis lancer la commande suivante.

```sh
node dist/main.js admin retry "$JOB_ID" --config ./pixelflow.yaml
```

La commande retourne l’identifiant du nouveau job. Le service le prend en charge au prochain scan de réconciliation, ou au démarrage suivant si le service est arrêté. Le job part avec son propre budget de tentatives et suit les étapes chargées par le service. Le fichier et le diagnostic d’origine restent dans `failed/`. Avec `--config`, la commande vérifie que les chemins du job correspondent au YAML fourni.

Répéter la demande pour le même identifiant retourne le même nouveau job avec `queued: false`. Si ce nouveau job échoue et qu’une autre relance est nécessaire, utiliser son identifiant. Une demande dont l’original est déjà absent est rejetée.

Après une mise à niveau depuis la Phase 5, redémarrer le service avec la version qui fournit la commande `admin` avant de programmer des relances.

## Suivre les mesures

```sh
node dist/main.js admin metrics --config ./pixelflow.yaml
```

Le rapport indique le nombre de jobs par état, les tentatives par issue, les relances manuelles et les tentatives automatiques après le premier essai. Les durées des tentatives publiées sont exprimées en millisecondes avec le nombre de mesures, la moyenne, le p50 et le p95 par rang. Elles mesurent le temps entre les deux écritures du journal et peuvent inclure un délai de reprise après interruption.

## Utiliser la CLI dans le conteneur

```sh
docker compose exec -T pixelflow node /app/dist/main.js admin jobs --config /etc/pixelflow/pipelines.yaml
docker compose exec -T pixelflow node /app/dist/main.js admin metrics --config /etc/pixelflow/pipelines.yaml
```

Passer le chemin du YAML tel que le conteneur le voit, pour que la relance vérifie les mêmes chemins que le service. [Guide d’exploitation](deployment.md)
