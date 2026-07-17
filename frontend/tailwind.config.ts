import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        terminal: {
          bg: "#0b0f14",
          panel: "#121820",
          border: "#1e2731",
          muted: "#7c8896",
          text: "#d7dee6",
        },
        // Data-kind semantic colours (observed vs estimated must be distinct).
        kind: {
          observed: "#38bdf8",
          forecast: "#a78bfa",
          estimated: "#f59e0b",
          assumption: "#f472b6",
          synthetic: "#64748b",
        },
        action: {
          charge: "#22c55e",
          discharge: "#ef4444",
          idle: "#64748b",
          reserveup: "#eab308",
          reservedown: "#0ea5e9",
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
