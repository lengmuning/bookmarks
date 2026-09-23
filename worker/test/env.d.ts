type WorkerEnv = Env;

declare namespace Cloudflare {
  interface Env extends WorkerEnv {}
  interface Exports {
    default: Fetcher;
  }
}
