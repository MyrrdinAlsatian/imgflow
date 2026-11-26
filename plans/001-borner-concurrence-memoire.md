# Plan 001 : Borner la concurrence par budget mémoire

> **Instructions d’exécution** : suivre les étapes dans l’ordre. Exécuter chaque
> vérification avant de poursuivre. En cas de condition d’arrêt, s’arrêter et
> rapporter le blocage. À la fin, mettre à jour le statut dans
> `plans/README.md`. Ne pas créer de commit, pousser ou déployer sans autorisation.
>
> **Vérification de dérive (première étape)** :
> `git diff --stat 7bc197b..HEAD -- src/infrastructure/watch-config.ts src/infrastructure/configured-watch.ts tests/configured-watch.test.ts docs/configuration.md docs/benchmarks.md docs/adr/README.md docs/adr/0010-concurrence-memoire.md`
> Si un fichier de ce périmètre a changé depuis le commit de référence, comparer
> les extraits ci-dessous au code actuel avant de continuer. Toute divergence
> non expliquée est une condition d’arrêt.

## Statut

- **Priorité** : P2
- **Effort** : M
- **Risque** : MED
- **Dépend de** : aucun
- **Catégorie** : performance
- **Planifié au** : commit `7bc197b`, 2026-11-26

## Pourquoi

La configuration accepte toute valeur entière positive pour `settings.concurrency`,
puis la transmet à la file globale. Chaque décodage peut matérialiser jusqu’à
64 millions de pixels dans un tampon RGBA, et le modèle BEN2 a déjà mesuré un
pic de 4,42 Gio RSS. Le déploiement documente 6 Gio disponibles : lancer plusieurs
jobs simultanément avec BEN2 peut dépasser cette enveloppe et arrêter tout le
service. Ce plan impose un seul job global lorsque BEN2 est activé et borne les
pipelines sans BEN2 à partir d’une mesure faite sous le budget de 6 Gio.

## État actuel

- `src/infrastructure/watch-config.ts` valide les réglages YAML. `positive` ne
  fixe aucun maximum et `concurrency` vaut 1 par défaut :

  ```ts
  const positive = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
  // ...
  concurrency: v.optional(positive, 1),
  ```

- `src/infrastructure/configured-watch.ts` détecte les pipelines BEN2 et
  sérialise leurs inférences, mais transmet ensuite `settings.concurrency` au
  service. Cette file d’inférence ne limite donc pas le nombre de jobs en cours.
- `src/infrastructure/watch-folder.ts` crée une seule file partagée pour tous
  les dossiers avec `new PQueue({ concurrency })`.
- `src/infrastructure/sharp-image.ts` fixe `inputPixelLimit` à `64_000_000`.
  `readRgba` matérialise les pixels avec quatre octets par pixel.
- `docs/benchmarks.md` rapporte 4,42 Gio RSS après quatre conversions BEN2 sur
  Windows et précise que le pic Linux reste à mesurer. `docs/deployment.md`
  demande au moins 6 Gio disponibles.
- La configuration est validée par Valibot, les tests sont hors ligne et le
  projet utilise Node `>=24.14.0 <25` avec `pnpm@10.34.9`. Les messages et
  identifiants du code restent en anglais; la documentation reste en français.

## Commandes de vérification

| Objet | Commande | Résultat attendu |
| ----- | -------- | ---------------- |
| Tests ciblés | `corepack pnpm test -- tests/configured-watch.test.ts` | Tous les tests de configuration et de concurrence passent. |
| Vérification complète | `corepack pnpm check` | Format, lint, types, build, tests et démarrage compilé réussissent sous Node 24. |
| Mesure BEN2 | `corepack pnpm bench:ben2 <image-de-test>` | Rapport reproductible du temps et du pic RSS avec cache local. |

Ne pas installer de dépendance pour ce changement. Les mesures de modèles réels
restent une validation dédiée; les tests ordinaires utilisent les doubles
existants et fonctionnent hors ligne.

## Périmètre

**Fichiers modifiables** :

- `src/infrastructure/watch-config.ts`
- `src/infrastructure/configured-watch.ts`
- `tests/configured-watch.test.ts`
- `docs/configuration.md`
- `docs/benchmarks.md`
- `docs/adr/README.md`
- `docs/adr/0010-concurrence-memoire.md` (nouveau)
- `plans/README.md`

**Hors périmètre** :

- modifier la limite d’entrée de 64 Mpx ou le comportement des transformations Sharp;
- ajouter une détection dynamique de mémoire hôte/cgroup ou un ordonnanceur pondéré;
- modifier Docker Compose pour imposer une limite mémoire à l’hôte;
- paralléliser les inférences BEN2;
- ajouter ou modifier le connecteur HTTP, qui n’est pas présent dans le commit de référence;
- ajouter des dépendances ou changer les formats de configuration existants.

## Étapes

### 1. Mesurer une borne sûre sous 6 Gio

Sur une machine Linux Node 24 avec le cache BEN2 local, mesurer le pic RSS
conformément à `docs/benchmarks.md`, sous une limite mémoire de 6 Gio. Mesurer
séparément :

1. un pipeline avec BEN2, `concurrency: 1`, et plusieurs dépôts simultanés;
2. un pipeline sans BEN2, avec une image proche de la limite 64 Mpx, puis une
   montée graduelle de concurrence;
3. chaque configuration au moins trois fois, avec le même corpus et les mêmes
   arrivées de fichiers.

