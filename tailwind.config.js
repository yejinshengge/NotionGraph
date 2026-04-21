/** @type {import('tailwindcss').Config} */
export default {
  // 覆盖全部需要样式的入口文件
  content: [
    './src/**/*.{ts,tsx,html}',
  ],
  theme: {
    extend: {
      colors: {
        notion: {
          bg: '#1e1e1e',
          panel: '#252526',
          border: '#3c3c3c',
          text: '#d4d4d4',
          muted: '#888888',
          accent: '#a882ff',
        },
      },
      fontFamily: {
        notion: [
          'ui-sans-serif',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Helvetica',
          '"Apple Color Emoji"',
          'Arial',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
};
