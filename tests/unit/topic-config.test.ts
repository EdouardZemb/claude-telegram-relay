/**
 * @file topic-config.test.ts
 * @description Dedicated unit tests for src/topic-config.ts
 * Tests TOPIC_CONFIGS object and getTopicConfig() function.
 */

import { describe, expect, it } from "bun:test";
import { getTopicConfig, TOPIC_CONFIGS, type TopicConfig } from "../../src/topic-config.ts";

describe("TOPIC_CONFIGS", () => {
  it("is a non-empty object", () => {
    expect(typeof TOPIC_CONFIGS).toBe("object");
    expect(Object.keys(TOPIC_CONFIGS).length).toBeGreaterThan(0);
  });

  it("each config has systemPrompt, allowedCommands, and label", () => {
    for (const [key, config] of Object.entries(TOPIC_CONFIGS)) {
      expect(typeof config.systemPrompt).toBe("string");
      expect(Array.isArray(config.allowedCommands)).toBe(true);
      expect(typeof config.label).toBe("string");
    }
  });

  it("contains at least one topic with a non-empty allowedCommands list", () => {
    const hasCommands = Object.values(TOPIC_CONFIGS).some((c) => c.allowedCommands.length > 0);
    expect(hasCommands).toBe(true);
  });
});

describe("getTopicConfig", () => {
  it("returns undefined for unknown topic", () => {
    const result = getTopicConfig("this-topic-does-not-exist");
    expect(result).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    const result = getTopicConfig(undefined);
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    const result = getTopicConfig("");
    expect(result).toBeUndefined();
  });

  it("returns a TopicConfig for a known topic key", () => {
    const knownKey = Object.keys(TOPIC_CONFIGS)[0];
    const result = getTopicConfig(knownKey);
    expect(result).not.toBeUndefined();
    expect(typeof (result as TopicConfig).systemPrompt).toBe("string");
  });

  it("is case-insensitive (normalizes to lowercase)", () => {
    const knownKey = Object.keys(TOPIC_CONFIGS)[0];
    const lowerResult = getTopicConfig(knownKey.toLowerCase());
    const upperResult = getTopicConfig(knownKey.toUpperCase());
    // Both should return same config (or both undefined if key is already lower)
    expect(lowerResult).toEqual(upperResult);
  });

  it("trims whitespace from input", () => {
    const knownKey = Object.keys(TOPIC_CONFIGS)[0];
    const trimmed = getTopicConfig(knownKey);
    const padded = getTopicConfig(`  ${knownKey}  `);
    expect(trimmed).toEqual(padded);
  });
});
