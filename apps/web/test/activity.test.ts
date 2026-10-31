import { AUTH_EVENT_KINDS, type AuthActivityEvent } from "@zuri/shared";
import { describe, expect, it } from "vitest";
import { deviceText, groupOf, isWarning, KIND_LABEL, placeText, reasonLabels } from "../src/components/security/activity.ts";

const event = (over: Partial<AuthActivityEvent> = {}): AuthActivityEvent => ({
  id: 1,
  at: "2026-10-31T12:00:00.000Z",
  lastAt: "2026-10-31T12:00:00.000Z",
  kind: "login_success",
  reason: "",
  ip: "192.0.2.10",
  country: "BR",
  region: "São Paulo",
  city: "Campinas",
  asn: 64500,
  userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36",
  knownDevice: true,
  count: 1,
  ...over,
});

describe("the access log's helpers", () => {
  it("has a label for every kind", () => {
    for (const kind of AUTH_EVENT_KINDS) expect(KIND_LABEL[kind]).toMatch(/^web\.activity\.kind\./);
  });

  it("reads the known reasons in order and drops unknown or empty parts", () => {
    expect(reasonLabels("")).toEqual([]);
    expect(reasonLabels("totp,new_device")).toEqual(["web.accessLog.reason.totp", "web.accessLog.reason.new_device"]);
    expect(reasonLabels(" missing ,credentials,,x")).toEqual(["web.accessLog.reason.missing"]);
    expect(reasonLabels("__proto__,constructor")).toEqual([]);
  });

  it("groups and flags kinds the way the badges show them", () => {
    expect(groupOf("login_success")).toBe("success");
    expect(groupOf("mfa_failure")).toBe("failure");
    expect(groupOf("login_attack")).toBe("blocked");
    expect(groupOf("login_turnstile")).toBe("robot");
    expect(groupOf("logout")).toBe("account");
    expect(isWarning("login_turnstile")).toBe(true);
    expect(isWarning("credentials_reset")).toBe(true);
    expect(isWarning("logout")).toBe(false);
  });

  it("names the country in the owner's language, and keeps what isn't a country code", () => {
    expect(placeText(event(), "pt-BR")).toBe("Campinas, São Paulo, Brasil");
    expect(placeText(event(), "en")).toBe("Campinas, São Paulo, Brazil");
    expect(placeText(event({ city: "", region: "", country: "T1" }), "pt-BR")).toBe("T1");
    expect(placeText(event({ city: "", region: "", country: "" }), "pt-BR")).toBe("");
  });

  it("describes the browser, or only the half it knows, or nothing", () => {
    const format = (browser: string, system: string) => `${browser} no ${system}`;
    expect(deviceText(event(), format)).toBe("Chrome no Android");
    expect(deviceText(event({ userAgent: "" }), format)).toBe("");
    expect(deviceText(event({ userAgent: "curl/8.0" }), format)).toBe("");
  });
});
