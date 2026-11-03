import { toBase64Url } from "@zuri/shared";

/**
 * A simulated OAuth sign-in server (step 18b) for local development, the e2e
 * tests and the unit tests: protected-resource metadata on the MCP server,
 * authorization-server metadata, dynamic registration, and a token endpoint
 * that checks the PKCE verifier, the redirect, the client and the resource.
 * Nothing here reaches the internet. The authorization page itself is the
 * browser's: in the e2e a route answers it with a redirect carrying the code.
 */
export interface DevOAuth {
  /** The MCP server's address the tokens are for. */
  resource: string;
  issuer: string;
  /** Codes the authorization page "gave out": code -> what it was given for. */
  codes: Map<string, { challenge: string; redirect: string; clientId: string }>;
  clients: Map<string, { redirect: string[] }>;
  /** Access tokens handed out, valid until revoked. */
  tokens: Set<string>;
  refreshTokens: Set<string>;
  /** Every request the sign-in server got, for the tests. */
  seen: { url: string; method: string; authorization: string | null; body: string }[];
  /** Turns registration off: a service that doesn't accept new apps. */
  registration: boolean;
  /**
   * Local development: the authorization page is never served, so a code
   * "dev.<PKCE challenge>" stands for the owner's approval (the e2e answers the
   * page with it). The verifier, client and redirect are still checked.
   */
  devCodes: boolean;
  /** Simulates the owner approving on the authorization page: a code bound to the URL's PKCE challenge. */
  approve(authorizeUrl: string): { code: string; state: string };
  /** Handles a request meant for the MCP server's metadata or the sign-in server; null when it isn't one. */
  handle(request: Request): Promise<Response | null>;
  /** True when the request carries a live access token. */
  authorized(request: Request): boolean;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

async function s256(verifier: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

const random = () => toBase64Url(crypto.getRandomValues(new Uint8Array(16)));

export function devOAuth(resource: string, issuer: string): DevOAuth {
  const resourceUrl = new URL(resource);
  const issuerUrl = new URL(issuer);
  const prmPath = `/.well-known/oauth-protected-resource${resourceUrl.pathname === "/" ? "" : resourceUrl.pathname}`;
  const oauth: DevOAuth = {
    resource,
    issuer: issuerUrl.origin,
    codes: new Map(),
    clients: new Map(),
    tokens: new Set(),
    refreshTokens: new Set(),
    seen: [],
    registration: true,
    devCodes: false,
    approve(authorizeUrl) {
      const url = new URL(authorizeUrl);
      const clientId = url.searchParams.get("client_id") ?? "";
      const redirect = url.searchParams.get("redirect_uri") ?? "";
      const challenge = url.searchParams.get("code_challenge") ?? "";
      if (url.searchParams.get("code_challenge_method") !== "S256" || !challenge) throw new Error("PKCE S256 is required");
      if (!oauth.clients.get(clientId)?.redirect.includes(redirect)) throw new Error("unknown client or redirect");
      if (url.searchParams.get("resource") !== resource) throw new Error("wrong resource");
      const code = `code-${random()}`;
      oauth.codes.set(code, { challenge, redirect, clientId });
      return { code, state: url.searchParams.get("state") ?? "" };
    },
    authorized(request) {
      const header = request.headers.get("authorization") ?? "";
      return header.startsWith("Bearer ") && oauth.tokens.has(header.slice(7));
    },
    async handle(request) {
      const url = new URL(request.url);
      if (url.origin === resourceUrl.origin && url.pathname === prmPath && request.method === "GET") {
        return json({ resource, authorization_servers: [oauth.issuer], bearer_methods_supported: ["header"] });
      }
      if (url.origin !== oauth.issuer) return null;
      const body = request.method === "POST" ? await request.text() : "";
      oauth.seen.push({ url: request.url, method: request.method, authorization: request.headers.get("authorization"), body });
      if (url.pathname === "/.well-known/oauth-authorization-server" && request.method === "GET") {
        return json({
          issuer: oauth.issuer,
          authorization_endpoint: `${oauth.issuer}/authorize`,
          token_endpoint: `${oauth.issuer}/token`,
          ...(oauth.registration ? { registration_endpoint: `${oauth.issuer}/register` } : {}),
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/register" && request.method === "POST" && oauth.registration) {
        const meta = JSON.parse(body || "{}") as { redirect_uris?: string[] };
        const clientId = `client-${random()}`;
        oauth.clients.set(clientId, { redirect: meta.redirect_uris ?? [] });
        return json({ ...meta, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) }, 201);
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const form = new URLSearchParams(body);
        const issue = () => {
          const access = `tok-${random()}`;
          const refresh = `ref-${random()}`;
          oauth.tokens.add(access);
          oauth.refreshTokens.add(refresh);
          return json({ access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh });
        };
        if (form.get("grant_type") === "authorization_code") {
          const given = form.get("code") ?? "";
          const registered = oauth.clients.get(form.get("client_id") ?? "");
          const code =
            oauth.codes.get(given) ??
            (oauth.devCodes && given.startsWith("dev.") && registered?.redirect.includes(form.get("redirect_uri") ?? "")
              ? { challenge: given.slice(4), redirect: form.get("redirect_uri") ?? "", clientId: form.get("client_id") ?? "" }
              : undefined);
          oauth.codes.delete(given);
          if (!code) return json({ error: "invalid_grant" }, 400);
          if (code.clientId !== form.get("client_id") || code.redirect !== form.get("redirect_uri")) return json({ error: "invalid_grant" }, 400);
          if ((await s256(form.get("code_verifier") ?? "")) !== code.challenge) return json({ error: "invalid_grant" }, 400);
          if (form.get("resource") !== resource) return json({ error: "invalid_target" }, 400);
          return issue();
        }
        if (form.get("grant_type") === "refresh_token") {
          const token = form.get("refresh_token") ?? "";
          if (!oauth.refreshTokens.delete(token)) return json({ error: "invalid_grant" }, 400);
          return issue();
        }
        return json({ error: "unsupported_grant_type" }, 400);
      }
      return new Response(null, { status: 404 });
    },
  };
  return oauth;
}

/** The 401 an MCP server under OAuth answers, pointing to its metadata. */
export function signInRequired(resource: string): Response {
  const url = new URL(resource);
  const metadata = `${url.origin}/.well-known/oauth-protected-resource${url.pathname === "/" ? "" : url.pathname}`;
  return new Response(JSON.stringify({ error: "invalid_token" }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": `Bearer resource_metadata="${metadata}"` },
  });
}
