"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { formatDateTime, type ServerClock } from "@/lib/time";

type ClockValue = { now: number; timeZone: string; dateTime: (value?: string) => string };
const ClockContext = createContext<ClockValue>({ now: 0, timeZone: "UTC", dateTime: () => "未记录" });

export function ServerClockProvider({ initial, children }: { initial: ServerClock; children: React.ReactNode }) {
  const [clock, setClock] = useState(initial);
  useEffect(() => {
    let active = true;
    let sequence = 0;
    let anchor = { now: Date.parse(initial.now), monotonic: performance.now(), timeZone: initial.timeZone };
    const publish = () => setClock({ now: new Date(anchor.now + performance.now() - anchor.monotonic).toISOString(), timeZone: anchor.timeZone });
    const sync = async () => {
      const request = ++sequence;
      try {
        const response = await fetch("/api/time", { cache: "no-store" });
        if (!response.ok) return;
        const next = await response.json() as ServerClock;
        if (!active || request !== sequence || typeof next.timeZone !== "string" || !next.timeZone || !Number.isFinite(Date.parse(next.now))) return;
        new Intl.DateTimeFormat("en", { timeZone: next.timeZone });
        anchor = { now: Date.parse(next.now), monotonic: performance.now(), timeZone: next.timeZone };
        publish();
      } catch { /* Keep the last server anchor while temporarily offline. */ }
    };
    const tick = window.setInterval(publish, 15000);
    const refresh = window.setInterval(sync, 60000);
    const visible = () => { if (document.visibilityState === "visible") void sync(); };
    document.addEventListener("visibilitychange", visible);
    void sync();
    return () => { active = false; clearInterval(tick); clearInterval(refresh); document.removeEventListener("visibilitychange", visible); };
  }, [initial]);
  return <ClockContext.Provider value={{ now: Date.parse(clock.now), timeZone: clock.timeZone, dateTime: value => formatDateTime(value, clock.timeZone) }}>{children}</ClockContext.Provider>;
}

export function useServerClock() { return useContext(ClockContext); }
