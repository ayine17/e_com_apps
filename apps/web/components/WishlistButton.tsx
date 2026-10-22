"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";

export function WishlistButton({ productId, initiallySaved }: { productId: string; initiallySaved: boolean }) {
  const { me } = useSession();
  const router = useRouter();
  const [saved, setSaved] = useState(initiallySaved);
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="secondary"
      disabled={busy}
      aria-pressed={saved}
      onClick={async () => {
        if (!me) return router.push(`/login?next=/products/${productId}`);
        setBusy(true);
        try {
          await api(`/me/wishlist/${productId}`, { method: saved ? "DELETE" : "PUT" });
          setSaved(!saved);
        } finally {
          setBusy(false);
        }
      }}
    >
      {saved ? "♥ Saved" : "♡ Save"}
    </button>
  );
}
