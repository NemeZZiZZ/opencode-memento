// opencode-memento — amnesia insurance for OpenCode.
//
// When a session is auto-compacted, the summarizer only sees what it is
// given. This plugin hands it your project's Markdown memory index, so
// long-term memory survives the summary instead of evaporating with the
// transcript.
//
// Zero dependencies by design: OpenCode 2.x accepts a plain { id, setup }
// object (no Plugin.define import needed), and 1.18.29+ uses the server()
// entrypoint — one file serves both plugin APIs.
//
// Every hook body is wrapped in try/catch: a failing memory lookup must
// never break a compaction or a session.

import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export interface MementoOptions {
  /**
   * Directory holding one subdirectory per project, addressed by hash.
   * Default: `~/.config/opencode/memento/projects`
   * Deliberately outside `~/.config/opencode/memory` — that tree belongs to
   * other memory plugins (e.g. @npv12/opencode-memory-md); storage never collides.
   * Fallback env var (the only way to configure V1): `MEMENTO_MEMORY_ROOT`
   */
  memoryRoot?: string
  /**
   * Name of the index file inside a project's memory directory.
   * Default: `MEMORY.md` (env fallback: `MEMENTO_INDEX_FILE`)
   */
  indexFile?: string
}

/** Resolve symlinks (like `pwd -P`) and drop trailing slashes (POSIX and Windows). */
export function canonicalDir(dir: string): string {
  try {
    dir = realpathSync(dir)
  } catch {
    // Path doesn't exist (yet) — hash it as written.
  }
  return dir.replace(/[\\/]+$/, "") || "/"
}

/** First 16 hex chars of sha256 of the canonical project path. */
export function projectHash(dir: string): string {
  return createHash("sha256").update(canonicalDir(dir)).digest("hex").slice(0, 16)
}

/**
 * Effective options: explicit values win, `MEMENTO_*` env vars follow,
 * documented defaults last.
 */
export function resolveOptions(options: MementoOptions = {}): Required<MementoOptions> {
  return {
    memoryRoot:
      options.memoryRoot ?? process.env.MEMENTO_MEMORY_ROOT ?? join(homedir(), ".config", "opencode", "memento", "projects"),
    indexFile: options.indexFile ?? process.env.MEMENTO_INDEX_FILE ?? "MEMORY.md",
  }
}

/** Absolute path of the memory index for a project directory. */
export function memoryIndexPath(directory: string, options: MementoOptions = {}): string {
  const resolved = resolveOptions(options)
  return join(resolved.memoryRoot, projectHash(directory), resolved.indexFile)
}

/**
 * Read the memory index to inject at compaction time.
 * Returns null when the project has no memory yet — silence is correct.
 */
export async function readProjectIndex(directory: string, options: MementoOptions = {}): Promise<string | null> {
  const indexPath = memoryIndexPath(directory, options)
  let index: string
  try {
    index = await readFile(indexPath, "utf8")
  } catch {
    // This project has no memory yet — nothing to preserve.
    return null
  }
  if (!index.trim()) return null
  return [
    `# Project memory index (${indexPath})`,
    "",
    index.trimEnd(),
    "",
    "(Long-term memory: preserve these entries in the summary; individual fact files stay readable at their paths.)",
  ].join("\n")
}

/** Structural types for the OpenCode 2.x plugin context (no SDK import). */
interface V2Context {
  location: { directory: string; project?: { canonical?: string } }
  options?: unknown
  session: {
    hook: (
      name: "compaction",
      cb: (event: { system: Array<{ type: string; text: string }> }) => Promise<void> | void,
    ) => Promise<unknown>
  }
}

function optionsFrom(value: unknown): MementoOptions {
  return value && typeof value === "object" ? (value as MementoOptions) : {}
}

/**
 * V1 entrypoint for OpenCode 1.18.29+ (dual package: `server` + `setup`).
 * V1 has no ctx.options, so `MEMENTO_*` env vars are the configuration path.
 */
async function server({ directory }: { directory: string }) {
  return {
    "experimental.session.compacting": async (_input: unknown, output: { context: string[] }) => {
      try {
        const text = await readProjectIndex(directory)
        if (text) output.context.push(text)
      } catch {
        // A failing hook must never break a session.
      }
    },
  }
}

/** Dual OpenCode V1/V2 plugin definition. */
export default {
  id: "memento",
  async setup(ctx: V2Context) {
    const options = optionsFrom(ctx.options)
    const projectDir = ctx.location.project?.canonical ?? ctx.location.directory
    await ctx.session.hook("compaction", async (event) => {
      try {
        const text = await readProjectIndex(projectDir, options)
        if (text) event.system.push({ type: "text", text })
      } catch {
        // A failing hook must never break a session.
      }
    })
  },
  server,
}
