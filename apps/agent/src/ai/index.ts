import type { ChatModel, Locale } from "@zuri/shared";
import { AppError } from "../http/errors.ts";
import { MockAIProvider } from "./mock.ts";
import type { AIProvider } from "./provider.ts";
import { WorkersAIProvider } from "./workers-ai.ts";

export type { AiLimits } from "./usage.ts";
export { MeteredAI } from "./metered.ts";
export { UsageMeter } from "./usage.ts";

/**
 * The provider of this deploy. Local development (a loopback http PUBLIC_URL)
 * always gets the mock, so `npm run dev` and the e2e tests never spend Neurons.
 * Anywhere else it is Workers AI; without the AI binding the AI is not configured.
 */
export function chooseProvider(options: {
  development: boolean;
  binding: Ai | undefined;
  model: ChatModel;
  locale: () => Locale;
}): AIProvider {
  if (options.development) return new MockAIProvider(options.locale);
  if (!options.binding) throw new AppError("NOT_CONFIGURED");
  return new WorkersAIProvider(options.binding, options.model);
}
