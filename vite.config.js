import { defineConfig } from 'vite';

// Relative base so the build works on GitHub Pages under /<repo-name>/
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
});
