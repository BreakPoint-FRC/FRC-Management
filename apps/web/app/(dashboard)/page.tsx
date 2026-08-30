"use client";

import { TOOL_KEYS, formatAccountRoles, type PermissionSet } from "@breakpoint/types";

import { useAuth } from "@/components/auth/auth-provider";
import { AsyncSection, Badge, Card, PageHeader } from "@/components/ui";
import { useApi } from "@/hooks/use-api";
import { formatDate } from "@/lib/format";
import type { SeasonRow } from "@/lib/api-types";

const ACTIONS = [
  { key: "canRead", short: "O", label: "Okuma" },
  { key: "canCreate", short: "E", label: "Ekleme" },
  { key: "canUpdate", short: "G", label: "Guncelleme" },
  { key: "canDelete", short: "S", label: "Silme" },
] as const;

function Flags({ set }: { set: PermissionSet | undefined }) {
  return (
    <>
      {ACTIONS.map((action) => {
        const granted = set?.[action.key] ?? false;
        return (
          <td key={action.key} className="numeric" title={action.label}>
            <span className={granted ? "" : "muted"}>{granted ? "✓" : "·"}</span>
          </td>
        );
      })}
    </>
  );
}

/**
 * The overview exists to make the authorization model visible.
 *
 * Everything else in the app is a list of records; this is the one page that
 * answers "why can I see that and not this", by putting the account, its roles,
 * its departments and the resolved permission matrix on one screen. Signing in
 * as an admin, a lead and a member and comparing this page is the fastest way
 * to check the model is behaving.
 */
export default function OverviewPage() {
  const { account, roles = [], groups = [], permissions } = useAuth();
  const season = useApi<SeasonRow>("/seasons/current");

  return (
    <>
      <PageHeader title={`Merhaba, ${account?.fullName ?? ""}`} />

      <div className="stack">
        <div className="grid">
          <Card title="Rollerim">
            {roles.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                Henuz rol atanmamis.
              </p>
            ) : (
              <p style={{ margin: 0 }}>{formatAccountRoles(roles)}</p>
            )}
          </Card>

          <Card title="Gruplarim">
            {groups.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                Hicbir gruba uye degilsiniz.
              </p>
            ) : (
              <div className="row">
                {groups.map((group) => (
                  <Badge key={group.id}>{group.name}</Badge>
                ))}
              </div>
            )}
          </Card>

          <Card title="Aktif sezon">
            <AsyncSection state={season} empty="Aktif sezon yok.">
              {(data) => (
                <div>
                  <div className="stat">{data.name}</div>
                  <div className="small muted">
                    {formatDate(data.startDate)} — {formatDate(data.endDate)}
                  </div>
                  <div className="small muted" style={{ marginTop: 4 }}>
                    {data._count.tasks} gorev · {data._count.meetings} toplanti ·{" "}
                    {data._count.transactions} finans kaydi · {data._count.sponsorships} sponsorluk
                  </div>
                </div>
              )}
            </AsyncSection>
          </Card>
        </div>

        <div>
          <h2>Yetkilerim</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            Takim geneli yetkiler her yerde gecerlidir. Grup sutunlari yalnizca uye oldugunuz
            departmanlar icin, ve o departmanda o modul acikken gecerlidir. Bu tablo neyin
            gosterilecegine karar verir; istegi kabul veya reddeden sunucudur.
          </p>

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Modul</th>
                  <th className="numeric" colSpan={4}>
                    Takim geneli
                  </th>
                  {groups.map((group) => (
                    <th key={group.id} className="numeric" colSpan={4}>
                      {group.name}
                    </th>
                  ))}
                </tr>
                <tr>
                  <th />
                  {[null, ...groups].map((group, index) =>
                    ACTIONS.map((action) => (
                      <th key={`${group?.id ?? "global"}-${action.key}-${index}`} className="numeric small">
                        {action.short}
                      </th>
                    ))
                  )}
                </tr>
              </thead>
              <tbody>
                {TOOL_KEYS.map((tool) => (
                  <tr key={tool}>
                    <td>{tool}</td>
                    <Flags set={permissions?.global[tool]} />
                    {groups.map((group) => (
                      <Flags key={group.id} set={permissions?.byGroup[group.id]?.[tool]} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="small muted">
            O = okuma, E = ekleme, G = guncelleme, S = silme.
          </p>
        </div>
      </div>
    </>
  );
}
