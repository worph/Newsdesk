import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['{shared,server}/test/**/*.test.ts'],
    environment: 'node',
  },
})
