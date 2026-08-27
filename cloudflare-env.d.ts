declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    FILES: R2Bucket;
    OCR_ENDPOINT?: string;
    OCR_TOKEN?: string;
    DEWU_SYNC_ENDPOINT?: string;
    DEWU_APP_KEY?: string;
    DEWU_APP_SECRET?: string;
  }
}
