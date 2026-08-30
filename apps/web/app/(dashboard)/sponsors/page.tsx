"use client";

import { useState } from "react";
import {
  sponsorshipStatusLabels,
  type Paginated,
  type SponsorshipStatus,
} from "@breakpoint/types";

import { useAuth } from "@/components/auth/auth-provider";
import {
  AsyncSection,
  Badge,
  ConfirmButton,
  ErrorBox,
  PageHeader,
  RowActions,
} from "@/components/ui";
import {
  FormPanel,
  SelectField,
  TextAreaField,
  TextField,
  optionsFrom,
} from "@/components/ui/form";
import { useApi } from "@/hooks/use-api";
import { useMutation } from "@/hooks/use-mutation";
import { apiClient } from "@/lib/api-client";
import type { OrganizationRow, SeasonRow } from "@/lib/api-types";
import { emptyToNull } from "@/lib/form-helpers";
import { formatMoney } from "@/lib/format";
import { issueFor } from "@/lib/issues";
import { can } from "@/lib/permissions";
import { sponsorshipTone } from "@/lib/status";

interface OrgDraft {
  name: string;
  website: string;
  email: string;
  phone: string;
  notes: string;
}

interface SponsorshipDraft {
  organizationId: string;
  seasonId: string;
  status: SponsorshipStatus;
  amount: string;
  notes: string;
}

const BLANK_ORG: OrgDraft = { name: "", website: "", email: "", phone: "", notes: "" };

type Panel =
  | { kind: "closed" }
  | { kind: "org"; org: OrganizationRow | null }
  | { kind: "sponsorship"; org: OrganizationRow; sponsorshipId: string | null };

/**
 * Organisations with their per-season relationship history.
 *
 * The two are separate tables on purpose, and this page is where that pays off:
 * a company keeps one row for its name and phone number, and gains one
 * relationship row per season. The same firm can be a candidate in 2026 and a
 * sponsor in 2027 without either record overwriting the other.
 */
