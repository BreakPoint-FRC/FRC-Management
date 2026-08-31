"use client";

import { useState } from "react";
import { TEAM_SETUP_STAGE_LABELS, type Paginated } from "@breakpoint/types";

import { useAuth } from "@/components/auth/auth-provider";
import {
  AsyncSection,
  Badge,
  ConfirmButton,
  ErrorBox,
  PageHeader,
  RowActions,
} from "@/components/ui";
import { FormPanel, TextField } from "@/components/ui/form";
import { useApi } from "@/hooks/use-api";
import { useMutation } from "@/hooks/use-mutation";
import { apiClient } from "@/lib/api-client";
import type { TeamRow } from "@/lib/api-types";
import { issueFor } from "@/lib/issues";
import { can } from "@/lib/permissions";

interface CreatedAdmin {
  admin: { id: string; email: string; fullName: string };
  temporaryPassword: string;
}

type Panel = { kind: "closed" } | { kind: "team" } | { kind: "admin"; team: TeamRow };

/**
 * The platform screen: opening teams and the administrators who run them.
 *
 * Gated on TEAMS, which only the platform SYSTEM_ADMIN role holds -- the
 * TEAM_ADMIN permission matrix is every tool except this one. There is no
 * isSystemAdmin flag anywhere and no branch on one; "who may open a team" is a
 * row in RolePermission like every other question of authority.
 *
 * The name typed here is a draft. The team admin is asked for the real one at
 * the NAMING step of their setup wizard, because the groups they create in step
 * one already need a team to hang from.
 */
