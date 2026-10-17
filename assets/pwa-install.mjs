// Installation is browser-owned; never infer success from prompt acceptance.
const button = document.getElementById("pwaInstall");
const status = document.getElementById("pwaInstallStatus");
let offeredPrompt = null;
let prompting = false;
const standalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
function instructions() {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) {
    return "On iPhone or iPad, open Nschess in Safari, tap Share, then Add to Home Screen. On newer versions, turn on Open as Web App if offered.";
  }
  return /Android/.test(ua)
    ? "Open your browser menu and choose Install app or Add to Home screen, if offered. If unavailable, use Nschess in your browser."
    : "In Chrome or Edge, use the address-bar install icon or browser menu → Install Nschess, if offered. Other browsers may offer Add to Dock or a shortcut; otherwise continue in your browser.";
}
function render() {
  if (!button || !status) return;
  button.disabled = prompting || standalone();
  button.textContent = standalone() ? "Running as an app" : "Install Nschess";
  status.textContent = standalone() ? "Nschess is running in an app-style window." : "Install from your browser for an app-style window. No app store required.";
}
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  offeredPrompt = event;
  render();
});
window.addEventListener("appinstalled", () => {
  offeredPrompt = null;
  render();
  if (status) status.textContent = "Browser confirmed Nschess installation.";
});
window.matchMedia("(display-mode: standalone)").addEventListener("change", render);
button?.addEventListener("click", async () => {
  if (prompting || standalone()) return;
  if (!offeredPrompt) { status.textContent = instructions(); return; }
  const prompt = offeredPrompt;
  offeredPrompt = null;
  prompting = true;
  button.disabled = true;
  try {
    await prompt.prompt();
    const choice = await prompt.userChoice;
    status.textContent = choice.outcome === "accepted"
      ? "Installation requested. Your browser will confirm when it finishes."
      : "Installation dismissed. You can continue in your browser.";
  } catch {
    status.textContent = instructions();
  } finally {
    prompting = false;
    button.disabled = standalone();
  }
});
render();
