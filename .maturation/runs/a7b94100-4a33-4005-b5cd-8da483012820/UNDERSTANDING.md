`UNDERSTANDING.md` écrit. Voici le résumé de l'analyse :

**Score d'ambiguïté : 7/10**

L'intention est claire — un assistant financier personnel intégré au bot Telegram, avec consultation du solde La Banque Postale, suivi des dépenses et conseils budget.

Le **point bloquant critique** : La Banque Postale n'expose pas d'API publique OAuth simple. Les options techniques (agrégateur PSD2 payant comme Powens, solution open-source Woob, scraping web, import manuel CSV/OFX) ont chacune des contraintes majeures non résolues.

**5 questions de clarification** ont été formulées, dont les plus importantes :
1. Quelle méthode d'accès aux données bancaires ?
2. Comment gérer les credentials (stockage, OAuth, sans credentials) ?
3. Quel est le MVP minimal acceptable ?