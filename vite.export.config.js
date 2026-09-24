import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react()], build: { outDir: "dist/export", emptyOutDir: true, lib: { entry: "src/export.tsx", name: "AgentAtlasExport", formats: ["iife"], fileName: "agent-atlas-export" } } });
