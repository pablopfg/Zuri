import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  hashRecoveryCode,
  matchTotp,
  newRecoveryCode,
  newTotpSecret,
  normalizeRecoveryCode,
  otpauthUri,
  RECOVERY_CODE_COUNT,
  totpCode,
  totpStep,
} from "../src/totp.ts";

// RFC 6238, appendix B: the SHA-1 seed is the ASCII "12345678901234567890".
const RFC_SECRET = base32Encode(new TextEncoder().encode("12345678901234567890"));
const RFC_VECTORS: [number, string][] = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
];

describe("TOTP (RFC 6238)", () => {
  it.each(RFC_VECTORS)("at %i s the code is %s", async (seconds, code) => {
    expect(await totpCode(RFC_SECRET, totpStep(seconds * 1000))).toBe(code);
  });

  it("base32 goes both ways and accepts spaces, dashes, padding and lower case", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    const text = base32Encode(bytes);
    expect(base32Decode(text)).toEqual(bytes);
    expect(base32Decode(`${text.toLowerCase().replace(/(.{4})/g, "$1 ")}===`)).toEqual(bytes);
    expect(base32Decode("ABC1")).toBeNull();
  });

  it("a new secret has 160 bits", () => {
    expect(base32Decode(newTotpSecret())).toHaveLength(20);
  });

  it("accepts the step before and after, not two away", async () => {
    const now = 1_800_000_000_000;
    const step = totpStep(now);
    for (const offset of [-1, 0, 1]) {
      expect(await matchTotp(RFC_SECRET, await totpCode(RFC_SECRET, step + offset), null, now)).toBe(step + offset);
    }
    for (const offset of [-2, 2]) {
      expect(await matchTotp(RFC_SECRET, await totpCode(RFC_SECRET, step + offset), null, now)).toBeNull();
    }
  });

  it("never accepts a step already used, nor an earlier one (code reuse)", async () => {
    const now = 1_800_000_000_000;
    const step = totpStep(now);
    const code = await totpCode(RFC_SECRET, step);
    expect(await matchTotp(RFC_SECRET, code, step, now)).toBeNull();
    expect(await matchTotp(RFC_SECRET, await totpCode(RFC_SECRET, step - 1), step - 1, now)).toBeNull();
    // A later step is still fine after an earlier one was used.
    expect(await matchTotp(RFC_SECRET, code, step - 1, now)).toBe(step);
  });

  it("refuses anything but six digits", async () => {
    const now = 1_800_000_000_000;
    const code = await totpCode(RFC_SECRET, totpStep(now));
    expect(await matchTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, null, now)).toBe(totpStep(now));
    for (const bad of ["", "12345", "1234567", "12345a", "١٢٣٤٥٦", `${code}0`]) {
      expect(await matchTotp(RFC_SECRET, bad, null, now)).toBeNull();
    }
  });

  it("the otpauth link names the agent, never an e-mail", () => {
    const uri = otpauthUri("JBSWY3DPEHPK3PXP", "Zuri");
    expect(uri).toBe("otpauth://totp/Zuri%3AZuri?secret=JBSWY3DPEHPK3PXP&issuer=Zuri&algorithm=SHA1&digits=6&period=30");
  });
});

describe("recovery codes", () => {
  it("are 16 base32 characters in groups of four, all different", () => {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
  });

  it("hash the same however typed, and refuse what isn't one", async () => {
    const code = newRecoveryCode();
    const hash = await hashRecoveryCode(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashRecoveryCode(code.toLowerCase().replace(/-/g, " "))).toBe(hash);
    expect(normalizeRecoveryCode("ABCD-EFGH-JKLM-NPQ")).toBeNull();
    expect(normalizeRecoveryCode("ABCD-EFGH-JKLM-NPQ1")).toBeNull();
    expect(await hashRecoveryCode("123456")).toBeNull();
  });
});
