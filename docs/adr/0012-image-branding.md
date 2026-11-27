# ADR 0012 · Copyright et filigrane

**Décision adoptée.** Le copyright est conservé dans l’état du rendu puis encodé en XMP à chaque export. Cela permet d’utiliser du texte Unicode et de conserver la mention quand une transformation reconstruit les pixels. Les métadonnées issues de la source suivent la politique habituelle de suppression.

Le filigrane est une transformation de pixels. Il compose une image locale sur le cadre courant en combinant son canal alpha et l’opacité configurée. Son emplacement dans la pipeline détermine les transformations ultérieures qui s’appliquent au filigrane. [Configuration](../configuration.md#copyright-et-filigrane)
