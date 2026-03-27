`DEVILS-ADVOCATE.md` écrit dans le répertoire de run.

---

**Résumé de la passe adversariale :**

**Verdict : PASS** — aucun SHOWSTOPPER, mais 3 angles morts significatifs identifiés que les critiques précédentes ont tous manqués car focalisées sur Powens/V3.

**Findings clés :**

| # | Axe | Titre |
|---|-----|-------|
| AM-1 | Angle mort | CSV MIME exclus du handler document existant — prémisse "réutilise" invalide en l'état |
| AM-2 | Angle mort | Contamination mémoire dev par les données financières via `autoRemember` |
| AM-3 | Angle mort | Edge Function `embed` sur chaque transaction → ~2400-4800 appels d'embedding à l'import initial |
| HNT-1 | Hypothèse | Estimation "2-3 j/p" sous-évalue le périmètre Phase 0 réel (6 sous-systèmes → estimé 5-9 j/p) |
| HNT-2 | Hypothèse | Idempotence par hash fragile si libellés LBP contiennent des références variables |
| HNT-3 | Hypothèse | Format CSV LBP potentiellement ISO-8859-1/point-virgule, pas UTF-8/virgule |
| ESO-1 | Effet 2nd ordre | Chevauchement handlers CSV si DOCUMENT_MIME_TYPES étendu ultérieurement |
| ESO-2 | Effet 2nd ordre | Valeur long terme conditionnée à discipline d'import mensuel non garantie |

**Recommandation :** Obtenir un CSV LBP réel avant tout développement — ce fichier répond à HNT-2, HNT-3, et la "question ouverte #1" de la SPEC-UNIFIEE simultanément. Corriger l'estimation Phase 0 en conséquence.