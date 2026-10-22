"use client";

import { useState } from "react";
import { uploadImage } from "@/lib/api";

export function ImageUploader({ value, onChange, max = 10 }: { value: string[]; onChange: (urls: string[]) => void; max?: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="stack">
      <div className="uploads">
        {value.map((url) => (
          <div className="u" key={url}>
            <img src={url} alt="" />
            <button type="button" className="secondary" onClick={() => onChange(value.filter((u) => u !== url))} aria-label="Remove image">×</button>
          </div>
        ))}
      </div>
      {value.length < max && (
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          disabled={busy}
          onChange={async (e) => {
            const files = Array.from(e.target.files ?? []).slice(0, max - value.length);
            e.target.value = "";
            setBusy(true);
            setError(null);
            try {
              const urls: string[] = [];
              for (const f of files) urls.push(await uploadImage(f));
              onChange([...value, ...urls]);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
      {busy && <span className="muted small">Uploading…</span>}
      {error && <div className="notice error">{error}</div>}
    </div>
  );
}
