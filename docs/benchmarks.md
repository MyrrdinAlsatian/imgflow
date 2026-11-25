# Protocole de mesure

La première campagne de traitement d’images démarrera avec le moteur de Phase 1. Le protocole de détourage s’appliquera à la Phase 3.

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
