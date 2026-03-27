`EXPAND.md` écrit dans le répertoire de run.

**Résumé de l'expansion** :

5 variantes générées (S → XXL) + 3 alternatives radicales qui questionnent les hypothèses fondamentales :

- **V1** — Import CSV/OFX + enveloppes JSON locales (effort S, zéro risque, opérationnel en quelques heures)
- **V2** — Agrégation PSD2 (GoCardless) + OAuth2 + catégorisation par règles (effort M)
- **V3** — Budget hybride complet + semi-auto LLM + stockage local-first chiffré (effort L, correspond à l'intention déclarée)
- **V4** — V3 + moteur d'apprentissage auto + heartbeat hebdomadaire + objectifs épargne (effort XL)
- **V5** — IA prédictive + multi-comptes/banques + anomalies + vue patrimoine (effort XXL)

Alternatives radicales :
- **AR1** — Full conversationnel/vocal (zéro OAuth, s'appuie sur `transcribe.ts` déjà dispo, effort S)
- **AR2** — Supabase-first avec chiffrement AES-256-GCM côté client (abandonne le local-first, garde toute la puissance analytique Supabase existante)
- **AR3** — Firefly III auto-hébergé comme moteur budgétaire (bot = frontend conversationnel uniquement, scope divisé par 3)

**Point clé stratégique** : **AR3 + AR2** offre le meilleur ratio valeur/effort/risque — Firefly III fournit le moteur mature, Supabase chiffré donne la cohérence architecturale. V3 reste la voie souveraine si on préfère tout construire in-house.