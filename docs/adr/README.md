# Architecture Decision Records

Ce dossier contient les décisions durables de PixelFlow. Une ADR est utile
lorsqu’une décision affecte plusieurs applications, une frontière de confiance,
un contrat public, un stockage, une permission ou une opération difficilement
réversible.

Ne pas créer d’ADR pour un renommage local, une correction évidente ou une
préférence qui ne contraint pas la suite du projet.

## Décisions

- [ADR 0001 · Runtime et outillage](0001-runtime-and-tooling.md)
- [ADR 0002 · Frontières des dépendances](0002-dependency-boundaries.md)
- [ADR 0003 · Conversion WebP et publication](0003-webp-conversion.md)
- [ADR 0004 · Prise en charge dans un dossier surveillé](0004-watch-folder.md)
- [ADR 0005 · Détourage local avec BEN2](0005-local-ben2.md)
- [ADR 0006 · Pipelines déclaratives et publication par lot](0006-declarative-pipelines.md)
- [ADR 0007 · Journal et reprise des jobs](0007-durable-watch-jobs.md)
- [ADR 0008 · Image Docker et contrôle de fonctionnement](0008-container-runtime.md)
- [ADR 0009 · Administration du journal](0009-journal-administration.md)
- [ADR 0010 · Extraction de la couche domaine](0010-domain-layer.md)
- [ADR 0011 · Recadrage automatique du sujet](0011-auto-crop.md)
- [ADR 0012 · Copyright et filigrane](0012-image-branding.md)
- [ADR 0013 · API HTTP des jobs](0013-http-jobs.md)

## Format

Nommer les fichiers avec un numéro et un sujet court, puis utiliser ce modèle :

## Titre

- Statut : proposed, accepted, superseded ou rejected
- Date :
- Périmètre :

### Contexte

Décrire le problème, les invariants, les contraintes et le negative space.

### Décision

Décrire le choix et ses frontières.

### Alternatives écartées

Expliquer les options importantes non retenues.

### Conséquences

Décrire les bénéfices, coûts, risques, migrations et effets sur les tests.

### Vérification et retour arrière

Décrire les preuves attendues et le plan de rollback si nécessaire.

Préserver l’historique : une nouvelle décision remplace l’ancienne par son
statut, sans réécrire son contenu.
