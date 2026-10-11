export default function Home() {
  return (
    <main style={{ padding: 32, maxWidth: 640 }}>
      <h1 style={{ fontSize: 22 }}>Reference app for the conference load rehearsal</h1>
      <p>Participant screen: <code>/play</code>. Room display: <code>/display</code>.
        Both expect a session injected by the rehearsal driver (see <code>rehearse/browsers.mjs</code>).</p>
    </main>
  );
}
