export default function SafetyPage() {
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <h1>Safety centre</h1>
      <div className="card stack">
        <h2>How buyer protection works</h2>
        <p>When you pay, your money is held in escrow. The seller only receives it after you confirm the order arrived, or 7 days after delivery if you don&apos;t report a problem.</p>
        <p>If the item doesn&apos;t arrive, is damaged, or isn&apos;t as described, open a dispute from your order page before the payment is released.</p>
      </div>
      <div className="card stack">
        <h2>Spotting scams</h2>
        <ul>
          <li><strong>Never pay outside the site.</strong> Bank transfers, gift cards, crypto and payment links sent in chat are not protected.</li>
          <li><strong>Keep your delivery code private</strong> until the package is in your hands. Giving it early tells us you received the item.</li>
          <li><strong>Be wary of prices far below normal</strong>, especially from brand-new sellers.</li>
          <li><strong>We will never ask for your login code.</strong> Nobody from our team needs it.</li>
        </ul>
      </div>
      <div className="card stack">
        <h2>Report and block</h2>
        <p>Use the <em>Report</em> links on listings, seller pages and messages. You can block a user from any order chat; you can still open a dispute afterwards.</p>
      </div>
      <div className="card stack">
        <h2>Local pickup</h2>
        <p>Meet in a busy public place during the day, check the item before handing over your delivery code, and never pay cash in person for an order you placed here.</p>
      </div>
    </div>
  );
}
