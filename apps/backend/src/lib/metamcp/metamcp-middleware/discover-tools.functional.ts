import { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { eq, sql } from "drizzle-orm";

import logger from "@/utils/logger";

import { db } from "../../../db/index";
import { mcpRequestAuditLogsTable, namespacesTable } from "../../../db/schema";
import { parseToolName } from "../tool-name-parser";
import {
  CallToolHandler,
  CallToolMiddleware,
  ListToolsHandler,
  ListToolsMiddleware,
} from "./functional-middleware";

/**
 * Discover/call gateway middleware.
 *
 * When a namespace has discovery mode enabled, tools/list collapses the
 * namespace's real tool list down to two meta-tools (metamcp_discover,
 * metamcp_call). This must sit OUTSIDE (i.e. earlier in compose() than) the
 * audit/filter/override middleware: metamcp_call rewrites the request to the
 * real tool name and re-enters the chain, so audit logging, per-tool
 * filtering, and name/description overrides all keep applying to the real
 * tool exactly as they do when discovery mode is off.
 */

export const DISCOVER_TOOL_NAME = "metamcp_discover";
export const CALL_TOOL_NAME = "metamcp_call";

const DISCOVER_TOOL: Tool = {
  name: DISCOVER_TOOL_NAME,
  description:
    "Search this namespace's available tools by keyword. Returns matching tool names, descriptions, and full parameter schemas. Call this first to find the right tool, then invoke it with metamcp_call.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Keyword(s) to search for, matched against tool names, descriptions, and server names. Omit to list all available tools.",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return. Default 20.",
      },
    },
  },
};

const CALL_TOOL: Tool = {
  name: CALL_TOOL_NAME,
  description:
    "Execute a tool found via metamcp_discover. Pass the exact tool name returned by metamcp_discover and its arguments.",
  inputSchema: {
    type: "object",
    required: ["tool", "args"],
    properties: {
      tool: {
        type: "string",
        description: "Exact tool name as returned by metamcp_discover.",
      },
      args: {
        type: "object",
        description: "Arguments for the tool, matching its inputSchema.",
      },
    },
  },
};

// Per-namespace cache of the last fully-resolved (post filter/override) tool
// list, so metamcp_discover/metamcp_call never read the DB's tools table —
// that mirror is only hash-synced on tool *names*, so it can go stale on a
// schema/description-only upstream change. The live list is always current.
interface DiscoveryIndexEntry {
  tools: Tool[];
  expiresAt: number;
}

const DISCOVERY_INDEX_TTL_MS = 5 * 60 * 1000;
const discoveryIndex = new Map<string, DiscoveryIndexEntry>();

function setDiscoveryIndex(namespaceUuid: string, tools: Tool[]): void {
  discoveryIndex.set(namespaceUuid, {
    tools,
    expiresAt: Date.now() + DISCOVERY_INDEX_TTL_MS,
  });
}

function getDiscoveryIndex(namespaceUuid: string): Tool[] | null {
  const entry = discoveryIndex.get(namespaceUuid);
  if (!entry || Date.now() > entry.expiresAt) {
    return null;
  }
  return entry.tools;
}

export function clearDiscoveryIndex(namespaceUuid?: string): void {
  if (namespaceUuid) {
    discoveryIndex.delete(namespaceUuid);
  } else {
    discoveryIndex.clear();
  }
}

// Namespace discovery-mode flag, cached briefly to avoid a DB round trip on
// every tools/list and tools/call.
const discoveryModeCache = new Map<
  string,
  { enabled: boolean; expiresAt: number }
>();
const DISCOVERY_MODE_CACHE_TTL_MS = 30 * 1000;

async function isDiscoveryModeEnabled(namespaceUuid: string): Promise<boolean> {
  const cached = discoveryModeCache.get(namespaceUuid);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.enabled;
  }

  try {
    const [namespace] = await db
      .select({ enabled: namespacesTable.discovery_mode_enabled })
      .from(namespacesTable)
      .where(eq(namespacesTable.uuid, namespaceUuid))
      .limit(1);

    const enabled = namespace?.enabled ?? false;
    discoveryModeCache.set(namespaceUuid, {
      enabled,
      expiresAt: Date.now() + DISCOVERY_MODE_CACHE_TTL_MS,
    });
    return enabled;
  } catch (error) {
    logger.error(
      `Error checking discovery mode for namespace ${namespaceUuid}:`,
      error,
    );
    return false;
  }
}

export function clearDiscoveryModeCache(namespaceUuid?: string): void {
  if (namespaceUuid) {
    discoveryModeCache.delete(namespaceUuid);
  } else {
    discoveryModeCache.clear();
  }
}

