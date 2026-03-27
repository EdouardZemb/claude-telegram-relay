`ANALOGIES.md` écrit. Voici le résumé :

**5 analogies cross-domaines :**

1. **Système immunitaire** (biologie) — Score de confiance cumulatif par règle marchand→catégorie : confirmations implicites → score monte, corrections → score baisse, seuil haut = silence automatique
2. **Zonage adaptatif** (urbanisme) — Budget hybride : zones protégées (enveloppes fixes, intransférables) + zones souples (plafonds) + corridors de transfert avec confirmation + tampon central absorbeur
3. **Rationnement de guerre** (systèmes humains) — Transférabilité asymétrique : les enveloppes protégées ne peuvent pas être ponctionnées, mais les surplus des souples alimentent l'épargne automatiquement ; solde glissant naturel
4. **Progression RPG** (jeux vidéo) — Règles à 3 niveaux de maturité (question / proposer / silence), XP = confirmations, dégradation si erreurs trop fréquentes, visible via `/finance rules`
5. **Circuit avec fusibles** (électronique) — Alertes progressives : 80% = avertissement, 100% = fusible (notification urgente), surplus = charge condensateur (épargne auto)

**5 solutions adjacentes :** YNAB (enveloppes reportées), Actual Budget (local-first NDJSON sans SQLite), OAuth2 Device Flow RFC 8628 (débloque le problème redirect_uri), GoCardless/Nordigen (PSD2 gratuit avec requisition link natif), catégorisation ML hybride (Codat/Genify patterns)

**Patterns les plus actionnables :** Device Flow RFC 8628 (déblocage architectural immédiat), Score de confiance par règle (semi-auto → auto sans dépendance ML), NDJSON append-only (local-first conforme ADR-001, déjà prouvé dans `maturation/documents.ts`)