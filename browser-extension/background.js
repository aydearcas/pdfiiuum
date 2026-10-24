// «Abrir en pdfiiuum»: descarga el PDF con la sesión del navegador (sirve aunque haga falta
// iniciar sesión) y se lo pasa a la app instalada por mensajería nativa. El puente es el propio
// pdfiiuum.exe; el instalador lo registra con el nombre HOST.

const HOST = "com.pdfiiuum.open";
/** Trozo de cada mensaje: 6 MB en binario son 8 MB en base64 (el límite es 64 MB). */
const CHUNK = 6 * 1024 * 1024;
const MAX_PDF = 1024 * 1024 * 1024;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "open-link", title: "Abrir enlace en pdfiiuum", contexts: ["link"] });
    chrome.contextMenus.create({ id: "open-page", title: "Abrir en pdfiiuum", contexts: ["page", "frame"] });
  });
});

chrome.action.onClicked.addListener((tab) => open(tab.url, tab.id));

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.menuItemId === "open-link" ? info.linkUrl : info.frameUrl || info.pageUrl;
  open(url, tab?.id);
});

async function open(url, tabId) {
  if (!url) return;
  await badge(tabId, "…", "#5b6170", "Abriendo en pdfiiuum…");
  try {
    const message = url.startsWith("file:") ? [{ type: "path", path: fileUrlToPath(url) }] : await download(url);
    const reply = await sendToApp(message);
    if (!reply?.ok) throw new Error(reply?.error || "pdfiiuum no respondió");
    await badge(tabId, "✓", "#13a35a", "Abierto en pdfiiuum");
  } catch (e) {
    await badge(tabId, "!", "#e2231a", `No se pudo abrir en pdfiiuum: ${e.message}`);
  }
}

/** Descarga el PDF y lo prepara como mensajes «begin», «chunk»… y «end». */
async function download(url) {
  if (!/^https?:/.test(url)) throw new Error("solo se pueden abrir PDF de páginas web o archivos locales");
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`el servidor respondió ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_PDF) throw new Error("el PDF pesa más de 1 GB");
  if (!looksLikePdf(bytes)) throw new Error("esto no es un PDF");
  const messages = [{ type: "begin", name: fileName(res, url), size: bytes.length }];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    messages.push({ type: "chunk", data: toBase64(bytes.subarray(i, i + CHUNK)) });
  }
  messages.push({ type: "end" });
  return messages;
}

/** Envía los mensajes por una conexión y espera la única respuesta del puente. */
function sendToApp(messages) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST);
    } catch (e) {
      return reject(e);
    }
    port.onMessage.addListener((reply) => {
      resolve(reply);
      port.disconnect();
    });
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message ?? "";
      reject(
        new Error(
          /not found|no se encontr/i.test(err)
            ? "pdfiiuum no está instalado (o es una versión sin extensión)"
            : err || "se cerró la conexión con pdfiiuum",
        ),
      );
    });
    for (const m of messages) port.postMessage(m);
  });
}

function looksLikePdf(bytes) {
  // Como los lectores de PDF, se admite basura antes de la cabecera (primer KB).
  const head = bytes.subarray(0, 1024);
  for (let i = 0; i + 3 < head.length; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46) return true;
  }
  return false;
}

/** Nombre del archivo: el que indique el servidor o el final de la dirección. */
function fileName(res, url) {
  const cd = res.headers.get("content-disposition") || "";
  const star = cd.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i);
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  let name = "";
  try {
    name = star ? decodeURIComponent(star[1]) : plain ? plain[1] : decodeURIComponent(new URL(url).pathname.split("/").pop());
  } catch {
    name = "";
  }
  return name.trim() || "documento.pdf";
}

/** file:///C:/Docs/a%20b.pdf → C:\Docs\a b.pdf (y file://servidor/… → \\servidor\…). */
function fileUrlToPath(url) {
  const u = new URL(url);
  const path = decodeURIComponent(u.pathname).replace(/\//g, "\\");
  return u.host ? `\\\\${u.host}${path}` : path.replace(/^\\/, "");
}

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Estado en el icono de la extensión de esa pestaña; se borra a los pocos segundos. */
async function badge(tabId, text, color, title) {
  if (tabId == null) return;
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setTitle({ tabId, title });
  } catch {
    return; // la pestaña ya no existe
  }
  if (text !== "…") {
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
      chrome.action.setTitle({ tabId, title: "Abrir en pdfiiuum" }).catch(() => {});
    }, 5000);
  }
}
