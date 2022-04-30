/**
 * @type {import('eslint').Linter.BaseConfig}
 */
module.exports = {
  extends: [
    "@remix-run/eslint-config",
    "@remix-run/eslint-config/node",
    "@remix-run/eslint-config/jest-testing-library",
    "plugin:react/recommended",
    "plugin:react/jsx-runtime",
    "prettier",
  ],
  rules: {
    "react/jsx-sort-props": ["error"],
  },
};
