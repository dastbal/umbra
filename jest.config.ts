import type { Config } from "jest";

const config: Config = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  // Busca archivos que terminen en .spec.ts
  testRegex: ".*\\.spec\\.ts$",

  // 1. Usamos ts-jest para procesar archivos .ts y .js
  transform: {
    "^.+\\.(t|j)s$": ["ts-jest", { diagnostics: false }],
  },

  // 2. 🔥 EL PARCHE PARA EL ERROR DE UUID
  // Por defecto, Jest ignora todo lo que está en node_modules.
  // Aquí le decimos: "Ignora node_modules, PERO procesa (transforma) uuid, ts-morph y langchain"
  // Esto obliga a Jest a transpilar el código ESM de esas librerías a CommonJS.
  transformIgnorePatterns: [
    "/node_modules/(?!(uuid|ts-morph|@langchain|langchain|deepagents)/)",
  ],

  collectCoverageFrom: ["**/*.(t|j)s"],
  coverageDirectory: "./coverage",
  testEnvironment: "node",

  // Opcional: Aumenta el timeout si tus tests son lentos
  testTimeout: 10000,
};

export default config;
