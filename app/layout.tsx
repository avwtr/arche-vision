import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Arche Vision',
  description: 'An open lab log for a recording or a camera. Bring your own key.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
