import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "../lib/i18n.tsx";

/** Only these schemes become links; anything else (javascript:, data:, vbscript:) stays plain text. */
const SAFE_LINK = /^(https?:|mailto:)/i;

interface Labels {
  image: (alt: string) => string;
  done: string;
  open: string;
}

/** Where a link really goes: the host of a web address, the address of a mailto. */
function destination(href: string): string {
  try {
    const url = new URL(href);
    return url.protocol === "mailto:" ? url.pathname : url.host;
  } catch {
    return href;
  }
}

function components(labels: Labels, showDestination: boolean): Components {
  return {
    // Links open apart, without the referrer or a handle back to this page.
    // In the assistant's answers the real destination shows beside the text: an
    // injected note could make "Abrir a nota" point anywhere (rule 2).
    a: ({ href, children }) =>
      href && SAFE_LINK.test(href) ? (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow">
          {children}
          {showDestination && <span className="ml-1 text-xs text-fg-muted">({destination(href)})</span>}
        </a>
      ) : (
        <span>{children}</span>
      ),
    // A note never loads an image from elsewhere (it would tell that server when the note was read).
    img: ({ alt }) => <span className="text-fg-muted">{labels.image(alt ?? "")}</span>,
    // A checkbox from "- [ ]" is a mark, not a control.
    input: ({ checked, type }) =>
      type === "checkbox" ? (
        <input type="checkbox" checked={Boolean(checked)} readOnly disabled aria-label={checked ? labels.done : labels.open} />
      ) : null,
  };
}

/**
 * The owner's Markdown, rendered safely: raw HTML is dropped (skipHtml), links
 * only for http(s) and mailto, no remote images. No dangerouslySetInnerHTML.
 */
export const Markdown = memo(function Markdown({ content, showDestination = false }: { content: string; showDestination?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="prose-zuri">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components({ image: (alt) => t("web.markdown.image", { alt }), done: t("web.markdown.done"), open: t("web.markdown.open") }, showDestination)} skipHtml>
        {content}
      </ReactMarkdown>
    </div>
  );
});
