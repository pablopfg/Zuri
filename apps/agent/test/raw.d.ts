declare module "*?raw" {
  const text: string;
  export default text;
}

// Vite's import.meta.glob, which the tests use to read the Worker's sources.
interface ImportMeta {
  glob<T = unknown>(pattern: string, options: { query: "?raw"; import: "default"; eager: true }): Record<string, T>;
}
