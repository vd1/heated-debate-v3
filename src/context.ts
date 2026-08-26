import { access } from "node:fs/promises";
import { resolve } from "node:path";

export async function resolveContextPaths(
  paths: readonly string[],
  cwd: string,
): Promise<string[]> {
  const resolved: string[] = [];
  for (const path of paths) {
    const absolutePath = resolve(cwd, path);
    try {
      await access(absolutePath);
    } catch {
      throw new Error(`context source not found: ${path}`);
    }
    if (!resolved.includes(absolutePath)) resolved.push(absolutePath);
  }
  return resolved;
}

export function contextManifest(paths: readonly string[]): string {
  return [
    "# Context",
    "",
    ...(paths.length === 0
      ? ["No additional context sources were selected."]
      : paths.map((path) => `- \`${path.replaceAll("`", "'")}\``)),
    "",
  ].join("\n");
}
