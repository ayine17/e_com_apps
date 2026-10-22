"use client";

import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import type { Me } from "./types";

interface Session { me: Me | null; loading: boolean; refresh: () => Promise<void>; logout: () => Promise<void> }

const Ctx = createContext<Session>({ me: null, loading: true, refresh: async () => {}, logout: async () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>("/auth/me"));
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) console.error(e);
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);
  const logout = useCallback(async () => {
    await api("/auth/logout", { method: "POST" });
    setMe(null);
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return <Ctx.Provider value={{ me, loading, refresh, logout }}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);
