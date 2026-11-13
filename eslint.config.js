import js from '@eslint/js'
import globals from 'globals'

export default [
  { ignores: ['node_modules/', 'data/'] },
  { files: ['scripts/e2e.mjs', 'scripts/e2e-workboard.mjs'], languageOptions: { globals: { ...globals.browser } } },
  js.configs.recommended,
  {
    files: ['server/**/*.js', 'test/**/*.js', 'scripts/**/*.{js,mjs}', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }] }
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser } },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }] }
  }
]
