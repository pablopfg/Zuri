import { APP_VERSION, type DiagnosticEntry, type DiagnosticSource } from "@zuri/shared";

/**
 * "Relatar no GitHub" in Settings > Diagnóstico (docs/agente/issues.md, the
 * owner's choice of 02/11/2026): a link that opens the repository's "Erro"
 * issue form already filled in, in a new tab. Nothing leaves without the owner
 * reading it and pressing Submit on GitHub; no token, no request from the server.
 *
 * Only what the diagnostics record already keeps goes in the link, and less
 * of it: source, code, error name, route with ids swapped, counts, dates to
 * the minute in UTC, the cf-ray without its data center, the record's id and
 * the version of the system (the newest section of CHANGELOG.md: the build of
 * a tag's own commit still shows the previous one, see docs/agente/versionamento.md).
 * Never anything the owner wrote, and not the deployment's version id (an id
 * of the owner's account that matches no commit). GitHub fills only text
 * fields from the link, so "Onde aconteceu" is left for the owner. The text is
 * in pt-BR whatever the interface language: it goes to the repository's
 * tracker, which is in pt-BR (AGENTS.md).
 */
export const ISSUE_REPOSITORY = "pablopfg/Zuri";
export const ISSUE_TEMPLATE = "erro.yml";

const SOURCE_NAME: Record<DiagnosticSource, string> = {
  api: "servidor",
  ai: "IA",
  automation: "automações",
  chat: "conversa",
  interface: "tela",
};

/** 2026-11-02T08:00:12.345Z → 2026-11-02 08:00 UTC. */
const minute = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** The cf-ray's request id, without the "-GRU" data center that hints where the owner was. */
const rayId = (ref: string) => ref.replace(/-[A-Z]{3}$/, "");

/** The issue form link for one recorded failure. */
export function issueReportUrl(entry: DiagnosticEntry): string {
  const where = SOURCE_NAME[entry.source];
  const name = entry.errorName !== "Error" ? ` ${entry.errorName}` : "";
  const params = new URLSearchParams({
    template: ISSUE_TEMPLATE,
    title: `[erro] ${entry.code}${name} (${where})`,
    contexto: [
      `Falha registrada no Diagnóstico (origem: ${where}).`,
      entry.route ? `Rota: ${entry.route}` : null,
      `Primeira vez: ${minute(entry.firstAt)}`,
      `Última vez: ${minute(entry.lastAt)}`,
      `Versão da Zuri: ${APP_VERSION}`,
    ]
      .filter(Boolean)
      .join("\n"),
    obtido: `${entry.code}${name}: ${entry.countToday} hoje, ${entry.countTotal} nos últimos 30 dias.`,
    codigo: [entry.code, entry.errorName !== "Error" ? entry.errorName : null, entry.lastRef ? `cf-ray ${rayId(entry.lastRef)}` : null, `id ${entry.id}`]
      .filter(Boolean)
      .join(" · "),
  });
  return `https://github.com/${ISSUE_REPOSITORY}/issues/new?${params.toString()}`;
}
