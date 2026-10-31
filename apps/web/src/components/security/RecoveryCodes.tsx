import { Copy } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../lib/i18n.tsx";
import { Button, Notice } from "../ui.tsx";

/** The recovery codes, shown once. Copying needs the owner's click; nothing is stored in the browser. */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-4">
      <Notice tone="warning">{t("web.mfa.codesWarning")}</Notice>
      <ol className="grid grid-cols-1 gap-2 rounded-xl border border-border bg-raised p-4 font-mono text-sm sm:grid-cols-2" aria-label={t("web.mfa.codesTitle")}>
        {codes.map((code) => (
          <li key={code} translate="no">
            {code}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(codes.join("\n")).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          <Copy className="h-4 w-4" aria-hidden />
          {copied ? t("web.copied") : t("web.mfa.copyCodes")}
        </Button>
        <Button onClick={onDone}>{t("web.mfa.codesSaved")}</Button>
      </div>
    </div>
  );
}
