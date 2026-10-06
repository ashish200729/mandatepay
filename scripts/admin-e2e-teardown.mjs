export default async function globalTeardown() {
  try {
    await fetch("http://127.0.0.1:4121/__admin_fixture/cleanup", { method: "POST" });
  } catch {
    // The last spec file may already have stopped the fixture server.
  }
}
