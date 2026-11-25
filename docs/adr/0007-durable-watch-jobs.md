# ADR 0007 · Journal et reprise des jobs

**Décision adoptée en Phase 5.** Le module `node:sqlite` fourni par Node 24 stocke les jobs et les tentatives dans `jobs.sqlite`. L’état d’une tentative et celui du job progressent dans la même transaction. Un verrou SQLite détenu dans un fichier distinct réserve le répertoire d’état à un service et est libéré si le processus s’arrête. Les outils de lecture peuvent accéder à l’historique pendant le fonctionnement du service.

La prise en charge enregistre l’identifiant et l’empreinte de l’entrée avant son déplacement. Si une copie intervolume interrompue laisse l’entrée et l’original de travail, le service retire l’entrée seulement après vérification de son identité et de l’égalité des octets. Une nouvelle version du fichier sous le même nom reste un nouveau dépôt.

Un lot est encodé dans `.pixelflow-<id>` sur le volume de sortie, puis publié par renommage vers `output/<id>`. Le scan reprend l’archivage des lots publiés, termine les mises en échec interrompues et reprend les conversions dont le lot est encore en préparation. Le nettoyage de la préparation temporaire est limité au dossier du job. Les interruptions comptent dans le budget de tentatives, avec un délai exponentiel de 100 ms à 30 s. Un dépôt ayant plusieurs tentatives conserve un identifiant et un lot final.

Les originaux présents dans un dossier de travail de la Phase 4 sont adoptés lorsqu’ils se trouvent seuls sous un identifiant de job valide. Les lots temporaires anonymes et les jobs achevés avant la création du journal restent consultables sur disque. Garder les chemins du job et le journal disponibles pendant la reprise. Une arborescence de données appartient à un seul service et le volume d’état est local.
