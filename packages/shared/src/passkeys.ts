// Before any schema here: the package is marked side-effect free, so index.ts alone can't order it.
import "./zod-config.ts";

import { z } from "zod";

/**
 * Passkeys (WebAuthn) as a second sign-in step, next to the authenticator app,
 * and later (step 16) as the confirmation of an approval from the bot. They need
 * two-step sign-in on, so the recovery codes stay the way back in when every
 * passkey is lost.
 */
export const MAX_PASSKEYS = 10;
export const PASSKEY_NAME_MAX = 60;
/** How long the browser has to create or use a passkey once asked. */
export const PASSKEY_TIMEOUT_MS = 2 * 60_000;

const b64url = (max: number) => z.string().max(max).regex(/^[A-Za-z0-9_-]*$/);

const credentialBase = {
  id: /* @__PURE__ */ b64url(1400).min(1),
  rawId: /* @__PURE__ */ b64url(1400).min(1),
  type: /* @__PURE__ */ z.literal("public-key"),
  clientExtensionResults: /* @__PURE__ */ z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: /* @__PURE__ */ z.enum(["platform", "cross-platform"]).optional(),
};

const name = /* @__PURE__ */ z.string().trim().min(1).max(PASSKEY_NAME_MAX);

/** What navigator.credentials.create returns, as JSON. The server checks every field again. */
export const passkeyRegistrationSchema = /* @__PURE__ */ z
  .object({
    name,
    response: z.object({
      ...credentialBase,
      response: z.object({
        clientDataJSON: b64url(4096).min(1),
        attestationObject: b64url(16_384).min(1),
        transports: z.array(z.string().max(32)).max(10).optional(),
        publicKeyAlgorithm: z.number().int().optional(),
        publicKey: b64url(4096).optional(),
        authenticatorData: b64url(16_384).optional(),
      }),
    }),
  })
  .strict();

/** What navigator.credentials.get returns, as JSON. */
export const passkeyAssertionSchema = /* @__PURE__ */ z
  .object({
    response: z.object({
      ...credentialBase,
      response: z.object({
        clientDataJSON: b64url(4096).min(1),
        authenticatorData: b64url(4096).min(1),
        signature: b64url(2048).min(1),
        userHandle: b64url(256).optional(),
      }),
    }),
  })
  .strict();

export const passkeyRenameSchema = /* @__PURE__ */ z.object({ name }).strict();

/** A passkey as the owner's list shows it. Never the public key or the counter. */
export const passkeyInfoSchema = /* @__PURE__ */ z
  .object({
    id: z.string(),
    name: z.string(),
    createdAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().nullable(),
    /** Synced by its provider (iCloud Keychain, Google Password Manager, a password manager). */
    synced: z.boolean(),
    /**
     * Made for this address. A passkey belongs to the host it was made on: one
     * made on the workers.dev address doesn't work on the owner's own domain.
     */
    usableHere: z.boolean(),
  })
  .strict();

export type PasskeyRegistration = z.infer<typeof passkeyRegistrationSchema>;
export type PasskeyAssertion = z.infer<typeof passkeyAssertionSchema>;
export type PasskeyInfo = z.infer<typeof passkeyInfoSchema>;
