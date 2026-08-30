"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { useAuth } from "@/components/auth/auth-provider";
import { ApiError } from "@/lib/api-client";
import { ErrorBox, Loading } from "@/components/ui";

export default function LoginPage() {
  const { status, signIn } = useAuth();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Someone who is already signed in has no business on this page -- most
  // often it is a bookmark, or a back button after signing in.
  useEffect(() => {
    if (status === "authenticated") router.replace("/");
  }, [status, router]);

  if (status === "loading") return <Loading />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await signIn(email, password);
      router.replace("/");
    } catch (cause) {
      // The API answers a bad login with a Turkish sentence, and deliberately
      // the same one for an unknown address and a wrong password. Showing it
      // verbatim is both more useful and no more revealing.
      setError(
        cause instanceof ApiError ? cause : new ApiError(0, "Beklenmeyen bir hata olustu")
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <form className="card login-card stack-sm" onSubmit={onSubmit}>
        <div className="brand" style={{ marginBottom: 8 }}>
          <span className="brand-dot" />
          <span>BreakPoint</span>
        </div>

        <h1 style={{ fontSize: 16 }}>Giris yap</h1>

        {error ? <ErrorBox error={error} /> : null}

        <div className="field">
          <label htmlFor="email">E-posta</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="password">Sifre</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <button className="btn btn-primary" type="submit" disabled={submitting}>
          {submitting ? "Giriliyor..." : "Giris yap"}
        </button>

        <p className="small muted" style={{ margin: 0 }}>
          Ornek veri sifresi: <code>Breakpoint2026!</code> — sistem yoneticisi icin{" "}
          <code>ada@breakpoint.test</code>, alt takim lideri icin{" "}
          <code>kerem@breakpoint.test</code>, uye icin <code>emre@breakpoint.test</code>.
          Ucu de farkli seyler gorur.
        </p>
      </form>
    </main>
  );
}
