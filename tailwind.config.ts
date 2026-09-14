import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        raf: {
          ink: "var(--text-strong)",
          moss: "var(--primary-color)",
          sage: "var(--primary-soft)",
          gold: "#b6832f",
          mist: "#f3f1eb",
          clay: "#e7ddd0",
          alert: "#b45309",
          danger: "#b91c1c",
        },
      },
      boxShadow: {
        panel: "var(--shadow-panel)",
        lift: "var(--shadow-lift)",
        focus: "var(--shadow-focus)",
      },
      fontFamily: {
        sans: ["var(--font-family)"],
        display: ["var(--font-display)"],
      },
    },
  },
  plugins: [],
} satisfies Config;
