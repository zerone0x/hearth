/**
 * Spike (issue #40): pi as the hub-side brain, with every file and shell tool
 * routed to a box. This is the shape PRD §8.2.1 and decision 0009 describe, with
 * FakeBox standing in for the tool RPC of #41. Findings and file:line citations
 * are in docs/spikes/pi-runner.md.
 */
import { type FauxProviderHandle, fauxProvider, type Model } from "@earendil-works/pi-ai";
import {
  type BashOperations,
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  type EditOperations,
  type ExtensionFactory,
  type FileEntry,
  type FindOperations,
  type LsOperations,
  ModelRuntime,
  type ReadOperations,
  SessionManager,
  SettingsManager,
  type ToolCallEvent,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { BoxError, type FakeBox } from "./fake-box";

/** The runner's cwd is the box path, never a hub path (PRD §8.2.1, "Paths"). */
export const BOX_CWD = "/workspace";
export const ROUTED_TOOLS = ["read", "write", "edit", "bash", "ls", "find", "grep"] as const;

export type ToolPolicy = (event: ToolCallEvent) => { block: true; reason: string } | undefined;

export interface HearthToolsOptions {
  /** The box user's home. pi expands `~` with the hub's homedir, so the runner rewrites it. */
  boxHome: string;
  /** Approval gate, applied hub-side before a call leaves the hub. */
  policy?: ToolPolicy | undefined;
}

const PATH_TOOLS = new Set(["read", "write", "edit", "ls", "find", "grep"]);

function rewriteHome(path: string, boxHome: string): string {
  if (path === "~") return boxHome;
  if (path.startsWith("~/")) return `${boxHome}${path.slice(1)}`;
  return path;
}

async function mustExist(box: FakeBox, toolCallId: string, path: string): Promise<void> {
  const stat = await box.stat(toolCallId, path);
  if (!stat.exists) throw new BoxError("ENOENT", `No such file in box: ${path}`);
}

/**
 * The one inline extension the runner loads. It registers the seven routed tools
 * under their built-in names, which replaces the built-ins, and builds the
 * operations per call so every box call carries pi's tool call id.
 */
export function hearthToolsExtension(box: FakeBox, options: HearthToolsOptions): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      ...createReadToolDefinition(BOX_CWD),
      async execute(id, params, signal, onUpdate, ctx) {
        const operations: ReadOperations = {
          readFile: (path) => box.readFile(id, path, signal),
          access: (path) => mustExist(box, id, path),
        };
        return createReadToolDefinition(BOX_CWD, { operations }).execute(
          id,
          params,
          signal,
          onUpdate,
          ctx,
        );
      },
    });

    pi.registerTool({
      ...createWriteToolDefinition(BOX_CWD),
      async execute(id, params, signal, onUpdate, ctx) {
        const operations: WriteOperations = {
          writeFile: (path, content) => box.writeFile(id, path, content),
          mkdir: (dir) => box.mkdir(id, dir),
        };
        return createWriteToolDefinition(BOX_CWD, { operations }).execute(
          id,
          params,
          signal,
          onUpdate,
          ctx,
        );
      },
    });

    pi.registerTool({
      ...createEditToolDefinition(BOX_CWD),
      async execute(id, params, signal, onUpdate, ctx) {
        const operations: EditOperations = {
          readFile: (path) => box.readFile(id, path, signal),
          writeFile: (path, content) => box.writeFile(id, path, content),
          access: (path) => mustExist(box, id, path),
        };
        return createEditToolDefinition(BOX_CWD, { operations }).execute(
          id,
          params,
          signal,
          onUpdate,
          ctx,
        );
      },
    });

    pi.registerTool({
      ...createBashToolDefinition(BOX_CWD),
      async execute(id, params, signal, onUpdate, ctx) {
        const operations: BashOperations = {
          // pi passes the hub's environment in `env` (getShellEnv() plus PI_* vars).
          // It is dropped here on purpose: the box uses its own (PRD §8.2.1).
          exec: (command, cwd, { onData, signal: execSignal }) =>
            box.exec(id, command, cwd, { onData, signal: execSignal, env: undefined }),
        };
        return createBashToolDefinition(BOX_CWD, { operations }).execute(
          id,
          params,
          signal,
          onUpdate,
          ctx,
        );
      },
    });

    pi.registerTool({
      ...createLsToolDefinition(BOX_CWD),
      async execute(id, params, signal, onUpdate, ctx) {
        const operations: LsOperations = {
          exists: async (path) => (await box.stat(id, path)).exists,
          stat: async (path) => {
            const stat = await box.stat(id, path);
            return { isDirectory: () => stat.isDirectory };
          },
          readdir: (path) => box.list(id, path),
        };
        return createLsToolDefinition(BOX_CWD, { operations }).execute(
          id,
          params,
          signal,
          onUpdate,
          ctx,
        );
      },
    });

    pi.registerTool({
      ...createFindToolDefinition(BOX_CWD),
      async execute(id, params, signal, onUpdate, ctx) {
        const operations: FindOperations = {
          exists: async (path) => (await box.stat(id, path)).exists,
          glob: (pattern, cwd, { limit }) => box.find(id, pattern, cwd, limit),
        };
        return createFindToolDefinition(BOX_CWD, { operations }).execute(
          id,
          params,
          signal,
          onUpdate,
          ctx,
        );
      },
    });

    // GrepOperations only covers the directory check; grep would still run the
    // hub's `rg`. So grep's execute() is replaced as a whole, like Gondolin's.
    pi.registerTool({
      ...createGrepToolDefinition(BOX_CWD),
      async execute(id, params, signal) {
        const text = await box.grep(id, params, signal);
        return { content: [{ type: "text", text }], details: undefined };
      },
    });

    pi.on("tool_call", (event) => {
      if (PATH_TOOLS.has(event.toolName)) {
        const input = event.input as { path?: unknown };
        if (typeof input.path === "string") input.path = rewriteHome(input.path, options.boxHome);
      }
      return options.policy?.(event);
    });
  };
}

