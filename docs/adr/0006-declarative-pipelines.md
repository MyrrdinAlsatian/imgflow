# ADR 0006 · Pipelines déclaratives et publication par lot

**Décision adoptée en Phase 4.** YAML décrit les dossiers d’un pipeline et ses étapes. Valibot transforme ces données en une union discriminée. Le chargeur contrôle aussi la position des étapes, l’unicité des noms de sortie et la séparation des dossiers, y compris après résolution des ancêtres existants.

L’adaptateur Sharp exécute les étapes dans l’ordre et encode chaque variante depuis le résultat commun. Le service surveille tous les dossiers avec une file d’attente partagée. Les pipelines qui détournent des images utilisent une session BEN2 commune et sérialisent ses inférences.

Le répertoire temporaire et le répertoire publié se trouvent sur le même volume. Le stockage publie le lot par renommage lorsque le dernier encodeur a réussi. L’archive est écrite ensuite. Une erreur de conversion déclenche la conservation de l’original avec son diagnostic. L’historique et la reprise après interruption brutale relèvent de la Phase 5.
