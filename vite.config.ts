import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
    // brawl.html は 3Dアクション版の試作（夜明けの乱闘）
    rollupOptions: { input: { main: 'index.html', brawl: 'brawl.html' } },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
