/**
 * Unit Tests — src/projects.ts
 *
 * Tests for multi-project CRUD, context resolution, and formatting.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createMockSupabase } from "../fixtures/mock-supabase";
import {
  createProject,
  getProject,
  getProjectById,
  listProjects,
  updateProject,
  archiveProject,
  resolveProjectFromTopic,
  resolveProjectContext,
  formatProjectList,
  formatProjectDetail,
  getActiveProjectSlug,
  setActiveProjectSlug,
  type Project,
} from "../../src/projects";

const MOCK_PROJECT: Project = {
  id: "proj-001-uuid",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  name: "Telegram Relay",
  slug: "telegram-relay",
  description: "Bot Telegram personnel",
  repo_url: "https://github.com/user/relay",
  directory: "/home/user/relay",
  status: "active",
  telegram_topic_id: 42,
  current_sprint: "S14",
  workflow_config: {},
  metadata: {},
};

const MOCK_PROJECT_2: Project = {
  id: "proj-002-uuid",
  created_at: "2026-02-01T00:00:00Z",
  updated_at: "2026-02-01T00:00:00Z",
  name: "Side Project",
  slug: "side-project",
  description: null,
  repo_url: null,
  directory: null,
  status: "paused",
  telegram_topic_id: null,
  current_sprint: null,
  workflow_config: {},
  metadata: {},
};

describe("Active Project Tracking", () => {
  beforeEach(() => {
    setActiveProjectSlug("telegram-relay");
  });

  it("defaults to telegram-relay", () => {
    expect(getActiveProjectSlug()).toBe("telegram-relay");
  });

  it("can be changed", () => {
    setActiveProjectSlug("side-project");
    expect(getActiveProjectSlug()).toBe("side-project");
  });
});

describe("createProject", () => {
  it("inserts a new project and returns it", async () => {
    const supabase = createMockSupabase();

    const result = await createProject(supabase, {
      name: "New App",
      slug: "new-app",
      description: "A brand new project",
    });

    expect(result).not.toBeNull();
    expect(result!.name).toBe("New App");
    expect(result!.slug).toBe("new-app");
    expect(result!.description).toBe("A brand new project");
    expect(result!.id).toBeDefined();
  });

  it("sets null for optional fields when not provided", async () => {
    const supabase = createMockSupabase();

    const result = await createProject(supabase, {
      name: "Minimal",
      slug: "minimal",
    });

    expect(result).not.toBeNull();
    expect(result!.repo_url).toBeNull();
    expect(result!.directory).toBeNull();
    expect(result!.telegram_topic_id).toBeNull();
  });
});

describe("getProject", () => {
  it("finds project by slug", async () => {
    const supabase = createMockSupabase({
      projects: [MOCK_PROJECT],
    });

    const result = await getProject(supabase, "telegram-relay");
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("telegram-relay");
  });

  it("finds project by ID prefix via like", async () => {
    const supabase = createMockSupabase({
      projects: [MOCK_PROJECT],
    });

    const result = await getProject(supabase, "proj-001");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("proj-001-uuid");
  });

  it("returns null when project not found", async () => {
    const supabase = createMockSupabase({ projects: [] });

    const result = await getProject(supabase, "nonexistent");
    expect(result).toBeNull();
  });
});

describe("getProjectById", () => {
  it("finds project by exact ID", async () => {
    const supabase = createMockSupabase({
      projects: [MOCK_PROJECT],
    });

    const result = await getProjectById(supabase, "proj-001-uuid");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Telegram Relay");
  });

  it("returns null for non-matching ID", async () => {
    const supabase = createMockSupabase({
      projects: [MOCK_PROJECT],
    });

    const result = await getProjectById(supabase, "nonexistent-id");
    expect(result).toBeNull();
  });
});

describe("listProjects", () => {
  it("lists all projects", async () => {
    const supabase = createMockSupabase({
      projects: [MOCK_PROJECT, MOCK_PROJECT_2],
    });

    const result = await listProjects(supabase);
    expect(result.length).toBe(2);
  });

  it("filters by status", async () => {
    const supabase = createMockSupabase({
      projects: [MOCK_PROJECT, MOCK_PROJECT_2],
    });

    const result = await listProjects(supabase, { status: "active" });
    expect(result.length).toBe(1);
    expect(result[0].slug).toBe("telegram-relay");
  });

  it("returns empty array when no projects", async () => {
    const supabase = createMockSupabase({ projects: [] });

    const result = await listProjects(supabase);
    expect(result.length).toBe(0);
  });
});

describe("updateProject", () => {
  it("updates project fields", async () => {
    const supabase = createMockSupabase({
      projects: [MOCK_PROJECT],
    });

    const result = await updateProject(supabase, "proj-001-uuid", {
      description: "Updated description",
      current_sprint: "S15",
    });

    expect(result).not.toBeNull();
    expect(result!.description).toBe("Updated description");
    expect(result!.current_sprint).toBe("S15");
  });
});

describe("archiveProject", () => {
  it("sets status to archived", async () => {
    const supabase = createMockSupabase({
      projects: [MOCK_PROJECT],
    });

    const success = await archiveProject(supabase, "proj-001-uuid");
    expect(success).toBe(true);

    // Verify the project was actually updated in the store
    const projects = supabase._getTable("projects");
    const archived = projects.find((p: any) => p.id === "proj-001-uuid");
    expect(archived.status).toBe("archived");
  });
});

describe("resolveProjectFromTopic", () => {
  it("finds project by topic thread ID", async () => {
    const supabase = createMockSupabase({
      projects: [MOCK_PROJECT],
    });

    const result = await resolveProjectFromTopic(supabase, 42);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("telegram-relay");
  });

  it("returns null when no project matches topic", async () => {
    const supabase = createMockSupabase({
      projects: [MOCK_PROJECT],
    });

    const result = await resolveProjectFromTopic(supabase, 999);
    expect(result).toBeNull();
  });
});

describe("resolveProjectContext", () => {
  beforeEach(() => {
    setActiveProjectSlug("telegram-relay");
  });

  it("prefers topic-based resolution", async () => {
    const supabase = createMockSupabase({
      projects: [MOCK_PROJECT, MOCK_PROJECT_2],
    });

    const result = await resolveProjectContext(supabase, 42);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("telegram-relay");
  });

  it("falls back to active project slug when no topic", async () => {
    const supabase = createMockSupabase({
      projects: [MOCK_PROJECT],
    });

    const result = await resolveProjectContext(supabase);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("telegram-relay");
  });

  it("falls back to active project when topic doesn't match", async () => {
    const supabase = createMockSupabase({
      projects: [MOCK_PROJECT],
    });

    const result = await resolveProjectContext(supabase, 999);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("telegram-relay");
  });
});

describe("formatProjectList", () => {
  it("formats empty list", () => {
    const text = formatProjectList([]);
    expect(text).toContain("Aucun projet");
  });

  it("formats projects with status and sprint", () => {
    setActiveProjectSlug("telegram-relay");
    const text = formatProjectList([MOCK_PROJECT, MOCK_PROJECT_2]);
    expect(text).toContain("PROJETS");
    expect(text).toContain("[ACTIF] Telegram Relay (telegram-relay)");
    expect(text).toContain("Sprint S14");
    expect(text).toContain("<< actif");
    expect(text).toContain("[PAUSE] Side Project (side-project)");
  });
});

describe("formatProjectDetail", () => {
  it("formats full project details", () => {
    const text = formatProjectDetail(MOCK_PROJECT);
    expect(text).toContain("Telegram Relay (telegram-relay)");
    expect(text).toContain("ACTIF");
    expect(text).toContain("Sprint: S14");
    expect(text).toContain("Bot Telegram personnel");
    expect(text).toContain("proj-001");
    expect(text).toContain("Topic Telegram: 42");
  });

  it("handles project with minimal fields", () => {
    const text = formatProjectDetail(MOCK_PROJECT_2);
    expect(text).toContain("Side Project (side-project)");
    expect(text).toContain("PAUSE");
    expect(text).toContain("Pas de sprint actif");
    expect(text).toContain("Pas de topic lie");
  });
});
