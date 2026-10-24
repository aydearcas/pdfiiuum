import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "pdfjs-dist/web/pdf_viewer.css";
import "./styles.css";
import App from "./App";
import EmbeddedNotice from "./components/EmbeddedNotice";
import { isEmbedded } from "./lib/platform";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isEmbedded ? <EmbeddedNotice /> : <App />}
  </StrictMode>,
);
