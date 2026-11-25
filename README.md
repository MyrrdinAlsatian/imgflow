# PixelFlow

PixelFlow est un projet de moteur de traitement d’images auto-hébergé. À terme, déposer une image dans un dossier déclenchera une suite d’opérations locales et la publication de variantes pour le web.

**La Phase 1 permet de convertir une image locale en WebP.** La surveillance des dossiers arrive en Phase 2.

## Installer et lancer

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
