# ADR 0001 · Runtime et outillage

**Décision adoptée en Phase 0.** Une seule application privée utilise Node.js 24 LTS, TypeScript strict, ESM natif et pnpm 10 épinglé. Le poste de référence dispose de Node 24.14.0. La même branche sert au développement Windows et à la future exécution Linux.

Node lance directement les sources TypeScript en développement. Le compilateur limite la syntaxe à celle que Node peut effacer, vérifie les types puis produit du JavaScript ESM pour l’exécution. Vitest teste le point d’entrée dans un autre processus. Vite est une dépendance de développement requise comme pair de Vitest. Oxlint et Oxfmt couvrent respectivement l’analyse statique et le formatage.

Le manifeste fixe les versions directes, le lockfile fixe la résolution transitive. Les mises à jour des outils natifs doivent passer les contrôles du projet et la vérification des plateformes. Les dépendances d’exécution arriveront avec leurs premiers appels métier. La [roadmap](../roadmap.md) donne leur ordre d’intégration.
