/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef6ff",
          500: "#2d7d9a",
          600: "#256a84",
          700: "#1e566b",
        },
      },
    },
  },
  plugins: [],
};
