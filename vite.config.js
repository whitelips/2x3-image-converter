import { defineConfig } from "vite";

export default defineConfig({
  base: "/2x3-image-converter/",
  optimizeDeps: { exclude: ["@jsquash/webp"] },
  worker: { format: "es" },
});
