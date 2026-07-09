import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves project sites from /<repo-name>/ — keep this in sync
// with the actual repo name if you ever rename it.
export default defineConfig({
  plugins: [react()],
  base: "/TemuDashboard/",
});
