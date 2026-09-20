"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console -- there is no error-reporting service wired up yet.
    console.error(error);
  }, [error]);

  return (
    <main className="login-shell">
      <div className="card login-card stack-sm">
        <div className="login-brand">
          <span className="brand-dot login-brand-dot" />
          <span>BreakPoint</span>
        </div>
        <h1 className="login-heading">Bir şeyler ters gitti</h1>
        <p className="muted" style={{ margin: 0 }}>
          Sayfa yüklenirken beklenmeyen bir hata oluştu. Tekrar denemek genelde sorunu çözer.
        </p>
        <button className="btn btn-primary" type="button" onClick={reset}>
          Tekrar dene
        </button>
      </div>
    </main>
  );
}
