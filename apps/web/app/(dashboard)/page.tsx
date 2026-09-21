"use client";

import { useState } from "react";
import Link from "next/link";
import { taskPriorityLabels, taskStatusLabels } from "@breakpoint/types";

import { useAuth } from "@/components/auth/auth-provider";
import { AsyncSection, Badge, Card, PageHeader } from "@/components/ui";
import { GuardedLink } from "@/components/unsaved-changes";
import { useApi } from "@/hooks/use-api";
import { dayKey } from "@/lib/calendar-grid";
import { formatDate } from "@/lib/format";
import { canAnywhere } from "@/lib/permissions";
import type { DashboardRow } from "@/lib/api-types";

type Scope = "mine" | "group" | "team" | "management";

const SCOPE_LABEL: Record<Scope, string> = {
  mine: "Benim",
  group: "Grubum",
  team: "Takım",
  management: "Yönetim",
};

/**
 * The homepage: what to do today, not why you can or cannot do it.
 *
 * Scope tabs, not a role mode: GET /dashboard returns `mine`/`group`/`team`/
 * `management` independently, each non-null only when the account's actual
 * resolved grants qualify for it (dashboard.service.ts). A person holding
 * several roles at once -- a software captain who is also the team captain
 * and a finance reader -- gets every tab that applies, exactly like the
 * OR-merged permission model those roles already produce; there is no "which
 * role is active" to pick.
 *
 * The old diagnostic view that used to live here, answering "why can I see
 * this and not that" with the raw permission matrix, moved to "Hesabım"
 * (/account) -- useful for checking the authorization model, not for finding
 * out what is due today.
 */
export default function DashboardPage() {
  const { account, permissions } = useAuth();
  const dashboard = useApi<DashboardRow>("/dashboard");
  const [tab, setTab] = useState<Scope>("mine");

  return (
    <>
      <PageHeader title={`Merhaba, ${account?.fullName ?? ""}`} />

      <AsyncSection state={dashboard}>
        {(data) =>
          data.scope === "platform" && data.platform ? (
            <PlatformSummary data={data.platform} />
          ) : (
            <ScopedDashboard data={data} tab={tab} setTab={setTab} permissions={permissions} />
          )
        }
      </AsyncSection>
    </>
  );
}

function ScopedDashboard({
  data,
  tab,
  setTab,
  permissions,
}: {
  data: DashboardRow;
  tab: Scope;
  setTab: (tab: Scope) => void;
  permissions: ReturnType<typeof useAuth>["permissions"];
}) {
  const available = (["mine", "group", "team", "management"] as const).filter((scope) => data[scope] !== null);
  const active = available.includes(tab) ? tab : (available[0] ?? "mine");

  return (
    <>
      <div className="scope-tabs" role="tablist" aria-label="Kapsam">
        {available.map((scope) => (
          <button
            key={scope}
            type="button"
            role="tab"
            aria-selected={scope === active}
            className={`scope-tab${scope === active ? " is-active" : ""}`}
            onClick={() => setTab(scope)}
          >
            {SCOPE_LABEL[scope]}
          </button>
        ))}
      </div>

      {active === "mine" && data.mine ? <MineSummary data={data.mine} /> : null}
      {active === "group" && data.group ? <GroupSummary data={data.group} /> : null}
      {active === "team" && data.team ? (
        <TeamSummary
          data={data.team}
          canCreateTask={canAnywhere(permissions, "TASKS", "create")}
          canCreateMeeting={canAnywhere(permissions, "MEETINGS", "create")}
        />
      ) : null}
      {active === "management" && data.management ? <ManagementSummary data={data.management} /> : null}
    </>
  );
}