export default function SponsorsPage() {
  const { permissions } = useAuth();
  const organizations = useApi<Paginated<OrganizationRow>>(
    "/sponsors/organizations?pageSize=100"
  );
  const mutation = useMutation();

  const [panel, setPanel] = useState<Panel>({ kind: "closed" });
  const [orgDraft, setOrgDraft] = useState<OrgDraft>(BLANK_ORG);
  const [sponsorshipDraft, setSponsorshipDraft] = useState<SponsorshipDraft>({
    organizationId: "",
    seasonId: "",
    status: "CANDIDATE",
    amount: "",
    notes: "",
  });

  const seasons = useApi<Paginated<SeasonRow>>(
    panel.kind === "sponsorship" ? "/seasons?pageSize=100" : null
  );

  const mayCreate = can(permissions, "SPONSORS", "create");
  const mayUpdate = can(permissions, "SPONSORS", "update");
  const mayDelete = can(permissions, "SPONSORS", "delete");

  function close() {
    setPanel({ kind: "closed" });
    mutation.reset();
  }

  function openOrg(org: OrganizationRow | null) {
    setOrgDraft(
      org
        ? {
            name: org.name,
            website: org.website ?? "",
            email: org.email ?? "",
            phone: org.phone ?? "",
            notes: "",
          }
        : BLANK_ORG
    );
    setPanel({ kind: "org", org });
    mutation.reset();
  }

  function openSponsorship(org: OrganizationRow, existing?: OrganizationRow["sponsorships"][number]) {
    setSponsorshipDraft({
      organizationId: org.id,
      seasonId: existing?.season.id ?? "",
      status: existing?.status ?? "CANDIDATE",
      amount: existing?.amount ?? "",
      notes: "",
    });
    setPanel({ kind: "sponsorship", org, sponsorshipId: existing?.id ?? null });
    mutation.reset();
  }

  async function submitOrg() {
    if (panel.kind !== "org") return;

    const body = {
      name: orgDraft.name,
      website: emptyToNull(orgDraft.website),
      email: emptyToNull(orgDraft.email),
      phone: emptyToNull(orgDraft.phone),
      notes: emptyToNull(orgDraft.notes),
    };

    const ok = await mutation.run(() =>
      panel.org
        ? apiClient.patch(`/sponsors/organizations/${panel.org.id}`, body)
        : apiClient.post("/sponsors/organizations", body)
    );
    if (ok) {
      close();
      organizations.reload();
    }
  }

  async function submitSponsorship() {
    if (panel.kind !== "sponsorship") return;

    const body = {
      status: sponsorshipDraft.status,
      amount: emptyToNull(sponsorshipDraft.amount),
      notes: emptyToNull(sponsorshipDraft.notes),
    };

    const ok = await mutation.run(() =>
      panel.sponsorshipId
        ? apiClient.patch(`/sponsors/sponsorships/${panel.sponsorshipId}`, body)
        : apiClient.post("/sponsors/sponsorships", {
            ...body,
            organizationId: sponsorshipDraft.organizationId,
            seasonId: sponsorshipDraft.seasonId || undefined,
          })
    );
    if (ok) {
      close();
      organizations.reload();
    }
  }

  async function removeOrg(id: string) {
    // Refused once the firm has any sponsorship history -- the 409 says so and
    // suggests marking the relationship INACTIVE instead.
    if (await mutation.run(() => apiClient.delete(`/sponsors/organizations/${id}`))) {
      organizations.reload();
    }
  }

  async function removeSponsorship(id: string) {
    if (await mutation.run(() => apiClient.delete(`/sponsors/sponsorships/${id}`))) {
      organizations.reload();
    }
  }

  return (
    <>
      <PageHeader title="Sponsorlar">
        {mayCreate ? (
          <button className="btn btn-primary btn-sm" type="button" onClick={() => openOrg(null)}>
            + Yeni firma
          </button>
        ) : null}
      </PageHeader>

      {panel.kind === "org" ? (
        <FormPanel
          title={panel.org ? "Firmayi duzenle" : "Yeni firma"}
          error={mutation.error}
          saving={mutation.saving}
          onSubmit={submitOrg}
          onCancel={close}
        >
          <TextField
            label="Ad"
            value={orgDraft.name}
            required
            onChange={(name) => setOrgDraft({ ...orgDraft, name })}
            error={issueFor(mutation.error, "name")}
          />
          <div className="row">
            <TextField
              label="Site"
              value={orgDraft.website}
              placeholder="https://ornek.com"
              onChange={(website) => setOrgDraft({ ...orgDraft, website })}
              error={issueFor(mutation.error, "website")}
            />
            <TextField
              label="E-posta"
              type="email"
              value={orgDraft.email}
              onChange={(email) => setOrgDraft({ ...orgDraft, email })}
              error={issueFor(mutation.error, "email")}
            />
            <TextField
              label="Telefon"
              value={orgDraft.phone}
              onChange={(phone) => setOrgDraft({ ...orgDraft, phone })}
              error={issueFor(mutation.error, "phone")}
            />
          </div>
          <TextAreaField
            label="Notlar"
            rows={2}
            value={orgDraft.notes}
            onChange={(notes) => setOrgDraft({ ...orgDraft, notes })}
            error={issueFor(mutation.error, "notes")}
          />
        </FormPanel>
      ) : null}

      {panel.kind === "sponsorship" ? (
        <FormPanel
          title={`${panel.org.name} — sezonluk kayit`}
          error={mutation.error}
          saving={mutation.saving}
          onSubmit={submitSponsorship}
          onCancel={close}
        >
          <p className="small muted" style={{ margin: 0 }}>
            Her firma icin sezon basina tek kayit. Ayni firma 2026 sezonunda aday, 2027
            sezonunda sponsor olabilir; ikisi birbirinin uzerine yazmaz.
          </p>
          {!panel.sponsorshipId ? (
            <AsyncSection state={seasons}>
              {(data) => (
                <SelectField
                  label="Sezon"
                  value={sponsorshipDraft.seasonId}
                  placeholder="Aktif sezon"
                  options={data.items.map((season) => ({
                    value: season.id,
                    label: season.name,
                  }))}
                  onChange={(seasonId) => setSponsorshipDraft({ ...sponsorshipDraft, seasonId })}
                  error={issueFor(mutation.error, "seasonId")}
                />
              )}
            </AsyncSection>
          ) : null}
          <div className="row">
            <SelectField
              label="Durum"
              value={sponsorshipDraft.status}
              options={optionsFrom(sponsorshipStatusLabels)}
              onChange={(status) =>
                setSponsorshipDraft({ ...sponsorshipDraft, status: status as SponsorshipStatus })
              }
              error={issueFor(mutation.error, "status")}
            />
            <TextField
              label="Tutar"
              value={sponsorshipDraft.amount}
              inputMode="decimal"
              placeholder="25000.00"
              hint="Bos birakilabilir."
              onChange={(amount) => setSponsorshipDraft({ ...sponsorshipDraft, amount })}
              error={issueFor(mutation.error, "amount")}
            />
          </div>
          <TextAreaField
            label="Notlar"
            rows={2}
            value={sponsorshipDraft.notes}
            onChange={(notes) => setSponsorshipDraft({ ...sponsorshipDraft, notes })}
            error={issueFor(mutation.error, "notes")}
          />
        </FormPanel>
      ) : null}

      {panel.kind === "closed" && mutation.error ? <ErrorBox error={mutation.error} /> : null}

      <AsyncSection state={organizations}>
        {(data) => (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Firma</th>
                  <th>Iletisim</th>
                  <th>Sezonlara gore durum</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((organization) => (
                  <tr key={organization.id}>
                    <td>
                      <div>{organization.name}</div>
                      {organization.website ? (
                        <a
                          className="small muted"
                          href={organization.website}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {organization.website}
                        </a>
                      ) : null}
                    </td>
                    <td className="small muted">
                      <div>{organization.email ?? "—"}</div>
                      <div>{organization.phone ?? "—"}</div>
                    </td>
                    <td>
                      {organization.sponsorships.length === 0 ? (
                        <span className="muted">Kayit yok</span>
                      ) : (
                        <div className="stack-sm">
                          {organization.sponsorships.map((sponsorship) => (
                            <div key={sponsorship.id} className="row">
                              <span className="small">{sponsorship.season.name}</span>
                              <Badge tone={sponsorshipTone[sponsorship.status]}>
                                {sponsorshipStatusLabels[sponsorship.status]}
                              </Badge>
                              {sponsorship.amount ? (
                                <span className="small muted">
                                  {formatMoney(sponsorship.amount)}
                                </span>
                              ) : null}
                              {mayUpdate ? (
                                <button
                                  className="btn btn-sm"
                                  type="button"
                                  onClick={() => openSponsorship(organization, sponsorship)}
                                >
                                  Duzenle
                                </button>
                              ) : null}
                              {mayDelete ? (
                                <ConfirmButton
                                  question={`${sponsorship.season.name} kaydi silinsin mi?`}
                                  onConfirm={() => void removeSponsorship(sponsorship.id)}
                                >
                                  Sil
                                </ConfirmButton>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>
                      <RowActions>
                        {mayCreate ? (
                          <button
                            className="btn btn-sm"
                            type="button"
                            onClick={() => openSponsorship(organization)}
                          >
                            + Sezon
                          </button>
                        ) : null}
                        {mayUpdate ? (
                          <button
                            className="btn btn-sm"
                            type="button"
                            onClick={() => openOrg(organization)}
                          >
                            Duzenle
                          </button>
                        ) : null}
                        {mayDelete ? (
                          <ConfirmButton
                            question={`${organization.name} silinsin mi?`}
                            onConfirm={() => void removeOrg(organization.id)}
                          >
                            Sil
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
