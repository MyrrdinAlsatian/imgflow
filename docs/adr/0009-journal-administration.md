# ADR 0009 · Administration du journal

**Décision adoptée en Phase 7.** Le CLI lit le journal local en lecture seule pour l’historique et les métriques. La validation YAML réutilise le même chargeur que le service. Les commandes de consultation restent compatibles avec les journaux de la Phase 5.

Une relance manuelle crée un job et son lien vers le job en échec dans une seule transaction SQLite. La contrainte d’unicité rend deux demandes pour le même job idempotentes. Au scan, le service prépare la copie de l’original dans le nouveau dossier de travail. Ce dossier et le nouveau job suivent ensuite la reprise et le budget de tentatives ordinaires. L’original en échec et son historique restent disponibles.

Le CLI et le service partagent le journal. Le verrou du service s’applique au traitement des fichiers, et les transactions SQLite arbitrent l’ajout des demandes de relance. Les mesures du CLI proviennent des tentatives enregistrées. [Commandes et métriques](../administration.md)
