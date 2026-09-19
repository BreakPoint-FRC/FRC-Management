"use client";

import { useRef, useState } from "react";

import { Badge, ErrorBox } from "@/components/ui";
import { useUnsavedChanges } from "@/components/unsaved-changes";
import { useMutation } from "@/hooks/use-mutation";
import { apiClient } from "@/lib/api-client";
import type {
  BulkImportCommitResult,
  BulkImportPreviewResult,
  BulkImportRowResult,
  GroupTreeRow,
  RoleRow,
} from "@/lib/api-types";
import {
  RoleAssignmentRows,
  roleAssignmentPayload,
  type RoleAssignmentDraft,
} from "./role-assignment-rows";

const ROW_STATUS: Record<BulkImportRowResult["status"], { label: string; tone: "ok" | "warn" | "danger" }> = {
  ok: { label: "Hazır", tone: "ok" },
  invalid: { label: "Hatalı", tone: "danger" },
  duplicate_in_file: { label: "Dosyada yinelenen", tone: "warn" },
  duplicate_in_db: { label: "Zaten kayıtlı", tone: "warn" },
};

function downloadCredentials(rows: Array<{ fullName: string; email: string; temporaryPassword: string }>) {
  const header = "fullName,email,temporaryPassword";
  const lines = rows.map((row) => {
    // Only fullName can plausibly contain a comma; email and the generated
    // password never do.
    const name = row.fullName.includes(",") ? `"${row.fullName.replace(/"/g, '""')}"` : row.fullName;
    return `${name},${row.email},${row.temporaryPassword}`;
  });
  const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "gecici-sifreler.csv";
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * CSV account import: paste or upload, preview, pick the roles everyone in
 * the batch gets, confirm.
 *
 * Shared by the Hesaplar screen and the setup wizard's ACCOUNTS step -- the
 * same 60-person bottleneck exists in both places, so the editor is written
 * once. The two stages are two API calls, not one: /preview never writes, and
 * /commit re-validates the same CSV itself rather than trusting that an
 * earlier preview still holds. If the row list a commit refuses is identical
 * in shape to what preview would have said, it is shown here exactly the same
 * way -- "yellow file" gets rejected the same way twice, not once as an error
 * banner and once as a table.
 */
export function BulkImportPanel({
  roles,
  groups,
  onImported,
}: {
  roles: readonly RoleRow[];
  groups: readonly GroupTreeRow[];
  onImported: () => void;
}) {
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<BulkImportPreviewResult | null>(null);
  const [roleDrafts, setRoleDrafts] = useState<RoleAssignmentDraft[]>([]);
  const [result, setResult] = useState<Extract<BulkImportCommitResult, { committed: true }> | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const previewMutation = useMutation();
  const commitMutation = useMutation();
  const fileInput = useRef<HTMLInputElement>(null);

  // The one moment these passwords exist anywhere is this screen. Leaving it
  // unacknowledged -- a stray nav click, an accidental reload -- must not be
  // silent, the same contract every other editor with something to lose
  // keeps.
  const guard = useUnsavedChanges({
    dirty: result !== null && !acknowledged,
    saving: false,
    discard: () => {
      setResult(null);
      setAcknowledged(false);
    },
  });

  async function readFile(file: File) {
    const text = await file.text();
    setCsv(text);
    setPreview(null);
  }

  async function runPreview() {
    const response = await previewMutation.runFor<BulkImportPreviewResult>(() =>
      apiClient.post("/accounts/bulk-import/preview", { csv })
    );
    if (response) setPreview(response);
  }

  async function runCommit() {
    const response = await commitMutation.runFor<BulkImportCommitResult>(() =>
      apiClient.post("/accounts/bulk-import/commit", {
        csv,
        roles: roleAssignmentPayload(roleDrafts),
      })
    );
    if (!response) return;

    if (!response.committed) {
      // The batch changed since the last preview -- show exactly what is
      // different now instead of a bare error, and let the same "Onayla ve
      // oluştur" button try again once it is fixed.
      setPreview(response);
      return;
    }

    setResult(response);
    setAcknowledged(false);
    setCsv("");
    setPreview(null);
    setRoleDrafts([]);
    onImported();
  }

  function closeResult() {
    guard.requestLeave(() => {
      setResult(null);
      setAcknowledged(false);
    });
  }

  if (result) {
    return (
      <div className="card stack-sm">
        <p className="card-title" style={{ margin: 0 }}>
          {result.created.length} hesap oluşturuldu — geçici şifreler
        </p>
        <p className="small muted" style={{ margin: 0 }}>
          Bu şifreler yalnızca burada ve yalnızca bir kez gösteriliyor. Listeyi indirin veya kopyalayın
          -- kapattıktan sonra hiçbir yerden tekrar alınamaz. Hesaplar ilk girişte kendi şifrelerini
          belirlemeden başka hiçbir şey yapamaz.
        </p>

        <div className="table-wrap table-responsive-wrap">
          <table className="table table-responsive">
            <thead>
              <tr>
                <th>Ad soyad</th>
                <th>E-posta</th>
                <th>Geçici şifre</th>
              </tr>
            </thead>
            <tbody>
              {result.created.map((row) => (
                <tr key={row.id}>
                  <td data-label="Ad soyad">{row.fullName}</td>
                  <td className="muted" data-label="E-posta">
                    {row.email}
                  </td>
                  <td data-label="Geçici şifre">
                    <code style={{ fontSize: "1.05em", letterSpacing: "0.04em" }}>
                      {row.temporaryPassword}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <button
          className="btn btn-sm"
          type="button"
          onClick={() => downloadCredentials(result.created)}
        >
          Listeyi indir
        </button>

        <label className="row small" style={{ gap: 6 }}>
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          Bu şifreleri kaydettim veya ilgili kişilere iletmek üzere aldım.
        </label>

        <div className="row">
          <button className="btn btn-primary btn-sm" type="button" disabled={!acknowledged} onClick={closeResult}>
            Kapat
          </button>
        </div>
      </div>
    );
  }

  const rows = preview?.rows ?? [];
  const readyCount = rows.filter((row) => row.status === "ok").length;
  const canCommit = preview?.valid === true && !commitMutation.saving;

  return (
    <div className="card stack-sm">
      <p className="card-title" style={{ margin: 0 }}>
        CSV ile toplu hesap ekle
      </p>
      <p className="small muted" style={{ margin: 0 }}>
        Dosya yalnızca <code>fullName</code> ve <code>email</code> sütunlarını içermeli, en fazla 250
        satır. Şifreler sunucu tarafında üretilir ve yalnızca oluşturma sonucunda bir kez gösterilir.
      </p>
      <pre
        className="small muted"
        style={{ margin: 0, background: "var(--surface-2)", padding: 8, borderRadius: "var(--radius)" }}
      >
        {"fullName,email\nAda Yılmaz,ada@example.com\nKerem Kaya,kerem@example.com"}
      </pre>

      <div className="row">
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void readFile(file);
            event.target.value = "";
          }}
        />
      </div>

      <textarea
        rows={6}
        value={csv}
        placeholder="fullName,email"
        onChange={(event) => {
          setCsv(event.target.value);
          setPreview(null);
        }}
      />

      {previewMutation.error ? <ErrorBox error={previewMutation.error} /> : null}
      {commitMutation.error ? <ErrorBox error={commitMutation.error} /> : null}

      <div className="row">
        <button
          className="btn btn-sm"
          type="button"
          disabled={csv.trim().length === 0 || previewMutation.saving}
          onClick={() => void runPreview()}
        >
          {previewMutation.saving ? "Kontrol ediliyor..." : "Önizle"}
        </button>
      </div>

      {preview ? (
        preview.fileError ? (
          <p className="field-error">{preview.fileError}</p>
        ) : (
          <div className="stack-sm">
            <p className="small muted" style={{ margin: 0 }}>
              {readyCount} / {rows.length} satır hazır
              {readyCount < rows.length ? " -- düzeltmeden onaylanamaz." : "."}
            </p>
            <div className="table-wrap table-responsive-wrap">
              <table className="table table-responsive">
                <thead>
                  <tr>
                    <th>Satır</th>
                    <th>Ad soyad</th>
                    <th>E-posta</th>
                    <th>Durum</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.line}>
                      <td data-label="Satır">{row.line}</td>
                      <td data-label="Ad soyad">{row.fullName || <span className="muted">—</span>}</td>
                      <td className="muted" data-label="E-posta">
                        {row.email || "—"}
                      </td>
                      <td data-label="Durum">
                        <Badge tone={ROW_STATUS[row.status].tone}>{ROW_STATUS[row.status].label}</Badge>
                        {row.issues.length > 0 ? (
                          <div className="small muted">{row.issues.join(", ")}</div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      ) : null}

      <div className="field">
        <label>Roller (tüm hesaplara uygulanır)</label>
        <p className="small muted" style={{ margin: "0 0 6px" }}>
          Boş bırakılırsa hesaplar rolsüz oluşturulur ve sonradan tek tek atanabilir.
        </p>
        <RoleAssignmentRows
          value={roleDrafts}
          onChange={setRoleDrafts}
          roles={roles}
          groups={groups}
          error={commitMutation.error}
        />
      </div>

      <div className="row">
        <button
          className="btn btn-primary btn-sm"
          type="button"
          disabled={!canCommit}
          onClick={() => void runCommit()}
        >
          {commitMutation.saving ? "Oluşturuluyor..." : "Onayla ve oluştur"}
        </button>
      </div>
    </div>
  );
}
