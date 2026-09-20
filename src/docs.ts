import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { normalizeOutput, truncate } from "./output.js";

/**
 * Live documentation tools: fetch the GoModel docs anonymously from GitHub
 * (Mintlify docs.json index + raw page contents) so the agent can read the
 * upstream docs without leaving the session. No token, no extra dependencies.
 */

const REPO = process.env.GOMODEL_DOCS_REPO ?? "ENTERPILOT/GoModel";
const REF = process.env.GOMODEL_DOCS_REF ?? "main";

// GitHub degrades often enough that stale docs beat no docs: 30 min default,
// overridable; clamped so a typo can never disable or freeze the cache.
const DOCS_CACHE_TTL_SECONDS = (() => {
  const value = Number.parseInt(process.env.GOMODEL_DOCS_CACHE_TTL_SECONDS ?? "", 10);
  if (!Number.isFinite(value)) return 1800;
  return Math.min(Math.max(value, 60), 86400);
})();
const INDEX_TTL_MS = DOCS_CACHE_TTL_SECONDS * 1000;
const CONTENT_TTL_MS = DOCS_CACHE_TTL_SECONDS * 1000;
const FETCH_CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 30_000;

interface DocPage {
  /** Path relative to the repo's docs/ directory, e.g. "guides/foo.mdx". */
  path: string;
  title: string;
  /** Nearest enclosing tab or group name, "" when the index gives none. */
  group: string;
}

interface CacheEntry {
  content: string;
  fetchedAt: number;
}

let index: DocPage[] | null = null;
let indexFetchedAt = 0;
const contentCache = new Map<string, CacheEntry>();

/** Anonymous GET of a raw/text URL. Resolves null on 404, throws otherwise. */
async function fetchDocText(url: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "text/plain, application/json;q=0.9, */*;q=0.8", "User-Agent": "gomodel-admin-mcp" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`docs fetch failed for ${url}: ${message}`);
  }
  if (res.status === 404) return null;
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`docs fetch failed ${res.status} ${res.statusText} for ${url}: ${body.slice(0, 2000)}`);
  }
  return truncate(body);
}

function rawUrl(path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${REPO}/${REF}/docs/${encoded}`;
}

/** "getting-started.mdx" -> "Getting Started" */
function titleFromPath(path: string): string {
  const base = path.replace(/\.(mdx|md)$/i, "").split("/").pop() ?? path;
  return base
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

function normalizePath(path: string): string {
  return path.replace(/^\.?\//, "").replace(/^docs\//, "");
}

function toPage(path: string, group: string, title?: string): DocPage {
  const normalized = normalizePath(path);
  return { path: normalized, title: title ?? titleFromPath(normalized), group };
}

/** Walk a Mintlify navigation tree: tabs -> groups -> pages, defensively. */
function walkNavigation(nodes: unknown[], group: string, out: DocPage[]): void {
  for (const node of nodes) {
    if (typeof node === "string") {
      out.push(toPage(node, group));
      continue;
    }
    if (!node || typeof node !== "object") continue;
    const record = node as Record<string, unknown>;
    const name =
      typeof record.tab === "string"
        ? record.tab
        : typeof record.group === "string"
          ? record.group
          : typeof record.title === "string"
            ? record.title
            : group;
    const childGroup = name || group;
    if (typeof record.page === "string") {
      out.push(toPage(record.page, childGroup, typeof record.title === "string" ? record.title : undefined));
    }
    if (Array.isArray(record.pages)) walkNavigation(record.pages, childGroup, out);
  }
}

/** Extract the page list from a parsed Mintlify docs.json. */
function collectPages(docsJson: unknown): DocPage[] {
  const navigation = (docsJson as Record<string, unknown> | null)?.navigation;
  let roots: unknown[] = [];
  if (Array.isArray(navigation)) {
    roots = navigation;
  } else if (navigation && typeof navigation === "object") {
    for (const key of ["tabs", "groups", "pages"]) {
      const value = (navigation as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        roots = value;
        break;
      }
    }
  }
  const out: DocPage[] = [];
  walkNavigation(roots, "", out);
  const seen = new Set<string>();
  return out
    .filter((page) => (seen.has(page.path) ? false : seen.add(page.path)))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Fallback index: list every markdown page in the repo's docs/ tree. */
async function fetchIndexFromTree(): Promise<DocPage[]> {
  const url = `https://api.github.com/repos/${REPO}/git/trees/${encodeURIComponent(REF)}?recursive=1`;
  const text = await fetchDocText(url);
  if (!text) throw new Error(`docs fetch failed: tree listing for ${REPO}@${REF} not found`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`docs fetch failed: unparseable tree listing for ${REPO}@${REF}: ${message}`);
  }
  const tree = (parsed as Record<string, unknown> | null)?.tree;
  if (!Array.isArray(tree)) {
    throw new Error(`docs fetch failed: tree listing for ${REPO}@${REF} has no tree entries`);
  }
  const out: DocPage[] = [];
  for (const entry of tree) {
    if (!entry || typeof entry !== "object") continue;
    const gitPath = (entry as Record<string, unknown>).path;
    if (typeof gitPath !== "string" || !/^docs\/.*\.(mdx|md)$/.test(gitPath)) continue;
    out.push(toPage(gitPath, ""));
  }
  const seen = new Set<string>();
  return out.filter((page) => (seen.has(page.path) ? false : seen.add(page.path))).sort((a, b) => a.path.localeCompare(b.path));
}

