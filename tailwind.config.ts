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
          gold: "#c27a0a",
          mist: "#faf9f6",
          clay: "#e6e4de",
          alert: "#c27a0a",
          danger: "#c84848",
        },
      },
      boxShadow: {
        panel: "0 3px 14px rgba(17,24,39,.05)",
        lift: "0 14px 34px rgba(17,24,39,.055)",
        focus: "0 0 0 3px rgba(14,159,115,.08)",
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
      },
      screens: {
        desk: "940px",
      },
    },
  },
  plugins: [],
} satisfies Config;
