import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { projectHash, resolveOptions, readProjectIndex } from "../src/index.ts"
import memento from "../src/index.ts"

const DEFAULT_INDEX = `# Project memory

- [[convention-tests]] — we always write tests first
- [[api-basics]] — REST routes live in src/api
`

interface Fixture {
  root: string
  projectDir: string
  memoryRoot: string
}

function makeFixture(t: test.TestContext, content: string = DEFAULT_INDEX, indexFile = "MEMORY.md"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "memento-test-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const projectDir = join(root, "project")
  mkdirSync(projectDir)
  const memoryRoot = join(root, "memory-projects")
  mkdirSync(join(memoryRoot, projectHash(projectDir)), { recursive: true })
  if (content !== "") {
    writeFileSync(join(memoryRoot, projectHash(projectDir), indexFile), content)
  }
  return { root, projectDir, memoryRoot }
}

function withEnv(t: test.TestContext, vars: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {}
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key]
    if (vars[key] === undefined) delete process.env[key]
    else process.env[key] = vars[key]
  }
  t.after(() => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })
}

// --- projectHash -----------------------------------------------------------

test("projectHash is the first 16 hex chars of sha256 of the canonical path", () => {
  // golden vector: printf '%s' "/tmp/demo" | shasum -a 256 | cut -c1-16
  assert.equal(projectHash("/tmp/demo"), "84a8cd7d7a26dbdf")
})

test("projectHash ignores trailing slashes", () => {
  // golden vector for "/tmp/demo/" is 779a6dc911621f61 — must NOT leak out
  assert.equal(projectHash("/tmp/demo/"), "84a8cd7d7a26dbdf")
})

test("projectHash ignores trailing backslashes (Windows paths)", () => {
  // golden vectors via node:crypto; 4c72d8aa322fe73d is the un-stripped hash — must NOT leak out
  assert.equal(projectHash("C:\\Users\\demo\\"), "7dd9d03c45b3d668")
  assert.equal(projectHash("C:\\Users\\demo"), "7dd9d03c45b3d668")
})

