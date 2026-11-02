import { type ChatModel, type FallbackModel, isChatModel, type Locale } from "@zuri/shared";
import { AppError } from "../http/errors.ts";
import { type CircuitBreaker, ProviderChain } from "./chain.ts";
import { MockAIProvider } from "./mock.ts";
import type { AIProvider } from "./provider.ts";
import { WorkersAIProvider } from "./workers-ai.ts";

export { CircuitBreaker, ProviderChain } from "./chain.ts";

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

/**
 * The chosen model and the fallback the owner picked (Settings > AI), as one
 * chain with the object's breaker. In local development both are the mock: the
 * chosen one fails a message that starts with `fail `, so the switch can be
 * seen and tested without a real model.
 */
export function chooseChain(options: {
  development: boolean;
  binding: Ai | undefined;
  model: ChatModel;
  fallback: FallbackModel;
  locale: () => Locale;
  breaker: CircuitBreaker;
}): ProviderChain {
  const wanted = isChatModel(options.fallback) && options.fallback !== options.model ? options.fallback : null;
  if (options.development) {
    const primary = new MockAIProvider(options.locale, { failOnRequest: true });
    return new ProviderChain(primary, wanted ? new MockAIProvider(options.locale, { model: "mock-fallback" }) : null, options.breaker);
  }
  const primary = chooseProvider(options);
  return new ProviderChain(primary, wanted && options.binding ? new WorkersAIProvider(options.binding, wanted) : null, options.breaker);
}