// Call-frequency, used only as a tiebreaker on top of keyword relevance so
// tools with zero calls (the long tail discovery exists to surface) aren't
// starved by a pure-popularity sort.
async function getToolCallFrequency(
  namespaceUuid: string,
): Promise<Map<string, number>> {
  const frequency = new Map<string, number>();

  try {
    const rows = await db
      .select({
        toolName: mcpRequestAuditLogsTable.tool_name,
        callCount: sql<number>`count(*)`,
      })
      .from(mcpRequestAuditLogsTable)
      .where(eq(mcpRequestAuditLogsTable.namespace_uuid, namespaceUuid))
      .groupBy(mcpRequestAuditLogsTable.tool_name);

    for (const row of rows) {
      frequency.set(row.toolName, Number(row.callCount));
    }
  } catch (error) {
    logger.error(
      `Error fetching tool call frequency for namespace ${namespaceUuid}:`,
      error,
    );
  }

  return frequency;
}

function scoreMatch(tool: Tool, queryTerms: string[]): number {
  if (queryTerms.length === 0) {
    return 1;
  }

  const name = tool.name.toLowerCase();
  const description = (tool.description || "").toLowerCase();
  const server = (parseToolName(tool.name)?.serverName || "").toLowerCase();

  let score = 0;
  for (const term of queryTerms) {
    if (name.includes(term)) score += 3;
    if (server.includes(term)) score += 2;
    if (description.includes(term)) score += 1;
  }

  return score;
}

interface DiscoverMatch {
  name: string;
  description?: string;
  inputSchema: unknown;
}

async function searchTools(
  namespaceUuid: string,
  query: string | undefined,
  limit: number,
): Promise<DiscoverMatch[]> {
  const tools = getDiscoveryIndex(namespaceUuid) || [];
  const queryTerms = (query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  const frequency = await getToolCallFrequency(namespaceUuid);

  const scored = tools
    .map((tool) => ({
      tool,
      matchScore: scoreMatch(tool, queryTerms),
      callCount: frequency.get(tool.name) || 0,
    }))
    .filter((entry) => queryTerms.length === 0 || entry.matchScore > 0);

  scored.sort((a, b) => {
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
    return b.callCount - a.callCount;
  });

  return scored.slice(0, limit).map((entry) => ({
    name: entry.tool.name,
    description: entry.tool.description,
    inputSchema: entry.tool.inputSchema,
  }));
}

export function createDiscoverListToolsMiddleware(): ListToolsMiddleware {
  return (handler: ListToolsHandler): ListToolsHandler => {
    return async (request, context) => {
      const response = await handler(request, context);

      const enabled = await isDiscoveryModeEnabled(context.namespaceUuid);
      if (!enabled) {
        return response;
      }

      setDiscoveryIndex(context.namespaceUuid, response.tools);

      return {
        ...response,
        tools: [DISCOVER_TOOL, CALL_TOOL],
      };
    };
  };
}

export function createDiscoverCallToolMiddleware(): CallToolMiddleware {
  return (handler: CallToolHandler): CallToolHandler => {
    return async (request, context): Promise<CallToolResult> => {
      const enabled = await isDiscoveryModeEnabled(context.namespaceUuid);
      if (!enabled) {
        return handler(request, context);
      }

      if (request.params.name === DISCOVER_TOOL_NAME) {
        const args = (request.params.arguments || {}) as {
          query?: string;
          limit?: number;
        };
        const limit =
          typeof args.limit === "number" && args.limit > 0
            ? Math.min(args.limit, 100)
            : 20;

        const indexPresent = getDiscoveryIndex(context.namespaceUuid) !== null;
        if (!indexPresent) {
          return {
            content: [
              {
                type: "text",
                text: "No tool index available yet for this namespace. Call tools/list once, then retry metamcp_discover.",
              },
            ],
            isError: true,
          };
        }

        const matches = await searchTools(
          context.namespaceUuid,
          args.query,
          limit,
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ matches, total: matches.length }, null, 2),
            },
          ],
        };
      }

      if (request.params.name === CALL_TOOL_NAME) {
        const args = (request.params.arguments || {}) as {
          tool?: string;
          args?: Record<string, unknown>;
        };

        if (!args.tool) {
          return {
            content: [
              {
                type: "text",
                text: 'metamcp_call requires a "tool" argument naming the tool to run — get it from metamcp_discover.',
              },
            ],
            isError: true,
          };
        }

        const index = getDiscoveryIndex(context.namespaceUuid);
        const known = index?.some((tool) => tool.name === args.tool);

        if (index && !known) {
          return {
            content: [
              {
                type: "text",
                text: `Tool "${args.tool}" was not found in the current tool list. It may have been renamed or removed upstream — call metamcp_discover again to refresh, then retry.`,
              },
            ],
            isError: true,
          };
        }

        const rewrittenRequest = {
          ...request,
          params: {
            ...request.params,
            name: args.tool,
            arguments: args.args || {},
          },
        };

        return handler(rewrittenRequest, context);
      }

      // Not a meta-tool call — pass through unchanged (e.g. a client that
      // cached a real tool name from before discovery mode was turned on).
      return handler(request, context);
    };
  };
}
