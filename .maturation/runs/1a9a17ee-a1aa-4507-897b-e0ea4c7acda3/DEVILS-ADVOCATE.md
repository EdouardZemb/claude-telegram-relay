**DEVILS-ADVOCATE.md écrit.** Voici le résumé des findings :

**Verdict : SHOWSTOPPER** — 3 angles morts, 3 hypothèses non testées, 2 effets de second ordre.

| # | Type | Finding |
|---|------|---------|
| AM-1 | **BLOQUANT** | `classify-thought` Edge Function envoie GPT-4o-mini chaque message conversationnel financier — chemin nominal, 100% des interactions |
| AM-2 | MAJEUR | `NotificationType` enum fermé (`"task"\|"pr"\|"idea"\|"alert"`) — alertes budget routées vers le thread dev sprint sans modification de code |
| AM-3 | MAJEUR | Aucune stratégie de migration SQLite pour les 4 phases incrémentales — `bank.db` phase 1 incompatible avec le schéma phase 3 |
| HNT-1 | **ÉLEVÉ** | "Local-first" couvre les transactions OFX, pas les conversations — `saveMessage` ligne 206 de `zz-messages.ts` cloud-stocke 100% des requêtes texte |
| HNT-2 | **ÉLEVÉ** | Anonymisation "noms marchands" insuffisante RGPD Art.9 — séquences temporelles = profil médical inférable sans PII explicite |
| HNT-3 | MOYEN | `llm-ops.ts` n'a pas de rôle `finance-categorizer` — coûts finance noyés dans les coûts dev, `/cost` inutilisable pour les deux |
| ESO-1 | MOYENNE | Dégradation permanente de l'index sémantique `documents.ts` si le fix MIME type régresse (vecteurs non réversibles) |
| ESO-2 | HAUTE | Dérive silencieuse du système d'apprentissage par sous-catégorisation implicitement confirmée |

Le SHOWSTOPPER porte sur **HNT-1 + AM-1 combinés** : la spec affirme "les données financières ne quittent jamais le serveur" mais `saveMessage` + `classify-thought` constituent un pipeline cloud qui s'applique à 100% des interactions conversationnelles, indépendamment du stockage SQLite des transactions.