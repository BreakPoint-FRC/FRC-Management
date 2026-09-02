"use client";

import { useState } from "react";
import { expandGroupSubtrees, flattenGroupTree } from "@breakpoint/types";

import { AsyncSection, ConfirmButton, ErrorBox, RowActions } from "@/components/ui";
import { useApi } from "@/hooks/use-api";
import { useMutation } from "@/hooks/use-mutation";
import { apiClient } from "@/lib/api-client";
import type { GroupTreeRow } from "@/lib/api-types";
import { issueFor } from "@/lib/issues";

/**
 * The first step: the shape of the team.
 *
 * Everything after it depends on this. A role cannot be scoped to a group that
 * does not exist, and a module cannot be assigned to one either -- which is why
 * this is the one step with a hard prerequisite of its own (at least one group).
 *
 * Depth is not limited. Teknik > Mekanik > Tasarim is three levels and there is
 * no reason a team could not want a fourth.
 */
export function GroupsStep() {
  const groups = useApi<GroupTreeRow[]>("/groups/tree");
  const mutation = useMutation();

  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");

  async function add() {
    if (!name.trim()) return;
    const ok = await mutation.run(() =>
      apiClient.post("/groups", { name: name.trim(), parentId: parentId || null })
    );
    if (!ok) return;

    setName("");
    // Back to "root" for the next one.
    //
    // Leaving the parent where it was is the whole of a bug worth remembering:
    // someone picks Teknik to add Mekanik under it, then types Medya and
    // Business and presses Ekle, and all three end up under Teknik because a
    // select ten lines below the list quietly kept its value. Nothing looks
    // wrong until Teknik is deleted and the entire team structure goes with it.
    // Nesting is the deliberate act, so it is the one that has to be repeated.
    setParentId("");
    groups.reload();
  }

  async function remove(id: string) {
    // Computed before the delete, while the tree still describes what is going.
    const going = expandGroupSubtrees([id], groups.data ?? []);
    if (!(await mutation.run(() => apiClient.delete(`/groups/${id}`)))) return;

    // The chosen parent may be the group that just went or anything under it. A
    // select pointing at a row that no longer exists shows the first option
    // while still holding the old id, and the next add would answer 404.
    if (going.has(parentId)) setParentId("");
    groups.reload();
  }

  return (
    <div className="stack-sm">
      {mutation.error ? <ErrorBox error={mutation.error} /> : null}

      <AsyncSection state={groups}>
        {(tree) =>
          tree.length === 0 ? (
            <p className="small muted">Henuz grup yok. Asagidan ilk grubu ekleyin.</p>
          ) : (
            <ul className="tree" style={{ borderLeft: "none", paddingLeft: 0 }}>
              {flattenGroupTree(tree).map(({ group, depth }) => (
                <li key={group.id} style={{ paddingLeft: depth * 20 }}>
                  <div className="row">
                    <span>{group.name}</span>
                    {depth > 0 ? <span className="small muted">alt grup</span> : null}
                    <RowActions>
                      {/* Nothing in a team being set up has any history behind
                          it, so this really deletes. The question names every
                          group that goes rather than saying "and its
                          subgroups": how deep the tree runs is exactly what
                          someone is liable to have forgotten. */}
                      <ConfirmButton
                        question={(() => {
                          const going = [...expandGroupSubtrees([group.id], tree)]
                            .map((id) => tree.find((row) => row.id === id)?.name ?? id)
                            .join(", ");
                          return `Silinecek: ${going}. Devam edilsin mi?`;
                        })()}
                        onConfirm={() => void remove(group.id)}
                      >
                        Sil
                      </ConfirmButton>
                    </RowActions>
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </AsyncSection>

      <div className="row">
        <input
          value={name}
          placeholder="Grup adi (orn. Teknik)"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void add();
            }
          }}
        />
        <select value={parentId} onChange={(event) => setParentId(event.target.value)}>
          <option value="">— Ana grup —</option>
          {flattenGroupTree(groups.data ?? []).map(({ group, depth }) => (
            <option key={group.id} value={group.id}>
              {"  ".repeat(depth)}
              {group.name}
            </option>
          ))}
        </select>
        <button
          className="btn btn-sm"
          type="button"
          disabled={mutation.saving}
          onClick={() => void add()}
        >
          Ekle
        </button>
      </div>

      {/* Where it will land, said before it lands. The select resets to "Ana
          grup" after every add, so this only ever describes a choice just
          made. */}
      <p className="small muted" style={{ margin: 0 }}>
        {parentId
          ? `Yeni grup, ${
              (groups.data ?? []).find((group) => group.id === parentId)?.name ?? "?"
            } altina eklenecek.`
          : "Yeni grup ana grup olarak eklenecek. Alt grup icin once ust grubu secin."}
      </p>
      {issueFor(mutation.error, "name") ? (
        <span className="field-error">{issueFor(mutation.error, "name")}</span>
      ) : null}
    </div>
  );
}
