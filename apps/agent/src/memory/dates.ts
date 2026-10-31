import { isValidCalendarDate } from "@zuri/shared";
import { fold } from "./text.ts";

const MONTHS_PT = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const MONTHS_EN = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const LEAD = "(?:desde|a partir de|em|no dia|since|from|as of|starting|on|in)";
const YEAR = "((?:19|20)\\d{2})";
const pad = (n: number) => String(n).padStart(2, "0");

const ISO = new RegExp(`(?<![\\p{L}\\p{N}])${LEAD}\\s+${YEAR}-(\\d{2})-(\\d{2})(?![\\p{N}])`, "u");
const BR_DATE = new RegExp(`(?<![\\p{L}\\p{N}])${LEAD}\\s+(\\d{1,2})/(\\d{1,2})/${YEAR}(?![\\p{N}])`, "u");
const MONTH = new RegExp(`(?<![\\p{L}\\p{N}])${LEAD}\\s+(${[...MONTHS_PT, ...MONTHS_EN].join("|")})(?:\\s+de)?\\s+${YEAR}(?![\\p{N}])`, "u");
const ONLY_YEAR = new RegExp(`(?<![\\p{L}\\p{N}])${LEAD}\\s+${YEAR}(?![\\p{L}\\p{N}/-])`, "u");

/**
 * A start date only when the text states one ("desde 2024", "em março de 2025",
 * "a partir de 01/02/2026", "since 2024-06-01"). Never guessed, never the save
 * time. "2024", "2025-03" or "2026-02-01"; an impossible day gives nothing.
 */
export function extractStatedDate(text: string): string | null {
  const folded = fold(text);
  const iso = folded.match(ISO);
  if (iso) return validDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const br = folded.match(BR_DATE);
  if (br) return validDay(Number(br[3]), Number(br[2]), Number(br[1]));
  const month = folded.match(MONTH);
  if (month) {
    const name = month[1] ?? "";
    const index = MONTHS_PT.includes(name) ? MONTHS_PT.indexOf(name) : MONTHS_EN.indexOf(name);
    return `${month[2]}-${pad(index + 1)}`;
  }
  const year = folded.match(ONLY_YEAR);
  return year?.[1] ?? null;
}

function validDay(year: number, month: number, day: number): string | null {
  return isValidCalendarDate(year, month, day) ? `${year}-${pad(month)}-${pad(day)}` : null;
}
