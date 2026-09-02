"use client";

import { useState } from "react";
import { flattenGroupTree, type Paginated } from "@breakpoint/types";

import {
  ToolStateGrid,
  toolStatesFrom,
  toolStatesPayload,
  type ToolStates,
} from "@/components/groups/tool-state-grid";
import { AsyncSection, ErrorBox } from "@/components/ui";
import { useApi } from "@/hooks/use-api";
import { useMutation } from "@/hooks/use-mutation";
import { apiClient } from "@/lib/api-client";
import type { GroupRow } from "@/lib/api-types";

/**
 * The third step: which modules each department uses.
 *
 * One group at a time, because the answer is per group and pretending otherwise
 * would hide the inheritance. Picking Tasarim shows what it actually gets --
 * including what it is borrowing from Teknik two levels up -- which is the only
 * way the tree is legible while it is being built.
 *
 * The editor is the same component the groups screen uses, not a copy of it.
 */
export function ToolsStep() {
  const groups = useApi<Paginated<GroupRow>>("/groups?pageSize=100&includeInactive=true");
  const mutation = useMutation();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tools, setTools] = useState<ToolStates>(new Map());

  function select(group: GroupRow) {
    setSelectedId(group.id);
    // Only what this group states for itself. The inherited answer is shown
    // beside each control instead, or saving an untouched form would turn every
    // inherited value into a local one and flatten the tree.
    setTools(toolStatesFrom(group.tools));
    mutation.reset();
  }

  async function save() {
    if (!selectedId) return;
    const ok = await mutation.run(() =>
      apiClient.put(`/groups/${selectedId}/tools`, { tools: toolStatesPayload(tools) })
    );
    if (ok) groups.reload();
  }

  return (
    <div className="stack-sm">
      {mutation.error ? <ErrorBox error={mutation.error} /> : null}

      <AsyncSection state={groups} empty="Once grup olusturun.">
        {(data) => {
          const selected = data.items.find((group) => group.id === selectedId) ?? null;

          return (
            <div className="stack-sm">
              <div>
                <p className="card-title" style={{ marginBottom: 4 }}>
                  Grup sec
                </p>
                <div className="stack-sm">
                  {flattenGroupTree(data.items).map(({ group, depth }) => (
                    <button
                      key={group.id}
                      type="button"
                      className={`btn btn-sm ${group.id === selectedId ? "btn-primary" : ""}`}
                      style={{ marginLeft: depth * 20, justifyContent: "flex-start" }}
                      onClick={() => select(group)}
                    >
                      {group.name}
                      <span className="small muted" style={{ marginLeft: 8 }}>
                        {group.effectiveTools.filter((tool) => tool.isEnabled).length} modul
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {selected ? (
                <div className="card stack-sm">
                  <p className="card-title" style={{ margin: 0 }}>
                    {selected.name}
                  </p>
                  <ToolStateGrid
                    value={tools}
                    effective={selected.effectiveTools}
                    onChange={setTools}
                  />
                  <div className="row">
                    <button
                      className="btn btn-primary btn-sm"
                      type="button"
                      disabled={mutation.saving}
                      onClick={() => void save()}
                    >
                      Bu grubu kaydet
                    </button>
                  </div>
                </div>
              ) : (
                <p className="small muted">
                  Modullerini belirlemek icin yukaridan bir grup secin. Bir gruba verilen modul
                  altindaki tum alt gruplara iner.
                </p>
              )}
            </div>
          );
        }}
      </AsyncSection>
    </div>
  );
}
