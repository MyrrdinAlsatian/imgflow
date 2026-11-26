# Plans d’implémentation

Plans produits après la revue d’architecture du commit `7bc197b` (2026-11-26).
Exécuter dans l’ordre indiqué. L’exécuteur lit chaque plan au complet, respecte
ses conditions d’arrêt et met à jour son statut après exécution.

## Ordre et statut

| Plan | Titre | Priorité | Effort | Dépendances | Statut |
| ---- | ----- | -------- | ------ | ----------- | ------ |
| 001 | Borner la concurrence par budget mémoire | P2 | M | — | TODO |

## Dépendances

Aucune.

## Constats écartés

- Extraire immédiatement `src/domain/` et `src/application/steps/` : la
  documentation les présente comme une architecture cible et aucun défaut
  fonctionnel ne justifie une refonte avant un besoin concret.
