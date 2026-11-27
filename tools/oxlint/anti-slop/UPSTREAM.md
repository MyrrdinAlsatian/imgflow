# Provenance anti-slop

## Source

Le contenu générique a été copié par le script `install-anti-slop` depuis le
snapshot embarqué dans la compétence utilisée pour cette installation. Le
bundle ne fournit ni dépôt amont ni commit immuable pour l’ensemble du plugin :
la révision amont est donc inconnue. Le snapshot source reste récupérable dans
les assets de cette compétence et les fichiers installés n’ont pas été adaptés
localement lors de la copie.

Le sous-module `vendor/eslint-stylistic` conserve sa propre provenance dans
[`vendor/eslint-stylistic/UPSTREAM.md`](./vendor/eslint-stylistic/UPSTREAM.md),
avec le commit ESLint Stylistic `435c3ea0fd26a5fef9042c4b36b6e165fbbf8d08`.

## Installation

- Point d’entrée générique : `tools/oxlint/anti-slop/index.ts`.
- Plugin optionnel Effect fourni par le snapshot :
  `tools/oxlint/anti-slop/effect/index.ts`.
- Dépendance associée : `@oxlint/plugins@1.95.0`, alignée sur
  `oxlint@1.95.0`.
- Configuration : [`.oxlintrc.json`](../../../.oxlintrc.json).

## Écarts intentionnels

- Seul le plugin générique est enregistré. Le plugin Effect n’est pas activé,
  car `effect` n’est pas une dépendance directe du projet.
- Les règles sont activées à `error`, avec `oxc/no-accumulating-spread` en
  complément de `anti-slop/no-reduce-accumulator-copy`.
- Le dossier vendored est ignoré par Oxlint et Oxfmt afin que les outils du
  projet n’altèrent pas les sources importées.
