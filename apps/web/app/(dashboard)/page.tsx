"use client";

import Link from "next/link";
import { taskPriorityLabels, taskStatusLabels } from "@breakpoint/types";

import { useAuth } from "@/components/auth/auth-provider";
import { AsyncSection, Badge, Card, PageHeader } from "@/components/ui";
import { GuardedLink } from "@/components/unsaved-changes";
import { useApi } from "@/hooks/use-api";
import { formatDate } from "@/lib/format";
import { canAnywhere } from "@/lib/permissions";
import type { DashboardRow } from "@/lib/api-types";

/**
 * The homepage: what to do today, not why you can or cannot do it.
 *
 * The old overview page answered "why can I see that and not this" by
 * putting the resolved permission matrix front and center -- useful for
 * checking the authorization model, useless for a member opening the app to
 * find out what is due. That diagnostic view still exists, moved to
 * "Hesabım" (/account); this page is what replaces it as "/".
 *
 * Which sections render comes entirely from GET /dashboard's `tier`, decided
 * server-side from the account's actual resolved grants -- never guessed
 * here from a role's name. See dashboard.service.ts.
 */
export default function DashboardPage() {
  const { account, permissions } = useAuth();
  const dashboard = useApi<DashboardRow>("/dashboard");

  return (
    <>
      <PageHeader title={`Merhaba, ${account?.fullName ?? ""}`} />

      <AsyncSection state={dashboard}>
        {(data) =>
          data.scope === "platform" && data.platform ? (
            <PlatformSummary data={data.platform} />
          ) : (
            <div className="stack">
              {data.tier === "team_admin" && data.teamAdmin ? (
                <TeamAdminSummary data={data.teamAdmin} />
              ) : null}
              {data.tier === "lead" && data.lead ? (
                <LeadSummary lead={data.lead} canCreateTask={canAnywhere(permissions, "TASKS", "create")} canCreateMeeting={canAnywhere(permissions, "MEETINGS", "create")} />
              ) : null}
              {data.member ? <MemberSummary data={data.member} /> : null}
            </div>
          )
        }
      </AsyncSection>
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

function TeamAdminSummary({ data }: { data: NonNullable<DashboardRow["teamAdmin"]> }) {
  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Takım yönetimi</h2>
        <Link className="btn btn-primary btn-sm" href="/accounts">
          Hesapları yönet
        </Link>
      </div>

      {data.setupIncomplete ? (
        <p className="small" style={{ margin: "0 0 12px" }}>
          <Link href="/setup">Takım kurulumu henüz tamamlanmadı — devam etmek için tıklayın.</Link>
        </p>
      ) : null}

      <div className="grid">
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
      </div>
    </div>
  );
}

function LeadSummary({
  lead,
  canCreateTask,
  canCreateMeeting,
}: {
  lead: NonNullable<DashboardRow["lead"]>;
  canCreateTask: boolean;
  canCreateMeeting: boolean;
}) {
  return (
    <div>
      <h2 style={{ marginBottom: 8 }}>Takımın durumu</h2>
      <div className="grid">
        <Card title="Açık görev">
          <div className="stat">{lead.teamOpenTaskCount}</div>
        </Card>
        <Card title="Geciken görev">
          <div className="stat">{lead.teamOverdueTaskCount}</div>
        </Card>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
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
        <Link className="btn btn-sm" href="/calendar">
          Takvimi aç
        </Link>
      </div>
    </div>
  );
}

function MemberSummary({ data }: { data: NonNullable<DashboardRow["member"]> }) {
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
  tasks: NonNullable<DashboardRow["member"]>["openTasks"];
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
            const overdue = task.dueDate !== null && new Date(task.dueDate) < new Date();
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
