RESEARCH.md écrit. Voici les points clés de l'analyse :

**Découverte critique** : GoCardless est fermé aux nouveaux inscrits depuis mi-2024, et Powens/Bridge sont exclusivement B2B — V3 (PSD2 automatisé) est **bloquée** pour un usage personnel en 2026.

**Analyse par variante** :
- **V1 Manuelle** : éliminée (friction éliminatoire)
- **V2 CSV/OFX + LLM** : **Modérée, recommandée** — La Banque Postale exporte bien OFX v1 SGML + CSV (4 mois)
- **V3 PSD2** : Très difficile, bloquée (GoCardless fermé, Powens B2B)
- **V4/V5** : éliminées (dépendent de V3 + bindings natifs incompatibles Bun)
- **AR2 PDF** : Modérée, complémentaire 2-4 j/p (`pdf-parse` déjà dans le projet)

**Librairie clé** : `ofx-data-extractor` (TypeScript, mode lenient pour OFX v1 SGML, MIT) — seule solution pour le format La Banque Postale.

**5 conditions de succès** : fix AM-1 (interception MIME avant `documents.ts`), calibration sur un vrai fichier La Banque Postale, interface `BankDataSource` abstraite pour V3 future, chiffrement AES-256-GCM sélectif dès le premier sprint, KPI taux d'escalade catégorisation < 20% à 3 mois.