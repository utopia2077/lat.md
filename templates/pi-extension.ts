import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-tui";
import { Markdown, Text } from "@mariozechner/pi-tui";

const PREVIEW_LINES = 4;

function collapsibleResult(
  result: { content: Array<{ type: string; text?: string }> },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
) {
  const text = result.content?.[0]?.type === "text" ? (result.content[0] as { type: "text"; text: string }).text : "";
  if (!text) return new Text(theme.fg("dim", "(empty)"), 0, 0);
  if (options.isPartial) return new Text(theme.fg("dim", "…"), 0, 0);
  const mdTheme = getMarkdownTheme();
  if (options.expanded) return new Markdown(text, 0, 0, mdTheme);

  const lines = text.split("\n");
  if (lines.length <= PREVIEW_LINES) return new Markdown(text, 0, 0, mdTheme);

  const preview = lines.slice(0, PREVIEW_LINES).join("\n");
  const remaining = lines.length - PREVIEW_LINES;
  const hint = keyHint("expandTools", "to expand");
  return new Text(
    preview + "\n" +
    theme.fg("dim", `… ${remaining} more lines (${hint})`),
    0, 0,
  );
}

/** Executable and prefix arguments, injected by `lat init`. */
const LAT = __LAT_INVOCATION__;

function run(args: string[], cwd?: string): string {
  const { execFileSync } = require("child_process") as typeof import("child_process");
  return execFileSync(LAT.command, [...LAT.args, ...args], {
    cwd: cwd ?? process.cwd(),
    encoding: "utf-8",
    timeout: 30_000,
  });
}

function tryRun(args: string[]): string {
  try {
    return run(args);
  } catch {
    return "";
  }
}

export default function (pi: ExtensionAPI) {
  // ── Tools ──────────────────────────────────────────────────────────

  pi.registerTool({
    name: "lat_search",
    label: "lat search",
    description: "Semantic search across lat.md sections using embeddings",
    promptSnippet: "Search lat.md documentation by meaning",
    promptGuidelines: [
      "Use before starting any task to find relevant design context",
      "Search results include section IDs you can pass to lat_section",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query in natural language" }),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default 5)", default: 5 }),
      ),
    }),
    async execute(_id, params) {
      const args = ["search", params.query];
      if (params.limit) args.push("--limit", String(params.limit));
      const output = tryRun(args);
      return {
        content: [{ type: "text", text: output || "No results found." }],
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("lat search ")) +
        theme.fg("dim", `"${args.query}"`),
        0, 0,
      );
    },
    renderResult: collapsibleResult,
  });

  pi.registerTool({
    name: "lat_section",
    label: "lat section",
    description:
      "Show full content of a lat.md section with outgoing/incoming refs",
    promptSnippet: "Read a specific lat.md section",
    parameters: Type.Object({
      query: Type.String({
        description:
          'Section ID or name (e.g. "cli#init", "Tests#User login")',
      }),
    }),
    async execute(_id, params) {
      const output = tryRun(["section", params.query]);
      return {
        content: [
          { type: "text", text: output || "Section not found." },
        ],
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("lat section ")) +
        theme.fg("dim", `"${args.query}"`),
        0, 0,
      );
    },
    renderResult: collapsibleResult,
  });

  pi.registerTool({
    name: "lat_locate",
    label: "lat locate",
    description:
      "Find a section by name (exact, subsection tail, or fuzzy match)",
    promptSnippet: "Find a lat.md section by name",
    parameters: Type.Object({
      query: Type.String({ description: "Section name to locate" }),
    }),
    async execute(_id, params) {
      const output = tryRun(["locate", params.query]);
      return {
        content: [
          { type: "text", text: output || "No sections matching query." },
        ],
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("lat locate ")) +
        theme.fg("dim", `"${args.query}"`),
        0, 0,
      );
    },
  });

  pi.registerTool({
    name: "lat_check",
    label: "lat check",
    description:
      "Run full lat.md validation. Returns errors or 'All checks passed'",
    promptSnippet: "Run full lat.md validation",
    parameters: Type.Object({}),
    async execute() {
      try {
        const output = run(["check"]);
        return { content: [{ type: "text", text: output }] };
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string };
        return {
          content: [{ type: "text", text: e.stdout || e.stderr || "Check failed" }],
          isError: true,
        };
      }
    },
    renderCall(_args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("lat check")),
        0, 0,
      );
    },
  });

  pi.registerTool({
    name: "lat_expand",
    label: "lat expand",
    description:
      "Expand [[refs]] in text to resolved file locations and context",
    promptSnippet: "Resolve [[wiki links]] in text",
    parameters: Type.Object({
      text: Type.String({ description: "Text containing [[refs]] to expand" }),
    }),
    async execute(_id, params) {
      const output = tryRun(["expand", params.text]);
      return {
        content: [{ type: "text", text: output || params.text }],
      };
    },
    renderCall(args, theme) {
      const preview = args.text.length > 60 ? args.text.slice(0, 60) + "…" : args.text;
      return new Text(
        theme.fg("toolTitle", theme.bold("lat expand ")) +
        theme.fg("dim", `"${preview}"`),
        0, 0,
      );
    },
  });

  pi.registerTool({
    name: "lat_refs",
    label: "lat refs",
    description: "Find what references a given section",
    promptSnippet: "Find incoming references to a lat.md section",
    parameters: Type.Object({
      query: Type.String({
        description: 'Section ID (e.g. "cli#init", "file#Section")',
      }),
    }),
    async execute(_id, params) {
      const output = tryRun(["refs", params.query]);
      return {
        content: [{ type: "text", text: output || "No references found." }],
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("lat refs ")) +
        theme.fg("dim", `"${args.query}"`),
        0, 0,
      );
    },
  });

}
