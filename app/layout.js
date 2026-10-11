export const metadata = { title: 'Rehearsal reference app' };
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'ui-sans-serif, system-ui, sans-serif', background: '#f6f4ef', color: '#1d2a33' }}>
        {children}
      </body>
    </html>
  );
}
