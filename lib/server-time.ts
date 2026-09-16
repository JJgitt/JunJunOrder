import "server-only";
import type { ServerClock } from "./time";

/** The application server's runtime timezone is authoritative, never the browser's. */
export function serverClock(): ServerClock {
  return { now: new Date().toISOString(), timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone };
}
