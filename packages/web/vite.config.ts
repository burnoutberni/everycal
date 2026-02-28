import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import vike from "vike/plugin";

const runningInProcessVite = process.env.EVERYCAL_IN_PROCESS_VITE === "1";

export default defineConfig({
  plugins: [react(), vike()],
  server: {
    port: 5173,
    proxy: runningInProcessVite
      ? undefined
      : {
          "/api": {
            target: "http://localhost:3000",
            changeOrigin: true,
          },
          "/uploads": {
            target: "http://localhost:3000",
            changeOrigin: true,
          },
          "/og-images": {
            target: "http://localhost:3000",
            changeOrigin: true,
          },
          // Proxy well-known and ActivityPub routes for dev
          "/.well-known": {
            target: "http://localhost:3000",
            changeOrigin: true,
          },
        },
  },
});
