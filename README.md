# PixelFlow

PixelFlow est un projet de moteur de traitement d’images auto-hébergé. À terme, déposer une image dans un dossier déclenchera une suite d’opérations locales et la publication de variantes pour le web.

**La Phase 0 fournit le socle exécutable.** Son lancement affiche `PixelFlow foundation is ready.` puis le processus se termine avec le code 0. Le premier traitement d’image est prévu en Phase 1 et la surveillance des dossiers en Phase 2.

## Installer et lancer

Utiliser Node.js 24 LTS (24.14.0 minimum) avec Corepack. Depuis la racine du dépôt, lancer les commandes suivantes. Corepack lit le champ `packageManager` pour sélectionner pnpm 10.34.9. Le premier téléchargement des outils nécessite un accès au registre npm.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm start
```

Sous Windows avec PowerShell, utiliser `corepack.cmd pnpm` si les scripts PowerShell sont bloqués. Si un ancien lanceur renvoie `MODULE_NOT_FOUND`, `Get-Command corepack.cmd -All` liste les installations. Utiliser le lanceur situé à côté de `node.exe` dans l’installation de Node 24.

Après le build, `node dist/main.js` suffit pour exécuter la fondation hors ligne. Le processus utilise uniquement Node.js. Il démarre depuis n’importe quel répertoire de travail, sans modèle, fichier YAML ni préparation de volumes.

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
