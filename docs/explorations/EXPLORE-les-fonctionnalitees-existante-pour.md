---
phase: 0-explore
generated_at: "2026-03-25T14:30:00Z"
subject: "Ameliorer l'UX design du bot Telegram a partir des fonctionnalites existantes"
verdict: GO
next_step: "dev-spec"
---

# Exploration : Ameliorer l'UX design du bot Telegram

## Section 1 -- Probleme

Le bot Telegram claude-relay dispose de 30+ commandes, d'un systeme d'intent detection conversationnelle (regex + LLM), de claviers inline pour le pipeline SDD et les notifications, d'un systeme de topics forum, et d'une gestion documentaire avec classification automatique. Malgre cette richesse fonctionnelle, l'experience utilisateur souffre de plusieurs frictions :

1. **Decouverte des commandes** : /help affiche une liste plate de 25+ commandes sans hierarchie, sans contexte, sans indication de frequence d'usage. L'utilisateur novice est submerge, l'utilisateur avance ne retrouve pas rapidement ce qu'il cherche.
2. **Feedback visuel minimal** : les reponses sont du texte brut uniquement (convention projet), sans barre de progression, sans emojis, sans structuration visuelle. Le "typing" indicator est le seul feedback pendant les operations longues.
3. **Navigation lineaire** : chaque commande est une interaction isolee. Il n'y a pas de menus contextuels, pas de navigation en arbre, pas de "retour" apres une sous-commande.
4. **Coherence des patterns d'interaction** : certaines commandes utilisent des InlineKeyboard (SDD, notifications, documents), d'autres non (tasks, brain, metrics). Le pattern varie sans raison apparente.
5. **Absence d'onboarding** : /start sans argument ne fait rien. Aucun message de bienvenue, aucun guide interactif.

L'exploration est necessaire avant de specifier car les ameliorations UX touchent transversalement tous les modules du bot et necessitent une vision coherente plutot que des corrections ponctuelles.

