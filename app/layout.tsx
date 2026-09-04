import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import './documentary-theme.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: 'H3 Studio',
  description: 'Studio locale per creare, confrontare e continuare video MiniMax H3.',
  openGraph: {
    title: 'H3 Studio',
    description: 'Create. Compare. Continue.',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'H3 Studio candidate workspace' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'H3 Studio',
    description: 'Create. Compare. Continue.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="it">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
