# API HTTP des jobs

- Statut : accepted
- Date : 2026-11-28
- Périmètre : réception d’images, suivi des jobs et téléchargement des sorties

## Contexte

Un client HTTP doit obtenir un identifiant dès l’acceptation de l’image, puis
suivre le traitement et télécharger les variantes. Le dossier surveillé, le
journal et la publication par lot fournissent déjà le cycle de vie.

## Décision

Activer l’adaptateur Node HTTP dans le mode YAML via `settings.http`. Le client
choisit un pipeline existant dans l’URL et envoie un fichier binaire. Sharp valide
le décodage avant admission. Le service écrit et synchronise l’original dans un
dossier provisoire, puis le renomme vers le dossier de traitement portant l’UUID.
Le journal enregistre un job `pending`, ensuite soumis à la même file que les
dépôts sur disque. Après le renommage, la réconciliation peut adopter l’original
avec le même UUID si le processus est interrompu avant l’écriture SQLite.

Le reçu utilise `202 Accepted`, avec l’URL de suivi, les variantes déclarées
et une estimation dérivée des rendus réussis du pipeline. Le suivi lit SQLite
et les téléchargements servent les variantes du lot publié dans le répertoire
configuré. Les diagnostics et les chemins internes restent dans les journaux
du service. Les adresses d’écoute hors boucle locale exigent un jeton partagé.

## Alternatives écartées

Le statut `204 No Content` ne prévoit aucun corps. Le dépôt de l’image dans
le dossier surveillé reporterait l’attribution de l’UUID et le reçu jusqu’à
l’observation de stabilité. La connexion HTTP se termine au moment de
l’admission, avant l’exécution du pipeline.

## Conséquences

Les deux types d’entrée partagent les limites de concurrence du rendu, les
reprises et l’archivage. La validation HTTP décode l’image avant le traitement.
Elle s’effectue sur un envoi à la fois pour borner la mémoire utilisée par
l’admission. Une répétition du POST complet crée un autre job.

## Vérification et retour arrière

Les tests HTTP démarrent le service configuré, soumettent une image, vérifient
les sorties et relisent le même job après redémarrage. Ils couvrent aussi des
images invalides, l’échec d’un pipeline et l’authentification. Retirer le bloc
`settings.http` au redémarrage coupe l’écoute HTTP. Le journal et son répertoire
de traitement permettent de reprendre les jobs déjà acceptés.
