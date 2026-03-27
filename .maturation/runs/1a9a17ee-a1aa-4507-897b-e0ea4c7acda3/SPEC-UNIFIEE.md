`SPEC-UNIFIEE.md` ecrite. Voici la synthese :

**Approche retenue** : V2 adaptee — Import CSV/OFX + budget hybride + `bun:sqlite` local-first + categorisation par regles avec fallback LLM anonymise.

**Decision cle** : `bun:sqlite` (built-in Bun, pas de dependance native) resout la tension centrale entre local-first et puissance analytique. Les donnees financieres ne quittent jamais le serveur — seuls les noms de marchands anonymises transitent vers l'API LLM en fallback.

**16 findings adresses** issus des 3 critiques :
- 6 BLOQUANTS → tous resolus ou flagges comme decision humaine
- Les 6 conflits inter-documents sont resolus avec justification

**4 phases incrementales** : MVP import (3-5j) → categorisation + plafonds (3-4j) → enveloppes + alertes (2-3j) → apprentissage + digest (2-3j)

**Score : 7/10 — Recommandation : HUMAN** — 2 decisions bloquantes avant implementation :
1. Accepter le pivot CSV/OFX (PSD2 inaccessible en 2026)
2. Valider l'envoi de noms de marchands anonymises a l'API Anthropic pour categorisation