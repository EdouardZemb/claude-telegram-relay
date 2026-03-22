# Spec : Phase d'exploration optionnelle dans le workflow PRD-to-Deploy

> Généré le 2026-03-22. Source : analyse de prd-workflow.ts, exploration.ts, exploration-scoring.ts, planning.ts + interview utilisateur (1 round).

## 1. Objectif

Le workflow PRD-to-Deploy (F1→F7) ne propose pas de phase d'exploration avant la génération du PRD. L'utilisateur peut donc produire un PRD basé sur des hypothèses non validées, sans état de l'art ni analyse du codebase existant. Cette spec ajoute un bouton "Explorer d'abord" après le triage (F1), permettant à l'utilisateur de lancer l'agent Explorer (Ada) avant de créer le PRD. Le rapport d'exploration alimente ensuite la génération du PRD.

## 2. Règles métier

| # | Règle | Source | Exemple |
|---|-------|--------|---------|
| R1 | Après le triage (F1), un bouton "Explorer d'abord" est affiché en plus des boutons existants | Réponse user Q1c | Keyboard: [Explorer d'abord] [Creer le PRD] [Juste une tache] [Annuler] |
| R2 | Le bouton d'exploration est toujours visible, le choix revient à l'utilisateur | Réponse user Q1c | Pas de scoring automatique, pas de seuil de difficulté |
| R3 | Le rapport d'exploration complet est affiché dans le chat | Réponse user Q2b | Verdict, alternatives, état de l'art, archéologie codebase |
| R4 | Si le verdict est PIVOT, le bot propose une reformulation et relance l'exploration | Réponse user Q3b | "L'exploration suggère un pivot. Reformulez votre besoin :" |
| R5 | Si le verdict est DROP, le bot propose une reformulation et relance l'exploration | Réponse user Q3b | "L'exploration déconseille cette approche. Reformulez ou annulez :" |
| R6 | Si le verdict est GO, le bot affiche le rapport puis propose "Creer le PRD" avec le contexte d'exploration enrichi | Logique métier | Le PRD est généré avec le résumé exploration en contexte |
| R7 | L'exploration utilise l'agent Ada avec détection de recherche web (Tavily si pertinent) | Code existant exploration.ts | Mots-clés web → Sonnet + Tavily, sinon Haiku + codebase |
| R8 | Le rapport d'exploration est stocké pour enrichir la description du PRD | Logique métier | buildEnrichedDescription() inclut le résumé exploration |
| R9 | L'exploration s'exécute en background via job-manager | Pattern existant preflight | Job tag PRDWF_EXPLORED:{prdKey} |
| R10 | Pas de feature flag supplémentaire, la fonctionnalité est toujours disponible via le bouton | Simplicité | Le bouton est présent dès que prd_to_deploy est actif |

## 3. Données d'entrée

| Source | Type | Accès | Champs utilisés |
|--------|------|-------|-----------------|
| Description utilisateur | string | pendingDescriptions Map | Description triée en F1 |
| Session conversationnelle | ConversationSession | conversation-session.ts | Contexte enrichi (constraints, historique) |
| Code graph | CodeGraph | code-graph.ts | Analyse structurelle du codebase |
| Tavily (optionnel) | API externe | MCP tools via mcpRole "explorer" | Recherche web si intention détectée |

## 4. Données de sortie

| Donnée | Format | Destination |
|--------|--------|-------------|
| Rapport d'exploration | Plain text (pas de markdown) | Message Telegram |
| Verdict | GO / PIVOT / DROP | Logique de routage (R4/R5/R6) |
| Résumé exploration | string | pendingExplorations Map → enrichissement PRD |

## 5. Fichiers concernés

| Fichier | Action | Raison |
|---------|--------|--------|
| src/prd-workflow.ts | modifier | Ajouter buildTriageKeyboardWithExplore(), stocker/récupérer le résumé exploration, enrichir buildEnrichedDescription() avec contexte exploration |
| src/commands/planning.ts | modifier | Ajouter callbacks prdwf_explore et prdwf_explore_go, gérer le résultat exploration (verdict routing), reformulation sur PIVOT/DROP |
| src/commands/exploration.ts | exporter | Extraire la logique d'invocation Explorer en fonction réutilisable (runExploration) |
| src/action-registry.ts | modifier | Mettre à jour la description de /prd_workflow pour mentionner l'exploration optionnelle |
| CLAUDE.md | modifier | Section PRD-to-Deploy : documenter la phase d'exploration optionnelle |

## 6. Patterns existants

### Boutons inline du triage (prd-workflow.ts)
Le triage (F1) construit un InlineKeyboard avec 3 boutons. Le nouveau bouton s'insère en première position :

```typescript
// Actuel
keyboard.text("Creer le PRD", `prdwf_create`);
keyboard.text("Juste une tache", `prdwf_task`);
keyboard.text("Annuler", `prdwf_cancel`);

// Nouveau
keyboard.text("Explorer d'abord", `prdwf_explore`);
keyboard.text("Creer le PRD", `prdwf_create`);
keyboard.text("Juste une tache", `prdwf_task`);
keyboard.text("Annuler", `prdwf_cancel`);
```

### Stockage état pending (prd-workflow.ts)
Pattern existant avec TTL 10 minutes :

```typescript
const pendingExplorations = new Map<string, { summary: string; verdict: string }>();

export function storePendingExploration(key: string, summary: string, verdict: string): void {
  pendingExplorations.set(key, { summary, verdict });
  setTimeout(() => pendingExplorations.delete(key), 10 * 60 * 1000);
}
```

### Invocation Explorer (exploration.ts)
La logique d'invocation de l'agent Ada est actuellement dans le handler /explore. Elle doit être extraite en fonction réutilisable :

```typescript
export async function runExploration(
  query: string,
  bctx: BotContext
): Promise<{ report: string; verdict: string; summary: string }>;
```

### Job-manager background (pattern preflight)
Le même pattern que runPrdPreflightChecks : lancer un job background, parser le tag résultat, afficher le rapport et les boutons.

```typescript
// Tag format
`PRDWF_EXPLORED:${chatKey}|${verdict}|${summaryFirstLine}`

// Job-manager notification → planning.ts callback
```

### Enrichissement description PRD
buildEnrichedDescription() dans prd-workflow.ts ajoute déjà les constraints de session. Ajouter le résumé exploration :

```typescript
if (explorationSummary) {
  parts.push(`Contexte exploration (agent Ada) :\n${explorationSummary}`);
}
```

## 7. Flow détaillé

```
F1: Triage
  ↓
  Boutons: [Explorer d'abord] [Creer le PRD] [Juste une tache] [Annuler]
  ↓
  Si "Explorer d'abord" (prdwf_explore):
    → Lancer job Explorer (Ada) en background
    → Message: "Agent Ada explore le sujet..."
    → Job terminé → rapport complet affiché dans le chat
    ↓
    Si verdict = GO:
      → Boutons: [Creer le PRD] [Relancer l'exploration] [Annuler]
      → Si "Creer le PRD" (prdwf_explore_go):
        → Stocker résumé exploration → F2 avec contexte enrichi
    ↓
    Si verdict = PIVOT ou DROP:
      → Message: "L'exploration suggère de reformuler. Décrivez votre besoin autrement :"
      → Boutons: [Relancer l'exploration] [Creer le PRD quand meme] [Annuler]
      → Si reformulation texte reçue:
        → Nouvelle description → relancer exploration
      → Si "Creer le PRD quand meme":
        → F2 avec contexte exploration (malgré verdict négatif)
  ↓
  Si "Creer le PRD" (prdwf_create) — flow existant inchangé:
    → F2: Génération PRD (sans exploration)
```

## 8. Gestion d'erreur

| Scénario | Comportement |
|----------|-------------|
| Explorer timeout (> 5min) | Job-manager cancel automatique, message "Exploration interrompue, vous pouvez créer le PRD directement" + boutons [Creer le PRD] [Réessayer] [Annuler] |
| Tavily indisponible | Explorer continue en mode codebase-only, le rapport mentionne l'absence de recherche web |
| Verdict parsing échoue | Traiter comme GO (conservative), warning dans le rapport |
| Reformulation après PIVOT/DROP | Nouvelle exploration complète avec la description reformulée, même flow |

## 9. V-Critères (validation)

| # | Critère | Méthode de vérification |
|---|---------|------------------------|
| V1 | Le bouton "Explorer d'abord" apparaît après le triage | Test unitaire : buildTriageKeyboard inclut prdwf_explore |
| V2 | Le callback prdwf_explore lance un job Explorer | Test unitaire : mock job-manager, vérifier launchJob("prdwf-explore") |
| V3 | Le rapport complet est affiché dans le chat | Test unitaire : mock sendResponse, vérifier contenu ≥ 200 chars |
| V4 | Verdict GO → boutons [Creer le PRD] [Relancer] [Annuler] | Test unitaire : vérifier keyboard après verdict GO |
| V5 | Verdict PIVOT → message reformulation + boutons [Relancer] [Creer quand meme] [Annuler] | Test unitaire : vérifier message et keyboard après PIVOT |
| V6 | Verdict DROP → même flow que PIVOT (reformulation proposée) | Test unitaire : vérifier comportement identique à PIVOT |
| V7 | Résumé exploration enrichit la description du PRD | Test unitaire : buildEnrichedDescription avec explorationSummary non vide |
| V8 | Sans exploration, le flow F1→F2 existant est inchangé | Test de régression : prdwf_create sans exploration préalable |
| V9 | Le job Explorer s'exécute en background (non-bloquant) | Test unitaire : vérifier launchJob et non appel synchrone |
| V10 | Timeout Explorer → message clair et boutons de repli | Test unitaire : simuler timeout, vérifier message et keyboard |
| V11 | Reformulation après PIVOT relance une nouvelle exploration | Test unitaire : nouvelle description → nouveau job Explorer |
| V12 | Le résumé exploration est stocké avec TTL 10min | Test unitaire : storePendingExploration puis vérifier getPendingExploration |
| V13 | L'action registry décrit la phase d'exploration | Test : vérifier la description mise à jour de /prd_workflow |
| V14 | CLAUDE.md documente la phase d'exploration | Revue manuelle |
