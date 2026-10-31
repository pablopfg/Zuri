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

function components(labels: Labels): Components {
  return {
    // Links open apart, without the referrer or a handle back to this page.
    a: ({ href, children }) =>
      href && SAFE_LINK.test(href) ? (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow">
          {children}
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
export const Markdown = memo(function Markdown({ content }: { content: string }) {
  const { t } = useI18n();
  return (
    <div className="prose-zuri">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components({ image: (alt) => t("web.markdown.image", { alt }), done: t("web.markdown.done"), open: t("web.markdown.open") })} skipHtml>
        {content}
      </ReactMarkdown>
    </div>
  );
});