export interface FauxRuntime {
  faux: FauxProviderHandle;
  modelRuntime: ModelRuntime;
  model: Model<string>;
}

/** A model runtime with only pi-ai's scripted faux provider: no network, no credits. */
export async function createFauxRuntime(agentDir: string): Promise<FauxRuntime> {
  const faux = fauxProvider({ provider: "faux" });
  const modelRuntime = await ModelRuntime.create({
    authPath: `${agentDir}/auth.json`,
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  // The real runner passes the session's key from the SecretStore the same way: in memory.
  await modelRuntime.setRuntimeApiKey("faux", "faux-key-not-a-secret");
  return { faux, modelRuntime, model: faux.getModel() };
}

export interface RunnerOptions extends HearthToolsOptions {
  box: FakeBox;
  runtime: FauxRuntime;
  /** An empty temp dir: pi still reads global settings, auth and context from agentDir. */
  agentDir: string;
  /** Stored session entries ([header, ...entries]) to rebuild from. */
  entries?: FileEntry[] | undefined;
  /** Context files the runner fetched from the box (PRD §12 Q9). */
  contextFiles?: Array<{ path: string; content: string }> | undefined;
}

export async function createRunner(options: RunnerOptions) {
  const settingsManager = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({
    cwd: BOX_CWD,
    agentDir: options.agentDir,
    settingsManager,
    // Only Hearth's own extension loads; nothing is discovered on the hub's disk.
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    agentsFilesOverride: () => ({ agentsFiles: options.contextFiles ?? [] }),
    extensionFactories: [
      { name: "hearth-tools", factory: hearthToolsExtension(options.box, options) },
    ],
  });
  await loader.reload();
  const sessionManager = SessionManager.inMemory(BOX_CWD, undefined, options.entries);
  const { session } = await createAgentSession({
    cwd: BOX_CWD,
    agentDir: options.agentDir,
    modelRuntime: options.runtime.modelRuntime,
    model: options.runtime.model,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
    tools: [...ROUTED_TOOLS],
  });
  return { session, sessionManager, loader };
}

/** What the runner would write to the EventStore: the header and the finalized entries. */
export function storedEntries(sessionManager: SessionManager): FileEntry[] {
  const header = sessionManager.getHeader();
  if (!header) throw new Error("session has no header");
  return JSON.parse(JSON.stringify([header, ...sessionManager.getEntries()])) as FileEntry[];
}
