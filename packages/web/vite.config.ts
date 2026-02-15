import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/uploads": {
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
