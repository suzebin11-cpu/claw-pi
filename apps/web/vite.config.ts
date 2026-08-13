import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

process.env.VITE_COMMIT_HASH ??= "local-dev";

const configDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(configDir, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api/auth/get-session": {
        target: "http://localhost:3010",
        bypass(_req, res) {
          const body = JSON.stringify({
            session: {
              id: "desktop-local-session",
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
            user: {
              id: "desktop-local-user",
              email: "desktop@local",
              name: "Desktop User",
              image: null,
            },
          });
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body).toString(),
          });
          res.end(body);
        },
      },
      "/v1": "http://localhost:3010",
      "/api": "http://localhost:3010",
      "/openapi.json": "http://localhost:3010",
    },
  },
});
