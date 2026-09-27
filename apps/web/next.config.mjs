/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Nothing here terminates TLS or sits behind a reverse proxy that
          // adds these on its own (see docs/deployment.md) -- an admin page
          // (role changes, credential downloads, bulk delete) embedded in an
          // attacker's invisible iframe is a classic way to turn a real click
          // into a privileged action the victim never meant to take. Both
          // headers say the same thing in the two forms browsers respect.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
