# ADR 0011 · Recadrage automatique du sujet

- Statut `accepted`
- Date 2026-11-27
- Périmètre Phase 4, étape déclarative `auto-crop`

## Contexte

Après détourage, le sujet peut toucher le bord ou être entouré de pixels isolés. Le cadre doit conserver plusieurs parties significatives du sujet, respecter le ratio et la marge et garder les pixels de la source jusqu’à l’optimisation finale.

## Décision

Le registre Sharp exécute une étape optionnelle après `remove-background` ou sur une image autonome. Le domaine reçoit les pixels RGBA et réduit le masque par présence de premier plan dans chaque cellule. Les composantes connexes à huit voisins permettent d’écarter les petites régions isolées du calcul. Le domaine projette leurs limites sur la source et calcule le plus petit canevas au ratio demandé contenant la boîte augmentée de sa marge. Sharp applique la découpe et ajoute les pixels nécessaires hors de la source.

Le réglage `padding` accepte une valeur commune ou des marges minimales indépendantes. Le domaine applique ces marges avant de répartir l’espace supplémentaire qu’impose le ratio.

## Alternatives écartées

Un simple cadre englobant serait sensible aux pixels isolés. Garder uniquement la plus grande composante pourrait couper une partie détachée du sujet. Un rééchantillonnage de l’image d’analyse pourrait faire disparaître un contour fin. La réduction par présence préserve ce signal dans le masque.

## Conséquences

La lecture du tampon RGBA reste proportionnelle au nombre de pixels de la source. Le masque et la file des composantes sont bornés par la résolution d’analyse. À faible résolution, des éléments proches peuvent se retrouver dans des cellules voisines et être retenus ensemble.

L’absence de sujet transmet l’image à l’étape suivante avec ses dimensions et ses pixels. Un canevas qui dépasse les limites existantes suit le parcours d’erreur du job.

## Vérification et retour arrière

Les tests couvrent la géométrie, le filtrage, les sujets aux bords, l’alpha conservé et l’enchaînement après un double de détourage. Pour retirer le recadrage d’une pipeline, désactiver l’étape ou retirer son entrée YAML.
