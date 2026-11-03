import { fromBase64Url, MCP_LIMITS, toBase64Url } from "@zuri/shared";

const VERSION = "v1";
const encoder = new TextEncoder();

/**
 * The MCP servers' credentials at rest (step 18): AES-256-GCM under a key
 * derived (HKDF-SHA256) from the MCP_CREDENTIAL_KEY Worker secret, with the
 * server's id as associated data, so a ciphertext copied onto another server's
 * row does not open. Without the secret, servers that need a token can't be
 * added; servers without one still work. The Google Calendar (step 19) uses
 * the same secret with its own `info`.
 */
export class McpCredentials {
  #key: Promise<CryptoKey> | null = null;

  /** `info` keeps each use's key apart: the Google Calendar (step 19) derives its own from the same secret. */
  constructor(
    private readonly secret: string | undefined,
    private readonly info = "credentials-v1",
  ) {}

  get available(): boolean {
    return typeof this.secret === "string" && this.secret.trim().length >= MCP_LIMITS.credentialKeyMin;
  }

  private cryptoKey(): Promise<CryptoKey> {
    if (!this.available) return Promise.reject(new Error("MCP_CREDENTIAL_KEY is not set"));
    this.#key ??= crypto.subtle
      .importKey("raw", encoder.encode(this.secret?.trim()), "HKDF", false, ["deriveKey"])
      .then((base) =>
        crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: encoder.encode("zuri-mcp"), info: encoder.encode(this.info) },
          base,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      );
    return this.#key;
  }

  async encrypt(serverId: string, plaintext: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(serverId) }, await this.cryptoKey(), encoder.encode(plaintext));
    return `${VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(sealed))}`;
  }

  /** The plain credential, or null when it can't be opened (another key, another row, tampered). */
  async decrypt(serverId: string, stored: string): Promise<string | null> {
    const [version, iv, sealed, extra] = stored.split(".");
    if (version !== VERSION || !iv || !sealed || extra !== undefined || !this.available) return null;
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(iv), additionalData: encoder.encode(serverId) }, await this.cryptoKey(), fromBase64Url(sealed));
      return new TextDecoder().decode(plain);
    } catch {
      return null;
    }
  }
}