## Section 2 -- Etat de l'art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | [Telegram Bot Features (core.telegram.org)](https://core.telegram.org/bots/features) | Documentation officielle | 2025-03 | Reference complete des capacites Telegram : reply keyboards, inline keyboards, Web Apps, command scoping, menu button, chat actions | Haute |
| 2 | [Telegram Inline Keyboard UX Design Guide](https://wyu-telegram.com/blogs/444/) | Guide UX | 2025-03 | Limites des inline keyboards (100 boutons, 64 bytes callback_data), optimisation performance (cache 300s, editing vs sending), seuils mobile (5 rows max iOS) | Haute |
| 3 | [Telegram Mini Apps vs Bots (magnetto.com)](https://magnetto.com/blog/telegram-mini-apps-vs-bots) | Comparatif | 2025-03 | Quand utiliser Mini Apps vs bots : Mini Apps pour >50 options, multi-select, interface riche ; bots pour automation simple et notifications | Moyenne |
| 4 | [Conversational UX in Chatbot Design (Toptal)](https://www.toptal.com/designers/ui/chatbot-ux-design) | Article expert | 2025-03 | Principes de design conversationnel : equilibre texte/boutons, personnalite du bot, feedback d'etat, progressive disclosure | Haute |
| 5 | [grammY Keyboard Plugin (grammy.dev)](https://grammy.dev/plugins/keyboard) | Documentation framework | 2025-03 | API grammY pour custom keyboards, inline keyboards, keyboard builder, remove keyboard, resize keyboard | Haute |

### Synthese de l'etat de l'art

**Patterns UX recommandes pour les bots Telegram en 2025-2026 :**

Les meilleures pratiques convergent sur plusieurs principes :

- **Progressive disclosure** : ne montrer que les options pertinentes au contexte courant. Eviter les listes plates de commandes. Utiliser des menus a niveaux avec des boutons "Retour" et "Menu principal".
- **Feedback constant** : chaque action utilisateur doit recevoir un feedback immediat (chat action "typing", messages d'etat, progression). Les operations longues doivent indiquer leur progression.
- **Coherence des patterns** : choisir un pattern d'interaction (inline keyboard vs texte) et l'appliquer uniformement a travers le bot. Les actions destructives ou a risque doivent toujours passer par une confirmation inline.
- **Mobile-first** : 70%+ des utilisateurs Telegram sont sur mobile. Les inline keyboards doivent rester sous 5 rows pour eviter les problemes de rendering sur iOS. Les textes doivent etre courts et scannables.
- **Onboarding guide** : /start doit accueillir l'utilisateur, presenter les capacites du bot, et offrir un parcours de decouverte interactif avec des boutons.
- **Seuils de migration** : quand les interactions depassent la complexite d'un inline keyboard (>50 options, multi-select, formulaires), migrer vers un Telegram Mini App (Web App).

## Section 3 -- Archeologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/commands/help.ts` | /help est une liste plate en texte brut, 25+ commandes sans categorisation interactive. /workflow est aussi textuel. | Haut |
| 2 | `src/commands/zz-messages.ts` | Pipeline unifie texte+voix. Intent detection (regex + LLM) deja en place. Convergence SDD detectee et proposee via inline keyboard. | Moyen |
| 3 | `src/commands/command-router.ts` | Routing intent -> commande avec clarification et confirmation inline pour actions "high risk". Pattern deja en place mais inegal. | Moyen |
| 4 | `src/intent-detection.ts` | 16 patterns regex + fallback LLM. Permet deja l'usage conversationnel sans commandes slash. Couverture correcte. | Faible |
| 5 | `src/action-registry.ts` | Registre structure : 27 commandes avec description, risk level, aliases, params. Metadata riche deja disponible pour generer des menus dynamiques. | Haut |
| 6 | `src/notification-queue.ts` | Inline keyboards pour les notifications (demarrer/terminer tache, voir PR, promouvoir idee). Pattern coherent et bien implemente. | Faible |
| 7 | `src/commands/sdd-flow.ts` | Pipeline SDD avec inline keyboards contextuels selon la phase. `buildSddKeyboard()` est un bon modele de menu dynamique contextuel. | Moyen |
| 8 | `src/commands/documents.ts` | Classification avec inline keyboards (confirmer, changer categorie, annuler). Bon pattern de confirmation multi-etapes. | Faible |
| 9 | `src/commands/tasks.ts` | /task, /backlog, /sprint, /done, /start : aucun inline keyboard. Confirmation textuelle uniquement. /start sans argument = noop. | Haut |
| 10 | `src/bot-context.ts` | `sendResponse()` decoupe les messages >4000 chars. `buildPrompt()` injecte les instructions de formatage (plain text only). `heartbeatOpts()` pour feedback operations longues. | Moyen |
| 11 | `src/topic-config.ts` | 4 topics forum avec system prompts et allowedCommands. Scoping deja en place mais pas exploite pour la navigation contextuelle. | Moyen |
| 12 | `src/commands/profile.ts` | /profile et /notify : texte brut uniquement, pas d'inline keyboard pour les preferences. | Moyen |
| 13 | `dashboard/index.html` | Dashboard Kanban web existant (port 3456). Pourrait servir de base pour un Mini App si necessaire. | Faible |
| 14 | `src/loader.ts` | Auto-discovery des Composers. Ajout de nouveaux modules de commande trivial. | Faible |

### Points de friction identifies

1. **Inconsistance des patterns** : SDD-flow et documents utilisent des inline keyboards, mais tasks, brain, metrics, profile n'en utilisent pas. L'utilisateur n'a pas de modele mental coherent.
2. **/start vide** : /start sans argument est un noop dans tasks.ts (ligne 274 : `if (!idPrefix) return;`). Aucun onboarding.
3. **/help non-interactif** : liste plate de texte, non navigable, non categorisee.
4. **Absence de menu principal** : pas de point d'entree interactif pour naviguer les fonctionnalites par categorie.
5. **Feedback operations longues** : seul le heartbeat ("Je travaille toujours dessus... X min") donne du feedback. Pas de barre de progression, pas d'estimation de duree.

### Actifs reutilisables

1. **action-registry.ts** : metadata complete (description, risk, params, module, aliases) pour generer des menus dynamiques automatiquement.
2. **buildSddKeyboard()** : pattern de construction de clavier contextuel reutilisable.
3. **command-router.ts** : infrastructure de confirmation et clarification deja en place.
4. **notification-queue inline keyboards** : pattern mature pour les boutons d'action.
5. **topic-config.ts** : scoping par topic deja defini, exploitable pour filtrer les menus.

## Section 4 -- Matrice d'alternatives

| Critere | A: Status quo | B: Menus inline progressifs | C: Mini App dashboard | D: Hybrid (B + C partiel) |
|---------|:------------:|:-----------:|:-----------:|:-----------:|
| **Complexite** (obligatoire) | S | M | L | M |
| **Valeur ajoutee** (obligatoire) | Low | High | High | High |
| **Risque technique** (obligatoire) | Low | Low | High | Med |
| *Impact maintenance* | Nul | Faible (memes modules) | Eleve (nouveau stack) | Moyen |
| *Reversibilite* | N/A | Haute (boutons optionnels) | Faible (nouveau frontend) | Haute |

### Discussion des options

**A: Status quo** — Conserver l'UX actuelle. Cout zero, mais les frictions identifiees persistent et s'aggravent a mesure que de nouvelles fonctionnalites s'ajoutent. Les 30+ commandes deviennent difficiles a memoriser et a decouvrir. Cette option ne resout aucun des 5 problemes identifies.

**B: Menus inline progressifs** — Transformer /help en menu interactif categorise avec inline keyboards. Ajouter un onboarding interactif sur /start. Generaliser les inline keyboards aux modules qui n'en ont pas (tasks, metrics, profile). Exploiter action-registry.ts pour generer les menus dynamiquement. Complexite moderee car l'infrastructure existe deja (command-router, buildSddKeyboard, notification keyboards). Le risque est faible car les boutons sont additifs et ne cassent pas les commandes slash existantes. Respecte la contrainte "plain text only" pour le contenu des reponses tout en ajoutant de la navigation interactive.

**C: Mini App dashboard** — Creer un Telegram Mini App basee sur le dashboard existant (port 3456) pour offrir un Kanban interactif, des graphiques de metriques, et une navigation riche. Haute valeur ajoutee visuelle mais complexite elevee : nouveau frontend a maintenir, integration OAuth/auth Telegram, deploiement supplementaire. Le dashboard existant n'est pas concu pour le contexte Mini App (pas de Telegram WebApp SDK, pas d'auth Telegram). Le risque technique est eleve et la reversibilite faible.

**D: Hybrid (B + C partiel)** — Implementer les menus inline progressifs (option B) comme fondation immediate, puis evaluer un Mini App pour les cas complexes (dashboard, metrics graphiques) dans un second temps. Combine la valeur des deux approches avec un risque maitrise. L'option B fournit 80% de la valeur UX pour 40% de l'effort total.

## Section 5 -- Verdict et justification

**Verdict : GO**

L'option B (Menus inline progressifs) est recommandee comme implementation principale.

**Justification :**

1. **L'infrastructure existe deja** (Axe 2) : action-registry.ts contient toute la metadata necessaire pour generer des menus dynamiques. Les patterns de inline keyboard sont deja en production dans SDD-flow, notifications, et documents. Le command-router gere deja la clarification et la confirmation. Le travail est principalement d'unification et d'extension, pas de construction from scratch.

2. **Les meilleures pratiques le confirment** (Axe 1) : l'etat de l'art recommande unanimement la progressive disclosure, les menus contextuels, et un onboarding interactif pour les bots a nombreuses commandes. Les seuils de migration vers Mini App (>50 options, multi-select) ne sont pas atteints par ce bot.

3. **Rapport cout/benefice optimal** (Axe 3) : complexite M, valeur High, risque Low. Les changements sont additifs et reversibles. Les commandes slash existantes continuent de fonctionner. L'investissement est modere et les gains en decouverte et coherence sont immediats.

4. **Les 5 problemes identifies sont resolus** : decouverte (menu categorise), feedback (inline confirmation sur plus de commandes), navigation (hierarchie de menus), coherence (generalisation du pattern inline), onboarding (accueil interactif sur /start).

## Section 6 -- Input pour etape suivante

### Option recommandee : Menus inline progressifs

### Fichiers concernes
- `src/commands/help.ts` — Refactoring en menu interactif categorise avec inline keyboard
- `src/commands/tasks.ts` — Ajout inline keyboards pour /backlog (demarrer tache), /sprint (voir details), /done et /start (confirmation)
- `src/commands/zz-messages.ts` — Integration du menu comme fallback quand l'intent n'est pas detectee
- `src/action-registry.ts` — Ajout d'un champ `category` pour le regroupement par menu
- `src/bot-context.ts` — Eventuellement un helper `buildCategoryKeyboard()` partage
- `src/commands/profile.ts` — Inline keyboard pour les preferences /notify
- `src/commands/quality.ts` — Inline keyboard optionnel pour navigation /metrics -> /retro -> /alerts

### Contraintes identifiees
- Respecter la convention "plain text only" pour le contenu des reponses (les inline keyboards sont de la navigation, pas du contenu)
- Rester sous 5 rows de boutons par keyboard pour la compatibilite iOS
- Callback data max 64 bytes (deja gere dans documents.ts avec les short IDs)
- Ne pas casser les commandes slash existantes : les menus sont un ajout, pas un remplacement
- Convention de nommage des callbacks : prefixer par module (menu_, task_, quality_, etc.)

### Questions ouvertes a resoudre pendant la spec
1. Faut-il un bouton "Menu principal" persistant (reply keyboard) ou rester 100% inline keyboard ?
2. Le menu principal doit-il etre contextuel au topic (topic-config.ts) ou global ?
3. Faut-il regrouper les commandes en combien de categories ? (proposition : 4-5 categories max)
4. Le onboarding /start doit-il etre different pour un premier usage vs un usage subsequent ?
5. Les inline keyboards sur /backlog doivent-ils inclure des boutons d'action directe (demarrer, terminer) par tache, ou seulement a la consultation individuelle ?
