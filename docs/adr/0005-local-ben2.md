# ADR 0005 · Détourage local avec BEN2

**Décision adoptée en Phase 3.** PixelFlow utilise `onnx-community/BEN2-ONNX` à la révision `c552aa82688edce09f0ac9d2e31ad53d9d629010`, avec le graphe FP16 de 219 121 675 octets. Le cache contient les deux fichiers de configuration et le graphe. La commande `pnpm model:prepare` vérifie leurs sommes SHA-256 avant utilisation. [Révision de l’export](https://huggingface.co/onnx-community/BEN2-ONNX/tree/c552aa82688edce09f0ac9d2e31ad53d9d629010)

La licence MIT figure dans le dépôt de code de Prama LLC et dans les métadonnées des poids BEN2 et de leur export ONNX. Le paquet et le dépôt PixelFlow ne distribuent aucun poids. [Licence du code BEN2](https://github.com/PramaLLC/BEN2/blob/main/LICENSE) · [Poids amont](https://huggingface.co/PramaLLC/BEN2) · [Fiche de l’export épinglé](https://huggingface.co/onnx-community/BEN2-ONNX/blob/c552aa82688edce09f0ac9d2e31ad53d9d629010/README.md)

Transformers.js 4.3.2 fournit le prétraitement et le masque de segmentation. Il utilise son backend ONNX Runtime Node 1.30.0 avec le fournisseur CPU, jusqu’à quatre threads intra-op et un thread inter-op. Les binaires CPU sont inclus dans le paquet natif. Au démarrage, l’adaptateur exige les fichiers locaux et désactive le chargement distant. Le téléchargement explicite est indépendant du démarrage. [Backend Node](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)

Le cas Windows x64 a été vérifié avec une photo et une session locale. Le comportement et le budget mémoire restent à vérifier sur le serveur Linux cible. [Protocole et mesures](../benchmarks.md)
