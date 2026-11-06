export const metadata = { title: "Privacy — Amigos" };

export default function Privacy() {
  return (
    <main style={{ maxWidth: 680, margin: "0 auto", padding: "32px 20px", lineHeight: 1.6 }}>
      <h1>Privacy</h1>
      <h2>What we keep</h2>
      <p>If you make an account: your email or username, your characters, your chats and the memories they keep of you. Without an account, your chats stay in your browser.</p>
      <h2>Who sees it</h2>
      <p>Your messages are sent to an AI provider (Google Gemini) to write replies and voice, and to our database host. We do not sell your data or use it for ads.</p>
      <h2>Imported chats</h2>
      <p>Imported conversations are measured in your browser. Only measured habits and a short excerpt are sent to build a character.</p>
      <h2>Your control</h2>
      <ul>
        <li>Tell a character to forget something, or delete a memory, and it is removed.</li>
        <li>Export your data from the account menu.</li>
        <li>Delete your account from the app and your data is deleted.</li>
      </ul>
      <h2>Security</h2>
      <p>Passwords are stored hashed. No system is perfectly secure, so do not share anything you could not bear to see leaked.</p>
      <p><a href="/terms">Terms of use</a></p>
    </main>
  );
}
