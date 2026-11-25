# Vision

PixelFlow s’adresse à l’opérateur d’un serveur Linux qui reçoit régulièrement des images à préparer pour le web. Il doit pouvoir déposer un fichier, récupérer les variantes publiées et retrouver l’original, y compris si le traitement échoue.

Chaque dossier d’entrée sera associé à une pipeline déclarative. Les premières opérations couvriront l’orientation, le redimensionnement et la conversion WebP. Le détourage local, le recadrage et les sorties multiples étendront ensuite ce parcours. Le traitement restera possible hors ligne après la mise à disposition locale des modèles.

Le MVP cible un processus autonome sur CPU, exploitable via les fichiers et les journaux, avec un déploiement Docker sous Linux et un développement possible sous Windows. L’interface web, l’API REST, Python, Redis et les services d’IA hébergés sont hors périmètre. L’architecture et la documentation doivent permettre une réutilisation open source. La licence du projet devra être choisie avant sa distribution.

Les [jalons](roadmap.md) indiquent quand chaque capacité devient vérifiable.
