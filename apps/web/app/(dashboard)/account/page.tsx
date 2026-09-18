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
  { key: "canUpdate", short: "G", label: "Güncelleme" },
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
 * "Hesabım" -- what this account is and why it can see what it can see.
 *
 * The one page that answers "why can I see that and not this", by putting the
 * account's roles, its departments and the resolved permission matrix on one
 * screen. Signing in as an admin, a lead and a member and comparing this page
 * is the fastest way to check the model is behaving. This used to be the
 * homepage; the dashboard now on "/" answers "what do I need to do today"
 * instead, and links here for anyone who wants the diagnostic view.
 */
export default function AccountPage() {
  const { account, team, roles = [], groups = [], permissions } = useAuth();

  // A platform system admin belongs to no team, so there is no season to ask
  // for -- /seasons/current answers 403 for an account with no team. Passing
  // null skips the request rather than rendering an error nobody can act on.
  const season = useApi<SeasonRow>(team ? "/seasons/current" : null);
  const platformOnly = team === null;

  return (
    <>
      <PageHeader title="Rollerim ve yetkilerim" />

      <div className="stack">
        {platformOnly ? (
          <p className="muted" style={{ margin: 0 }}>
            Bu bir platform hesabı. Takımların dışında durur: takım açar, arşivler ve her
            takımın yöneticisini oluşturur. Görevler, toplantılar ve finans bir takımın
            içindedir, bu yüzden burada yoklar.
          </p>
        ) : null}

        <div className="grid">
          <Card title="Rollerim">
            {roles.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                Henüz rol atanmamış.
              </p>
            ) : (
              <p style={{ margin: 0 }}>{formatAccountRoles(roles)}</p>
            )}
          </Card>

          {/* Both are about life inside a team, and a platform account has
              none. Drawing them empty would say "you are in no groups" where
              the truth is that groups are not a thing this account has. */}
          {platformOnly ? null : (
            <>
              <Card title="Gruplarım">
                {groups.length === 0 ? (
                  <p className="muted" style={{ margin: 0 }}>
                    Hiçbir gruba üye değilsiniz.
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
                        {data._count.tasks} görev · {data._count.meetings} toplantı ·{" "}
                        {data._count.transactions} finans kaydı ·{" "}
                        {data._count.sponsorships} sponsorluk
                      </div>
                    </div>
                  )}
                </AsyncSection>
              </Card>
            </>
          )}
        </div>

        <div>
          <h2>Yetkilerim</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            {platformOnly
              ? "Platform hesabının tek modülü budur. Diğer modüller bir takımın içindedir ve bu hesap hiçbir takıma ait değildir."
              : "Takım geneli yetkiler her yerde geçerlidir. Grup sütunları yalnızca üye olduğunuz departmanlar için, ve o departmanda o modül açıkken geçerlidir."}{" "}
            Bu tablo neyin gösterileceğine karar verir; isteği kabul veya reddeden sunucudur.
          </p>

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Modül</th>
                  <th className="numeric" colSpan={4}>
                    Takım geneli
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
                {/* A team account sees every module, because "you cannot do
                    this" is half of what the table is for. A platform account
                    sees only what it holds: the other fourteen rows would be
                    fourteen dots explaining an absence it already knows. */}
                {(platformOnly
                  ? TOOL_KEYS.filter((tool) =>
                      ACTIONS.some((action) => permissions?.global[tool]?.[action.key])
                    )
                  : TOOL_KEYS
                ).map((tool) => (
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
            O = okuma, E = ekleme, G = güncelleme, S = silme.
          </p>
        </div>
      </div>
    </>
  );
}
