import type { FlowNetwork } from "./connections.ts";

/**
 * The flows' network in local development (a loopback http PUBLIC_URL): every
 * https address on `*.exemplo.com.br` is answered here, so `npm run dev`, the
 * e2e tests and the screenshots never reach a real site. `fora.exemplo.com.br`
 * is a site that is down; `api.exemplo.com.br` is a small JSON service with
 * clients under `/v1/clientes`. Every other address goes out as in production.
 */
const SIMULATED = /\.exemplo\.com\.br$/;

const CLIENTS = [
  { id: 1, nome: "Ana Souza", etapa: "proposta", valor: 1200 },
  { id: 2, nome: "Bruno Lima", etapa: "negociacao", valor: 3400 },
  { id: 3, nome: "Carla Dias", etapa: "proposta", valor: 800 },
];

function answer(request: Request): Response {
  const url = new URL(request.url);
  if (url.hostname === "fora.exemplo.com.br") return new Response("indisponível", { status: 503 });
  if (url.hostname === "api.exemplo.com.br") {
    if (url.pathname === "/v1/clientes") return Response.json({ data: CLIENTS });
    const one = /^\/v1\/clientes\/(\d+)$/.exec(url.pathname);
    if (one) {
      const client = CLIENTS.find((entry) => entry.id === Number(one[1]));
      return client ? Response.json(client) : Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return new Response("<html><body>ok</body></html>", { status: 200, headers: { "content-type": "text/html" } });
}

export function developmentFlowNetwork(real: FlowNetwork): FlowNetwork {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (SIMULATED.test(new URL(request.url).hostname)) return answer(request);
      return real.fetch(request);
    }) as typeof fetch,
    // Any public address: the documentation ranges count as private in the checks.
    resolve: async (host, signal) => (SIMULATED.test(host) ? ["8.8.8.8"] : real.resolve(host, signal)),
  };
}
