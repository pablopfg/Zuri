import type { ReactNode } from "react";
import { EmptyState } from "../../components/ui.tsx";

/** A tab whose settings arrive in a later step: its empty state says which. */
export function LaterTab({ title, body, icon }: { title: string; body: string; icon: ReactNode }) {
  return (
    <EmptyState icon={icon} title={title}>
      <p>{body}</p>
    </EmptyState>
  );
}
