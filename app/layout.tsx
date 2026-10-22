import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Gravity Wars',
  description: "A gravity brawler: eat debris, absorb smaller rivals, don't fall into a star.",
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#02030a',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
