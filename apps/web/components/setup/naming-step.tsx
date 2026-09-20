"use client";

import { useState } from "react";

import { FormPanel, TextField } from "@/components/ui/form";
import { useMutation } from "@/hooks/use-mutation";
import { apiClient } from "@/lib/api-client";
import { issueFor } from "@/lib/issues";

/**
 * The step that names the team and opens its first season.
 *
 * The name is asked for here rather than when the team was created because the
 * groups in step one already needed a teamId to hang from -- the row had to
 * exist before there was a considered answer to what it is called. A system
 * admin types a draft; this replaces it.
 *
 * The season is asked for with it because every operational record hangs off
 * one. Without a season the team would finish the wizard and land on a
 * dashboard where no task, meeting or transaction can be created, and the error
 * would read as a bug rather than a missing step.
 *
 * Saving again renames rather than adding a second season: correcting a typo is
 * the common case, and two seasons would both claim to be the first.
 */
export function NamingStep({ team }: { team: { name: string } }) {
  const mutation = useMutation();
  const thisYear = new Date().getFullYear();

  const [name, setName] = useState(team.name);
  const [seasonName, setSeasonName] = useState(`${thisYear} Sezonu`);
  const [seasonStartDate, setSeasonStartDate] = useState(`${thisYear}-01-01`);
  const [seasonEndDate, setSeasonEndDate] = useState(`${thisYear}-12-31`);
  const [saved, setSaved] = useState(false);

  async function submit() {
    const ok = await mutation.run(() =>
      apiClient.put("/setup/naming", {
        name,
        seasonName,
        seasonStartDate,
        seasonEndDate,
      })
    );
    setSaved(ok);
  }

  return (
    <FormPanel
      title="Takım ve sezon"
      error={mutation.error}
      saving={mutation.saving}
      submitLabel={saved ? "Kaydedildi — tekrar kaydet" : "Kaydet"}
      onSubmit={submit}
      onCancel={() => setSaved(false)}
    >
      <TextField
        label="Takım adı"
        value={name}
        required
        onChange={setName}
        error={issueFor(mutation.error, "name")}
      />
      <TextField
        label="Sezon adı"
        value={seasonName}
        required
        hint="Görevler, toplantılar ve finans kayıtları bu sezona bağlanır."
        onChange={setSeasonName}
        error={issueFor(mutation.error, "seasonName")}
      />
      <TextField
        label="Sezon başlangıcı"
        type="date"
        value={seasonStartDate}
        required
        onChange={setSeasonStartDate}
        error={issueFor(mutation.error, "seasonStartDate")}
      />
      <TextField
        label="Sezon bitişi"
        type="date"
        value={seasonEndDate}
        required
        onChange={setSeasonEndDate}
        error={issueFor(mutation.error, "seasonEndDate")}
      />
    </FormPanel>
  );
}