/** Index source: Mintlify docs.json, falling back to the GitHub tree API. */
async function fetchIndex(): Promise<DocPage[]> {
  try {
    const text = await fetchDocText(rawUrl("docs.json"));
    if (text) {
      const pages = collectPages(JSON.parse(text));
      if (pages.length > 0) return pages;
    }
  } catch {
    // fall through to the tree listing
  }
  return fetchIndexFromTree();
}

async function getIndex(refresh: boolean): Promise<DocPage[]> {
  if (refresh) {
    index = null;
    indexFetchedAt = 0;
    contentCache.clear();
  }
  if (index && Date.now() - indexFetchedAt <= INDEX_TTL_MS) return index;
  const pages = await fetchIndex();
  index = pages;
  indexFetchedAt = Date.now();
  return pages;
}

/**
 * Fetch one page's content (trying .mdx then .md for extension-less entries),
 * updating the index entry in place once the real extension is known.
 */
async function loadPage(page: DocPage, bust: boolean): Promise<CacheEntry | null> {
  if (!bust) {
    const cached = contentCache.get(page.path);
    if (cached && Date.now() - cached.fetchedAt <= CONTENT_TTL_MS) return cached;
  }
  const candidates = /\.(mdx|md)$/i.test(page.path) ? [page.path] : [`${page.path}.mdx`, `${page.path}.md`];
  for (const candidate of candidates) {
    const content = await fetchDocText(rawUrl(candidate));
    if (content === null) continue;
    if (candidate !== page.path) page.path = candidate;
    const entry: CacheEntry = { content, fetchedAt: Date.now() };
    contentCache.set(candidate, entry);
    return entry;
  }
  return null;
}

/** Fill the content cache for pages not yet cached, 8 at a time; returns failures. */
async function fillContents(pages: DocPage[]): Promise<number> {
  const now = Date.now();
  const pending = pages.filter((page) => {
    const cached = contentCache.get(page.path);
    return !cached || now - cached.fetchedAt > CONTENT_TTL_MS;
  });
  let failed = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, pending.length) }, async () => {
    while (cursor < pending.length) {
      const page = pending[cursor++];
      try {
        const entry = await loadPage(page, false);
        if (!entry) failed += 1;
      } catch {
        failed += 1;
      }
    }
  });
  await Promise.all(workers);
  return failed;
}

const REGEX_METACHARS = /[\\^$|?*+()[\]{}]/;

async function docsIndexText(args: Record<string, unknown>): Promise<string> {
  const pages = await getIndex(args.refresh === true);
  const header = `${REPO}@${REF} — ${pages.length} pages`;
  // Assemble first, then bound: the header must count toward the byte cap.
  return truncate(
    `${header}\n${normalizeOutput(
      JSON.stringify(pages.map(({ path, title, group }) => ({ path, title, group }))),
    )}`,
  );
}

