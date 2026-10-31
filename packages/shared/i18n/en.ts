import type { Messages } from "./index.ts";

export const en: Messages = {
  "app.name": "Zuri",
  "app.tagline": "Your personal AI assistant, in your own Cloudflare account.",
  "app.underConstruction": "Under construction: the interface arrives in step {stage}.",
  "error.unauthorized": "Sign in to continue.",
  "error.forbidden": "You are not allowed to do this.",
  "error.httpsRequired": "Use a secure connection (HTTPS).",
  "error.websocketNotSupported": "This address does not accept WebSocket.",
  "error.accessRequired": "Sign in through Cloudflare Access to continue.",
  "error.hostNotAllowed": "This address does not serve Zuri.",
  "error.notFound": "Not found.",
  "error.notConfigured": "Zuri is not fully set up yet.",
  "error.internal": "Something went wrong. Your data is safe; please try again.",
  "error.validationFailed": "Check the data you sent.",
  "format.dateTime": "{date} at {time}",
};
