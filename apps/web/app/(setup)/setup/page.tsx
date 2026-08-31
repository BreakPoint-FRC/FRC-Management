"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import {
  isSetupStageReached,
  TEAM_SETUP_STAGE_LABELS,
  type TeamSetupStage,
} from "@breakpoint/types";

import { useAuth } from "@/components/auth/auth-provider";
import { AccountsStep } from "@/components/setup/accounts-step";
import { GroupsStep } from "@/components/setup/groups-step";
import { NamingStep } from "@/components/setup/naming-step";
import { PermissionsStep } from "@/components/setup/permissions-step";
import { RolesStep } from "@/components/setup/roles-step";
import { StepShell } from "@/components/setup/step-shell";
import { ToolsStep } from "@/components/setup/tools-step";
import { AsyncSection, Loading, PageHeader } from "@/components/ui";
import { useApi } from "@/hooks/use-api";
import type { SetupStateRow } from "@/lib/api-types";

/**
 * The first-run flow a team admin lands in.
 *
 * The order is a dependency order, not a preference: a role cannot be scoped to
 * a group that does not exist, a tool cannot be assigned to one either, and a
 * permission cannot be granted on a tool no group uses. The server enforces it
 * -- `advance` refuses to leave a step whose prerequisites are unmet -- and this
 * screen only draws where the team has got to.
 *
 * Every step is done here. The dashboard is unreachable until setup finishes --
 * it has no season to hang anything off until the NAMING step -- so a step that
 * sent people to another screen would be sending them somewhere they cannot go.
 *
 * The editors are the same components the dashboard screens use, imported
 * rather than copied: a second copy of the permission matrix or the module grid
 * would drift from the first the next time the model changed.
 *
 * Each step writes through the ordinary endpoints, the same ones the dashboard
 * pages use. A second write path would have to re-implement the invariants in
 * docs/authorization.md, and would eventually get one of them wrong.
 *
 * Deliberately outside the (dashboard) route group: that layout redirects here
 * until the wizard is finished, and a page inside it would redirect to itself.
 */
export default function SetupPage() {
  const { status, account, team, refresh } = useAuth();
  const router = useRouter();
  const state = useApi<SetupStateRow>("/setup");

  useEffect(() => {
    if (status === "anonymous") {
      router.replace("/login");
      return;
    }
    if (status !== "authenticated") return;
    // The password screen comes first: an account on a temporary one is refused
    // by every endpoint this wizard would call.
    if (account?.mustChangePassword) {
      router.replace("/change-password");
      return;
    }
    // A platform system admin has no team and no wizard; a team that has
    // finished has nothing left to do here.
    if (!team || team.setupStage === "DONE") router.replace("/");
  }, [status, account?.mustChangePassword, team, router]);

  if (status !== "authenticated" || !team || team.setupStage === "DONE") return <Loading />;

  return (
    <main className="content" style={{ maxWidth: 1100, margin: "0 auto" }}>
      <PageHeader title="Takim kurulumu" />

      <AsyncSection state={state}>
        {(setup) => (
          <div className="stack">
            <StageRail current={setup.stage} stages={setup.stages} />

            <StepShell
              setup={setup}
              onChanged={async () => {
                await state.reload();
                await refresh();
              }}
            >
              {setup.stage === "GROUPS" ? <GroupsStep /> : null}
              {setup.stage === "ROLES" ? <RolesStep /> : null}
              {setup.stage === "TOOLS" ? <ToolsStep /> : null}
              {setup.stage === "PERMISSIONS" ? <PermissionsStep /> : null}
              {setup.stage === "NAMING" ? <NamingStep team={setup.team} /> : null}
              {setup.stage === "ACCOUNTS" ? <AccountsStep /> : null}
            </StepShell>
          </div>
        )}
      </AsyncSection>
    </main>
  );
}

/** Where the team is, and what is behind and ahead of it. */
function StageRail({
  current,
  stages,
}: {
  current: TeamSetupStage;
  stages: TeamSetupStage[];
}) {
  return (
    <ol className="row" style={{ flexWrap: "wrap", gap: 8, listStyle: "none", padding: 0 }}>
      {stages
        .filter((stage) => stage !== "DONE")
        .map((stage) => {
          const done = isSetupStageReached(current, stage) && stage !== current;
          return (
            <li
              key={stage}
              className={`badge ${stage === current ? "badge-ok" : ""}`}
              style={{ opacity: done || stage === current ? 1 : 0.5 }}
            >
              {done ? "✓ " : ""}
              {TEAM_SETUP_STAGE_LABELS[stage]}
            </li>
          );
        })}
    </ol>
  );
}
