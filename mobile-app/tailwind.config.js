/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./App.tsx", "./components/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  darkMode: 'class', // Enables class-based toggling (needed for custom theme selections)
  theme: {
    extend: {
      colors: {
        youtube: '#ff0000',
      },
    },
  },
  plugins: [],
}