function PlatformSummary({ data }: { data: NonNullable<DashboardRow["platform"]> }) {
  return (
    <div className="stack">
      <div className="grid">
        <Card title="Aktif takımlar">
          <div className="stat">{data.activeTeamCount}</div>
        </Card>
        <Card title="Arşivlenmiş takımlar">
          <div className="stat">{data.archivedTeamCount}</div>
        </Card>
      </div>

      <div>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Son oluşturulan takımlar</h2>
          <Link className="btn btn-primary btn-sm" href="/teams">
            + Yeni takım
          </Link>
        </div>
        {data.recentTeams.length === 0 ? (
          <p className="muted">Henüz takım oluşturulmamış.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Takım</th>
                  <th>Oluşturulma</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.recentTeams.map((team) => (
                  <tr key={team.id}>
                    <td>{team.name}</td>
                    <td className="muted small">{formatDate(team.createdAt)}</td>
                    <td>
                      <Link className="btn btn-sm" href="/teams">
                        Aç
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function ManagementSummary({ data }: { data: NonNullable<DashboardRow["management"]> }) {
  const warnings: string[] = [];
  if (data.mustChangePasswordCount !== null && data.mustChangePasswordCount > 0) {
    warnings.push(
      `${data.mustChangePasswordCount} hesap ilk şifresini henüz değiştirmedi.`
    );
  }
  if (data.withoutRoleCount !== null && data.withoutRoleCount > 0) warnings.push(`${data.withoutRoleCount} hesapta rol bulunmuyor.`);
  if (data.withoutGroupCount !== null && data.withoutGroupCount > 0) warnings.push(`${data.withoutGroupCount} hesap hiçbir gruba bağlı değil.`);
  if (data.setupIncomplete) warnings.push("Takım kurulumu henüz tamamlanmadı.");

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Yönetim sağlığı</h2>
        {data.canReadAccounts ? (
          <Link className="btn btn-primary btn-sm" href="/accounts">
            Hesapları yönet
          </Link>
        ) : null}
      </div>

      {warnings.length > 0 ? (
        <div className="stack-sm">
          {warnings.map((text, index) => (
            <div key={index} className="card">
              <p style={{ margin: 0 }}>
                <Badge tone="warn">Dikkat</Badge> {text}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      <div className="grid">
        {data.canReadAccounts ? (
          <>
            <Card title="Aktif hesap">
              <div className="stat">{data.activeAccountCount}</div>
            </Card>
            <Card title="Şifresini değiştirmemiş">
              <div className="stat">{data.mustChangePasswordCount}</div>
            </Card>
            <Card title="Rolü olmayan hesap">
              <div className="stat">{data.withoutRoleCount}</div>
            </Card>
            <Card title="Grubu olmayan hesap">
              <div className="stat">{data.withoutGroupCount}</div>
            </Card>
          </>
        ) : null}
        {data.canReadSeasons ? (
          <Card title="Aktif sezon">
            {data.activeSeason ? (
              <div>
                <div className="stat" style={{ fontSize: 16 }}>
                  {data.activeSeason.name}
                </div>
                <div className="small muted">
                  {formatDate(data.activeSeason.startDate)} — {formatDate(data.activeSeason.endDate)}
                </div>
              </div>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                Aktif sezon yok.
              </p>
            )}
          </Card>
        ) : null}
      </div>

      {data.setupIncomplete ? (
        <p className="small">
          <Link href="/setup">Takım kurulumu henüz tamamlanmadı — devam etmek için tıklayın.</Link>
        </p>
      ) : null}
    </div>
  );
}

function TeamSummary({
  data,
  canCreateTask,
  canCreateMeeting,
}: {
  data: NonNullable<DashboardRow["team"]>;
  canCreateTask: boolean;
  canCreateMeeting: boolean;
}) {
  return (
    <div className="stack">
      <div className="grid">
        {data.canReadSeasons ? <Card title="Sezon">
          {data.activeSeason ? (
            <div>
              <div className="stat" style={{ fontSize: 16 }}>
                {data.activeSeason.name}
              </div>
              <div className="small muted">
                {data.seasonDaysRemaining !== null
                  ? `${data.seasonDaysRemaining} gün kaldı`
                  : "Bitiş tarihi geçti"}
              </div>
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              Aktif sezon yok.
            </p>
          )}
        </Card> : null}
        {data.canReadCrossGroupTasks ? <Card title="Gruplar arası açık görev">
          <div className="stat">{data.crossGroupOpenTaskCount}</div>
        </Card> : null}
        {data.canReadCrossGroupTasks ? <Card title="Sorumlusu olmayan (gruplar arası)">
          <div className="stat">{data.crossGroupUnassignedTaskCount}</div>
        </Card> : null}
        {data.canReadMeetings ? <Card title="Yaklaşan takım toplantısı">
          {data.upcomingMeeting ? (
            <div>
              <div className="stat" style={{ fontSize: 15 }}>
                {data.upcomingMeeting.title}
              </div>
              <div className="small muted">{formatDate(data.upcomingMeeting.meetingDate)}</div>
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              Planlanmış toplantı yok.
            </p>
          )}
        </Card> : null}
      </div>

      {data.canReadTasks ? <div>
        <h2 style={{ marginBottom: 8 }}>Departman durumu</h2>
        {data.departments.length === 0 ? (
          <p className="muted">Henüz grup oluşturulmamış.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Grup</th>
                  <th className="numeric">Açık</th>
                  <th className="numeric">Geciken</th>
                  <th className="numeric">Sorumlusuz</th>
                  <th>Durum</th>
                </tr>
              </thead>
              <tbody>
                {[...data.departments]
                  .sort((a, b) => b.overdueCount - a.overdueCount || b.unassignedCount - a.unassignedCount)
                  .map((department) => {
                    const attention = department.overdueCount > 0 || department.unassignedCount > 0;
                    return (
                      <tr key={department.groupId}>
                        <td>{department.groupName}</td>
                        <td className="numeric">{department.openCount}</td>
                        <td className="numeric">{department.overdueCount}</td>
                        <td className="numeric">{department.unassignedCount}</td>
                        <td>
                          <Badge tone={attention ? "warn" : "ok"}>{attention ? "Dikkat" : "İyi"}</Badge>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </div> : null}

      <div className="row">
        {canCreateTask ? (
          <Link className="btn btn-sm" href="/tasks">
            + Görev oluştur
          </Link>
        ) : null}
        {canCreateMeeting ? (
          <Link className="btn btn-sm" href="/meetings">
            + Toplantı oluştur
          </Link>
        ) : null}
        <Link className="btn btn-sm" href="/gantt">
          Zaman çizelgesini aç
        </Link>
      </div>
    </div>
  );
}

function GroupSummary({ data }: { data: NonNullable<DashboardRow["group"]> }) {
  return (
    <div className="stack">
      {data.map((department) => (
        <div key={department.groupId} className="stack">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 style={{ margin: 0 }}>{department.groupName}</h2>
            <GuardedLink className="btn btn-sm" href="/tasks">
              Görevleri aç
            </GuardedLink>
          </div>

          {department.canReadTasks ? <div className="grid">
            <Card title="Açık">
              <div className="stat">{department.openCount}</div>
            </Card>
            <Card title="Gecikmiş">
              <div className="stat">{department.overdueCount}</div>
            </Card>
            <Card title="Sorumlusuz">
              <div className="stat">{department.unassignedCount}</div>
            </Card>
            <Card title="Bu hafta tamamlandı">
              <div className="stat">{department.completedThisWeekCount}</div>
            </Card>
          </div> : null}

          <div className="grid">
            {department.canReadTasks ? <div>
              <h2 style={{ marginBottom: 8, fontSize: 13 }}>Öncelikli görevler</h2>
              <TaskList tasks={department.topTasks} empty="Açık görev yok." />
            </div> : null}
            {department.canReadMeetings ? <div>
              <h2 style={{ marginBottom: 8, fontSize: 13 }}>Yaklaşan toplantı</h2>
              {department.upcomingMeeting ? (
                <GuardedLink className="card" href={`/meetings/${department.upcomingMeeting.id}`}>
                  <p className="card-title" style={{ margin: 0 }}>
                    {department.upcomingMeeting.title}
                  </p>
                  <p className="small muted" style={{ margin: 0 }}>
                    {formatDate(department.upcomingMeeting.meetingDate)}
                  </p>
                </GuardedLink>
              ) : (
                <p className="muted">Planlanmış toplantı yok.</p>
              )}
            </div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function MineSummary({ data }: { data: NonNullable<DashboardRow["mine"]> }) {
  const nothingAssigned = data.groups.length === 0 && data.roles.length === 0;

  return (
    <div className="stack">
      {nothingAssigned ? (
        <div className="card">
          <p className="card-title" style={{ margin: "0 0 4px" }}>
            Henüz rol veya grup atanmamış
          </p>
          <p className="small muted" style={{ margin: 0 }}>
            Takım yöneticiniz hesabınızı henüz tamamlamamış olabilir. Bir role ya da gruba
            atandığınızda burada göreviniz, toplantılarınız ve grubunuz görünür.
          </p>
        </div>
      ) : (
        <div className="grid">
          <Card title="Gruplarım">
            {data.groups.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                Hiçbir gruba üye değilsiniz.
              </p>
            ) : (
              <div className="row">
                {data.groups.map((group) => (
                  <Badge key={group.id}>{group.name}</Badge>
                ))}
              </div>
            )}
          </Card>
          <Card title="Rollerim">
            {data.roles.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                Henüz rol atanmamış.
              </p>
            ) : (
              <div className="stack-sm">
                {data.roles.map((role, index) => (
                  <div key={index} className="small">
                    {role.roleName}
                    {role.groupName ? ` — ${role.groupName}` : ""}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      <div className="grid">
        <div>
          <h2 style={{ marginBottom: 8 }}>Görevlerim</h2>
          <TaskList
            tasks={[...data.overdueTasks, ...data.openTasks]}
            empty="Size atanmış açık göreviniz yok."
          />
        </div>
        <div>
          <h2 style={{ marginBottom: 8 }}>Yaklaşan toplantılar</h2>
          {data.upcomingMeetings.length === 0 ? (
            <p className="muted">Önümüzdeki 7 gün içinde toplantı yok.</p>
          ) : (
            <div className="stack-sm">
              {data.upcomingMeetings.map((meeting) => (
                <GuardedLink key={meeting.id} className="card" href={`/meetings/${meeting.id}`}>
                  <p className="card-title" style={{ margin: 0 }}>
                    {meeting.title}
                  </p>
                  <p className="small muted" style={{ margin: 0 }}>
                    {formatDate(meeting.meetingDate)}
                    {meeting.groupName ? ` · ${meeting.groupName}` : ""}
                  </p>
                </GuardedLink>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TaskList({
  tasks,
  empty,
}: {
  tasks: NonNullable<DashboardRow["mine"]>["openTasks"];
  empty: string;
}) {
  if (tasks.length === 0) return <p className="muted">{empty}</p>;

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Görev</th>
            <th>Grup</th>
            <th>Durum</th>
            <th>Öncelik</th>
            <th>Bitiş</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => {
            // dueDate is a date-only field (UTC midnight): a task due today
            // is not overdue until its whole calendar day has passed, so this
            // has to compare calendar days, not the raw instant against now.
            const overdue = task.dueDate !== null && dayKey(task.dueDate) < dayKey(new Date());
            return (
              <tr key={task.id}>
                <td>
                  <GuardedLink href={`/tasks/${task.id}`}>{task.name}</GuardedLink>
                </td>
                <td className="muted small">{task.groupName ?? "Gruplar arası"}</td>
                <td>{taskStatusLabels[task.status]}</td>
                <td>{taskPriorityLabels[task.priority]}</td>
                <td style={overdue ? { color: "var(--danger-text)" } : undefined}>
                  {task.dueDate ? formatDate(task.dueDate) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
