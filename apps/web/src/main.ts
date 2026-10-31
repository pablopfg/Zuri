import { DEFAULT_LOCALE } from "@zuri/shared/i18n";
import { placeholderContent } from "./placeholder.ts";

const root = document.getElementById("app");
if (root) {
  const content = placeholderContent(DEFAULT_LOCALE);
  const heading = document.createElement("h1");
  heading.textContent = content.heading;
  root.append(heading);
  for (const line of content.lines) {
    const paragraph = document.createElement("p");
    paragraph.textContent = line;
    root.append(paragraph);
  }
}
