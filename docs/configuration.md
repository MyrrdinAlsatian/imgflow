# Configuration YAML cible

La lecture de ce format est prévue en Phase 4. En Phase 0, le point d’entrée s’exécute directement et ne lit aucun fichier de configuration.

```yaml
version: 1
settings:
  concurrency: 1
  maxRetries: 3
  scanIntervalSeconds: 60
  modelCache: /models
  logLevel: info
pipelines:
  portraits:
    watch: /data/input/portraits
    output: /data/output/portraits
    archive: /data/archive/portraits
    failed: /data/failed/portraits
    steps:
      - type: normalize
      - type: remove-background
        model: ben2
      - type: trim
        padding: 0.05
      - type: resize
        width: 800
        height: 800
        fit: contain
        background: transparent
      - type: export
        variants:
          - format: webp
            quality: 85
          - format: avif
            quality: 65
```

## Lecture et validation prévues

- `version` sélectionne le schéma. `settings` regroupe la limite de jobs simultanés, les nouvelles tentatives après le premier essai, la période de réconciliation en secondes, le répertoire des modèles et le niveau de log. La reprise persistante et le scan périodique relèvent de la Phase 5.
- Chaque clé de `pipelines` identifie une pipeline. Les chemins d’entrée et de destination doivent permettre d’exclure toute réingestion des sorties, archives, échecs et fichiers temporaires.
- `steps` est une séquence ordonnée. Valibot validera une union discriminée par `type` avant la construction des étapes. La normalisation corrige l’orientation, le détourage produit une transparence, le recadrage utilise une marge relative et le redimensionnement définit les dimensions finales.
- L’export terminal déclare les variantes. Les formats cibles sont WebP, AVIF, PNG et JPEG. La qualité dépend de l’encodeur. Pour JPEG, une couleur de fond opaque devra être définie si le résultat intermédiaire contient de la transparence.
- Valider l’ensemble au démarrage avant de prendre possession d’un fichier. Une version inconnue, une étape indisponible ou une dimension invalide doit faire échouer le démarrage avec le chemin du champ concerné, par exemple `pipelines.portraits.steps[3].width`.
