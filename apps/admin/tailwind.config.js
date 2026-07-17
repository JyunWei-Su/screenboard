/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f0f9fb",
          100: "#d9eff4",
          200: "#b3dfe9",
          300: "#7fc6d6",
          400: "#47a6bd",
          500: "#2d7d9a",
          600: "#256a84",
          700: "#1e566b",
          800: "#1b4757",
          900: "#183b49",
        },
        // Soft dark-gray palette (not pure black), tuned for readable contrast.
        dark: {
          bg: "#1e222a", // page background
          surface: "#272c36", // cards, sidebar, header (raised above bg)
          raised: "#313743", // inputs, hover, table header
          border: "#3b4250",
          text: "#e6e9ef", // primary text
          muted: "#a5adbb", // secondary text
          subtle: "#838c9b", // tertiary text
        },
      },
      boxShadow: {
        card: "0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-in": {
          from: { transform: "translateY(4px)", opacity: "0" },
          to: { transform: "translateY(0)", opacity: "1" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.2s ease-out",
        "slide-in": "slide-in 0.2s ease-out",
      },
    },
  },
  plugins: [],
};
