import type { MemoryCategory, MemoryFilter, MemoryOrigin, MemoryReviewReason, MemoryStatus, MemoryTopic, MessageKey } from "@zuri/shared";

/** Catalog keys for the memory codes the server sends: the interface words them in the owner's language. */

export const CATEGORY_LABEL: Record<MemoryCategory, MessageKey> = {
  preference: "web.memory.category.preference",
  fact: "web.memory.category.fact",
  goal: "web.memory.category.goal",
  project: "web.memory.category.project",
  habit: "web.memory.category.habit",
  person: "web.memory.category.person",
  other: "web.memory.category.other",
};

export const STATUS_LABEL: Record<MemoryStatus, MessageKey> = {
  active: "web.memory.status.active",
  uncertain: "web.memory.status.uncertain",
  historical: "web.memory.status.historical",
};

export const FILTER_LABEL: Record<Exclude<MemoryFilter, "current">, MessageKey> = {
  all: "web.memory.filter.all",
  active: "web.memory.filter.active",
  uncertain: "web.memory.filter.uncertain",
  historical: "web.memory.filter.historical",
};

export const ORIGIN_LABEL: Record<MemoryOrigin, MessageKey> = {
  app: "web.memory.origin.app",
  telegram: "web.memory.origin.telegram",
  import: "web.memory.origin.import",
};

export const REASON_LABEL: Record<MemoryReviewReason, MessageKey> = {
  explicit_change: "web.memory.reason.explicitChange",
  topic_change: "web.memory.reason.topicChange",
  refines: "web.memory.reason.refines",
  same_topic: "web.memory.reason.sameTopic",
};

export const TOPIC_LABEL: Record<MemoryTopic, MessageKey> = {
  residence: "web.memory.topic.residence",
  vehicle: "web.memory.topic.vehicle",
  job: "web.memory.topic.job",
  diet: "web.memory.topic.diet",
  relationship: "web.memory.topic.relationship",
};
