"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useAuth } from "@/components/auth/auth-provider";
import { Loading, PageHeader } from "@/components/ui";
import { FormPanel, TextField } from "@/components/ui/form";
import { useMutation } from "@/hooks/use-mutation";
import { apiClient } from "@/lib/api-client";
import { issueFor } from "@/lib/issues";

/**
 * Where an account on a generated password lands, and the only thing it can do.
 *
 * The API refuses every route but /auth/me, /auth/password and /auth/logout
 * while `mustChangePassword` is set, so this is not a courtesy screen -- the
 * dashboard behind it would be a page of 403s. A temporary password was typed
 * by an administrator and read off a screen; it is a way in, not a credential.
 *
 * Deliberately outside the (dashboard) route group: that layout redirects here,
 * and a screen inside it would redirect to itself.
 */
export default function ChangePasswordPage() {
  const { status, account, signOut } = useAuth();
  const router = useRouter();
  const mutation = useMutation();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");

  useEffect(() => {
    if (status === "anonymous") router.replace("/login");
    // Someone who reaches this by typing the URL has nothing to do here.
    else if (status === "authenticated" && !account?.mustChangePassword) router.replace("/");
  }, [status, account?.mustChangePassword, router]);

  if (status !== "authenticated") return <Loading />;

  const mismatch = confirmation.length > 0 && confirmation !== newPassword;

  async function submit() {
    if (mismatch) return;

    const ok = await mutation.run(() =>
      apiClient.post("/auth/password", { currentPassword, newPassword })
    );
    if (!ok) return;

    // Changing the password revokes every session, this one included, so there
    // is nothing to refresh into -- sign in again with the new one.
    await signOut().catch(() => undefined);
    router.replace("/login");
  }

  return (
    <main className="content" style={{ maxWidth: 480, margin: "0 auto" }}>
      <PageHeader title="Sifrenizi belirleyin" />

      <p className="muted">
        Hesabiniz yoneticinin verdigi gecici bir sifreyle acildi. Devam etmek icin kendi
        sifrenizi belirlemelisiniz.
      </p>

      <FormPanel
        title="Yeni sifre"
        error={mutation.error}
        saving={mutation.saving}
        onSubmit={submit}
        // Nothing to cancel into: this screen is the only route the account can
        // reach, so the way out is forward or a sign-out.
        onCancel={() => void signOut()}
        submitLabel="Sifreyi degistir"
      >
        <TextField
          label="Gecici sifre"
          type="password"
          value={currentPassword}
          required
          onChange={setCurrentPassword}
          error={issueFor(mutation.error, "currentPassword")}
        />
        <TextField
          label="Yeni sifre"
          type="password"
          value={newPassword}
          required
          hint="En az 10 karakter."
          onChange={setNewPassword}
          error={issueFor(mutation.error, "newPassword")}
        />
        <TextField
          label="Yeni sifre (tekrar)"
          type="password"
          value={confirmation}
          required
          onChange={setConfirmation}
          error={mismatch ? "Sifreler eslesmiyor." : undefined}
        />
      </FormPanel>
    </main>
  );
}
