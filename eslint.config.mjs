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
  {
    // eslint-plugin-react-hooks 7.1 promoted its React Compiler diagnostics
    // to errors. This project doesn't use React Compiler, and the patterns
    // they flag (setState in effects, helpers used before declaration) are
    // long-standing and work fine, so keep them visible as warnings instead
    // of failing the build.
    rules: {
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
    },
  },
];
