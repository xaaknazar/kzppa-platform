import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Шрифты документов читаются с диска в серверных функциях (PDF/DOCX).
  outputFileTracingIncludes: {
    "/**": ["./src/server/docs/fonts/**/*", "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", "./node_modules/pdfjs-dist/standard_fonts/**/*"],
  },
  serverExternalPackages: ["pdfjs-dist", "postgres"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
