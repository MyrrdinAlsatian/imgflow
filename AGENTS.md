# Travailler sur PixelFlow

- Limiter chaque changement à la phase demandée. Consulter les critères de la [roadmap](docs/roadmap.md) avant d’ajouter une fonctionnalité ou une dépendance.
- Écrire le code, les identifiants et les messages du programme en anglais. Rédiger la documentation du projet en français. Consigner les décisions structurantes et leurs conséquences dans `docs/adr/`.
- Conserver le typage strict. Recevoir les données externes en `unknown`, les valider à la frontière et utiliser une union discriminée quand les opérations dépendent du type. Privilégier les fonctions pures, les valeurs immuables et les erreurs explicites.
- Garder le domaine et les cas d’utilisation indépendants des bibliothèques d’infrastructure. Introduire un port lorsqu’un cas concret doit appeler un adaptateur. Assembler les dépendances au point d’entrée. Voir les [responsabilités](docs/architecture.md).
- Utiliser la version de pnpm épinglée. Pour une dépendance nouvelle, vérifier les moteurs et pairs requis, ainsi que les binaires Windows et Linux si elle contient du code natif. Mettre à jour le verrouillage avec le manifeste.
- Tester les effets observables et les chemins d’échec. Les tests ordinaires doivent fonctionner hors ligne. Utiliser des doubles pour le port d’inférence et réserver les essais de modèles réels aux validations dédiées.
- Exécuter `corepack pnpm check` avant livraison. Rapporter les plateformes vérifiées et toute validation encore en attente. Attendre une autorisation explicite pour créer un commit, pousser ou déployer.
