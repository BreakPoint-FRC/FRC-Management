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
 * Two entries, one screen.
 *
 * An account on a generated password lands here and can do nothing else --
 * the API refuses every route but /auth/me, /auth/password and /auth/logout
 * while `mustChangePassword` is set, so this is not a courtesy screen -- the
 * dashboard behind it would be a page of 403s. A temporary password was typed
 * by an administrator and read off a screen; it is a way in, not a credential.
 *
 * The account menu's "Şifre değiştir" reaches the same screen voluntarily,
 * for anyone already past that: the endpoint underneath (/auth/password) has
 * no mustChangePassword requirement of its own, so the only difference is
 * what happens after -- a forced reset has nowhere to cancel into but signing
 * out, a voluntary one just goes back to the dashboard.
 *
 * Deliberately outside the (dashboard) route group: that layout redirects here
 * while mustChangePassword is set, and a screen inside it would redirect to
 * itself.
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
  }, [status, router]);

  if (status !== "authenticated") return <Loading />;

  const forced = !!account?.mustChangePassword;

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
      <PageHeader title={forced ? "Şifrenizi belirleyin" : "Şifre değiştir"} />

      {forced ? (
        <p className="muted">
          Hesabınız yöneticinin verdiği geçici bir şifreyle açıldı. Devam etmek için kendi
          şifrenizi belirlemelisiniz.
        </p>
      ) : (
        <p className="muted">Şifreniz değiştirildikten sonra tüm oturumlarınız kapanır.</p>
      )}

      <FormPanel
        title="Yeni şifre"
        error={mutation.error}
        saving={mutation.saving}
        onSubmit={submit}
        // A forced reset has nowhere to cancel into but signing out -- this is
        // the only route the account can reach. A voluntary visit just goes
        // back to the dashboard.
        onCancel={forced ? () => void signOut() : () => router.push("/")}
        submitLabel="Şifreyi değiştir"
      >
        <TextField
          label={forced ? "Geçici şifre" : "Mevcut şifre"}
          type="password"
          value={currentPassword}
          required
          onChange={setCurrentPassword}
          error={issueFor(mutation.error, "currentPassword")}
        />
        <TextField
          label="Yeni şifre"
          type="password"
          value={newPassword}
          required
          hint="En az 10 karakter."
          onChange={setNewPassword}
          error={issueFor(mutation.error, "newPassword")}
        />
        <TextField
          label="Yeni şifre (tekrar)"
          type="password"
          value={confirmation}
          required
          onChange={setConfirmation}
          error={mismatch ? "Şifreler eşleşmiyor." : undefined}
        />
      </FormPanel>
    </main>
  );
}
