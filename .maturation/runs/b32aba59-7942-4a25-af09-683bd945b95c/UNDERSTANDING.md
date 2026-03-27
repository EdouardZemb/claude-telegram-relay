`UNDERSTANDING.md` écrit dans le répertoire de run.

**Résumé de l'analyse :**

- **Type** : Feature nouvelle (module bancaire complet)
- **Score d'ambiguïté : 4/10** — direction claire grâce aux clarifications, quelques points de design à trancher

**Points clés identifiés :**

1. **Agrégateur Powens** confirmé — mais connecteur LBP doit être vérifié (risque élevé si instable)
2. **OAuth DSP2** — seul point potentiellement bloquant : le consentement bancaire nécessite une redirection web, incompatible nativement avec Telegram
3. **Architecture codebase** : nouveau Composer `src/commands/banking.ts`, nouvelles tables Supabase (`bank_accounts`, `bank_transactions`, `budget_envelopes`), nouvelles env vars dans `config.ts`, sync périodique via `job-manager.ts`
4. **UX des enveloppes** — catégories fixes vs personnalisées, et budget mensuel vs annuel restent à définir

**3 questions prioritaires restantes :**
1. Gestion OAuth sans interface web (lien one-time vs mini-webapp)
2. Design des enveloppes (prédéfinies ou personnalisées, période mensuelle ou annuelle)
3. Planification long terme (projections automatiques vs objectifs manuels avec suivi)