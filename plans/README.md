# Plans d’implémentation

Plans produits après la revue d’architecture du commit `7bc197b` (2026-11-26).
Exécuter dans l’ordre indiqué. L’exécuteur lit chaque plan au complet, respecte
ses conditions d’arrêt et met à jour son statut après exécution.

## Ordre et statut

| Plan | Titre                                    | Priorité | Effort | Dépendances | Statut |
| ---- | ---------------------------------------- | -------- | ------ | ----------- | ------ |
| 001  | Borner la concurrence par budget mémoire | P2       | M      | —           | TODO   |

## Dépendances

Aucune.

## Constats écartés

- Créer `src/application/steps/` : exige un port abstrayant Sharp sans second
  adaptateur ni besoin concret. `src/domain/` a été extrait à la demande (ADR 0010).
