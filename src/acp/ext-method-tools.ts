import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'

export type ClientToolSpec = {
  method: string
  toolName?: string
  label?: string
  description?: string
  parameters?: Record<string, unknown>
}

type RegisteredSession = {
  sessionId: string
  conn: AgentSideConnection
}

export type BridgeSpawnConfig = {
  token: string
  args: string[]
  env: Record<string, string>
}

export class ExtMethodToolBridge {
  private readonly specs: ClientToolSpec[]
  private readonly server: Server | null
  private readonly tokens = new Map<string, RegisteredSession>()
  private readonly extensionPath: string | null
  private readonly portReady: Promise<number> | null

  private constructor(specs: ClientToolSpec[], server: Server | null, extensionPath: string | null, portReady: Promise<number> | null) {
    this.specs = specs
    this.server = server
    this.extensionPath = extensionPath
    this.portReady = portReady
  }

  static fromEnv(): ExtMethodToolBridge {
    const specs = loadClientToolSpecs(process.env.PI_ACP_CLIENT_TOOLS)
    if (specs.length === 0) {
      return new ExtMethodToolBridge([], null, null, null)
    }
    const extensionPath = writeBridgeExtensionFile()
    const server = createServer()
    const portReady = new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (!addr || typeof addr === 'string') {
          reject(new Error('could not determine ext-method bridge address'))
          return
        }
        resolve(addr.port)
      })
    })
    const bridge = new ExtMethodToolBridge(specs, server, extensionPath, portReady)
    bridge.server.on('request', (req, res) => {
      void bridge.handleRequest(req, res)
    })
    bridge.server.unref()
    return bridge
  }

  isEnabled(): boolean {
    return this.specs.length > 0 && this.server !== null && this.extensionPath !== null
  }

  dispose(): void {
    this.tokens.clear()
    this.server?.closeAllConnections?.()
    this.server?.closeIdleConnections?.()
    this.server?.close()
  }

  async prepareSpawn(): Promise<BridgeSpawnConfig | null> {
    if (!this.isEnabled()) {
      return null
    }
    const port = await this.portReady
    const token = crypto.randomUUID()
    return {
      token,
      args: ['-e', this.extensionPath!],
      env: {
        PI_ACP_CLIENT_TOOLS_URL: `http://127.0.0.1:${port}/invoke`,
        PI_ACP_CLIENT_TOOLS_TOKEN: token,
        PI_ACP_CLIENT_TOOLS: JSON.stringify(this.specs)
      }
    }
  }

  bindToken(token: string | null | undefined, sessionId: string, conn: AgentSideConnection): void {
    if (!token) return
    this.tokens.set(token, { sessionId, conn })
  }

  unregisterSessionToken(token: string | null | undefined): void {
    if (!token) return
    this.tokens.delete(token)
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || req.url !== '/invoke') {
      this.writeJSON(res, 404, { error: 'not found' })
      return
    }
    const token = String(req.headers['x-pi-acp-token'] ?? '')
    const session = this.tokens.get(token)
    if (!session) {
      this.writeJSON(res, 403, { error: 'unknown bridge token' })
      return
    }
    let body: any
    try {
      body = await readJSONBody(req)
    } catch (err) {
      this.writeJSON(res, 400, { error: String(err) })
      return
    }
    const method = typeof body?.method === 'string' ? body.method : ''
    if (!method.startsWith('_')) {
      this.writeJSON(res, 400, { error: 'method must start with _' })
      return
    }
    const params = body?.params && typeof body.params === 'object' ? { ...body.params } : {}
    const meta = params._meta && typeof params._meta === 'object' ? { ...params._meta } : {}
    params._meta = {
      ...meta,
      sessionId: session.sessionId
    }
    try {
      const result = await session.conn.extMethod(method.substring(1), params)
      this.writeJSON(res, 200, { ok: true, result })
    } catch (err) {
      this.writeJSON(res, 500, { error: errorText(err) })
    }
  }

  private writeJSON(res: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
    res.statusCode = statusCode
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(payload))
  }
}

