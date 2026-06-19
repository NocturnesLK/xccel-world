import { defineConfig } from 'vite';
import path from 'path';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/xccel-world/',
  publicDir: 'Resources',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    open: true,
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'inline',
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,jpg,jpeg}'],
      },
      manifest: {
        name: '加速世界 | Accelerated World',
        short_name: '加速世界',
        description: '加速世界 - 策略卡牌对战游戏',
        theme_color: '#0f1015',
        background_color: '#0f1015',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/xccel-world/',
        scope: '/xccel-world/',
        icons: [
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      }
    })
  ]
});
