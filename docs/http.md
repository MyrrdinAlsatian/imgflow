# Envoyer des images par HTTP

Le connecteur est facultatif. Déposer des fichiers dans le dossier surveillé reste possible avec ou sans HTTP. Les deux modes utilisent les mêmes pipelines, le même journal SQLite et les mêmes dossiers d’archive et de sortie.

## Activer le connecteur

1. Préparer les volumes et le cache BEN2 en suivant le [guide Docker Compose](deployment.md).
2. Créer un jeton aléatoire : `openssl rand -hex 32`. Dans le dépôt, créer un fichier `.env.http` privé (`chmod 600 .env.http`) contenant `PIXELFLOW_HTTP_TOKEN=` suivi du jeton. Ce fichier est ignoré par Git. Ne pas partager le jeton dans une URL ou un journal.
3. Depuis la racine du dépôt, démarrer ou recréer le service avec la surcharge HTTP :

   ```sh
   docker compose --env-file .env.http -f compose.yaml -f compose.http.yaml up -d --build
   ```

4. Ouvrir `http://127.0.0.1:8080/` sur le serveur. Saisir le jeton, cliquer sur **Load pipelines**, sélectionner `web` et charger une image. Le formulaire affiche l’identifiant et l’état du traitement, puis propose les variantes à télécharger. Garder l’identifiant pour reprendre le suivi plus tard.

Le port hôte est publié uniquement sur `127.0.0.1`. Pour le changer, ajouter `PIXELFLOW_HTTP_PORT` dans `.env.http`. Compose conserve le port interne `8080`. Réutiliser les deux fichiers Compose pour les mises à jour et les recréations du service avec HTTP.

## Donner un accès distant

Sur le même hôte, configurer un proxy inverse HTTPS sur un sous-domaine dédié. Faire suivre `/`, `/app.js` et `/api/` avec leurs chemins d’origine et conserver l’en-tête `Authorization`. Exemple de bloc à placer dans un hôte virtuel Nginx **déjà configuré en HTTPS** :

```nginx
location / {
    client_max_body_size 20m;
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Authorization $http_authorization;
}
```

Le jeton est partagé : ses détenteurs peuvent déposer dans tous les pipelines et consulter ou télécharger tout résultat dont ils connaissent l’identifiant, y compris les résultats des dossiers surveillés. Réserver l’accès à des clients de confiance. Ajouter au proxy une restriction d’accès adaptée (VPN, liste d’adresses ou contrôle d’identité) et une limite de débit. Ne pas mettre en cache les réponses ni journaliser l’en-tête `Authorization`. Le connecteur ne gère ni comptes, ni quotas cumulés, ni purge automatique ; surveiller l’espace disque occupé par les entrées, les sorties et les archives.

## Appeler l’API

Tous les appels ci-dessous attendent `Authorization: Bearer <jeton>`. Remplacer `BASE_URL` par l’adresse HTTPS du proxy (ou l’adresse de boucle locale pour un test sur l’hôte) et fournir `PIXELFLOW_HTTP_TOKEN` au client via un canal sûr.

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $PIXELFLOW_HTTP_TOKEN" \
  -H 'Content-Type: image/jpeg' \
  --data-binary @photo.jpg \
  "$BASE_URL/api/v1/pipelines/web/jobs"
```

Le corps est **le fichier brut**, pas un formulaire `multipart`. Envoyer un JPEG, PNG ou WebP à une seule image, au plus 20 Mio et 64 millions de pixels. Utiliser respectivement `image/jpeg`, `image/png` ou `image/webp`. Le nom de l’original archivé est `upload.jpg`, `upload.png` ou `upload.webp` dans le dossier du job.

Une réponse `202 Accepted` fournit `id`, `status` et `statusUrl`. Suivre `statusUrl` (également retournée dans l’en-tête `Location`) pour attendre `completed`, `failed` ou `cancelled`. Un fichier accepté dont les pixels ne peuvent pas être décodés peut passer à `failed` malgré la validation initiale des en-têtes.

| Méthode et chemin                        | Résultat                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/pipelines`                  | `200` · Identifiants dans `pipelines`.                                                                               |
| `POST /api/v1/pipelines/{pipeline}/jobs` | `202` · Dépôt pris en charge de façon asynchrone.                                                                    |
| `GET /api/v1/jobs/{id}`                  | `200` · `id`, `pipeline`, `status`, `attempts`, `files` (chaque fichier contient `name` et `url` après `completed`). |
| `GET /api/v1/jobs/{id}/files/{name}`     | `200` · Fichier publié, en pièce jointe. Les originaux et diagnostics internes ne sont pas servis.                   |

```sh
curl --fail-with-body -H "Authorization: Bearer $PIXELFLOW_HTTP_TOKEN" \
  "$BASE_URL/api/v1/jobs/$JOB_ID"

curl --fail -H "Authorization: Bearer $PIXELFLOW_HTTP_TOKEN" \
  "$BASE_URL/api/v1/jobs/$JOB_ID/files/image.webp" -o image.webp
```

Erreurs possibles : `400` (corps vide), `401` (jeton absent ou invalide), `404` (pipeline, job, fichier ou route inconnu), `413` (taille dépassée), `415` (type non accepté), `422` (image invalide ou type incompatible), `429` (deux envois déjà en cours). Les erreurs applicatives contiennent un champ `error`. En cas de coupure avant de recevoir le `202`, un dépôt peut déjà avoir été enregistré ; la répétition du `POST` n’est pas idempotente.

## Désactiver le connecteur

Retirer la route du proxy puis recréer le service avec `docker compose -f compose.yaml up -d --force-recreate`. Les jobs et les fichiers existants restent disponibles sur disque. Le service repasse en mode sans réseau.
