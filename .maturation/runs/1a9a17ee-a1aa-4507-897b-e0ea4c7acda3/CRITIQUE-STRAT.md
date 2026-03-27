`CRITIQUE-STRAT.md` écrit. Résumé du double-pass :

---

**Verdict : SHOWSTOPPER** — 2 bloquants, 4 majeurs, 4 mineurs.

**[BLOQUANT] F-SC-1 — Contradiction pipeline GoCardless**
RESEARCH dit "fermé depuis mi-2024" → V3 bloquée. ANALOGIES dit "Device Flow disponible, déblocage immédiat." Incompatible dans le même pipeline. La spec ne peut pas être écrite sans résoudre empiriquement en 30 min : GoCardless free tier accessible en 2026 ou non ?

**[BLOQUANT] F-SC-2 — Pivot CSV non validé avec l'utilisateur**
R1 : "L'idéal serait d'automatiser via des API d'agrégation." RESEARCH conclut "import CSV/OFX recommandé." Le compromis n'a jamais été présenté à l'utilisateur. Toute la spec repose sur une hypothèse que l'utilisateur n'a pas acceptée.

**[MAJEUR] F-SC-3** — Architecture V2 en migration active (SDD non testé en prod, 6 bugfixes actifs dans git log)

**[MAJEUR] F-SC-4** — NDJSON local ≠ "équivalent DB vectorielle" (R2) — plafond de verre pour l'objectif semi-auto → auto

**[MAJEUR] F-SC-5** — Compatibilité Bun de `ofx-data-extractor` non vérifiée (précédent : V4/V5 éliminées pour ce motif)

**[MAJEUR] F-SC-6** — Firefly III (meilleure recommandation d'EXPAND.md) complètement absent de RESEARCH.md

**Prérequis avant spec :** (1) tester GoCardless free tier empiriquement, (2) valider le pivot CSV avec l'utilisateur, (3) évaluer Firefly III comme alternative.