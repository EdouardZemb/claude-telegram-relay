**CRITIQUE-PROD.md écrit.** Verdict : **CONCERNS**

## Résumé du double-pass

**5 MAJEURS, 3 MINEURS, 0 BLOQUANT**

Les findings clés :

| # | Sévérité | Titre |
|---|----------|-------|
| F-PC-1 | MAJEUR | Valeur différenciante vs YNAB/Bankin non justifiée — "pourquoi pas YNAB ?" sans réponse |
| F-PC-2 | MAJEUR | Pivot de domaine incompatible avec la vision orchestrateur dev |
| F-PC-3 | MAJEUR | 10-15 j/p pour 1 utilisateur vs backlog technique existant non traité |
| F-PC-4 | MAJEUR | App LBP native couvre déjà V1+V2 — adoption non garantie |
| F-PC-5 | MAJEUR | Données bancaires dans Supabase acceptées avec "on teste" — risque sécurité sans évaluation |
| F-PC-6 | MINEUR | Coût Powens récurrent inévitable pour la valeur "long terme" |
| F-PC-7 | MINEUR | Re-auth OAuth tous les 6 mois : vecteur d'abandon prévisible |
| F-PC-8 | MINEUR | Valeur "long terme" conditionnée à 2-3 mois de données minimum |

**Point central du Pass 2** : le signal le plus révélateur est R4 ("on teste, peut-être pas très longtemps") combiné à l'absence de toute friction documentée avec les outils actuels. Ce n'est pas une douleur — c'est de la curiosité. AR1 (CSV import, ~1-2 j/p) est le vrai test d'usage réel avant de committer 10-15 j/p sur Powens.