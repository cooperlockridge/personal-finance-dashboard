import { DOWN_MESSAGE, DOWN_TITLE } from './lib/siteStatus'

/* The whole website while SITE_DOWN is on (Oct 19, 2026). The app's pinks
   are gone on purpose: slate greys, slow rain, and the 🌸 the app greets her
   with, wilted. Everything is in this one file and the .sad-* rules in
   index.css, so taking it out later is a delete. */

const DROPS = Array.from({ length: 48 }, (_, i) => ({
  left: (i * 37) % 100,
  delay: ((i * 53) % 40) / 10,
  duration: 1.1 + ((i * 29) % 9) / 10,
  height: 10 + ((i * 17) % 14),
}))

export function SiteDown() {
  return (
    <div className="sad-page relative min-h-dvh overflow-hidden">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        {DROPS.map((drop, i) => (
          <span
            key={i}
            className="sad-drop"
            style={{
              left: `${drop.left}%`,
              height: `${drop.height}px`,
              animationDelay: `${drop.delay}s`,
              animationDuration: `${drop.duration}s`,
            }}
          />
        ))}
      </div>

      <header className="sad-rule relative border-b">
        <div className="mx-auto max-w-[1200px] px-4 py-3 sm:px-6">
          <h1 className="sad-muted text-[16px] font-semibold line-through decoration-1">Laken's Finance</h1>
        </div>
      </header>

      <main className="relative mx-auto flex max-w-md flex-col items-center px-6 pt-20 pb-24 text-center sm:pt-28">
        <div className="sad-cloud" aria-hidden="true">☁️</div>
        <div className="sad-flower mt-2 text-[64px] leading-none" role="img" aria-label="a wilted flower">
          🥀
        </div>

        <p className="sad-ink mt-8 text-[24px] font-semibold text-balance">{DOWN_TITLE}</p>
        <p className="sad-muted mt-1 text-[15px]">Indefinitely.</p>

        <p className="sad-ink mt-6 text-[15px] leading-relaxed text-pretty">{DOWN_MESSAGE}</p>

        <div className="sad-card mt-8 w-full rounded-apple border px-5 py-4 text-left">
          <p className="sad-muted text-[12px] tracking-wide uppercase">Status</p>
          <p className="sad-ink mt-1 text-[14px]">
            <span className="sad-dot" aria-hidden="true" /> Down. No estimate. No updates expected.
          </p>
        </div>

        <p className="sad-muted mt-10 text-[12px] italic">It's not you. It's not anyone. It's just down.</p>
      </main>
    </div>
  )
}
