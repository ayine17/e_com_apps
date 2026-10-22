import type { Metadata } from "next";
import { Header } from "@/components/Header";
import { SessionProvider } from "@/lib/session";
import "./globals.css";

export const metadata: Metadata = {
  title: "Escrow Market",
  description: "Buy and sell with payment held safely in escrow until you receive your order.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>
          <Header />
          <main className="container">{children}</main>
          <footer className="footer">
            <div className="container spread">
              <span>Payments are held in escrow until you confirm delivery.</span>
              <a href="/safety">Safety centre</a>
            </div>
          </footer>
        </SessionProvider>
      </body>
    </html>
  );
}
