import coreWebVitals from "eslint-config-next/core-web-vitals";

export default [
  {
    ignores: [".next/**", "node_modules/**", "data/**", "public/**"],
  },
  ...coreWebVitals,
  {
    // Skip eslint-plugin-react's filesystem version lookup on every run.
    settings: { react: { version: "19.2" } },
  },
];
