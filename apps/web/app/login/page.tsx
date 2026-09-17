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
        cause instanceof ApiError ? cause : new ApiError(0, "Beklenmeyen bir hata oluştu")
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <form className="card login-card stack-sm" onSubmit={onSubmit}>
        <div className="login-brand">
          <span className="brand-dot login-brand-dot" />
          <span>BreakPoint</span>
        </div>

        <h1 className="login-heading">Giriş yap</h1>

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
          <label htmlFor="password">Şifre</label>
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
          {submitting ? "Giriliyor..." : "Giriş yap"}
        </button>

        {/* Dead code in a production build -- Next replaces process.env.NODE_ENV
            statically and strips the branch, so the seed password never ships.
            Only useful to someone running the seeded dev database locally. */}
        {process.env.NODE_ENV !== "production" ? (
          <p className="small muted" style={{ margin: 0 }}>
            Örnek veri şifresi: <code>Breakpoint2026!</code> — sistem yöneticisi için{" "}
            <code>ada@breakpoint.test</code>, alt takım lideri için{" "}
            <code>kerem@breakpoint.test</code>, üye için <code>emre@breakpoint.test</code>.
            Üçü de farklı şeyler görür.
          </p>
        ) : null}
      </form>
    </main>
  );
}
