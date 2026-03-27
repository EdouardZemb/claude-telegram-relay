`CRITIQUE-TECH.md` écrit. Résumé du double-pass :

---

**Verdict : SHOWSTOPPER — 2 BLOQUANTS · 6 MAJEURS · 2 MINEURS**

| # | Sévérité | Finding |
|---|----------|---------|
| F-TC-1 | BLOQUANT | **AES-256-GCM sans threat model** — clé dans `.env` sur le même disque que les données = chiffrement de façade + irrécouvrabilité si perte de clé |
| F-TC-2 | BLOQUANT | **Fuite RGPD** — libellés transactions (santé, religion, politique inférables) envoyés à l'API Anthropic, décision non résolue dans les 4 documents |
| F-TC-3 | MAJEUR | **Conflit AM-1** — caption "releve" dans `zz-messages.ts` intercepte les relevés OFX/CSV vers `documents.ts` → Supabase non chiffré |
| F-TC-4 | MAJEUR | **Race condition NDJSON** — job-manager background + callback confirmation = appends concurrents sans locking → corruption silencieuse |
| F-TC-5 | MAJEUR | **Absence déduplication FITID** — exports La Banque Postale chevauchants → doublons → calculs budgétaires faux |
| F-TC-6 | MAJEUR | **N+1 LLM sans batching** — 300-500 appels/import, 10-17 min de latence, flooding Telegram |
| F-TC-7 | MAJEUR | **Schéma scoring confiance indéfini** — aucun type ni emplacement pour les règles merchant→catégorie avec XP |
| F-TC-8 | MINEUR | NDJSON plat vs "DB vectorielle" — `bun:sqlite` natif non évalué |
| F-TC-9 | MINEUR | `ofx-data-extractor` : Bun + ISO-8859-1 non testés |
| F-TC-10 | MINEUR | Device Flow RFC 8628 incompatible PSD2/SCA — erreur de catégorie |

**Points clés du Pass 2 :** F-TC-1 consolidé (threat model + irrécouvrabilité = un seul BLOQUANT) ; F-TC-2 promu BLOQUANT (RGPD Art.9 + décision structurante non résolue) ; F-TC-4 (race condition) ajouté — absent du run précédent ; F-TC-7 (schéma scoring) ajouté — le moteur RPG de ANALOGIES.md est une dette architecturale non spécifiée. Les deux BLOQUANTS doivent être résolus avant la spec car ils déterminent si le module est local-first avec modèle LLM local, ou cloud avec consentement explicite.