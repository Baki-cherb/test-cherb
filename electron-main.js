/* =========================================================================
   KUKA Robot Hub — processus principal Electron
   Charge l'application web locale dans une fenêtre de bureau.
   ========================================================================= */
const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("path");

function createWindow() {
  const win = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#0e1116",
    autoHideMenuBar: true,
    title: "KUKA Robot Hub",
    icon: path.join(__dirname, "build", "icon.ico"),
    webPreferences: {
      // Application 100% locale : pas besoin d'intégration Node dans le rendu
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  win.loadFile(path.join(__dirname, "index.html"));

  // Ouvre les liens externes dans le navigateur par défaut
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) { shell.openExternal(url); return { action: "deny" }; }
    return { action: "allow" };
  });
}

// Menu minimal en français
function buildMenu() {
  const template = [
    {
      label: "Fichier",
      submenu: [{ role: "quit", label: "Quitter" }]
    },
    {
      label: "Édition",
      submenu: [
        { role: "undo", label: "Annuler" },
        { role: "redo", label: "Rétablir" },
        { type: "separator" },
        { role: "cut", label: "Couper" },
        { role: "copy", label: "Copier" },
        { role: "paste", label: "Coller" },
        { role: "selectAll", label: "Tout sélectionner" }
      ]
    },
    {
      label: "Affichage",
      submenu: [
        { role: "reload", label: "Recharger" },
        { role: "togglefullscreen", label: "Plein écran" },
        { role: "resetZoom", label: "Zoom 100%" },
        { role: "zoomIn", label: "Agrandir" },
        { role: "zoomOut", label: "Réduire" },
        { type: "separator" },
        { role: "toggleDevTools", label: "Outils de développement" }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
