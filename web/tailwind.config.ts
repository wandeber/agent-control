import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: {
          50: "#f7f8fa",
          100: "#eef1f4",
          200: "#dde3e8",
          900: "#15191d"
        },
        ink: {
          50: "#f8fafc",
          300: "#8a949f",
          500: "#5b6570",
          700: "#30363d",
          900: "#15191d"
        },
        signal: {
          teal: "#14b8a6",
          amber: "#f59e0b",
          lime: "#84cc16",
          coral: "#fb6b5f",
          blue: "#3b82f6"
        }
      },
      boxShadow: {
        hairline: "0 0 0 1px rgba(21, 25, 29, 0.06)",
        panel: "0 18px 55px rgba(22, 27, 34, 0.08)",
        node: "0 16px 36px rgba(22, 27, 34, 0.12)"
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif"
        ],
        mono: ["SFMono-Regular", "ui-monospace", "Menlo", "Monaco", "Consolas", "monospace"]
      }
    }
  },
  plugins: []
};

export default config;
