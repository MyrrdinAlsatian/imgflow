# ADR 0003 · Conversion WebP et publication

**Décision adoptée en Phase 1.** Le port de conversion reçoit un chemin d’entrée et de sortie, des dimensions maximales et une qualité. L’adaptateur Sharp détecte le format, rejette les entrées hors périmètre, applique l’orientation EXIF et redimensionne sans agrandir. Le WebP est encodé avec la conversion colorimétrique par défaut de Sharp et sans recopier les métadonnées.

L’adaptateur encode dans un répertoire temporaire privé sous le dossier de destination. Une fois l’encodage terminé, un lien physique publie le fichier complet avec une opération qui échoue si la destination existe. Le nettoyage retire le nom temporaire. Cela protège les sorties existantes et l’original, y compris si plusieurs processus visent la même destination. Le dossier de sortie doit accepter les liens physiques, comme NTFS ou ext4. Un arrêt brutal peut laisser un répertoire temporaire identifiable.
