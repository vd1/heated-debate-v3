import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveContextPaths } from "../src/context";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

describe("resolveContextPaths", () => {
  test("resolves user-selected files against the debate working directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heated-debate-context-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "notes.md"), "Evidence", "utf8");

    expect(await resolveContextPaths(["notes.md"], directory)).toEqual([
      join(directory, "notes.md"),
    ]);
  });

  test("rejects a missing context source before the debate starts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heated-debate-context-"));
    temporaryDirectories.push(directory);

    let failure: unknown;
    try {
      await resolveContextPaths(["missing.md"], directory);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "context source not found: missing.md",
    );
  });
});
