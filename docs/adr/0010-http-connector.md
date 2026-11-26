# ADR 0010 · Connecteur HTTP pour les pipelines

- Statut : accepted
- Date : 2026-11-26
- Périmètre : dépôt, suivi et téléchargement par HTTP

## Contexte

Un client HTTP doit obtenir un identifiant dès le dépôt, sans attendre une inférence. Les dépôts sur disque doivent continuer à fonctionner, et les variantes ne doivent pas devenir accessibles avant la publication du lot.

## Décision

Un serveur HTTP Node facultatif reçoit le corps binaire dans un répertoire temporaire invisible pour la réconciliation. Après validation et écriture complète, il publie atomiquement ce répertoire dans `processing/<id>` puis inscrit et planifie le travail dans le journal existant. Si le service s’arrête entre le renommage et l’inscription, la réconciliation peut adopter l’original.

L’API et le formulaire partagent une origine et un jeton Bearer. Le formulaire ne stocke pas le jeton. Les téléchargements sont limités aux variantes publiées de jobs terminés. Compose conserve son isolation par défaut ; la surcharge HTTP ouvre un port sur la boucle locale pour un proxy HTTPS.

## Alternatives écartées

- Attendre la conversion dans le `POST` couplerait la durée des connexions à celle de BEN2.
- Déposer dans `input/` seul ne donnerait pas l’identifiant durable au client avant l’admission par le watcher.
- Un second service avec sa propre file dupliquerait le suivi et la reprise.

## Conséquences

Pas de nouveau modèle ni de dépendance de production. Le jeton donne un accès partagé et n’isole pas les clients. Le proxy assure TLS et le contrôle de débit ; l’exploitant surveille l’espace disque. Une requête répétée crée un nouveau job.

## Vérification et retour arrière

Tester l’envoi, la consultation et le téléchargement après redémarrage, ainsi que l’authentification et le rejet des corps invalides. Pour revenir au mode hors ligne, retirer la surcharge Compose sans modifier les volumes ni le journal.
