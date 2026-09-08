import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadReviewers, loadSettings } from "../src/reviewers";

function configFile(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "loupe-reviewers-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(config));
  return path;
}

describe("fallbackModels config", () => {
  it("preserves top-level and reviewer fallback order", () => {
    const path = configFile({
      fallbackModels: ["fallback-a", "fallback-b"],
      reviewers: [
        { name: "default" },
        {
          name: "special",
          fallbackModels: ["fallback-c", "fallback-d"],
        },
      ],
    });

    expect(loadSettings(path).fallbackModels).toEqual([
      "fallback-a",
      "fallback-b",
    ]);
    expect(loadReviewers(path).map((r) => r.fallbackModels)).toEqual([
      undefined,
      ["fallback-c", "fallback-d"],
    ]);
  });

  it("rejects an empty fallback list", () => {
    const path = configFile({ fallbackModels: [], reviewers: [{ name: "x" }] });
    expect(() => loadSettings(path)).toThrow();
  });
});

describe("whip subagentModels config", () => {
  const provider = {
    name: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
  };

  it("preserves exact configured model names", () => {
    const path = configFile({
      whip: {
        provider,
        models: ["z-ai/glm-5.3-flash", "deepseek/deepseek-v4-pro-0813"],
        subagentModels: ["z-ai/glm-5.3-flash", "deepseek/deepseek-v4-pro-0813"],
      },
      reviewers: [{ name: "x" }],
    });

    expect(loadSettings(path).whip?.subagentModels).toEqual([
      "z-ai/glm-5.3-flash",
      "deepseek/deepseek-v4-pro-0813",
    ]);
  });

  it("rejects empty or unregistered subagent model lists", () => {
    const empty = configFile({
      whip: {
        provider,
        models: ["z-ai/glm-5.3-flash"],
        subagentModels: [],
      },
      reviewers: [{ name: "x" }],
    });
    const unregistered = configFile({
      whip: {
        provider,
        models: ["z-ai/glm-5.3-flash"],
        subagentModels: ["deepseek/deepseek-v4-pro-0813"],
      },
      reviewers: [{ name: "x" }],
    });

    expect(() => loadSettings(empty)).toThrow();
    expect(() => loadSettings(unregistered)).toThrow(
      "subagentModels entries must also appear in models",
    );
  });
});