Pour le pipeline sans BEN2, retenir le plus grand nombre de jobs dont le pic RSS
maximal reste sous 4,5 Gio (75 % du budget). Le reste réserve de la marge au
processus, au système et aux variations de charge. Pour BEN2, conserver une
concurrence globale de 1 selon le choix validé par l’opérateur.

**Vérifier** : consigner dans `docs/benchmarks.md` le matériel Linux, la limite
mémoire, la configuration, les dimensions, le nombre de répétitions et le pic
RSS. Le maximum retenu doit être reproductible et strictement inférieur ou égal
à 4,5 Gio.

### 2. Valider et appliquer la politique de concurrence

Dans `src/infrastructure/watch-config.ts`, définir une limite explicite pour la
concurrence des pipelines sans BEN2, déterminée à l’étape 1. Rejeter une valeur
supérieure à cette limite avec un message indiquant le champ `settings.concurrency`.
Après validation du YAML, détecter si au moins une étape de pipeline utilise
`remove-background`; si oui, rejeter toute valeur de concurrence supérieure à 1.
Ne pas accepter silencieusement une valeur puis en appliquer une autre.

Garder la limite globale à un seul réglage partagé entre pipelines, conformément
à `docs/configuration.md` et `src/infrastructure/watch-folder.ts`. Ne pas modifier
la file d’inférence BEN2 : elle doit rester sérialisée.

**Vérifier** : `corepack pnpm test -- tests/configured-watch.test.ts` réussit avec
des cas couvrant la valeur par défaut, la limite sans BEN2, une valeur juste
au-dessus, BEN2 à concurrence 1 et BEN2 à concurrence 2 rejetée.

### 3. Documenter la règle et sa décision

Mettre à jour `docs/configuration.md` pour décrire :

- le maximum mesuré et accepté pour les pipelines sans BEN2;
- la règle de concurrence globale égale à 1 dès qu’un pipeline utilise BEN2;
- le rejet explicite d’une configuration dépassant ces limites;
- le budget de référence de 6 Gio et le fait que les limites sont conservatrices,
  pas une détection automatique de la RAM disponible.

Mettre à jour `docs/benchmarks.md` avec les résultats reproductibles de l’étape 1.
Créer `docs/adr/0010-concurrence-memoire.md` et l’ajouter à l’index. L’ADR doit
consigner le budget de 6 Gio, la règle BEN2, la méthode ayant déterminé la limite
sans BEN2 et les conséquences si l’opérateur dispose de moins de mémoire.

**Vérifier** : relire les deux documents et vérifier que les valeurs concordent
avec la limite réellement implémentée et les mesures de l’étape 1. Les chemins
des fichiers et la syntaxe de configuration cités doivent être exacts.

### 4. Exécuter les contrôles du dépôt

**Vérifier** : `corepack pnpm check` termine avec succès sous Node 24. Le statut
Git ne montre que les fichiers du périmètre. Rapporter séparément les systèmes
sur lesquels les mesures et les tests ont été exécutés.

## Plan de test

- Dans `tests/configured-watch.test.ts`, suivre le style des tests existants de
  chargement YAML et de pipelines.
- Tester la valeur par défaut, les valeurs valides aux bornes, le rejet au-dessus
  de la limite sans BEN2, et le rejet de toute concurrence supérieure à 1 si un
  pipeline contient `remove-background`.
- Vérifier qu’un pipeline sans BEN2 à concurrence 1 reste valide et ne nécessite
  aucun modèle ni accès réseau.
- Ne pas utiliser une mesure RSS comme assertion de test unitaire : elle dépend
  de l’OS et du matériel. La mesurer uniquement dans la validation dédiée décrite
  à l’étape 1.

## Critères de fin

- [ ] BEN2 et plusieurs pipelines partagent une concurrence effective de 1; une
      configuration BEN2 supérieure est rejetée avant le démarrage du watcher.
- [ ] La concurrence sans BEN2 est bornée par le maximum mesuré sur Linux sous
      6 Gio; une valeur au-dessus est rejetée.
- [ ] Les cas de validation cités dans le plan passent hors ligne.
- [ ] `corepack pnpm check` réussit avec Node 24.
- [ ] `docs/configuration.md`, `docs/benchmarks.md` et l’ADR correspondent aux
      valeurs testées et au comportement du code.
- [ ] Aucun fichier hors périmètre n’est modifié; `plans/README.md` est actualisé.

## Conditions d’arrêt

- Si une validation ne peut pas être exécutée sous Node 24, ne pas la remplacer
  par une validation sous une version non supportée.
- Si le pic RSS d’un job BEN2 dépasse 6 Gio, ou si aucune concurrence sans BEN2
  ne reste sous 4,5 Gio, s’arrêter et rapporter le résultat; ne pas inventer de
  maximum ni modifier les limites d’image.
- Si une limite de mémoire de 6 Gio ou un modèle BEN2 local n’est pas disponible,
  ne pas prétendre avoir vérifié la politique mémoire; demander une validation
  sur le matériel cible.
- Si l’application de la limite requiert de modifier le port de journal, le
  comportement de reprise ou les formats YAML hors de ce périmètre, s’arrêter
  et proposer un plan distinct.

## Maintenance

Toute augmentation de `inputPixelLimit`, modification de la pipeline avant BEN2
ou activation d’une inférence parallèle invalide les mesures de référence et
nécessite de refaire le benchmark sous 6 Gio. La revue doit vérifier que le
maximum YAML, la politique BEN2, l’ADR et les mesures restent cohérents. Les
machines disposant de plus de mémoire peuvent toujours choisir une valeur dans
la limite conservatrice; l’extension de cette limite nécessite de nouvelles
mesures et une décision documentée.
