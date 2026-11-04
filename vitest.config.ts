import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // .diorama/ holds local worlds and experiments (gitignored); their own tests are not the project's.
    exclude: [...configDefaults.exclude, '.diorama/**'],
    setupFiles: ['app/test/setup.ts'],
  },
});