async function docsSearchText(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? "");
  const rawMax = Number(args.max_results ?? 50);
  const max = Math.min(Math.max(Number.isFinite(rawMax) ? Math.trunc(rawMax) : 50, 1), 200);
  const refresh = args.refresh === true;

  let matchesLine: (line: string) => boolean;
  if (REGEX_METACHARS.test(query) || query.startsWith("^")) {
    let regex: RegExp;
    try {
      regex = new RegExp(query, "i");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid docs search regex ${JSON.stringify(query)}: ${message}`);
    }
    matchesLine = (line) => regex.test(line);
  } else {
    const needle = query.toLowerCase();
    matchesLine = (line) => line.toLowerCase().includes(needle);
  }

  const pages = await getIndex(refresh);
  const failed = await fillContents(pages);

  const lines: string[] = [];
  let extra = 0;
  for (const page of pages) {
    const entry = contentCache.get(page.path);
    if (!entry) continue;
    const pageLines = entry.content.split("\n");
    for (let i = 0; i < pageLines.length; i += 1) {
      if (!matchesLine(pageLines[i])) continue;
      if (lines.length < max) {
        lines.push(`docs/${page.path}:${i + 1}: ${pageLines[i].trim()}`);
      } else {
        extra += 1;
      }
    }
  }

  let text = lines.length > 0 ? lines.join("\n") : `[no matches for ${JSON.stringify(query)}]`;
  if (extra > 0) text += `\n[truncated: ${extra} more matches]`;
  if (failed > 0) text += `\n[note: ${failed} page(s) could not be fetched]`;
  return text;
}

async function docsGetText(args: Record<string, unknown>): Promise<string> {
  const refresh = args.refresh === true;
  const pages = await getIndex(false);
  const requested = normalizePath(String(args.path ?? ""));

  let page = pages.find((candidate) => candidate.path === requested);
  if (!page) {
    const suffixMatches = pages.filter((candidate) => candidate.path.endsWith(requested));
    if (suffixMatches.length === 0) {
      throw new Error(`docs page not found: ${requested} (repo ${REPO}@${REF})`);
    }
    if (suffixMatches.length > 1) {
      throw new Error(
        `ambiguous docs path ${requested}, matches: ${suffixMatches.map((candidate) => candidate.path).join(", ")}`,
      );
    }
    page = suffixMatches[0];
  }

  const entry = await loadPage(page, refresh);
  if (!entry) {
    throw new Error(`docs page not found: ${page.path} (tried .mdx and .md in ${REPO}@${REF})`);
  }
  const bytes = Buffer.byteLength(entry.content, "utf8");
  return `docs/${page.path} (${bytes} bytes)\n${entry.content}`;
}

/** Register the docs tools; returns the number of tools registered. */
export function registerDocsTools(server: McpServer): number {
  const tools: Array<{
    name: string;
    description: string;
    schema: Record<string, z.ZodTypeAny>;
    handler: (args: Record<string, unknown>) => Promise<string>;
  }> = [
    {
      name: "docs_index",
      description:
        `List the GoModel documentation pages fetched live from GitHub (Mintlify docs.json index). Returns a repo@ref header line with the page count, then a JSON array of {path, title, group} sorted by path. Cached for ${DOCS_CACHE_TTL_SECONDS}s (default 1800, GOMODEL_DOCS_CACHE_TTL_SECONDS); pass refresh to bust.`,
      schema: {
        refresh: z.boolean().optional().describe("Bust the cached index and page contents and refetch"),
      },
      handler: docsIndexText,
    },
    {
      name: "docs_search",
      description:
        `Search the GoModel documentation full text. Case-insensitive substring match by default; a regex-looking query (metacharacters or leading ^) is treated as a case-insensitive regex. Output is ripgrep-style lines: docs/path.mdx:LINE: text. Index and page contents are cached for ${DOCS_CACHE_TTL_SECONDS}s (default 1800, GOMODEL_DOCS_CACHE_TTL_SECONDS); pass refresh to bust.`,
      schema: {
        query: z.string().min(1).describe("Substring or regular expression to search for"),
        max_results: z.number().optional().describe("Maximum matching lines to return (default 50, cap 200)"),
        refresh: z.boolean().optional().describe("Bust the cached index and page contents and refetch"),
      },
      handler: docsSearchText,
    },
    {
      name: "docs_get",
      description:
        `Fetch one full GoModel documentation page by path (relative to docs/, extension optional — unique suffix matches work too). First line is a docs/path (bytes) header, followed by the raw page content. Cached for ${DOCS_CACHE_TTL_SECONDS}s (default 1800, GOMODEL_DOCS_CACHE_TTL_SECONDS); pass refresh to bust.`,
      schema: {
        path: z.string().min(1).describe('Page path, e.g. "guides/foo.mdx" or a unique suffix "foo.mdx"'),
        refresh: z.boolean().optional().describe("Bust this page's cached content and refetch"),
      },
      handler: docsGetText,
    },
  ];

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      async (args) => {
        try {
          const text = await tool.handler(args as Record<string, unknown>);
          return { content: [{ type: "text" as const, text }] };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
        }
      },
    );
  }
  return tools.length;
}
