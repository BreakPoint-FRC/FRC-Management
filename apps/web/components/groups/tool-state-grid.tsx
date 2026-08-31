"use client";

import { TOOL_KEYS, type ToolKey } from "@breakpoint/types";

import { SelectField } from "@/components/ui/form";

/**
 * What a group states about a tool for itself.
 *
 * A Map with the tool missing is the third state: state nothing, and the answer
 * falls through to the parent. That is the whole of the override mechanism, and
 * it is why this is not a Set of enabled keys -- a set could say "on" and "not
 * on", and "not on" would have to mean both "off" and "inherit".
 */
export type ToolStates = Map<ToolKey, boolean>;

/** What a group actually gets, once inheritance is resolved. */
export interface EffectiveTool {
  tool: string;
  isEnabled: boolean;
  /** The ancestor the answer came from, or null when the group states it. */
  inheritedFrom: string | null;
}

/** The stored rows of a group, in the shape this editor takes. */
export function toolStatesFrom(
  tools: ReadonlyArray<{ tool: string; isEnabled: boolean }>
): ToolStates {
  return new Map(tools.map((entry) => [entry.tool as ToolKey, entry.isEnabled]));
}

/** The whole set, as PUT /groups/:id/tools wants it. */
export function toolStatesPayload(states: ToolStates) {
  return [...states].map(([tool, isEnabled]) => ({ tool, isEnabled }));
}

/**
 * The three-state module grid for one department, as a controlled component.
 *
 * Shared by the groups screen and the setup wizard. The inherited answer is
 * shown beside each control rather than pre-selected: pre-selecting it would
 * turn every inherited value into a local one the moment an untouched form was
 * saved, and the tree would quietly flatten.
 */
export function ToolStateGrid({
  value,
  effective,
  onChange,
}: {
  value: ToolStates;
  /** GroupRow.effectiveTools for the group being edited. */
  effective: readonly EffectiveTool[];
  onChange: (next: ToolStates) => void;
}) {
  return (
    <div className="stack-sm">
      <p className="small muted" style={{ margin: 0 }}>
        Her modul ucte bir durumda olur. <strong>Devral</strong> cevabi ust gruptan alir;
        <strong> Acik</strong> ve <strong>Kapali</strong> burada karara baglar ve alt gruplara
        aynen iner. Hicbir ust grupta karar yoksa modul kapalidir ve istek, rol hic okunmadan
        reddedilir.
      </p>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        {TOOL_KEYS.map((tool) => {
          const resolved = effective.find((entry) => entry.tool === tool);
          const stated = value.get(tool);
          const inherited =
            resolved && resolved.inheritedFrom
              ? `Devralinan: ${resolved.isEnabled ? "acik" : "kapali"}`
              : "Ust grupta karar yok: kapali";

          return (
            <SelectField
              key={tool}
              label={tool}
              value={stated === undefined ? "" : stated ? "on" : "off"}
              hint={stated === undefined ? inherited : undefined}
              options={[
                { value: "", label: "Devral" },
                { value: "on", label: "Acik" },
                { value: "off", label: "Kapali" },
              ]}
              onChange={(next) => {
                const updated = new Map(value);
                if (next === "") updated.delete(tool);
                else updated.set(tool, next === "on");
                onChange(updated);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
