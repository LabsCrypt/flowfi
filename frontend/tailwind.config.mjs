import { type Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

export default {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx}",
    "./src/components/**/*.{js,ts,jsx,tsx}",
  ],
  plugins: [
    plugin(function ({ addVariant }) {
      addVariant("motion-reduce", [ "& where (prefers-reduced-motion: reduce)" ]);
      addVariant("motion-safe", [ "& where (prefers-reduced-motion: safe)" ]);
    }),
  ],
} satisfies Config;