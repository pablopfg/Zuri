import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { APP_VERSION, toBase64Url } from "@zuri/shared";
import { McpConnectionError } from "./guarded-fetch.ts";

/**
 * What Zuri keeps of one server's OAuth sign-in (step 18b): the registration,
 * the tokens, the discovery and, while a sign-in waits, its PKCE verifier and
 * state. Stored only as AES-256-GCM ciphertext in the server's `credential`,
 * like a static token; never returned, logged, exported or shown to the model.
 */
export interface OAuthRecord {
  /** The callback the registration was made for: another one (the app moved) needs a new registration. */
  redirect_url?: string | undefined;
  client?: StoredOAuthClientInformation | undefined;
  tokens?: StoredOAuthTokens | undefined;
  discovery?: OAuthDiscoveryState | undefined;
  verifier?: string | undefined;
  /** The waiting sign-in: single use, good until state_expires. */
  state?: string | undefined;
  state_expires?: string | undefined;
  /**
   * The app session that started the waiting sign-in (a SHA-256 of its id):
   * only that session can finish it, so a sign-in someone else started (with
   * their own account at the service) can't be finished in the owner's browser.
   */
  state_session?: string | undefined;
  /** The address and the way of signing in the record was made for: another one discards it. */
  bound_to?: string | undefined;
}

/** What a record is bound to: the server's address and its way of signing in. */
export const oauthBinding = (url: string, authType: string): string => `${authType} ${url}`;

export interface OAuthStore {
  load(): Promise<OAuthRecord>;
  save(patch: Partial<OAuthRecord>): Promise<void>;
  /** The sign-in page the owner opens, recorded on the server's row (null clears it). */
  pending(url: string | null, expires: string | null): void;
}

/** `<server id>.<secret>`: the id finds the server on the callback, the secret (32 random bytes) proves it. */
export const stateServerId = (state: string): string => state.split(".")[0] ?? "";

/** Compares two secrets without stopping at the first different character. */
export function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The MCP SDK's OAuth hooks for one server, over the encrypted record. Zuri
 * registers as a public client (dynamic registration, PKCE, no secret).
 *
 * `interactive` is true only for what the owner started in Settings
 * (connecting, signing in): then a sign-in the service asks for is recorded
 * for the owner to open. In a chat turn, a refresh still works, but a sign-in
 * is never started: the call fails with "signin" and nothing waiting is
 * overwritten (the state is asked before the verifier is saved).
 */
export class ZuriOAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly serverId: string,
    readonly redirectUrl: string,
    private readonly store: OAuthStore,
    private readonly opts: {
      interactive: boolean;
      /** The hashed session that started an interactive sign-in. */
      session?: string | undefined;
      /** Refuses a sign-in page that isn't a public https address. */
      checkAuthorizeUrl: (url: URL) => void;
      stateMs: number;
      clock: () => number;
    },
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Zuri",
      software_id: "zuri",
      software_version: APP_VERSION,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  async state(): Promise<string> {
    if (!this.opts.interactive) throw new McpConnectionError("signin");
    const state = `${this.serverId}.${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
    await this.store.save({ state, state_expires: new Date(this.opts.clock() + this.opts.stateMs).toISOString(), state_session: this.opts.session });
    return state;
  }

  async clientInformation(): Promise<StoredOAuthClientInformation | undefined> {
    const { client, redirect_url } = await this.store.load();
    if (redirect_url === this.redirectUrl && client) return client;
    // No registration for this callback: making one is the start of a sign-in, never a turn's.
    if (!this.opts.interactive) throw new McpConnectionError("signin");
    return undefined;
  }

  async saveClientInformation(client: StoredOAuthClientInformation): Promise<void> {
    await this.store.save({ client, redirect_url: this.redirectUrl });
  }

  async tokens(): Promise<StoredOAuthTokens | undefined> {
    return (await this.store.load()).tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    await this.store.save({ tokens });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.opts.interactive) throw new McpConnectionError("signin");
    this.opts.checkAuthorizeUrl(url);
    const { state_expires } = await this.store.load();
    this.store.pending(url.href, state_expires ?? null);
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    if (!this.opts.interactive) throw new McpConnectionError("signin");
    await this.store.save({ verifier });
  }

  async codeVerifier(): Promise<string> {
    const { verifier } = await this.store.load();
    if (!verifier) throw new McpConnectionError("oauth");
    return verifier;
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
    await this.store.save({ discovery });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.store.load()).discovery;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    const clear: Partial<OAuthRecord> = {};
    if (scope === "all" || scope === "client") clear.client = undefined;
    if (scope === "all" || scope === "tokens") clear.tokens = undefined;
    if (scope === "all" || scope === "verifier") clear.verifier = undefined;
    if (scope === "all" || scope === "discovery") clear.discovery = undefined;
    await this.store.save(clear);
  }
}