test("projectHash resolves symlinks to the canonical path", (t) => {
  const root = mkdtempSync(join(tmpdir(), "memento-link-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const real = join(root, "real")
  const link = join(root, "link")
  mkdirSync(real)
  symlinkSync(real, link)
  assert.equal(projectHash(link), projectHash(real))
})

// --- resolveOptions --------------------------------------------------------

test("resolveOptions falls back to documented defaults", (t) => {
  withEnv(t, { MEMENTO_MEMORY_ROOT: undefined, MEMENTO_INDEX_FILE: undefined })
  const options = resolveOptions()
  // own tree — deliberately NOT ~/.config/opencode/memory (that belongs to
  // @npv12/opencode-memory-md; storage must never collide)
  assert.equal(options.memoryRoot, join(homedir(), ".config", "opencode", "memento", "projects"))
  assert.equal(options.indexFile, "MEMORY.md")
})

test("resolveOptions passes explicit overrides through", () => {
  const options = resolveOptions({ memoryRoot: "/custom/root", indexFile: "INDEX.md" })
  assert.equal(options.memoryRoot, "/custom/root")
  assert.equal(options.indexFile, "INDEX.md")
})

test("resolveOptions picks up MEMENTO_* env vars as a fallback", (t) => {
  withEnv(t, { MEMENTO_MEMORY_ROOT: "/env/root", MEMENTO_INDEX_FILE: "ENV.md" })
  const fromEnv = resolveOptions()
  assert.equal(fromEnv.memoryRoot, "/env/root")
  assert.equal(fromEnv.indexFile, "ENV.md")

  const explicitWins = resolveOptions({ memoryRoot: "/explicit/root" })
  assert.equal(explicitWins.memoryRoot, "/explicit/root")
  assert.equal(explicitWins.indexFile, "ENV.md")
})

// --- readProjectIndex ------------------------------------------------------

test("readProjectIndex returns null when the project has no memory yet", async (t) => {
  const { projectDir, memoryRoot } = makeFixture(t, "")
  assert.equal(await readProjectIndex(projectDir, { memoryRoot }), null)
})

test("readProjectIndex returns null for a missing memory root", async (t) => {
  const { projectDir } = makeFixture(t)
  assert.equal(await readProjectIndex(projectDir, { memoryRoot: join(projectDir, "nope") }), null)
})

test("readProjectIndex returns a header plus the index body", async (t) => {
  const { projectDir, memoryRoot } = makeFixture(t)
  const text = await readProjectIndex(projectDir, { memoryRoot })
  assert.ok(text, "expected injected text")
  assert.match(text, /# Project memory index \(/)
  assert.match(text, /MEMORY\.md/)
  assert.match(text, /convention-tests/)
  assert.match(text, /api-basics/)
})

test("readProjectIndex honors a custom index file name", async (t) => {
  const { projectDir, memoryRoot } = makeFixture(t, DEFAULT_INDEX, "INDEX.md")
  const text = await readProjectIndex(projectDir, { memoryRoot, indexFile: "INDEX.md" })
  assert.match(text!, /convention-tests/)
})

// --- plugin shape ----------------------------------------------------------

test("default export is a dual V1/V2 definition", () => {
  assert.equal(memento.id, "memento")
  assert.equal(typeof memento.setup, "function")
  assert.equal(typeof memento.server, "function")
})

// --- V2 flow ---------------------------------------------------------------

interface SystemEntry {
  type: string
  text: string
}

interface FakeV2Ctx {
  location: { directory: string; project: { canonical: string } }
  options: Record<string, unknown>
  session: {
    hook: (name: string, cb: (event: { system: SystemEntry[] }) => Promise<void> | void) => Promise<unknown>
  }
}

function fakeV2Ctx(directory: string, options: Record<string, unknown> = {}, canonical?: string) {
  const registered: Array<{ name: string; cb: (event: { system: SystemEntry[] }) => Promise<void> | void }> = []
  const ctx: FakeV2Ctx = {
    location: { directory, project: { canonical: canonical ?? directory } },
    options,
    session: {
      hook: async (name, cb) => {
        registered.push({ name, cb })
      },
    },
  }
  return { ctx, registered }
}

test("V2 setup registers a compaction hook that injects the memory index", async (t) => {
  const { projectDir, memoryRoot } = makeFixture(t)
  const { ctx, registered } = fakeV2Ctx(projectDir, { memoryRoot })
  await memento.setup(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, "compaction")

  const event = { system: [] as SystemEntry[] }
  await registered[0].cb(event)
  assert.equal(event.system.length, 1)
  assert.equal(event.system[0].type, "text")
  assert.match(event.system[0].text, /Project memory index/)
  assert.match(event.system[0].text, /convention-tests/)
})

test("V2 setup prefers the canonical project path when present", async (t) => {
  const { projectDir, memoryRoot } = makeFixture(t)
  const { ctx, registered } = fakeV2Ctx(join(projectDir, "ghost"), { memoryRoot }, projectDir)
  // directory points at a non-existent "ghost", canonical at the real project
  assert.equal(ctx.location.project.canonical, projectDir)
  await memento.setup(ctx)
  const event = { system: [] as SystemEntry[] }
  await registered[0].cb(event)
  assert.equal(event.system.length, 1)
})

test("V2 setup falls back to ctx.location.directory without a canonical path", async (t) => {
  const { projectDir, memoryRoot } = makeFixture(t)
  const { ctx, registered } = fakeV2Ctx(projectDir, { memoryRoot })
  delete (ctx.location as { project?: unknown }).project
  await memento.setup(ctx)
  const event = { system: [] as SystemEntry[] }
  await registered[0].cb(event)
  assert.equal(event.system.length, 1)
})

test("V2 hook stays silent when there is no memory", async (t) => {
  const { projectDir, memoryRoot } = makeFixture(t, "")
  const { ctx, registered } = fakeV2Ctx(projectDir, { memoryRoot })
  await memento.setup(ctx)
  const event = { system: [] as SystemEntry[] }
  await registered[0].cb(event)
  assert.equal(event.system.length, 0)
})

// --- V1 flow ---------------------------------------------------------------

type V1HookMap = Record<string, (input: unknown, output: { context: string[] }) => Promise<void>>

test("V1 server registers experimental.session.compacting and injects the index via env config", async (t) => {
  const { projectDir, memoryRoot } = makeFixture(t)
  withEnv(t, { MEMENTO_MEMORY_ROOT: memoryRoot })
  const hooks = (await memento.server({ directory: projectDir })) as V1HookMap
  const compacting = hooks["experimental.session.compacting"]
  assert.equal(typeof compacting, "function")

  const output = { context: [] as string[] }
  await compacting(undefined, output)
  assert.equal(output.context.length, 1)
  assert.match(output.context[0], /Project memory index/)
  assert.match(output.context[0], /convention-tests/)
})

test("V1 server hook does not throw for a project without memory", async (t) => {
  const { projectDir } = makeFixture(t, "", "MEMORY.md")
  const hooks = (await memento.server({ directory: projectDir })) as V1HookMap
  const output = { context: [] as string[] }
  await hooks["experimental.session.compacting"](undefined, output)
  assert.equal(output.context.length, 0)
})
