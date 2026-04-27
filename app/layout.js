import "./globals.css";

export const metadata = {
  title: "Snippet",
  description: "Jump to moments in songs with Spotify",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
