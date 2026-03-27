`ANALOGIES.md` écrit dans le répertoire de run.

**Résumé des trouvailles :**

**4 analogies cross-domaines :**
1. **Biologie / Compartiments métaboliques** — hiérarchie de réservoirs temporels (immédiat → mensuel → sécurité → long terme) avec règles de rechargement et seuils d'alerte
2. **Réseaux / Token Bucket** — enveloppe mensuelle = bucket rechargé en début de mois, chaque dépense consomme des tokens, dépassement = alerte immédiate
3. **IoT / RFC 8628 Device Flow** — résout directement le blocage OAuth : lien one-time envoyé dans Telegram, polling côté bot, aucune infra web custom nécessaire
4. **Jeux de stratégie** — afficher burn-rate + projection fin de mois + engagements futurs connus, pas seulement le solde courant

**Solutions adjacentes clés :**
- YNAB : forward allocation + enveloppes fluides ("Roll with the punches")
- Actual Budget : open source, reconciliation workflow propre
- Pipeline Plaid/Powens : enrichissement en 4 étapes (import → normalisation → catégorisation → stockage)

**3 patterns prioritaires à retenir pour la spec :** Device Flow OAuth, Transaction Enrichment Pipeline découplé, et Token Bucket + Projection burn-rate comme cœur UX.