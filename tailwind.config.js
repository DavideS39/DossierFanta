/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Taccuino base palette (preview M1; full system arrives in M2)
        paper: "#F4ECD8",
        "paper-dim": "#E8DEC4",
        ink: "#2B1B12",
        "ink-soft": "#4A3A2E",
        red: "#8B2E1F",
        green: "#4A6741",
        amber: "#B8860B",
        blue: "#2C4A6B",
      },
      fontFamily: {
        // System serif for body (typewriter feel without external font deps in M1)
        body: ['"Courier Prime"', '"Courier New"', "ui-monospace", "monospace"],
        display: ['"Special Elite"', "Georgia", "serif"],
      },
      boxShadow: {
        card: "2px 3px 0 rgba(43, 27, 18, 0.15)",
        "card-hover": "3px 5px 0 rgba(43, 27, 18, 0.25)",
      },
    },
  },
  plugins: [],
};
