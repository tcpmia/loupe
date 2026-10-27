import { describe, expect, it } from "vitest";

import { renderFileTree, type DiffFile } from "../src/diff";
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildVerifyUserPrompt,
} from "../src/prompt";

const files: DiffFile[] = [
  { path: "src/a.ts", patch: "@@ -1,1 +1,2 @@\n line\n+added line\n-removed" },
  { path: "img.png", patch: undefined },
];

describe("renderFileTree", () => {
  it("lists paths with +/- counts, and marks binaries", () => {
    const tree = renderFileTree(files);
    expect(tree).toContain("- src/a.ts (+1 −1)");
    expect(tree).toContain("- img.png (binary/too large)");
    // it must NOT contain the actual patch body
    expect(tree).not.toContain("added line");
  });
});

describe("buildUserPrompt", () => {
  const base = { title: "t", description: "", files };

  it("headless mode inlines the full diff", () => {
    const p = buildUserPrompt(base);
    expect(p).toContain("Diff under review:");
    expect(p).toContain("+added line"); // the patch body is present
    expect(p).not.toContain("is written to");
  });

  it("agentic mode (diffPath) sends the tree + a pointer, not the diff body", () => {
    const p = buildUserPrompt({ ...base, diffPath: "/tmp/x/pr.diff" });
    expect(p).toContain("Changed files");
    expect(p).toContain("- src/a.ts (+1 −1)");
    expect(p).toContain("/tmp/x/pr.diff");
    expect(p).not.toContain("+added line"); // the diff body is NOT inlined
  });

  it("a first review says nothing about earlier rounds", () => {
    const p = buildUserPrompt(base);
    expect(p).not.toContain("re-review");
    expect(p).not.toContain("Already raised");
  });

  it("a re-review says the diff is only the new commits", () => {
    const p = buildUserPrompt({ ...base, newCommitsOnly: true });
    expect(p).toContain("This is a re-review");
  });

  it("lists findings already raised, one line each, so they are not repeated", () => {
    const p = buildUserPrompt({
      ...base,
      priorFindings: [
        {
          path: "src/a.ts",
          line: 2,
          body: "🔴 **blocker** Null deref\n\nmore",
        },
        { path: "src/b.ts", line: null, body: "🟡 **warning** Outdated line" },
      ],
    });
    expect(p).toContain("Never report any of these again");
    expect(p).toContain("- src/a.ts:2: 🔴 **blocker** Null deref");
    expect(p).toContain("- src/b.ts: 🟡 **warning** Outdated line");
    expect(p).not.toContain("more");
  });
});

describe("buildVerifyUserPrompt", () => {
  const finding = {
    path: "src/a.ts",
    line: 2,
    severity: "blocker" as const,
    body: "Null deref",
  };

  it("asks the verifier to reject repeats of findings already raised", () => {
    const p = buildVerifyUserPrompt([finding], files, [
      { path: "src/a.ts", line: 2, body: "Null deref" },
    ]);
    expect(p).toContain("Reject any finding that repeats one of these");
    expect(p).toContain("- src/a.ts:2: Null deref");
  });

  it("leaves the section out when nothing was raised before", () => {
    expect(buildVerifyUserPrompt([finding], files)).not.toContain(
      "Already raised",
    );
  });
});

describe("buildSystemPrompt", () => {
  it("retains the built-in subagent panel when none is configured", () => {
    const prompt = buildSystemPrompt({
      reasoning: "medium",
      agentic: true,
    });

    expect(prompt).toContain(
      "Use a mix of glm-5.3-flash, glm-5.2-fast, deepseek-v4-pro-0813.",
    );
  });

  it("uses exact configured model names for agentic subagent panels", () => {
    const prompt = buildSystemPrompt({
      reasoning: "medium",
      agentic: true,
      subagentModels: [
        "z-ai/glm-5.3-flash",
        "z-ai/glm-5.2",
        "deepseek/deepseek-v4-pro-0813",
      ],
    });

    expect(prompt).toContain(
      "Use these exact configured model names: z-ai/glm-5.3-flash, z-ai/glm-5.2, deepseek/deepseek-v4-pro-0813.",
    );
    expect(prompt).not.toContain("glm-5.2-fast");
  });
});