export function loadClientToolSpecs(raw: string | undefined): ClientToolSpec[] {
  if (!raw || !raw.trim()) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`invalid PI_ACP_CLIENT_TOOLS JSON: ${String(err)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error('PI_ACP_CLIENT_TOOLS must be a JSON array')
  }
  const out: ClientToolSpec[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    if (!item || typeof item !== 'object') {
      throw new Error('PI_ACP_CLIENT_TOOLS entries must be objects')
    }
    const method = typeof (item as any).method === 'string' ? (item as any).method.trim() : ''
    if (!method.startsWith('_')) {
      throw new Error(`client tool method must start with _: ${method || '(empty)'}`)
    }
    if (seen.has(method)) {
      throw new Error(`duplicate client tool method: ${method}`)
    }
    seen.add(method)
    const parameters = (item as any).parameters
    out.push({
      method,
      toolName: typeof (item as any).toolName === 'string' ? (item as any).toolName.trim() : undefined,
      label: typeof (item as any).label === 'string' ? (item as any).label.trim() : undefined,
      description: typeof (item as any).description === 'string' ? (item as any).description.trim() : undefined,
      parameters: parameters && typeof parameters === 'object' ? parameters : undefined
    })
  }
  return out
}

function writeBridgeExtensionFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-ext-tools-'))
  const path = join(dir, 'client-tools-extension.mjs')
  writeFileSync(path, extensionSource, 'utf8')
  return path
}

async function readJSONBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return {}
  return JSON.parse(raw)
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err) return err
  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string' && message) return message
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  return String(err)
}

const extensionSource = `
const DEFAULT_SCHEMA = { type: "object", properties: {}, additionalProperties: true };

function toolNameFor(spec) {
  if (typeof spec.toolName === "string" && spec.toolName.trim()) return spec.toolName.trim();
  return spec.method.replace(/^_+/, "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "client_tool";
}

function labelFor(spec, name) {
  if (typeof spec.label === "string" && spec.label.trim()) return spec.label.trim();
  return name;
}

function descriptionFor(spec) {
  if (typeof spec.description === "string" && spec.description.trim()) return spec.description.trim();
  return "Call ACP client extension method " + spec.method;
}

function contentFromResult(result) {
  if (Array.isArray(result?.content) && result.content.length > 0) return result.content;
  if (typeof result?.text === "string" && result.text) return [{ type: "text", text: result.text }];
  return [{ type: "text", text: JSON.stringify(result ?? {}, null, 2) }];
}

export default function(pi) {
  const url = process.env.PI_ACP_CLIENT_TOOLS_URL;
  const token = process.env.PI_ACP_CLIENT_TOOLS_TOKEN;
  const raw = process.env.PI_ACP_CLIENT_TOOLS;
  if (!url || !token || !raw) return;
  let specs;
  try {
    specs = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(specs)) return;

  for (const spec of specs) {
    if (!spec || typeof spec !== "object" || typeof spec.method !== "string" || !spec.method.startsWith("_")) continue;
    const name = toolNameFor(spec);
    pi.registerTool({
      name,
      label: labelFor(spec, name),
      description: descriptionFor(spec),
      parameters: spec.parameters && typeof spec.parameters === "object" ? spec.parameters : DEFAULT_SCHEMA,
      async execute(_toolCallId, params) {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-pi-acp-token": token
          },
          body: JSON.stringify({ method: spec.method, params: params ?? {} })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          let message = "client tool bridge failed";
          if (typeof payload?.error === "string" && payload.error) {
            message = payload.error;
          } else if (payload?.error && typeof payload.error === "object") {
            try {
              message = JSON.stringify(payload.error);
            } catch {
              message = String(payload.error);
            }
          }
          throw new Error(message);
        }
        const result = payload && typeof payload === "object" && payload.result && typeof payload.result === "object" ? payload.result : {};
        return {
          content: contentFromResult(result),
          details: result
        };
      }
    });
  }
}
`