export default function TeamsPage() {
  const { permissions } = useAuth();
  const teams = useApi<Paginated<TeamRow>>("/teams?pageSize=100&includeInactive=true");
  const mutation = useMutation();

  const [panel, setPanel] = useState<Panel>({ kind: "closed" });
  const [draft, setDraft] = useState({ name: "", adminFullName: "", adminEmail: "" });
  const [admin, setAdmin] = useState({ fullName: "", email: "" });
  // Held only until the next action. The server does not store it and cannot
  // send it again, so this is the one moment it exists anywhere.
  const [created, setCreated] = useState<CreatedAdmin | null>(null);

  const mayCreate = can(permissions, "TEAMS", "create");
  const mayDelete = can(permissions, "TEAMS", "delete");

  function close() {
    setPanel({ kind: "closed" });
    mutation.reset();
  }

  function open(next: Panel) {
    setCreated(null);
    setPanel(next);
    mutation.reset();
  }

  async function submitTeam() {
    const result = await mutation.runFor<CreatedAdmin>(() => apiClient.post("/teams", draft));
    if (!result) return;

    setDraft({ name: "", adminFullName: "", adminEmail: "" });
    close();
    setCreated(result);
    teams.reload();
  }

  async function submitAdmin() {
    if (panel.kind !== "admin") return;

    const result = await mutation.runFor<CreatedAdmin>(() =>
      apiClient.post(`/teams/${panel.team.id}/admins`, admin)
    );
    if (!result) return;

    setAdmin({ fullName: "", email: "" });
    close();
    setCreated(result);
    teams.reload();
  }

  async function archive(id: string) {
    if (await mutation.run(() => apiClient.delete(`/teams/${id}`))) teams.reload();
  }

  return (
    <>
      <PageHeader title="Takimlar">
        {mayCreate ? (
          <button
            className="btn btn-primary btn-sm"
            type="button"
            onClick={() => open({ kind: "team" })}
          >
            + Yeni takim
          </button>
        ) : null}
      </PageHeader>

      {/* Shown once. There is no mail sending in this project, so this is the
          only copy of the password and no later request can retrieve it. */}
      {created ? (
        <div className="card stack-sm">
          <p className="card-title" style={{ margin: 0 }}>
            {created.admin.fullName} icin gecici sifre
          </p>
          <p className="small muted" style={{ margin: 0 }}>
            Bu sifre yalnizca burada ve yalnizca bir kez gosterilir. Hesap sahibine iletin --
            ilk giriste kendi sifresini belirlemeden baska hicbir sey yapamaz.
          </p>
          <div className="row">
            <code style={{ fontSize: "1.1em", letterSpacing: "0.05em" }}>
              {created.temporaryPassword}
            </code>
            <span className="small muted">{created.admin.email}</span>
          </div>
          <RowActions>
            <button className="btn btn-sm" type="button" onClick={() => setCreated(null)}>
              Kapat
            </button>
          </RowActions>
        </div>
      ) : null}

      {panel.kind === "team" ? (
        <FormPanel
          title="Yeni takim"
          error={mutation.error}
          saving={mutation.saving}
          onSubmit={submitTeam}
          onCancel={close}
        >
          <TextField
            label="Takim adi (taslak)"
            value={draft.name}
            required
            hint="Takim yoneticisi kurulum sirasinda bu adi kendi belirleyecek."
            onChange={(name) => setDraft({ ...draft, name })}
            error={issueFor(mutation.error, "name")}
          />
          <TextField
            label="Yonetici ad soyad"
            value={draft.adminFullName}
            required
            onChange={(adminFullName) => setDraft({ ...draft, adminFullName })}
            error={issueFor(mutation.error, "adminFullName")}
          />
          <TextField
            label="Yonetici e-posta"
            type="email"
            value={draft.adminEmail}
            required
            hint="Bir e-posta bir hesap, bir hesap bir takim. Baska takimda kullanilamaz."
            onChange={(adminEmail) => setDraft({ ...draft, adminEmail })}
            error={issueFor(mutation.error, "adminEmail")}
          />
        </FormPanel>
      ) : null}

      {panel.kind === "admin" ? (
        <FormPanel
          title={`${panel.team.name} — yeni yonetici`}
          error={mutation.error}
          saving={mutation.saving}
          onSubmit={submitAdmin}
          onCancel={close}
        >
          <TextField
            label="Ad soyad"
            value={admin.fullName}
            required
            onChange={(fullName) => setAdmin({ ...admin, fullName })}
            error={issueFor(mutation.error, "fullName")}
          />
          <TextField
            label="E-posta"
            type="email"
            value={admin.email}
            required
            onChange={(email) => setAdmin({ ...admin, email })}
            error={issueFor(mutation.error, "email")}
          />
        </FormPanel>
      ) : null}

      {panel.kind === "closed" && mutation.error ? <ErrorBox error={mutation.error} /> : null}

      <AsyncSection state={teams}>
        {(data) => (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Takim</th>
                  <th>Kisa ad</th>
                  <th>Kurulum</th>
                  <th className="numeric">Hesap</th>
                  <th className="numeric">Grup</th>
                  <th>Durum</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((team) => (
                  <tr key={team.id}>
                    <td>{team.name}</td>
                    <td className="muted small">{team.slug}</td>
                    <td>
                      <Badge tone={team.setupStage === "DONE" ? "ok" : "warn"}>
                        {TEAM_SETUP_STAGE_LABELS[team.setupStage]}
                      </Badge>
                    </td>
                    <td className="numeric">{team.accountCount}</td>
                    <td className="numeric">{team.groupCount}</td>
                    <td>
                      <Badge tone={team.isActive ? "ok" : "off"}>
                        {team.isActive ? "Aktif" : "Arsivli"}
                      </Badge>
                    </td>
                    <td>
                      <RowActions>
                        {mayCreate && team.isActive ? (
                          <button
                            className="btn btn-sm"
                            type="button"
                            onClick={() => open({ kind: "admin", team })}
                          >
                            Yonetici ekle
                          </button>
                        ) : null}
                        {mayDelete && team.isActive ? (
                          <ConfirmButton
                            question={`${team.name} arsivlensin mi? Takimdaki herkesin oturumu kapanir.`}
                            onConfirm={() => void archive(team.id)}
                          >
                            Arsivle
                          </ConfirmButton>
                        ) : null}
                      </RowActions>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AsyncSection>
    </>
  );
}
