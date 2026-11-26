# ADR 0008 · Image Docker et contrôle de fonctionnement

**Décision adoptée en Phase 6.** Les étapes de build et d’exécution utilisent Node 24 sur Debian Bookworm slim. pnpm installe les versions verrouillées dans le conteneur afin de sélectionner les binaires Linux. L’image finale copie le JavaScript compilé et l’installation de production. Le build y exécute un encodage WebP et charge les bibliothèques SQLite et Transformers.js. Le processus tourne avec l’utilisateur fourni par l’image Node, UID et GID 1000. [Image Node officielle](https://hub.docker.com/_/node) · [Construction multi-stage](https://docs.docker.com/build/building/multi-stage/)

Compose monte les données en écriture et les modèles et le YAML en lecture seule. L’application utilise des fichiers locaux et les volumes montés. Le conteneur fonctionne avec `network_mode: none`. Le téléchargement des poids et la construction de l’image se font hors du processus de traitement. [Guide d’exploitation](../deployment.md)

Le service publie un fichier d’activité dans `/run/pixelflow` après avoir vérifié la disponibilité des dossiers surveillés et la capacité à ouvrir une transaction d’écriture SQLite. Le fichier reste distinct de l’état durable. Le healthcheck vérifie sa fraîcheur et l’existence du processus. Une image individuelle en échec peut être archivée avec son diagnostic pendant que le service poursuit le travail.
