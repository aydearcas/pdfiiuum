import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "pdfjs-dist/web/pdf_viewer.css";
import "./styles.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
