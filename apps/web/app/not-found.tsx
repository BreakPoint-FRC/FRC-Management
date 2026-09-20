import Link from "next/link";

export default function NotFound() {
  return (
    <main className="login-shell">
      <div className="card login-card stack-sm">
        <div className="login-brand">
          <span className="brand-dot login-brand-dot" />
          <span>BreakPoint</span>
        </div>
        <h1 className="login-heading">Sayfa bulunamadı</h1>
        <p className="muted" style={{ margin: 0 }}>
          Aradığınız sayfa taşınmış veya hiç var olmamış olabilir.
        </p>
        <Link className="btn btn-primary" href="/">
          Ana sayfaya dön
        </Link>
      </div>
    </main>
  );
}
