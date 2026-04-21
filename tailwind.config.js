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
          bg: '#ffffff',
          panel: '#fbfbfa',
          border: '#e9e9e7',
          text: '#37352f',
          muted: '#787774',
          accent: '#2383e2',
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
