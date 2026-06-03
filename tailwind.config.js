/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./web/index.html", "./web/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', '"Noto Sans SC"', "-apple-system", '"PingFang SC"', '"Microsoft YaHei"', "sans-serif"],
      },
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        border: "hsl(var(--border))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        ring: "hsl(var(--ring))",
        brand: {
          DEFAULT: "hsl(var(--primary))",
          dark: "hsl(var(--brand-primary-dark))",
          gold: "hsl(var(--brand-gold))",
          orange: "hsl(var(--brand-orange))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      boxShadow: {
        card: "0 30px 60px -15px rgba(0,40,175,.30)",
      },
    },
  },
  plugins: [],
};
