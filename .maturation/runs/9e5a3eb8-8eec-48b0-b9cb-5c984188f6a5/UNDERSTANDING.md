`UNDERSTANDING.md` écrit. Voici le résumé de l'analyse :

**Score d'ambiguïté : 6/10** — intention claire, contraintes techniques significatives.

Points clés identifiés :
- **Choix d'agrégateur décisif** : Powens ou Bridge (FR-natifs) nettement préférables à Plaid pour La Banque Postale
- **Problème SCA non résolu** : le flux OAuth2 avec authentification forte dans une interface conversationnelle Telegram est le défi principal de l'implémentation
- **Rôle "agent" ambigu** : affichage passif de données vs agent IA analysant les dépenses — deux périmètres très différents
- **Stockage tokens sensible** : access/refresh tokens bancaires nécessitent une décision sécurité explicite
- **Pattern codebase** : `src/transcribe.ts` (intégration SDK externe) + `src/config.ts` (Zod secrets) sont les modèles directs à suivre