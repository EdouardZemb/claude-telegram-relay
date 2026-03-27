`CRITIQUE-TECH.md` écrit. Voici le résumé du double-pass :

---

**Résultat : SHOWSTOPPER**

**1 BLOQUANT — F-TC-1 : Idempotence des transactions**
Le `pm2 restart` après chaque deploy tue les syncs Powens en cours. Sans `UNIQUE(transaction_id)` + UPSERT dans le DDL, chaque relance duplique les transactions → corruption garantie des calculs d'enveloppes. C'est la seule correction non négociable avant spec.

**5 MAJEURS** à traiter dans la spec :
- F-TC-2 : Token Powens (accès bancaire DSP2) stocké sans chiffrement applicatif dans Supabase
- F-TC-3 : Endpoint callback OAuth public sans validation `state` CSRF
- F-TC-4 : Contrainte S9 déjà à 20/20 — 2+ nouvelles env vars Powens cassent la CI immédiatement
- F-TC-5 : Expiration token 180j sans circuit-breaker — syncs silencieux en échec pendant des semaines
- F-TC-6 : N+1 implicite sur la catégorisation — 300-800 appels LLM pour la sync initiale si non batchée

**4 MINEURS** : mode dégradé LBP, abstraction `BankProvider` (testabilité S8), polling Device Flow sur Semaphore, index DB `bank_transactions`.