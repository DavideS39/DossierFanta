/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Taccuino base palette (M2 design system completo)
        paper: "#F4ECD8",
        "paper-dim": "#E8DEC4",
        ink: "#2B1B12",
        "ink-soft": "#5A4632",
        red: "#8B2E1F",
        green: "#4A6741",
        amber: "#B8860B",
        blue: "#2C4A6B",
      },
      fontFamily: {
        // M2: Special Elite (titoli), Courier Prime (body), Cormorant (handnote)
        body: ['"Courier Prime"', '"Courier New"', "ui-monospace", "monospace"],
        display: ['"Special Elite"', "Georgia", "serif"],
        handnote: ['"Cormorant Garamond"', "Georgia", "serif"],
      },
      boxShadow: {
        card: "2px 3px 0 rgba(43, 27, 18, 0.15)",
        "card-hover": "3px 5px 0 rgba(43, 27, 18, 0.25)",
      },
    },
  },
  plugins: [],
};
