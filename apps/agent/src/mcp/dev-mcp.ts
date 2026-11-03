import { devOAuth, signInRequired } from "./dev-oauth.ts";
import type { McpNetwork } from "./service.ts";

/**
 * The MCP servers of local development (a loopback http PUBLIC_URL, as for the
 * mock AI, the push services and the bot): any https address on
 * `*.exemplo.com.br` is answered here, so `npm run dev`, the e2e tests and the
 * screenshots never reach a real server. Every other address goes out as in
 * production. A token "invalido" is refused, to show the sign-in error, and
 * `conta.exemplo.com.br` asks for an OAuth sign-in (step 18b).
 */
const SIMULATED = /\.exemplo\.com\.br$/;

/** The simulated service with OAuth sign-in (step 18b): `https://conta.exemplo.com.br/mcp`, signing in at `entrar.exemplo.com.br`. */
export const DEV_OAUTH_RESOURCE = "https://conta.exemplo.com.br/mcp";
const oauth = devOAuth(DEV_OAUTH_RESOURCE, "https://entrar.exemplo.com.br");
oauth.devCodes = true;

const TOOLS = [
  {
    name: "buscar_documentos",
    title: "Buscar documentos",
    description: "Busca páginas na documentação da equipe.",
    inputSchema: { type: "object", properties: { consulta: { type: "string" } }, required: ["consulta"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "criar_chamado",
    title: "Criar chamado",
    description: "Abre um chamado no sistema de suporte.",
    inputSchema: { type: "object", properties: { titulo: { type: "string" } }, required: ["titulo"] },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

async function answer(request: Request): Promise<Response> {
  const signIn = await oauth.handle(request);
  if (signIn) return signIn;
  if (new URL(request.url).hostname === "conta.exemplo.com.br" && !oauth.authorized(request)) return signInRequired(DEV_OAUTH_RESOURCE);
  if ((request.headers.get("authorization") ?? "").includes("invalido")) return new Response(null, { status: 401 });
  if (request.method === "DELETE") return new Response(null, { status: 200 });
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const body = (await request.json().catch(() => null)) as { id?: unknown; method?: string; params?: { name?: unknown; arguments?: Record<string, unknown> } } | null;
  if (!body || body.id === undefined) return new Response(null, { status: 202 });
  const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result }, { headers: { "mcp-session-id": "dev-session" } });
  if (body.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "exemplo", version: "1.0.0" } });
  if (body.method === "tools/list") return reply({ tools: TOOLS });
  if (body.method === "tools/call") {
    const args = body.params?.arguments ?? {};
    const text = body.params?.name === "criar_chamado" ? `Chamado #128 criado: ${String(args.titulo ?? "")}` : `2 páginas sobre ${String(args.consulta ?? "")}`;
    return reply({ content: [{ type: "text", text }] });
  }
  return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
}

/** The development network: the simulated servers, and the real one for anything else. */
export function developmentMcpNetwork(real: McpNetwork): McpNetwork {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      return SIMULATED.test(new URL(request.url).hostname) ? answer(request) : real.fetch(request);
    }) as typeof fetch,
    resolve: (host, signal) => (SIMULATED.test(host) ? Promise.resolve(["203.0.114.10"]) : real.resolve(host, signal)),
  };
}
