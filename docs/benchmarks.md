# Protocole de mesure

## Reproduire le test BEN2

```sh
corepack pnpm model:prepare
corepack pnpm bench:ben2 chemin/vers/image.png
```

Le script mesure l’ouverture de la session, puis une première conversion à froid et trois conversions à chaud de la même image, en séquence. Il rapporte pour chacune le temps de la pipeline de masque (prétraitement, inférence et remise à l’échelle), le temps de conversion WebP, la taille de sortie et le pic RSS du processus. Le second argument sélectionne le répertoire du cache. [Révision du modèle](adr/0005-local-ben2.md)

## Premier essai sur CPU Windows x64

Node 24.14.0, AMD Ryzen 7 3700X (16 CPU logiques), ONNX Runtime Node 1.30.0, quatre threads intra-op. Ouverture de la session en **1,60 s**. Pic RSS du processus après quatre conversions de **4,42 Gio** (4 637 872 Kio). L’accès réseau par `fetch` était désactivé pendant le test.

La photo NASA d’Eileen Collins (512 × 512) provient du fichier `skimage/data/astronaut.png` de scikit-image v0.25.2. Son SHA-256 est `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`. Chaque sortie pèse 41 964 octets. [Fichier source](https://github.com/scikit-image/scikit-image/blob/v0.25.2/skimage/data/astronaut.png) · [Provenance et droits](https://scikit-image.org/docs/0.25.x/api/skimage.data.html#skimage.data.astronaut)

| Conversion | Pipeline du masque | Conversion WebP complète |
| ---------- | ------------------ | ------------------------ |
| À froid    | 11,016 s           | 11,092 s                 |
| À chaud 1  | 11,015 s           | 11,092 s                 |
| À chaud 2  | 10,604 s           | 10,682 s                 |
| À chaud 3  | 10,428 s           | 10,505 s                 |

Le dossier surveillé compilé a produit un WebP RGBA 512 × 512 et une archive identique à la source. L’alpha décodé vaut 0 au point de fond (10, 10) et 254 au point du sujet (220, 100). L’image de référence ne fournit pas de masque annoté. Cet essai vérifie le parcours complet et laisse l’évaluation de la qualité sur un corpus et la validation Linux ouvertes.

## Conditions reproductibles

1. Décrire CPU, nombre de cœurs disponibles, RAM, OS, architecture, versions de Node et des dépendances, configuration de la pipeline et concurrence. Pour l’IA, noter le backend, la précision, la révision, la somme SHA-256 du modèle et les limites mémoire du processus ou conteneur.
2. Constituer un corpus réutilisable avec droits documentés. Enregistrer format, dimensions, taille et somme de contrôle de chaque image. Inclure images orientées par EXIF, grands fichiers, portraits aux contours fins et fonds proches du sujet. Réserver les entrées corrompues à la mesure des échecs.
3. Préparer le modèle localement, désactiver tout accès distant et travailler sur des copies. Faire une série à froid après redémarrage du processus. Distinguer ouverture de session, chargement du modèle et première image. Puis préchauffer sur une image exclue des mesures et réutiliser la session.

## Exécution et compte rendu

- Commencer avec un seul job. Rejouer le même corpus avec les mêmes temps d’arrivée et la même concurrence pour chaque configuration. Répéter au moins trois fois et publier le nombre d’images et de répétitions. Mesurer séparément une montée en charge destinée à estimer le débit maximal.
- Chronométrer l’attente en file, le traitement et le délai du dépôt prêt jusqu’à la publication. Rapporter les latences p50 et p95 **à charge égale**, le débit en images par minute, les erreurs et les tailles de sortie. Pour un petit échantillon, joindre les durées individuelles.
- Mesurer le pic RSS du processus avec le système d’exploitation et consigner l’outil utilisé. Inclure le modèle, les tampons d’image et les allocations natives. Sur une limite mémoire définie, vérifier le devenir du job et de l’original en cas d’arrêt.
- Pour le détourage, vérifier les dimensions et le canal alpha sur fonds clair et sombre. Avec des masques de référence, mesurer l’erreur absolue moyenne de l’alpha et inspecter cheveux, bords fins et zones semi-transparentes. Conserver les sorties représentatives avec la révision du modèle.
- Livrer les données brutes, les conditions et les commandes avec les résultats. Comparer les configurations à sortie et qualité comparables. Définir les seuils d’acceptation sur le matériel Linux cible avant de retenir un modèle.
