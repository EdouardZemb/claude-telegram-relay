`CRITIQUE-PROD.md` écrit. Voici le résumé du double-pass :

---

**Verdict : SHOWSTOPPER** — 2 bloquants, 4 majeurs, 3 mineurs

**Bloquants :**

1. **F-PC-1** — La vision déclarée (automatisation PSD2) est confirmée irréalisable par RESEARCH.md, et le pivot vers l'import manuel n'a jamais été explicitement soumis à l'utilisateur pour validation. Spécifier sans cette validation revient à spécifier le mauvais produit.

2. **F-PC-2** — La catégorisation semi-auto (cœur de la valeur) envoie les libellés bancaires à `callClaude()` → API Anthropic externe. Contradiction directe avec l'intention local-first exprimée en R2, non traitée dans tout le pipeline.

**Majeurs :**
- F-PC-3 : coût d'opportunité élevé vs roadmap S34-S44 active
- F-PC-4 : Actual Budget (local-first, OFX, enveloppes, mature) jamais éliminé formellement
- F-PC-5 : changement de comportement manuel sous-estimé, adoption long-terme douteuse
- F-PC-6 : feature creep hors domaine core (dev workflow → personal finance)

**Point d'action avant spec** : re-valider avec l'utilisateur (1) l'abandon de l'automatisation au profit de l'import manuel, et (2) le modèle de catégorisation sans transit de données financières vers l'API externe.