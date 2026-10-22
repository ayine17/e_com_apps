"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCart } from "@/lib/cart";
import { useSession } from "@/lib/session";

function SearchBox() {
  const router = useRouter();
  const params = useSearchParams();
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = new FormData(e.currentTarget).get("q")?.toString().trim() ?? "";
    router.push(`/search?q=${encodeURIComponent(q)}`);
  }
  return (
    <form className="header-search" onSubmit={submit} role="search">
      <input name="q" placeholder="Search products" defaultValue={params.get("q") ?? ""} aria-label="Search products" />
      <button type="submit">Search</button>
    </form>
  );
}

export function Header() {
  const { me, logout } = useSession();
  const { count } = useCart();
  const router = useRouter();
  const isStaff = me?.roles.some((r) => r === "ADMIN" || r === "AGENT");
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (!me) return setUnread(0);
    const load = () => api<{ unread: number }>("/me/notifications").then((n) => setUnread(n.unread)).catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    window.addEventListener("notifications-read", load);
    return () => {
      clearInterval(t);
      window.removeEventListener("notifications-read", load);
    };
  }, [me]);
  return (
    <header className="header">
      <div className="container header-inner">
        <Link href="/" className="brand">
          Escrow<span>Market</span>
        </Link>
        <Suspense>
          <SearchBox />
        </Suspense>
        <nav className="nav">
          <Link href="/cart">
            Cart{count > 0 && <span className="badge-count">{count}</span>}
          </Link>
          {me ? (
            <>
              <Link href="/notifications" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}>
                🔔{unread > 0 && <span className="badge-count">{unread}</span>}
              </Link>
              <Link href="/wishlist">Saved</Link>
              <Link href="/orders">Orders</Link>
              <Link href="/sell">Sell</Link>
              {isStaff && <Link href="/admin">Admin</Link>}
              <Link href="/account">Account</Link>
              <button
                className="link"
                onClick={async () => {
                  await logout();
                  router.push("/");
                }}
              >
                Log out
              </button>
            </>
          ) : (
            <Link href="/login">Log in</Link>
          )}
        </nav>
      </div>
    </header>
  );
}
