// Ventana de la extensión: interruptor del visor de pdfiiuum y «Abrir en la app».
const viewer = document.getElementById("viewer");
const openApp = document.getElementById("open-app");
const status = document.getElementById("status");

const send = (msg) => chrome.runtime.sendMessage(msg);

const { enabled } = await send({ type: "get-viewer" });
viewer.checked = enabled;
viewer.addEventListener("change", async () => {
  await send({ type: "set-viewer", enabled: viewer.checked });
  status.textContent = viewer.checked
    ? "Los PDF que abras se verán en pdfiiuum."
    : "Los PDF que abras se verán con el visor del navegador.";
});

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const usable = /^(https?|file):/.test(tab?.url ?? "") || tab?.url?.startsWith(chrome.runtime.getURL("viewer/"));
openApp.disabled = !usable;
openApp.addEventListener("click", async () => {
  openApp.disabled = true;
  status.textContent = "Abriendo en pdfiiuum…";
  const r = await send({ type: "open-in-app", url: tab.url, tabId: tab.id });
  status.textContent = r?.error ? `No se pudo: ${r.error}` : "Abierto en la app de pdfiiuum.";
  openApp.disabled = false;
});
