// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['node_modules/**', 'android/**', 'ios/**', '.expo/**'],
  },
  {
    rules: {
      // Reanimated's shared values are mutated by design (`sv.value = …` is the
      // documented API) — the compiler-era immutability rule can't know that.
      'react-hooks/immutability': 'off',
      // Compiler-era strictness downgraded to warnings: these flag common,
      // working pre-compiler idioms (loader state synced in a param-change
      // effect, latest-callback refs, Date.now() in render). Clean up over
      // time; don't fail the lint gate on them today.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
    },
  },
]);
