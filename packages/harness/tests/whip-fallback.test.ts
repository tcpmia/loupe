import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import type { Logger } from "@loupe/logger";
import { describe, expect, it } from "vitest";

import { whipHarness } from "../src/index";

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

describe("whip fallback models", () => {
  it("passes the ordered list to whip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loupe-whip-args-"));
    const capture = join(dir, "args.txt");
    const whip = join(dir, "whip");
    writeFileSync(
      whip,
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\nprintf \'%s\\n\' \'{"type":"done","text":"ok"}\'\n',
    );
    chmodSync(whip, 0o755);

    const output = await whipHarness().review({
      systemPrompt: "system",
      userPrompt: "user",
      model: "primary",
      fallbackModels: ["fallback-a", "fallback-b"],
      workdir: dir,
      env: {
        CAPTURE: capture,
        PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
      },
      logger,
    });

    expect(output).toBe("ok");
    const args = readFileSync(capture, "utf8").trim().split("\n");
    const flag = args.indexOf("-fallback-models");
    expect(flag).toBeGreaterThan(-1);
    expect(args[flag + 1]).toBe("fallback-a,fallback-b");
  });
});
