"use client";

import {
  TEAM_SETUP_STAGE_DESCRIPTIONS,
  TEAM_SETUP_STAGE_LABELS,
  TEAM_SETUP_STAGES,
  type TeamSetupStage,
} from "@breakpoint/types";
import type { ReactNode } from "react";

import { ErrorBox } from "@/components/ui";
import { useMutation } from "@/hooks/use-mutation";
import { apiClient } from "@/lib/api-client";
import type { SetupStateRow } from "@/lib/api-types";

/**
 * The frame around every wizard step: the heading, the error, and the two
 * buttons that move between them.
 *
 * Forward is `/setup/advance` with no destination -- the server decides what
 * next means and refuses when the current step is unfinished, so the button
 * cannot skip a prerequisite even if this component got the order wrong.
 * Backward names a step, and only a finished one is accepted.
 */
export function StepShell({
  setup,
  onChanged,
  children,
}: {
  setup: SetupStateRow;
  onChanged: () => Promise<void>;
  children: ReactNode;
}) {
  const mutation = useMutation();
  const index = TEAM_SETUP_STAGES.indexOf(setup.stage);
  const previous = index > 0 ? (TEAM_SETUP_STAGES[index - 1] as TeamSetupStage) : null;
  const isLast = setup.stage === "ACCOUNTS";

  async function advance() {
    if (await mutation.run(() => apiClient.post("/setup/advance"))) await onChanged();
  }

  async function goBack() {
    if (!previous) return;
    if (await mutation.run(() => apiClient.post("/setup/back", { stage: previous }))) {
      await onChanged();
    }
  }

  return (
    <section className="card stack">
      <div>
        <h2 style={{ marginBottom: 4 }}>{TEAM_SETUP_STAGE_LABELS[setup.stage]}</h2>
        <p className="muted small" style={{ margin: 0 }}>
          {TEAM_SETUP_STAGE_DESCRIPTIONS[setup.stage]}
        </p>
      </div>

      {mutation.error ? <ErrorBox error={mutation.error} /> : null}

      {children}

      {/* What the server would refuse, said before the button is pressed. The
          button is still enabled: the server is the authority, and a disabled
          control with no explanation is worse than a refused one with. */}
      {setup.blocker ? <p className="small muted">Devam etmek icin: {setup.blocker}</p> : null}

      <div className="row">
        {previous ? (
          <button
            className="btn btn-sm"
            type="button"
            disabled={mutation.saving}
            onClick={() => void goBack()}
          >
            ← {TEAM_SETUP_STAGE_LABELS[previous]}
          </button>
        ) : null}
        <button
          className="btn btn-primary btn-sm"
          type="button"
          disabled={mutation.saving}
          onClick={() => void advance()}
        >
          {isLast ? "Kurulumu tamamla" : "Devam et →"}
        </button>
      </div>
    </section>
  );
}
