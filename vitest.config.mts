import { defineConfig } from "vitest/config"

// Resolve the same "@/" alias Next resolves from tsconfig and compile JSX for tests (tsconfig
// keeps jsx: "preserve" for Next), so app components are importable in the suite.
export default defineConfig({
  oxc: {
    jsx: "react-jsx",
  },
  resolve: {
    tsconfigPaths: true,
  },
})
