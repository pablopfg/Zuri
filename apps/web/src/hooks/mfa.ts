import { useQuery } from "@tanstack/react-query";
import type { MfaStatus } from "@zuri/shared";
import { api } from "../lib/api.ts";

/**
 * The two-step status, shared by the home page, the reminder and the security
 * cards. It lives apart from those cards so that pages outside settings don't
 * pull the QR code and passkey code into the first bundle.
 */
export const MFA_KEY = ["mfa"] as const;

export function useMfaStatus() {
  return useQuery({ queryKey: MFA_KEY, queryFn: () => api<MfaStatus>("/auth/mfa") });
}
