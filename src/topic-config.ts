/**
 * @module topic-config
 * @description Topic configuration for Telegram forum groups. Defines behavior and
 * allowed commands per topic.
 */

export interface TopicConfig {
  systemPrompt: string;
  allowedCommands: string[];
  label: string;
}

export const TOPIC_CONFIGS: Record<string, TopicConfig> = {
  "claude-relay": {
    label: "Dev",
    systemPrompt:
      "This is the development topic for the claude-relay project. " +
      "Focus on technical discussions: code, architecture, bugs, deployments, CI/CD. " +
      "Be precise and technical. Refer to files, functions, and line numbers when relevant. " +
      "You can suggest code changes and execute tasks.",
    allowedCommands: ["exec", "explore", "plan", "prd", "task", "backlog", "sprint", "done", "start", "status", "export", "remind", "speak", "metrics", "retro", "patterns", "alerts", "profile"],
  },
  "idees": {
    label: "Brainstorm",
    systemPrompt:
      "This is the brainstorming topic. " +
      "Help explore ideas freely. Be creative, propose alternatives, play devil's advocate. " +
      "No need to be overly technical here — focus on concepts, possibilities, and strategy. " +
      "Ask follow-up questions to refine ideas.",
    allowedCommands: ["task", "explore", "plan", "prd", "remind", "speak"],
  },
  "sprint": {
    label: "Sprint",
    systemPrompt:
      "This is the sprint management topic. " +
      "Focus on task tracking, progress updates, priorities, and planning. " +
      "Keep messages short and actionable. Use task IDs when referencing work.",
    allowedCommands: ["task", "backlog", "sprint", "done", "start", "plan", "prd", "exec", "explore", "status", "remind", "speak", "metrics", "retro", "patterns", "alerts", "profile"],
  },
  "serveur": {
    label: "Ops",
    systemPrompt:
      "This is the server operations topic. " +
      "Focus on infrastructure, monitoring, deployments, logs, and system health. " +
      "Be practical and direct. Suggest concrete commands when troubleshooting.",
    allowedCommands: ["status", "exec", "remind", "speak"],
  },
};

export function getTopicConfig(topicName: string | undefined): TopicConfig | undefined {
  if (!topicName) return undefined;
  const key = topicName.toLowerCase().trim();
  return TOPIC_CONFIGS[key];
}
