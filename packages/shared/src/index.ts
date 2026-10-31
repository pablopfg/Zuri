// First: settles Zod's configuration before any schema below is built.
import "./zod-config.ts";

export {
  createTranslator,
  DEFAULT_LOCALE,
  isLocale,
  LOCALES,
  type Locale,
  loadCatalog,
  type MessageKey,
  type Messages,
  type PluralBase,
  plural,
  ptBR,
  ptBRAi,
  ptBRCore,
  ptBRMemory,
  ptBRProductivity,
  ptBRSecurity,
  ptBRGreeting,
  ptBRPalette,
  ptBRServer,
  ptBRSettings,
  t,
} from "../i18n/index.ts";
export { AGENT_INSTANCE_NAME } from "./constants.ts";
export {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  type ApiError,
  type ApiErrorCode,
  apiErrorSchema,
  DEFAULT_ERROR_MESSAGE,
  healthSchema,
} from "./errors.ts";
export { formatDateTime, formatDateTimeParts, formatUsd } from "./format.ts";
export {
  DEFAULT_SETTINGS,
  DEFAULT_TIME_ZONE,
  isOwnerName,
  isTimeZone,
  normalizeOwnerName,
  OWNER_NAME_MAX,
  SESSION_TIMEOUT_RANGES,
  type Settings,
  type SettingsUpdate,
  settingsSchema,
  settingsUpdateSchema,
} from "./settings.ts";
export * from "./auth.ts";
export {
  fromBase64Url,
  hashPassword,
  hmacSha256Hex,
  isPasswordHash,
  PBKDF2_ITERATIONS,
  randomToken,
  sha256Hex,
  timingSafeEqual,
  timingSafeEqualText,
  toBase64Url,
  verifyPassword,
} from "./crypto.ts";
export {
  BREACH_API,
  isBreachedPassword,
  MIN_BREACH_LINES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_PROBLEM_MESSAGE,
  type PasswordProblem,
  passwordProblem,
  unpredictableLength,
} from "./password.ts";
export * from "./passkeys.ts";
export {
  base32Decode,
  base32Encode,
  hashRecoveryCode,
  matchTotp,
  newRecoveryCode,
  newTotpSecret,
  normalizeRecoveryCode,
  normalizeTotp,
  otpauthUri,
  RECOVERY_CODE_COUNT,
  TOTP_DIGITS,
  TOTP_DRIFT_STEPS,
  TOTP_PERIOD_S,
  totpCode,
  totpStep,
} from "./totp.ts";
export {
  instantSchema,
  isLeapYear,
  isValidCalendarDate,
  localDayBounds,
  MAX_DATE_YEAR,
  MIN_DATE_YEAR,
  parseInstant,
  type ZonedParts,
  zonedParts,
  zonedTimeToUtc,
} from "./dates.ts";
export * from "./productivity.ts";
export * from "./memory.ts";
export * from "./ai.ts";
