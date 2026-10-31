import { type Locale, t } from "@zuri/shared/i18n";

// The real interface arrives in step 5; until then the page only says so.
export const INTERFACE_STAGE = 5;

export function placeholderContent(locale: Locale) {
  return {
    heading: t(locale, "app.name"),
    lines: [t(locale, "app.tagline"), t(locale, "app.underConstruction", { stage: INTERFACE_STAGE })],
  };
}
