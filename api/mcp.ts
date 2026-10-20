import { createBudgetStore, ToolError } from './_lib/budgetStore.js'
import { ConfigError, json, type Env, type FetchLike } from './_lib/http.js'
import { dayKey, easternNow, TOOLS, TOOLS_BY_NAME, type ToolContext } from './_lib/mcpTools.js'
import { OAuthTokenError, oauthKeyFromEnv, originOf, verifyAccessToken } from './_lib/oauth.js'

/* /api/mcp — the budget as an MCP server, for Claude's custom connector
   (2026-10-19). Streamable HTTP, stateless: every POST carries one JSON-RPC
   message (or a batch) and gets plain JSON back, so no session or stream is
   kept between calls. Written against the spec directly rather than the MCP
   SDK because npm installs are banned on this machine, and the server only
   needs initialize, ping, tools/list and tools/call.

   Auth is the OAuth access token from /api/oauth. Without one the answer is
   a 401 pointing at the protected-resource metadata, which is how Claude
   discovers where to sign in. */

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

const SERVER_INFO = { name: 'lakens-finance', title: "Laken's Finance", version: '1.0.0' }

const INSTRUCTIONS = `This is Laken's personal budget (the "Laken's Finance" dashboard), shared with Cooper. Money is US dollars; dates are YYYY-MM-DD on Eastern time.

How the budget works: each post-tax paycheck is split by envelope rules (percent of take-home, percent of gross, or fixed $ per check). Debt envelopes (like the car) pay down "left to pay" instead of building a balance. Sinking funds save toward a dated goal; on automatic (perCheck 0) each check sets aside exactly what the deadline needs. Whatever is not allocated stays in checking. Random savings are extra amounts put away outside the split.

Use get_overview first for general questions. Before add_paycheck, it helps to show the split with preview_paycheck. Ask before anything destructive (removing a paycheck, envelope or fund) and before overriding the duplicate-paycheck guard. Changes save to the shared budget immediately and appear in the app the next time it is opened or focused. For changes to how the app itself works, use submit_request to ask Cooper.`

const MAX_BODY_BYTES = 256 * 1024

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id',
  'access-control-expose-headers': 'www-authenticate, mcp-session-id',
}

export type McpDeps = { env: Env, fetch: FetchLike, now: () => number }

type JsonRpcMessage = { jsonrpc?: unknown, id?: unknown, method?: unknown, params?: unknown }

export async function POST(request: Request): Promise<Response> {
  return handleMcp(request)
}

export async function GET(request: Request): Promise<Response> {
  return handleMcp(request)
}

export async function DELETE(request: Request): Promise<Response> {
  return handleMcp(request)
}

export async function OPTIONS(request: Request): Promise<Response> {
  return handleMcp(request)
}

export async function handleMcp(request: Request, overrides: Partial<McpDeps> = {}): Promise<Response> {
  const method = request.method.toUpperCase()
  const env = overrides.env ?? process.env
  const now = overrides.now ?? Date.now

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  /* No server-to-client stream and no sessions to end. */
  if (method !== 'POST') return json(405, { error: 'method_not_allowed' }, { ...CORS, allow: 'POST' })

  let userId: string
  try {
    userId = verifyAccessToken(request, oauthKeyFromEnv(env), now()).userId
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message)
      return json(500, { error: 'server_misconfigured' }, CORS)
    }
    const reason = error instanceof OAuthTokenError ? error.reason : 'invalid'
    const metadata = `${originOf(request)}/.well-known/oauth-protected-resource`
    const challenge = reason === 'missing'
      ? `Bearer resource_metadata="${metadata}"`
      : `Bearer error="invalid_token", resource_metadata="${metadata}"`
    return json(401, { error: 'unauthorized' }, { ...CORS, 'www-authenticate': challenge })
  }

  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return rpcHttpError(-32600, 'Request too large')
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return rpcHttpError(-32700, 'Parse error')
  }

  const store = createBudgetStore({ env, userId, ...(overrides.fetch ? { fetch: overrides.fetch } : {}) })
  const context = () => {
    const wallClock = easternNow(now())
    return { store, now: wallClock, today: dayKey(wallClock) }
  }

  const messages = Array.isArray(payload) ? payload : [payload]
  if (messages.length === 0) return rpcHttpError(-32600, 'Empty batch')
  const replies = []
  for (const message of messages) {
    const reply = await handleMessage(message as JsonRpcMessage, context)
    if (reply) replies.push(reply)
  }
  /* Only notifications or responses: accepted, nothing to say. */
  if (replies.length === 0) return new Response(null, { status: 202, headers: CORS })
  return json(200, Array.isArray(payload) ? replies : replies[0], CORS)
}

async function handleMessage(message: JsonRpcMessage, context: () => ToolContext) {
  if (typeof message !== 'object' || message === null || message.jsonrpc !== '2.0') {
    return rpcError(null, -32600, 'Invalid Request')
  }
  const hasId = message.id !== undefined && message.id !== null
  const id = hasId ? message.id : null
  if (typeof message.method !== 'string') {
    /* A response from the client to something we never sent. */
    return hasId && message.method === undefined ? null : rpcError(id, -32600, 'Invalid Request')
  }
  if (!hasId) return null

  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>

  switch (message.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      })
    }
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, {
        tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({
          name,
          title: annotations.title,
          description,
          inputSchema,
          annotations,
        })),
      })
    case 'tools/call': {
      const tool = typeof params.name === 'string' ? TOOLS_BY_NAME.get(params.name) : undefined
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(params.name)}`)
      const args = (typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments)
        ? params.arguments
        : {}) as Record<string, unknown>
      try {
        const result = await tool.run(context(), args)
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: false,
        })
      } catch (error) {
        /* A tool failure is a result the model reads and can recover from,
           not a protocol error. Only ToolError text is shown; anything else
           stays in the server log. */
        if (!(error instanceof ToolError)) console.error('mcp tool failed', tool.name, error)
        const text = error instanceof ToolError ? error.message : 'Something went wrong on the budget server. Try again in a moment.'
        return rpcResult(id, { content: [{ type: 'text', text }], isError: true })
      }
    }
    case 'resources/list':
      return rpcResult(id, { resources: [] })
    case 'resources/templates/list':
      return rpcResult(id, { resourceTemplates: [] })
    case 'prompts/list':
      return rpcResult(id, { prompts: [] })
    default:
      return rpcError(id, -32601, `Method not found: ${message.method}`)
  }
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function rpcHttpError(code: number, message: string) {
  return json(400, rpcError(null, code, message), CORS)
}
