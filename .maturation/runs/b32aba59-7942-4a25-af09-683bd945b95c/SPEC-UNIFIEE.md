`SPEC-UNIFIEE.md` ecrit. Voici le resume :

**Approche retenue : AR1 (Import CSV) en Phase 0, V3 (Powens) conditionnelle en Phase 1**

Les 3 critiques convergent : la douleur n'est pas validee (R4 : "on teste"), AR1 livre 80% de la valeur pour 10% de l'effort, et le SHOWSTOPPER roadmap est resolu par le choix d'un effort XS.

**Perimetre Phase 0** : import CSV LBP via Telegram, categorisation batch, enveloppes token bucket, burn-rate + projections, snapshots mensuels.

**Risques critiques adresses** :
- F-TC-1 (idempotence) → `UNIQUE(user_id, external_id)` + UPSERT dans le DDL
- F-SC-1 (conflit roadmap) → AR1 s'insere sans conflit (2-3 j/p)
- F-TC-6 (N+1 categorisation) → batch rules-based + LLM fallback groupe
- F-TC-4 (S9 env vars) → zero nouvelle env var pour AR1

**6 conflits resolus**, tous tranches en faveur de l'approche incrementale.

**Score : 7/10 — PROCEED**. Unique prerequis bloquant : question ouverte #1 (fichier CSV exemple LBP).