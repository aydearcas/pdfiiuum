// pdfiiuum en el navegador:
// - Los PDF que abre el navegador se muestran en el visor de pdfiiuum (viewer/viewer.html),
//   salvo que se desactive en la ventana de la extensión. El visor usa el PDFium de la app
//   instalada a través del puente de mensajería nativa.
// - «Abrir en pdfiiuum» (menú contextual y ventana de la extensión) descarga el PDF con la
//   sesión del navegador y lo abre en la app de escritorio.

const HOST = "com.pdfiiuum.open";
/** Trozo de cada mensaje: 6 MB en binario son 8 MB en base64 (el límite es 64 MB). */
const CHUNK = 6 * 1024 * 1024;
const MAX_PDF = 1024 * 1024 * 1024;
const VIEWER = chrome.runtime.getURL("viewer/viewer.html");
/** Regla que lleva al visor las respuestas PDF que se abren en una pestaña. */
const RULE_ID = 1;
/** Reglas de sesión que dejan ver un PDF con el visor del navegador en una pestaña concreta. */
const BYPASS_BASE = 1000;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "open-link", title: "Abrir enlace en la app de pdfiiuum", contexts: ["link"] });
    chrome.contextMenus.create({ id: "open-page", title: "Abrir en la app de pdfiiuum", contexts: ["page", "frame"] });
  });
  applyViewerSetting();
});
chrome.runtime.onStartup.addListener(applyViewerSetting);

/** ¿Se abren los PDF en el visor de pdfiiuum? (por defecto, sí) */
async function viewerEnabled() {
  const { viewer = true } = await chrome.storage.local.get("viewer");
  return viewer;
}

async function applyViewerSetting() {
  const enabled = await viewerEnabled();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: enabled
      ? [
          {
            id: RULE_ID,
            priority: 1,
            action: { type: "redirect", redirect: { regexSubstitution: `${VIEWER}?file=\\0` } },
            condition: {
              regexFilter: "^https?://.*",
              resourceTypes: ["main_frame"],
              responseHeaders: [{ header: "content-type", values: ["application/pdf*"] }],
              // Si el servidor pide descargarlo, se respeta.
              excludedResponseHeaders: [{ header: "content-disposition", values: ["attachment*"] }],
            },
          },
        ]
      : [],
  });
}

chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  const url = change.url;
  if (!url) return;
  // La excepción para ver un PDF con el visor del navegador dura hasta salir de ese PDF.
  const bypassed = await bypassedUrl(tabId);
  if (bypassed && url !== bypassed) await clearBypass(tabId);
  else if (bypassed) return;
  // Los PDF del equipo (file://) no pasan por las reglas de red: se redirigen al cargar.
  if (url.startsWith("file:") && /\.pdf$/i.test(new URL(url).pathname) && (await viewerEnabled())) {
    chrome.tabs.update(tabId, { url: `${VIEWER}?file=${url}` });
  }
});
chrome.tabs.onRemoved.addListener((tabId) => clearBypass(tabId));

async function bypassedUrl(tabId) {
  const { bypass = {} } = await chrome.storage.session.get("bypass");
  return bypass[tabId];
}

async function clearBypass(tabId) {
  const { bypass = {} } = await chrome.storage.session.get("bypass");
  delete bypass[tabId];
  await chrome.storage.session.set({ bypass });
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [BYPASS_BASE + tabId] });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.menuItemId === "open-link" ? info.linkUrl : info.frameUrl || info.pageUrl;
  open(url, tab?.id);
});

// Mensajes de la ventana de la extensión y del visor.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === "get-viewer") return { enabled: await viewerEnabled() };
    if (msg.type === "set-viewer") {
      await chrome.storage.local.set({ viewer: msg.enabled });
      await applyViewerSetting();
      return { enabled: msg.enabled };
    }
    if (msg.type === "open-in-app") return open(msg.url, msg.tabId);
    if (msg.type === "browser-viewer") return showInBrowserViewer(sender.tab?.id ?? msg.tabId, msg.url);
  })().then(reply, (e) => reply({ error: e.message }));
  return true;
});

/** Vuelve a abrir el PDF en la pestaña con el visor propio del navegador. */
async function showInBrowserViewer(tabId, url) {
  if (tabId == null || !url) return;
  const { bypass = {} } = await chrome.storage.session.get("bypass");
  await chrome.storage.session.set({ bypass: { ...bypass, [tabId]: url } });
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [BYPASS_BASE + tabId],
    addRules: [
      {
        id: BYPASS_BASE + tabId,
        priority: 2,
        action: { type: "allow" },
        condition: { tabIds: [tabId], resourceTypes: ["main_frame"] },
      },
    ],
  });
  await chrome.tabs.update(tabId, { url });
}

/** Dirección del PDF: la de la pestaña o, si es el visor de pdfiiuum, la del PDF que muestra. */
export function pdfUrlOf(url) {
  if (url?.startsWith(VIEWER)) return url.slice(url.indexOf("?file=") + 6);
  return url;
}

async function open(rawUrl, tabId) {
  const url = pdfUrlOf(rawUrl);
  if (!url) return;
  await badge(tabId, "…", "#5b6170", "Abriendo en pdfiiuum…");
  try {
    const message = url.startsWith("file:") ? [{ type: "path", path: fileUrlToPath(url) }] : await download(url);
    const reply = await sendToApp(message);
    if (!reply?.ok) throw new Error(reply?.error || "pdfiiuum no respondió");
    await badge(tabId, "✓", "#13a35a", "Abierto en pdfiiuum");
    return { ok: true };
  } catch (e) {
    await badge(tabId, "!", "#e2231a", `No se pudo abrir en pdfiiuum: ${e.message}`);
    return { error: e.message };
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

/**
 * file:///C:/Docs/a%20b.pdf → C:\Docs\a b.pdf. No admite file://servidor/…: con solo comprobar
 * si existe, Windows se conectaría a ese servidor y le enviaría las credenciales del usuario.
 */
function fileUrlToPath(url) {
  const u = new URL(url);
  if (u.host) throw new Error("solo se abren PDF de este equipo, no de otros equipos de la red");
  return decodeURIComponent(u.pathname).replace(/\//g, "\\").replace(/^\\/, "");
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
      chrome.action.setTitle({ tabId, title: "pdfiiuum" }).catch(() => {});
    }, 5000);
  }
}
