# ADR 0004 · Prise en charge dans un dossier surveillé

**Décision adoptée en Phase 2.** Un processus surveille un dossier d’entrée à plat et réserve un dossier de travail par prise en charge. L’identifiant du job relie le WebP, l’original et les journaux. Deux dépôts successifs portant le même nom ont chacun leur identifiant.

Sur un même volume, l’adaptateur déplace l’original par renommage. Si le système renvoie `EXDEV`, il copie dans un fichier temporaire du volume de destination, compare les empreintes SHA-256, vérifie l’identité et les dates de la source, puis synchronise la copie avant publication. La source est retirée après ces étapes. Un échec de suppression peut laisser deux copies, dont l’emplacement est consigné dans les journaux. Le service attend une période de stabilité, et un producteur peut signaler la fin de copie par un renommage.

Le dossier de sortie d’un job est préparé sur son volume avant publication. L’arrêt cesse les prises en charge et attend le traitement engagé. Les autres entrées restent disponibles pour le prochain scan. La réconciliation des fichiers déjà déplacés, des sorties et de l’historique est un jalon de la Phase 5.
