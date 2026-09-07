// The value globalSetup hands to the test files: the URL of the throwaway
// database, or null when there was no server to build it on and the suite is
// being skipped.
declare module "vitest" {
  export interface ProvidedContext {
    integrationDatabaseUrl: string | null;
  }
}

export {};
