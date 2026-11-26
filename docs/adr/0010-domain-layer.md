# ADR 0010 · Extraction de la couche domaine

- Statut : accepted
- Date : 2026-11-26
- Périmètre : `src/domain/`, `src/application/`, imports de `src/infrastructure/`

## Contexte

Le dossier `src/domain/` était vide. Les types métier (étapes, variantes, statuts de job), les règles pures (nom de fichier d’une variante, bornes WebP, politique de reprise) et les ports cohabitaient dans `src/application/`. Les bornes numériques (16 383 pixels, qualité 100, 64 millions de pixels, limites des effets) étaient dupliquées entre le cas d’utilisation, le schéma Valibot et l’adaptateur Sharp.

## Décision

`src/domain/` regroupe les valeurs et règles pures, sans import de bibliothèque ni de Node :

- `image.ts` : bornes d’image et d’effets, `ImageDimensions`, `WebpSettings`, `validateWebpSettings`.
- `image-pipeline.ts` : union discriminée `PipelineStep`, `ImageVariant`, `variantFileName`.
- `job.ts` : statuts, `JobRecord`, `JobOutcome`, valeurs par défaut, `canRetry` et `retryDelayMs`.

`src/application/` ne garde que les cas d’utilisation et leurs ports (`JobJournal`, `WebpConverter`, `BackgroundRemover`, `JobRenderer`, `WatchJobStorage`). Le schéma YAML et Sharp lisent leurs bornes dans le domaine. Aucun module ne réexporte les anciens chemins.

## Alternatives écartées

- **Créer `src/application/steps/` maintenant.** Le registre d’étapes vit dans `src/infrastructure/sharp-pipeline.ts` et manipule directement des objets Sharp. Le déplacer exigerait un port d’opérations d’image abstrayant Sharp. Ce port n’a qu’un seul adaptateur et aucun besoin concret aujourd’hui. Il ajouterait de l’indirection sans bénéfice testable. À revoir si un second moteur d’image ou des tests d’étapes sans Sharp deviennent nécessaires.
- **Réexporter les types depuis `application/`.** Deux chemins pour un même type brouilleraient la frontière. Les importeurs ont été mis à jour.

## Conséquences

- Les bornes ont une source unique. Une modification se répercute sur la validation CLI, le schéma YAML et le décodage.
- La politique de reprise est testable sans journal ni stockage.
- Comportement inchangé : seuls des imports et des constantes ont bougé.

## Vérification et retour arrière

`corepack pnpm check` passe sous Node 24 sur Linux. Pour revenir en arrière, revenir sur le commit : aucune donnée ni configuration n’est touchée.
