"use client";

import { useState } from "react";
import { ROLE_PLACEMENT_LABELS, type Paginated } from "@breakpoint/types";

import {
  matrixFromPermissions,
  permissionsPayload,
  PermissionMatrix,
  type PermissionMatrixValue,
} from "@/components/roles/permission-matrix";
import { AsyncSection, Badge, ErrorBox } from "@/components/ui";
import { useApi } from "@/hooks/use-api";
import { useMutation } from "@/hooks/use-mutation";
import { apiClient } from "@/lib/api-client";
import type { RoleRow } from "@/lib/api-types";

/**
 * The fourth step: what each role may do to each module.
 *
 * Usually a step of adjustments rather than of invention -- the template
 * applied at the roles step arrives with a matrix already filled in, and most
 * teams change a few cells rather than all of them.
 *
 * Only *direct* grants are edited. What a role inherits from the roles below it
 * is resolved from the hierarchy on every request and never stored, so a
 * permission added to the bottom role reaches everything above it without
 * anyone ticking a second box.
 *
 * The grid is the same component the roles screen uses, not a copy of it.
 */
export function PermissionsStep() {
  const roles = useApi<Paginated<RoleRow>>("/roles?pageSize=100");
  const mutation = useMutation();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [matrix, setMatrix] = useState<PermissionMatrixValue>({});

  function select(role: RoleRow) {
    setSelectedId(role.id);
    setMatrix(matrixFromPermissions(role.permissions));
    mutation.reset();
  }

  async function save() {
    if (!selectedId) return;
    const ok = await mutation.run(() =>
      apiClient.put(`/roles/${selectedId}/permissions`, { permissions: permissionsPayload(matrix) })
    );
    if (ok) roles.reload();
  }

  return (
    <div className="stack-sm">
      {mutation.error ? <ErrorBox error={mutation.error} /> : null}

      <AsyncSection state={roles} empty="Once rol olusturun.">
        {(data) => {
          // The team admin role is created with the team and already holds
          // everything; editing it here would only be a way to lock the team
          // out of its own settings.
          const editable = data.items.filter((role) => !role.isSystemRole);
          const selected = editable.find((role) => role.id === selectedId) ?? null;

          if (editable.length === 0) {
            return (
              <p className="small muted">
                Duzenlenecek rol yok. Onceki adima donup rolleri olusturun.
              </p>
            );
          }

          return (
            <div className="stack-sm">
              <div>
                <p className="card-title" style={{ marginBottom: 4 }}>
                  Rol sec
                </p>
                <div className="row" style={{ flexWrap: "wrap" }}>
                  {editable.map((role) => (
                    <button
                      key={role.id}
                      type="button"
                      className={`btn btn-sm ${role.id === selectedId ? "btn-primary" : ""}`}
                      onClick={() => select(role)}
                    >
                      {role.name}
                    </button>
                  ))}
                </div>
              </div>

              {selected ? (
                <div className="card stack-sm">
                  <div className="row">
                    <p className="card-title" style={{ margin: 0 }}>
                      {selected.name}
                    </p>
                    <Badge tone={selected.placement === "TEAM_WIDE" ? "warn" : "off"}>
                      {ROLE_PLACEMENT_LABELS[selected.placement]}
                    </Badge>
                  </div>
                  <p className="small muted" style={{ margin: 0 }}>
                    Yalnizca dogrudan verilen yetkiler. Alt rollerden devralinanlar burada
                    isaretli gorunmez; istek aninda hiyerarsiden cozulur.
                  </p>
                  <PermissionMatrix value={matrix} onChange={setMatrix} />
                  <div className="row">
                    <button
                      className="btn btn-primary btn-sm"
                      type="button"
                      disabled={mutation.saving}
                      onClick={() => void save()}
                    >
                      Bu rolu kaydet
                    </button>
                  </div>
                </div>
              ) : (
                <p className="small muted">Yetkilerini belirlemek icin bir rol secin.</p>
              )}
            </div>
          );
        }}
      </AsyncSection>
    </div>
  );
}
