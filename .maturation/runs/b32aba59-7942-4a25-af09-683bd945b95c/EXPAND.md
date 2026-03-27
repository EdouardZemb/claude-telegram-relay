`EXPAND.md` écrit dans le répertoire de run.

**Résumé de l'expansion :**

- **5 variantes** : V1 MVP (solde seul, S) → V5 assistant financier complet (XXL)
- **3 alternatives radicales** :
  - AR1 Import CSV manuel (XS, risque Low) — meilleur ratio effort/valeur/risque
  - AR2 Saisie conversationnelle (S) — zéro dépendance, réutilise `zz-messages.ts`
  - AR3 Enrichissement mémoire (S) — zéro nouvelle table, pattern `/brain`
- **5 extensions** : multi-banque, OCR factures, simulation épargne, coût-par-projet, export fiscal

**Point saillant** : AR1 (export CSV depuis l'app LBP + handler document existant) est l'alternative la plus solide pour un premier sprint — elle contourne entièrement le blocage OAuth DSP2/Telegram, coûte zéro, et livre 80% de la valeur des variantes V3-V4.