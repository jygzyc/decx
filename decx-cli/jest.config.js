/** @type {import('ts-jest').JestConfigWithTsJson} */
export default {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.ts"],
  globalSetup: "<rootDir>/tests/global-setup.js",
  setupFiles: ["<rootDir>/tests/setup.ts"],
  modulePathIgnorePatterns: ["<rootDir>/dist/"],
  transform: {
    "^.+\\.ts$": ["ts-jest", {
      useESM: true,
      tsconfig: "tsconfig.test.json",
    }],
  },
  extensionsToTreatAsEsm: [".ts"],
  transformIgnorePatterns: [
    "node_modules/(?!(commander|picocolors|jest-mock|expect|@jest|ts-jest)/)",
  ],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
};
