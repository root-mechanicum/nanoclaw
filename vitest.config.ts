import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'skills-engine/**/*.test.ts'],
    // Fails the run if any test moved THIS repo's git index (dev-2h43mx).
    globalSetup: ['./vitest.global-setup.ts'],
  },
});
