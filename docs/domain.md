# Domaine

Ce vocabulaire sert à définir les comportements à tester lors des prochaines phases. Chaque type apparaîtra dans le code avec la règle qu’il porte.

| Concept                              | Sens dans PixelFlow                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `WatchFolder`                        | Source de fichiers associée à une définition de pipeline et à des destinations.                                     |
| `ImageAsset`                         | Original identifié dont les octets sont conservés au cours du traitement.                                           |
| `PipelineDefinition`                 | Description validée et ordonnée des étapes et variantes attendues.                                                  |
| `Pipeline`, `ProcessingStep`         | Exécution de cette définition par composition d’étapes configurées indépendamment.                                  |
| `ProcessingJob`, `JobStatus`         | Suivi d’une prise en charge, de ses tentatives et de son issue. Deux dépôts distincts peuvent partager le même nom. |
| `OutputArtifact`, `ProcessingResult` | Variante publiée et résultat global qui relie le job aux sorties attendues ou à l’erreur.                           |

## Invariants

- Transformer une représentation de travail et préserver les octets de l’original. Un fichier corrompu reste récupérable avec le diagnostic de décodage.
- Associer les événements répétés d’une même prise de possession au même travail. Une collision de nom ne doit écraser ni un original ni une sortie existante.
- Une pipeline réussit après publication de toutes les variantes attendues et archivage de l’original. Si l’archivage échoue après publication, la reprise doit pouvoir terminer l’archivage sans republier.
- Enregistrer le job, l’étape, la tentative et la cause en cas d’échec. Une erreur d’entrée définitive et une erreur d’infrastructure transitoire appellent des décisions de reprise différentes.
