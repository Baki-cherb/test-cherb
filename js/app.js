/* =========================================================================
   KUKA Robot Hub — application complète (vanilla, une seule IIFE)
   - state persisté dans localStorage (+ migrate)
   - fichiers binaires & sauvegardes auto dans IndexedDB
   - moteur de rendu maison : render() -> renderers[view]()
   ========================================================================= */
(function () {
  "use strict";

  /* -----------------------------------------------------------------------
     Constantes
     ----------------------------------------------------------------------- */
  var STORAGE_KEY = "kuka_hub_state";
  var SCHEMA_VERSION = 1;
  var MAX_BACKUPS = 20;

  /* -----------------------------------------------------------------------
     Helpers DOM & utilitaires
     ----------------------------------------------------------------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Crée un noeud DOM à partir d'une chaîne HTML
  function node(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function uid() { return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); }
  function nowISO() { return new Date().toISOString(); }
  function todayISO() { return new Date().toISOString().slice(0, 10); }

  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d)) return esc(iso);
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
  }
  function fmtBytes(n) {
    if (!n && n !== 0) return "—";
    if (n < 1024) return n + " o";
    if (n < 1048576) return (n / 1024).toFixed(1) + " Ko";
    return (n / 1048576).toFixed(1) + " Mo";
  }
  function debounce(fn, ms) {
    var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms || 200); };
  }
  function parseTags(s) {
    if (Array.isArray(s)) return s;
    return String(s || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
  }

  /* -----------------------------------------------------------------------
     IndexedDB : fichiers binaires + sauvegardes
     ----------------------------------------------------------------------- */
  var DB = (function () {
    var dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        var req = indexedDB.open("kuka_hub", 1);
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "id" });
          if (!db.objectStoreNames.contains("backups")) db.createObjectStore("backups", { keyPath: "id" });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
      return dbp;
    }
    function tx(store, mode) { return open().then(function (db) { return db.transaction(store, mode).objectStore(store); }); }
    function wrap(request) { return new Promise(function (res, rej) { request.onsuccess = function () { res(request.result); }; request.onerror = function () { rej(request.error); }; }); }
    return {
      put: function (store, val) { return tx(store, "readwrite").then(function (s) { return wrap(s.put(val)); }); },
      get: function (store, key) { return tx(store, "readonly").then(function (s) { return wrap(s.get(key)); }); },
      del: function (store, key) { return tx(store, "readwrite").then(function (s) { return wrap(s.delete(key)); }); },
      all: function (store) { return tx(store, "readonly").then(function (s) { return wrap(s.getAll()); }); },
      clear: function (store) { return tx(store, "readwrite").then(function (s) { return wrap(s.clear()); }); }
    };
  })();

  // Lit un File en Blob stocké dans IndexedDB, renvoie l'id
  function storeFile(file) {
    var id = uid();
    return DB.put("files", { id: id, name: file.name, type: file.type, size: file.size, blob: file }).then(function () {
      return { id: id, name: file.name, type: file.type, size: file.size };
    });
  }
  function downloadStoredFile(fileMeta) {
    if (!fileMeta || !fileMeta.id) return;
    DB.get("files", fileMeta.id).then(function (rec) {
      if (!rec) { toast("Fichier introuvable dans le stockage local", "danger"); return; }
      var url = URL.createObjectURL(rec.blob);
      var a = document.createElement("a");
      a.href = url; a.download = rec.name || "fichier"; document.body.appendChild(a); a.click();
      a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
  }
  function withFileURL(fileMeta, cb) {
    if (!fileMeta || !fileMeta.id) { cb(null); return; }
    DB.get("files", fileMeta.id).then(function (rec) { cb(rec ? URL.createObjectURL(rec.blob) : null); });
  }

  /* -----------------------------------------------------------------------
     État applicatif
     ----------------------------------------------------------------------- */
  var state = null;

  function defaultState() {
    return {
      version: SCHEMA_VERSION,
      settings: { theme: "kuka", view: "dashboard" },
      org: [],
      robots: [], programs: [], functions: [], variables: [],
      instructions: [], standards: [], documents: [],
      faults: [], maintenance: [], contacts: [], glossary: []
    };
  }

  function loadState() {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (e) { raw = null; }
    if (!raw) { state = seed(defaultState()); persist(); return; }
    state = migrate(raw);
  }

  // Fait évoluer le schéma sans perdre de données
  function migrate(s) {
    var def = defaultState();
    if (!s.settings) s.settings = def.settings;
    if (!s.settings.theme) s.settings.theme = "kuka";
    if (!s.settings.view) s.settings.view = "dashboard";
    Object.keys(def).forEach(function (k) {
      if (Array.isArray(def[k]) && !Array.isArray(s[k])) s[k] = [];
    });
    s.version = SCHEMA_VERSION;
    return s;
  }

  var persist = debounce(function () {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {
      toast("Échec d'enregistrement (stockage plein ?)", "danger");
    }
    autoBackup();
  }, 250);

  function persistNow() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  var autoBackup = debounce(function () {
    var snap = { id: uid(), ts: nowISO(), data: JSON.stringify(state) };
    DB.put("backups", snap).then(function () {
      return DB.all("backups");
    }).then(function (all) {
      all.sort(function (a, b) { return a.ts < b.ts ? 1 : -1; });
      all.slice(MAX_BACKUPS).forEach(function (b) { DB.del("backups", b.id); });
    }).catch(function () {});
  }, 1500);

  // Données d'exemple au premier lancement (démonstration)
  function seed(s) {
    var r1 = { id: uid(), name: "R01 — Préhension", model: "KR 210 R2700 extra", controller: "KR C4",
      kss: "8.6.7", serial: "KR-210-00471", axes: "6", payload: "210", reach: "2700",
      site: "Usine Nord", cell: "Cellule A1", sector: "Emboutissage", status: "En production",
      notes: "Robot maître de la cellule, communication PROFINET avec l'automate.", createdAt: nowISO(), updatedAt: nowISO() };
    var r2 = { id: uid(), name: "R02 — Soudure", model: "KR 16 R1610", controller: "KR C5",
      kss: "8.7.2", serial: "KR-16-10932", axes: "6", payload: "16", reach: "1610",
      site: "Usine Nord", cell: "Cellule A2", sector: "Assemblage", status: "En production",
      notes: "Pince de soudure par points, surveillance SafeOperation active.", createdAt: nowISO(), updatedAt: nowISO() };
    s.robots = [r1, r2];

    var oSite = { id: uid(), type: "site", parentId: null, name: "Usine Nord", note: "", createdAt: nowISO(), updatedAt: nowISO() };
    var oLigne = { id: uid(), type: "ligne", parentId: oSite.id, name: "Ligne Carrosserie", note: "", createdAt: nowISO(), updatedAt: nowISO() };
    var oA1 = { id: uid(), type: "cellule", parentId: oLigne.id, name: "Cellule A1", note: "", createdAt: nowISO(), updatedAt: nowISO() };
    var oA2 = { id: uid(), type: "cellule", parentId: oLigne.id, name: "Cellule A2", note: "", createdAt: nowISO(), updatedAt: nowISO() };
    s.org = [oSite, oLigne, oA1, oA2];
    r1.cellId = oA1.id; r2.cellId = oA2.id;

    s.functions = [{
      id: uid(), name: "GET_PART_OK", category: "Sécurité / Process", params: "(BOOL signalEntree)",
      returns: "BOOL", tags: ["process", "securite"],
      description: "Vérifie la présence pièce et renvoie TRUE si la prise est autorisée.",
      code: "DEF GET_PART_OK(signalEntree :IN)\n  BOOL signalEntree\n  ; Attente présence pièce capteur\n  WAIT FOR $IN[12]\n  IF $IN[12]==TRUE THEN\n    RETURN(TRUE)\n  ENDIF\n  RETURN(FALSE)\nEND",
      createdAt: nowISO(), updatedAt: nowISO()
    }];

    s.standards = [{
      id: uid(), title: "Convention de nommage des programmes", category: "Nommage",
      content: "• Programmes principaux : MAIN_<cellule>.src\n• Sous-programmes : SUB_<fonction>.src\n• Fonctions réutilisables : FX_<nom>.src\n• Variables globales : préfixe g_  (ex. g_vitesseProcess)\n• Points : P_<zone>_<index>",
      createdAt: nowISO(), updatedAt: nowISO()
    }];

    s.faults = [{
      id: uid(), code: "KSS15006", title: "Erreur d'enchaînement de programme", severity: "Erreur",
      cause: "Acquittement manquant ou ordre d'appel de sous-programme incorrect.",
      solution: "Vérifier la séquence d'appel et acquitter le message via le KCP, puis relancer en mode T1.",
      createdAt: nowISO(), updatedAt: nowISO()
    }];

    s.glossary = [
      { id: uid(), term: "KRL", definition: "KUKA Robot Language — langage de programmation des robots KUKA." },
      { id: uid(), term: "KSS", definition: "KUKA System Software — logiciel système du contrôleur." },
      { id: uid(), term: "KRC", definition: "KUKA Robot Controller — armoire de commande du robot (KR C4, KR C5…)." },
      { id: uid(), term: "TOOL/BASE", definition: "Repères d'outil (TOOL) et de base (BASE) utilisés pour le calcul des trajectoires." },
      { id: uid(), term: "Mastering", definition: "Calibration des axes (mise à zéro / justage) du robot." }
    ];
    return s;
  }

  /* -----------------------------------------------------------------------
     Icônes (SVG en ligne)
     ----------------------------------------------------------------------- */
  function svg(p) { return '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + p + "</svg>"; }
  var ICON = {
    dashboard: svg('<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>'),
    robot: svg('<rect x="4" y="8" width="16" height="11" rx="2"/><path d="M12 8V4M9 4h6"/><circle cx="9" cy="13" r="1.2"/><circle cx="15" cy="13" r="1.2"/><path d="M2 13h2M20 13h2"/>'),
    code: svg('<path d="M8 6l-6 6 6 6M16 6l6 6-6 6"/>'),
    fx: svg('<path d="M4 20s2-1 2-6 2-6 2-6M4 12h7M14 4c2 0 3 2 3 5 0 6 3 6 3 6"/>'),
    variable: svg('<path d="M5 5c2 0 3 1 3 4v6c0 3 1 4 3 4M19 5c-2 0-3 1-3 4v6c0 3-1 4-3 4"/><path d="M9 12h6"/>'),
    book: svg('<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/>'),
    badge: svg('<path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z"/><path d="M9 12l2 2 4-4"/>'),
    file: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'),
    abc: svg('<path d="M3 17l3-9 3 9M3.8 14h4.4M14 8h3a2 2 0 0 1 0 4h-3zM14 12h3.5a2 2 0 0 1 0 4H14zM14 8v8"/>'),
    alert: svg('<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'),
    wrench: svg('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3 17.8 6.2 21l6.3-6.3a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.1-2.1z"/>'),
    user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>'),
    search: svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    edit: svg('<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
    trash: svg('<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>'),
    download: svg('<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>'),
    copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    chevron: svg('<path d="M9 6l6 6-6 6"/>'),
    theme: svg('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z"/>'),
    database: svg('<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>'),
    eye: svg('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>'),
    tag: svg('<path d="M3 11l8-8 10 10-8 8z"/><circle cx="8" cy="8" r="1.5"/>'),
    calendar: svg('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
    check: svg('<path d="M20 6 9 17l-5-5"/>'),
    chip: svg('<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/>'),
    folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>')
  };

  /* -----------------------------------------------------------------------
     Thèmes
     ----------------------------------------------------------------------- */
  var THEMES = [
    { id: "kuka", label: "KUKA Orange" },
    { id: "midnight", label: "Minuit" },
    { id: "carbon", label: "Carbone" },
    { id: "emeraude", label: "Émeraude" },
    { id: "clair", label: "Clair" }
  ];
  function applyTheme(id) {
    document.documentElement.setAttribute("data-theme", id);
    state.settings.theme = id; persist();
  }

  /* -----------------------------------------------------------------------
     Toasts
     ----------------------------------------------------------------------- */
  function toast(msg, kind) {
    var root = $("#toastRoot");
    var t = node('<div class="toast ' + (kind || "") + '"><div class="bar"></div><div class="toast-msg">' + esc(msg) + "</div></div>");
    root.appendChild(t);
    setTimeout(function () { t.classList.add("out"); setTimeout(function () { t.remove(); }, 250); }, 2800);
  }

  /* -----------------------------------------------------------------------
     Modales
     ----------------------------------------------------------------------- */
  function openModal(opts) {
    closeModal();
    var foot = (opts.footer || []).map(function (b) { return b; }).join("");
    var bd = node('<div class="modal-backdrop"><div class="modal ' + (opts.wide ? "wide" : "") + '">' +
      '<div class="modal-head"><h3>' + esc(opts.title || "") + '</h3>' +
      '<div class="modal-close" data-close>' + ICON.close + "</div></div>" +
      '<div class="modal-body"></div>' +
      (foot ? '<div class="modal-foot">' + foot + "</div>" : "") +
      "</div></div>");
    var body = $(".modal-body", bd);
    if (typeof opts.body === "string") body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);
    $("#modalRoot").appendChild(bd);
    bd.addEventListener("mousedown", function (e) { if (e.target === bd) closeModal(); });
    $$("[data-close]", bd).forEach(function (b) { b.addEventListener("click", closeModal); });
    if (opts.onMount) opts.onMount(bd);
    return bd;
  }
  function closeModal() { var m = $("#modalRoot"); if (m) m.innerHTML = ""; }
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });

  function confirmDialog(message, onYes, danger) {
    openModal({
      title: "Confirmation",
      body: '<p style="color:var(--text-soft)">' + esc(message) + "</p>",
      footer: ['<button class="btn" data-close>Annuler</button>',
        '<button class="btn ' + (danger ? "btn-danger" : "btn-primary") + '" data-yes>Confirmer</button>'],
      onMount: function (m) { $("[data-yes]", m).addEventListener("click", function () { closeModal(); onYes(); }); }
    });
  }

  /* -----------------------------------------------------------------------
     Configuration des modules
     ----------------------------------------------------------------------- */
  var ROBOT_REF = function () { return state.robots; };

  var MODULES = {
    robots: {
      key: "robots", label: "Parc robots", singular: "un robot", icon: "robot", group: "Robotique",
      layout: "cards", sub: "Cartes signalétiques — modèle, contrôleur KRC, version KSS, site & cellule",
      fields: [
        { name: "name", label: "Nom / Repère", type: "text", required: true, primary: true, placeholder: "ex. R01 — Préhension" },
        { name: "model", label: "Modèle", type: "text", placeholder: "ex. KR 210 R2700 extra" },
        { name: "controller", label: "Contrôleur (KRC)", type: "select", options: ["KR C4", "KR C5", "KR C5 micro", "VKR C4", "KR C2", "autre"] },
        { name: "kss", label: "Version KSS", type: "text", placeholder: "ex. 8.6.7" },
        { name: "serial", label: "N° de série", type: "text" },
        { name: "axes", label: "Nombre d'axes", type: "number" },
        { name: "payload", label: "Charge (kg)", type: "number" },
        { name: "reach", label: "Portée (mm)", type: "number" },
        { name: "site", label: "Site", type: "text" },
        { name: "cell", label: "Cellule", type: "text" },
        { name: "sector", label: "Secteur", type: "text" },
        { name: "cellId", label: "Rattachement (hiérarchie)", type: "cellRef" },
        { name: "status", label: "État", type: "select", options: ["En production", "En maintenance", "À l'arrêt", "En réserve"] },
        { name: "photo", label: "Photo du robot", type: "file", accept: "image/*" },
        { name: "notes", label: "Notes", type: "textarea" }
      ]
    },
    programs: {
      key: "programs", label: "Programmes", singular: "un programme", icon: "code", group: "Robotique",
      layout: "table", sub: "Archives des programmes + journal de ce qui a été fait dans le code",
      columns: ["name", "robotId", "version", "lang", "updatedAt"],
      fields: [
        { name: "name", label: "Nom du programme", type: "text", required: true, primary: true, placeholder: "ex. MAIN_CelluleA1.src" },
        { name: "robotId", label: "Robot", type: "robotRef" },
        { name: "sector", label: "Secteur", type: "text" },
        { name: "version", label: "Version", type: "text", placeholder: "ex. v1.2" },
        { name: "lang", label: "Type", type: "select", options: ["KRL (.src/.dat)", "Archive KRC (.zip)", "WorkVisual", "Sous-programme", "autre"] },
        { name: "tags", label: "Mots-clés", type: "tags" },
        { name: "file", label: "Fichier / archive", type: "file", accept: ".src,.dat,.zip,.sub,.kxr,.wvs,.txt" },
        { name: "description", label: "Description", type: "textarea" },
        { name: "workDone", label: "Ce qui a été fait dans le code", type: "textarea", big: true, placeholder: "Décrivez précisément les modifications apportées, points modifiés, vitesses, E/S, etc." }
      ]
    },
    functions: {
      key: "functions", label: "Bibliothèque de fonctions", singular: "une fonction", icon: "fx", group: "Robotique",
      layout: "cards", sub: "Toutes les fonctions développées — KRL réutilisable",
      fields: [
        { name: "name", label: "Nom de la fonction", type: "text", required: true, primary: true, placeholder: "ex. GET_PART_OK" },
        { name: "category", label: "Catégorie", type: "text", placeholder: "ex. Manipulation, Soudure, Sécurité" },
        { name: "params", label: "Paramètres", type: "text", placeholder: "ex. (REAL vitesse, INT mode)" },
        { name: "returns", label: "Retour / sortie", type: "text", placeholder: "ex. BOOL" },
        { name: "tags", label: "Mots-clés", type: "tags" },
        { name: "description", label: "Description / utilisation", type: "textarea" },
        { name: "code", label: "Code KRL", type: "code", primaryCode: true }
      ]
    },
    variables: {
      key: "variables", label: "Variables", singular: "une variable", icon: "variable", group: "Robotique",
      layout: "table", sub: "Catalogue des variables — déclarations, types et portée",
      columns: ["name", "type", "scope", "robotId", "value"],
      fields: [
        { name: "name", label: "Nom", type: "text", required: true, primary: true, placeholder: "ex. g_vitesseProcess" },
        { name: "type", label: "Type", type: "select", options: ["BOOL", "INT", "REAL", "CHAR", "E6POS", "E6AXIS", "FRAME", "POS", "AXIS", "SIGNAL", "STRUC", "ENUM", "autre"] },
        { name: "scope", label: "Portée", type: "select", options: ["Globale ($config.dat)", "Programme", "Locale", "Système ($...)"] },
        { name: "value", label: "Valeur / déclaration", type: "text", placeholder: "ex. 2.0" },
        { name: "robotId", label: "Robot", type: "robotRef" },
        { name: "description", label: "Description", type: "textarea" }
      ]
    },
    instructions: {
      key: "instructions", label: "Instructions de travail", singular: "une instruction", icon: "book", group: "Documentation",
      layout: "cards", sub: "Instructions par robot et par secteur",
      fields: [
        { name: "title", label: "Titre", type: "text", required: true, primary: true },
        { name: "robotId", label: "Robot", type: "robotRef" },
        { name: "sector", label: "Secteur", type: "text" },
        { name: "tags", label: "Mots-clés", type: "tags" },
        { name: "content", label: "Instruction de travail", type: "textarea", big: true }
      ]
    },
    standards: {
      key: "standards", label: "Standards de programmation", singular: "un standard", icon: "badge", group: "Documentation",
      layout: "cards", sub: "Règles et standards de programmation des robots",
      fields: [
        { name: "title", label: "Titre", type: "text", required: true, primary: true },
        { name: "category", label: "Catégorie", type: "text", placeholder: "ex. Nommage, Structure, Sécurité, E/S" },
        { name: "content", label: "Contenu du standard", type: "textarea", big: true }
      ]
    },
    documents: {
      key: "documents", label: "Documents KUKA", singular: "un document", icon: "file", group: "Documentation",
      layout: "cards", sub: "Manuels, notices, datasheets et schémas",
      fields: [
        { name: "title", label: "Titre", type: "text", required: true, primary: true },
        { name: "category", label: "Catégorie", type: "select", options: ["Manuel", "Notice", "Datasheet", "Schéma", "Procédure", "Certificat", "autre"] },
        { name: "robotModel", label: "Modèle concerné", type: "text" },
        { name: "tags", label: "Mots-clés", type: "tags" },
        { name: "file", label: "Fichier", type: "file", accept: ".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg" },
        { name: "description", label: "Description", type: "textarea" }
      ]
    },
    glossary: {
      key: "glossary", label: "Glossaire", singular: "un terme", icon: "abc", group: "Documentation",
      layout: "table", sub: "Termes et abréviations du domaine robotique",
      columns: ["term", "definition"],
      fields: [
        { name: "term", label: "Terme / abréviation", type: "text", required: true, primary: true },
        { name: "definition", label: "Définition", type: "textarea" }
      ]
    },
    faults: {
      key: "faults", label: "Codes défaut", singular: "un code défaut", icon: "alert", group: "Exploitation",
      layout: "table", sub: "Base de connaissances des messages et codes défaut KUKA",
      columns: ["code", "title", "severity"],
      fields: [
        { name: "code", label: "Code", type: "text", required: true, primary: true, placeholder: "ex. KSS15006" },
        { name: "title", label: "Intitulé", type: "text" },
        { name: "severity", label: "Gravité", type: "select", options: ["Info", "Avertissement", "Erreur", "Critique"] },
        { name: "cause", label: "Cause probable", type: "textarea" },
        { name: "solution", label: "Solution / action", type: "textarea", big: true }
      ]
    },
    maintenance: {
      key: "maintenance", label: "Maintenance", singular: "une intervention", icon: "wrench", group: "Exploitation",
      layout: "table", sub: "Journal des interventions et de la maintenance",
      columns: ["date", "robotId", "type", "technician"],
      fields: [
        { name: "date", label: "Date", type: "date", primary: true },
        { name: "robotId", label: "Robot", type: "robotRef" },
        { name: "type", label: "Type", type: "select", options: ["Préventive", "Corrective", "Mise en service", "Sauvegarde", "Mise à jour", "Calibration / Mastering", "autre"] },
        { name: "technician", label: "Intervenant", type: "text" },
        { name: "description", label: "Description de l'intervention", type: "textarea", big: true }
      ]
    },
    contacts: {
      key: "contacts", label: "Contacts", singular: "un contact", icon: "user", group: "Exploitation",
      layout: "cards", sub: "Support KUKA, intégrateurs et fournisseurs",
      fields: [
        { name: "name", label: "Nom", type: "text", required: true, primary: true },
        { name: "company", label: "Société", type: "text" },
        { name: "role", label: "Fonction", type: "text" },
        { name: "phone", label: "Téléphone", type: "text" },
        { name: "email", label: "E-mail", type: "text" },
        { name: "notes", label: "Notes", type: "textarea" }
      ]
    }
  };

  var NAV_GROUPS = ["Pilotage", "Robotique", "Documentation", "Exploitation"];

  function robotName(id) {
    var r = state.robots.filter(function (x) { return x.id === id; })[0];
    return r ? r.name : "—";
  }
  function fieldByName(mod, name) { return mod.fields.filter(function (f) { return f.name === name; })[0]; }

  // --- Hiérarchie du parc (Sites › Lignes › Cellules) ---
  function orgNode(id) { return state.org.filter(function (n) { return n.id === id; })[0]; }
  function orgChildren(parentId, type) {
    return state.org.filter(function (n) {
      return n.parentId === (parentId || null) && (!type || n.type === type);
    }).sort(function (a, b) { return a.name.localeCompare(b.name, "fr"); });
  }
  function descendantsOf(id) {
    var out = [];
    state.org.forEach(function (n) { if (n.parentId === id) { out.push(n.id); out = out.concat(descendantsOf(n.id)); } });
    return out;
  }
  function cellPath(id) {
    var n = orgNode(id);
    if (!n) return "—";
    var parts = [n.name], p = n.parentId;
    while (p) { var pn = orgNode(p); if (!pn) break; parts.unshift(pn.name); p = pn.parentId; }
    return parts.join(" / ");
  }
  function cellulesList() {
    return state.org.filter(function (n) { return n.type === "cellule"; })
      .map(function (c) { return { id: c.id, path: cellPath(c.id) }; })
      .sort(function (a, b) { return a.path.localeCompare(b.path, "fr"); });
  }
  function robotsInCell(id) { return state.robots.filter(function (r) { return r.cellId === id; }); }

  /* -----------------------------------------------------------------------
     Coloration syntaxique KRL (légère et sûre)
     ----------------------------------------------------------------------- */
  function highlightKRL(code) {
    var KW = /\b(DEF|DEFFCT|ENDFCT|END|GLOBAL|DECL|BOOL|INT|REAL|CHAR|FRAME|POS|E6POS|AXIS|E6AXIS|SIGNAL|STRUC|ENUM|IF|THEN|ELSE|ENDIF|FOR|TO|ENDFOR|WHILE|ENDWHILE|LOOP|ENDLOOP|REPEAT|UNTIL|SWITCH|CASE|DEFAULT|ENDSWITCH|RETURN|WAIT|FOR|SEC|PTP|LIN|CIRC|SPTP|SLIN|SCIRC|TRUE|FALSE|IN|OUT|VEL|ACC|BAS|TOOL_DATA|BASE_DATA|HALT|CONTINUE|INTERRUPT|TRIGGER|WHEN|DISTANCE|DELAY|DO|BRAKE)\b/g;
    return esc(code).split("\n").map(function (line) {
      var code = line, comment = "";
      var ci = line.indexOf(";");
      if (ci >= 0) { code = line.slice(0, ci); comment = line.slice(ci); }
      code = code.replace(/(&quot;[^&]*&quot;)/g, '<span class="st">$1</span>');
      code = code.replace(KW, '<span class="kw">$1</span>');
      code = code.replace(/\b(\d+\.?\d*)\b/g, '<span class="nm">$1</span>');
      return code + (comment ? '<span class="cm">' + comment + "</span>" : "");
    }).join("\n");
  }

  /* -----------------------------------------------------------------------
     Formulaires génériques
     ----------------------------------------------------------------------- */
  function buildField(f, value) {
    var id = "f_" + f.name;
    var inner = "";
    if (f.type === "textarea") {
      inner = '<textarea id="' + id + '" class="input' + (f.big ? '" rows="6' : '') + '" placeholder="' + esc(f.placeholder || "") + '">' + esc(value || "") + "</textarea>";
    } else if (f.type === "code") {
      inner = '<textarea id="' + id + '" class="input code" spellcheck="false" placeholder="' + esc(f.placeholder || "") + '">' + esc(value || "") + "</textarea>";
    } else if (f.type === "select") {
      inner = '<select id="' + id + '" class="input"><option value="">—</option>' +
        f.options.map(function (o) { return '<option ' + (o === value ? "selected" : "") + ">" + esc(o) + "</option>"; }).join("") + "</select>";
    } else if (f.type === "robotRef") {
      inner = '<select id="' + id + '" class="input"><option value="">— Aucun —</option>' +
        ROBOT_REF().map(function (r) { return '<option value="' + esc(r.id) + '" ' + (r.id === value ? "selected" : "") + ">" + esc(r.name) + "</option>"; }).join("") + "</select>";
    } else if (f.type === "cellRef") {
      inner = '<select id="' + id + '" class="input"><option value="">— Non affecté —</option>' +
        cellulesList().map(function (c) { return '<option value="' + esc(c.id) + '" ' + (c.id === value ? "selected" : "") + ">" + esc(c.path) + "</option>"; }).join("") + "</select>";
      if (!cellulesList().length) inner += '<div class="hint">Aucune cellule définie. Créez-en dans « Hiérarchie du parc ».</div>';
    } else if (f.type === "tags") {
      inner = '<input id="' + id + '" class="input" value="' + esc(parseTags(value).join(", ")) + '" placeholder="séparés par des virgules" />';
    } else if (f.type === "file") {
      var cur = value && value.name ? '<div class="hint">Actuel : ' + esc(value.name) + " (" + fmtBytes(value.size) + ")</div>" : "";
      inner = '<input id="' + id + '" type="file" class="input" accept="' + esc(f.accept || "") + '" />' + cur;
    } else if (f.type === "number") {
      inner = '<input id="' + id + '" type="number" step="any" class="input" value="' + esc(value || "") + '" placeholder="' + esc(f.placeholder || "") + '" />';
    } else if (f.type === "date") {
      inner = '<input id="' + id + '" type="date" class="input" value="' + esc(value || todayISO()) + '" />';
    } else {
      inner = '<input id="' + id + '" type="text" class="input" value="' + esc(value || "") + '" placeholder="' + esc(f.placeholder || "") + '" />';
    }
    return '<div class="field"><label for="' + id + '">' + esc(f.label) + (f.required ? " *" : "") + "</label>" + inner + "</div>";
  }

  function openForm(modKey, id) {
    var mod = MODULES[modKey];
    var existing = id ? state[modKey].filter(function (x) { return x.id === id; })[0] : null;
    var data = existing || {};

    // Regroupe les champs en lignes pour les champs courts (heuristique simple)
    var html = '<form id="entityForm">';
    mod.fields.forEach(function (f) { html += buildField(f, data[f.name]); });
    html += "</form>";

    openModal({
      title: (existing ? "Modifier " : "Ajouter ") + mod.singular,
      wide: mod.layout === "table" || modKey === "functions" || modKey === "robots",
      body: html,
      footer: ['<button class="btn" data-close>Annuler</button>',
        '<button class="btn btn-primary" data-save>' + ICON.check + "Enregistrer</button>"],
      onMount: function (m) {
        $("[data-save]", m).addEventListener("click", function () { saveForm(modKey, existing, m); });
      }
    });
  }

  function saveForm(modKey, existing, modalEl) {
    var mod = MODULES[modKey];
    var obj = existing ? existing : { id: uid(), createdAt: nowISO() };
    var filePromises = [];

    for (var i = 0; i < mod.fields.length; i++) {
      var f = mod.fields[i];
      var elm = $("#f_" + f.name, modalEl);
      if (!elm) continue;
      if (f.type === "file") {
        if (elm.files && elm.files[0]) {
          (function (field, file) {
            filePromises.push(storeFile(file).then(function (meta) { obj[field.name] = meta; }));
          })(f, elm.files[0]);
        }
      } else if (f.type === "tags") {
        obj[f.name] = parseTags(elm.value);
      } else {
        obj[f.name] = elm.value.trim();
      }
    }

    // Validation des champs requis
    var missing = mod.fields.filter(function (f) { return f.required && !obj[f.name]; });
    if (missing.length) { toast("Champ requis : " + missing[0].label, "warn"); return; }

    Promise.all(filePromises).then(function () {
      obj.updatedAt = nowISO();
      if (!existing) state[modKey].unshift(obj);
      persistNow(); persist();
      closeModal();
      toast(existing ? "Modifié avec succès" : "Ajouté avec succès", "ok");
      render();
    });
  }

  function deleteItem(modKey, id) {
    var mod = MODULES[modKey];
    confirmDialog("Supprimer définitivement cet élément (" + mod.singular + ") ?", function () {
      var item = state[modKey].filter(function (x) { return x.id === id; })[0];
      // Supprime les fichiers liés
      mod.fields.forEach(function (f) { if (f.type === "file" && item && item[f.name] && item[f.name].id) DB.del("files", item[f.name].id); });
      state[modKey] = state[modKey].filter(function (x) { return x.id !== id; });
      persistNow(); persist(); toast("Supprimé", "ok"); render();
    }, true);
  }

  /* -----------------------------------------------------------------------
     Vue détaillée générique
     ----------------------------------------------------------------------- */
  function openDetail(modKey, id) {
    var mod = MODULES[modKey];
    var item = state[modKey].filter(function (x) { return x.id === id; })[0];
    if (!item) return;
    var primary = mod.fields.filter(function (f) { return f.primary; })[0];
    var title = item[primary ? primary.name : "name"] || mod.singular;

    var body = '<div class="detail-body">';
    mod.fields.forEach(function (f) {
      var v = item[f.name];
      if (v === undefined || v === null || v === "") return;
      if (f.type === "code") {
        body += '<div class="section-title">' + esc(f.label) + ' <button class="btn btn-sm" data-copy style="float:right">' + ICON.copy + "Copier</button></div>";
        body += '<pre class="code-view">' + highlightKRL(v) + "</pre>";
      } else if (f.type === "file") {
        body += '<div class="section-title">' + esc(f.label) + "</div>";
        if (f.accept && /image/.test(f.accept) && v.type && /image/.test(v.type)) {
          body += '<div data-img="' + esc(v.id) + '"></div>';
        }
        body += '<button class="btn btn-sm" data-dl>' + ICON.download + esc(v.name) + " · " + fmtBytes(v.size) + "</button>";
      } else if (f.type === "tags") {
        if (parseTags(v).length) body += '<div class="section-title">' + esc(f.label) + '</div><div style="display:flex;gap:6px;flex-wrap:wrap">' +
          parseTags(v).map(function (t) { return '<span class="chip">' + esc(t) + "</span>"; }).join("") + "</div>";
      } else if (f.type === "robotRef") {
        body += '<div class="kv" style="margin-bottom:8px"><dt>' + esc(f.label) + "</dt><dd>" + esc(robotName(v)) + "</dd></div>";
      } else if (f.type === "cellRef") {
        body += '<div class="kv" style="margin-bottom:8px"><dt>' + esc(f.label) + "</dt><dd>" + esc(cellPath(v)) + "</dd></div>";
      } else if (f.type === "textarea") {
        body += '<div class="section-title">' + esc(f.label) + '</div><p style="white-space:pre-wrap;color:var(--text-soft)">' + esc(v) + "</p>";
      } else {
        body += '<div class="kv" style="margin-bottom:8px"><dt>' + esc(f.label) + "</dt><dd>" + esc(v) + "</dd></div>";
      }
    });
    body += '<div class="hint" style="margin-top:18px">Créé le ' + fmtDate(item.createdAt) + " · Modifié le " + fmtDate(item.updatedAt) + "</div>";
    body += "</div>";

    openModal({
      title: title, wide: true, body: body,
      footer: ['<button class="btn" data-close>Fermer</button>',
        '<button class="btn" data-edit>' + ICON.edit + "Modifier</button>"],
      onMount: function (m) {
        $("[data-edit]", m).addEventListener("click", function () { closeModal(); openForm(modKey, id); });
        var cp = $("[data-copy]", m);
        if (cp) cp.addEventListener("click", function () {
          var codeField = mod.fields.filter(function (f) { return f.type === "code"; })[0];
          navigator.clipboard.writeText(item[codeField.name] || "").then(function () { toast("Code copié", "ok"); });
        });
        var dl = $("[data-dl]", m);
        if (dl) dl.addEventListener("click", function () {
          var ff = mod.fields.filter(function (f) { return f.type === "file"; })[0];
          downloadStoredFile(item[ff.name]);
        });
        var imgHolder = $("[data-img]", m);
        if (imgHolder) {
          var ff2 = mod.fields.filter(function (f) { return f.type === "file"; })[0];
          withFileURL(item[ff2.name], function (url) {
            if (url) imgHolder.innerHTML = '<img src="' + url + '" style="max-width:100%;border-radius:12px;margin-bottom:12px;border:1px solid var(--border)"/>';
          });
        }
      }
    });
  }

  /* -----------------------------------------------------------------------
     Rendu des listes (cartes / table)
     ----------------------------------------------------------------------- */
  function moduleSearchText(modKey, item) {
    var mod = MODULES[modKey];
    return mod.fields.map(function (f) {
      var v = item[f.name];
      if (f.type === "robotRef") return robotName(v);
      if (f.type === "cellRef") return cellPath(v);
      if (f.type === "tags") return parseTags(v).join(" ");
      if (f.type === "file") return v ? v.name : "";
      return v || "";
    }).join(" ").toLowerCase();
  }

  function renderModuleView(modKey) {
    var mod = MODULES[modKey];
    var wrap = node('<div class="view"></div>');
    var q = (mod._query || "").toLowerCase();

    var toolbar = node('<div class="toolbar">' +
      '<div class="search-box">' + ICON.search + '<input type="search" placeholder="Rechercher dans ' + esc(mod.label.toLowerCase()) + '…" /></div>' +
      '<div class="spacer"></div>' +
      '<button class="btn btn-primary" data-add>' + ICON.plus + "Ajouter " + esc(mod.singular) + "</button>" +
      "</div>");
    $(".search-box input", toolbar).value = mod._query || "";
    $(".search-box input", toolbar).addEventListener("input", debounce(function (e) {
      mod._query = e.target.value;
      var listHost = $("[data-list]", wrap);
      listHost.replaceWith(buildList());
    }, 150));
    $("[data-add]", toolbar).addEventListener("click", function () { openForm(modKey); });
    wrap.appendChild(toolbar);

    function items() {
      var arr = state[modKey].slice();
      if (q) arr = arr.filter(function (it) { return moduleSearchText(modKey, it).indexOf(q) >= 0; });
      return arr;
    }

    function buildList() {
      var arr = items();
      if (!arr.length) {
        return node('<div data-list><div class="empty">' + ICON[mod.icon] +
          "<h3>Aucun élément</h3><p>Commencez par ajouter " + esc(mod.singular) + ".</p></div></div>");
      }
      return mod.layout === "table" ? buildTable(arr) : buildCards(arr);
    }

    function buildCards(arr) {
      var host = node('<div data-list class="grid grid-cards"></div>');
      arr.forEach(function (it) { host.appendChild(cardFor(modKey, it)); });
      return host;
    }

    function buildTable(arr) {
      var cols = mod.columns || mod.fields.slice(0, 4).map(function (f) { return f.name; });
      var head = cols.map(function (c) { var f = fieldByName(mod, c); return "<th>" + esc(f ? f.label : c) + "</th>"; }).join("") + "<th></th>";
      var rows = arr.map(function (it) {
        var tds = cols.map(function (c) {
          var f = fieldByName(mod, c), v = it[c];
          if (c === "robotId") v = robotName(v);
          else if (f && f.type === "date") v = fmtDate(v);
          else if (c === "updatedAt") v = fmtDate(v);
          else if (f && f.type === "tags") v = parseTags(v).join(", ");
          if (c === "severity") return '<td><span class="chip ' + severityClass(it[c]) + '">' + esc(v || "—") + "</span></td>";
          return "<td>" + esc(v || "—") + "</td>";
        }).join("");
        return '<tr data-id="' + esc(it.id) + '">' + tds +
          '<td><div class="row-actions">' +
          '<button class="btn btn-sm btn-icon" data-view title="Voir">' + ICON.eye + "</button>" +
          '<button class="btn btn-sm btn-icon" data-edit title="Modifier">' + ICON.edit + "</button>" +
          '<button class="btn btn-sm btn-icon btn-danger" data-del title="Supprimer">' + ICON.trash + "</button>" +
          "</div></td></tr>";
      }).join("");
      var host = node('<div data-list class="table-wrap"><table><thead><tr>' + head + "</tr></thead><tbody>" + rows + "</tbody></table></div>");
      $$("tr[data-id]", host).forEach(function (tr) {
        var id = tr.getAttribute("data-id");
        $("[data-view]", tr).addEventListener("click", function () { openDetail(modKey, id); });
        $("[data-edit]", tr).addEventListener("click", function () { openForm(modKey, id); });
        $("[data-del]", tr).addEventListener("click", function () { deleteItem(modKey, id); });
      });
      return host;
    }

    wrap.appendChild(buildList());
    return wrap;
  }

  function severityClass(s) {
    if (s === "Critique" || s === "Erreur") return "danger";
    if (s === "Avertissement") return "warn";
    if (s === "Info") return "info";
    return "";
  }

  function cardFor(modKey, it) {
    var mod = MODULES[modKey];
    var primary = mod.fields.filter(function (f) { return f.primary; })[0];
    var title = it[primary ? primary.name : "name"] || "(sans titre)";
    var sub = "", metaChips = "", desc = "";

    if (modKey === "robots") {
      sub = (it.model || "—") + " · " + (it.controller || "KRC ?");
      metaChips = chip(it.kss ? "KSS " + it.kss : "") + chip(it.cell) + statusChip(it.status);
      desc = (it.cellId && orgNode(it.cellId)) ? cellPath(it.cellId) : ((it.site ? it.site + " — " : "") + (it.sector || ""));
    } else if (modKey === "functions") {
      sub = (it.category || "Fonction") + (it.params ? " " + it.params : "");
      metaChips = parseTags(it.tags).slice(0, 3).map(function (t) { return chip(t); }).join("");
      desc = it.description || "";
    } else if (modKey === "documents") {
      sub = (it.category || "Document") + (it.robotModel ? " · " + it.robotModel : "");
      metaChips = it.file ? chip(fmtBytes(it.file.size)) : "";
      desc = it.description || "";
    } else if (modKey === "instructions") {
      sub = (it.robotId ? robotName(it.robotId) : "Général") + (it.sector ? " · " + it.sector : "");
      metaChips = parseTags(it.tags).slice(0, 3).map(function (t) { return chip(t); }).join("");
      desc = it.content || "";
    } else if (modKey === "standards") {
      sub = it.category || "Standard";
      desc = it.content || "";
    } else if (modKey === "contacts") {
      sub = [it.role, it.company].filter(Boolean).join(" · ");
      metaChips = chip(it.phone) + chip(it.email);
      desc = it.notes || "";
    }

    var card = node('<div class="entity">' +
      '<div class="entity-head">' +
      '<div class="entity-ico">' + ICON[mod.icon] + "</div>" +
      '<div style="flex:1;min-width:0"><div class="entity-title">' + esc(title) + '</div><div class="entity-sub">' + esc(sub) + "</div></div>" +
      "</div>" +
      (metaChips ? '<div class="entity-meta">' + metaChips + "</div>" : "") +
      (desc ? '<div class="entity-desc">' + esc(desc) + "</div>" : "") +
      '<div class="entity-foot"><span class="chip">' + fmtDate(it.updatedAt) + "</span>" +
      '<div class="entity-actions">' +
      '<button class="btn btn-sm btn-icon" data-edit title="Modifier">' + ICON.edit + "</button>" +
      '<button class="btn btn-sm btn-icon btn-danger" data-del title="Supprimer">' + ICON.trash + "</button>" +
      "</div></div></div>");

    card.addEventListener("click", function (e) {
      if (e.target.closest("[data-edit]") || e.target.closest("[data-del]")) return;
      openDetail(modKey, it.id);
    });
    $("[data-edit]", card).addEventListener("click", function () { openForm(modKey, it.id); });
    $("[data-del]", card).addEventListener("click", function () { deleteItem(modKey, it.id); });
    return card;

    function chip(v) { return v ? '<span class="chip">' + esc(v) + "</span>" : ""; }
    function statusChip(v) {
      if (!v) return "";
      var cls = v === "En production" ? "ok" : (v === "En maintenance" ? "warn" : (v === "À l'arrêt" ? "danger" : ""));
      return '<span class="chip ' + cls + '">' + esc(v) + "</span>";
    }
  }

  /* -----------------------------------------------------------------------
     Hiérarchie du parc : Sites › Lignes › Cellules › Robots
     ----------------------------------------------------------------------- */
  function renderHierarchy() {
    var wrap = node('<div class="view"></div>');
    var sites = orgChildren(null, "site");
    var nbLignes = state.org.filter(function (n) { return n.type === "ligne"; }).length;
    var nbCell = cellulesList().length;
    var nbAff = state.robots.filter(function (r) { return r.cellId && orgNode(r.cellId); }).length;

    var toolbar = node('<div class="toolbar">' +
      '<div><strong style="font-size:15px">Organisation du parc</strong>' +
      '<div class="hint">' + sites.length + " site(s) · " + nbLignes + " ligne(s) · " + nbCell + " cellule(s) · " +
      nbAff + "/" + state.robots.length + " robot(s) affecté(s)</div></div>" +
      '<div class="spacer"></div>' +
      '<button class="btn btn-primary" data-add-site>' + ICON.plus + "Ajouter un site</button></div>");
    $("[data-add-site]", toolbar).addEventListener("click", function () { openOrgForm("site", null); });
    wrap.appendChild(toolbar);

    if (!sites.length) {
      wrap.appendChild(node('<div class="empty">' + ICON.folder +
        "<h3>Aucun site</h3><p>Créez un site, puis des lignes et des cellules pour organiser vos robots.</p></div>"));
      return wrap;
    }

    var panel = node('<div class="panel"><div class="tree"></div></div>');
    var tree = $(".tree", panel);
    sites.forEach(function (s) { tree.appendChild(buildOrgNode(s)); });
    wrap.appendChild(panel);

    // Robots non affectés
    var orphans = state.robots.filter(function (r) { return !r.cellId || !orgNode(r.cellId); });
    if (orphans.length) {
      var op = node('<div class="panel" style="margin-top:16px"><h3>' + ICON.robot + "Robots non affectés (" + orphans.length + ")</h3></div>");
      orphans.forEach(function (r) {
        var row = node('<div class="tree-row"><span class="nav-icon">' + ICON.robot + '</span>' +
          '<span style="flex:1">' + esc(r.name) + '</span><span class="chip">' + esc(r.model || "—") + "</span>" +
          '<button class="btn btn-sm" data-assign style="margin-left:8px">Affecter</button></div>');
        $("[data-assign]", row).addEventListener("click", function (e) { e.stopPropagation(); openAssignRobot(r.id); });
        row.addEventListener("click", function (e) { if (!e.target.closest("[data-assign]")) openDetail("robots", r.id); });
        op.appendChild(row);
      });
      wrap.appendChild(op);
    }
    return wrap;
  }

  function buildOrgNode(n) {
    var childType = n.type === "site" ? "ligne" : (n.type === "ligne" ? "cellule" : null);
    var icon = n.type === "cellule" ? ICON.chip : ICON.folder;
    var el = node('<div class="tree-node open"></div>');

    var countTxt;
    if (n.type === "cellule") countTxt = robotsInCell(n.id).length + " robot(s)";
    else countTxt = orgChildren(n.id, childType).length + (childType === "ligne" ? " ligne(s)" : " cellule(s)");

    var actions = "";
    if (childType) actions += '<button class="btn btn-sm btn-icon" data-add title="Ajouter">' + ICON.plus + "</button>";
    if (n.type === "cellule") actions += '<button class="btn btn-sm btn-icon" data-assign title="Affecter des robots">' + ICON.robot + "</button>";
    actions += '<button class="btn btn-sm btn-icon" data-edit title="Renommer">' + ICON.edit + "</button>";
    actions += '<button class="btn btn-sm btn-icon btn-danger" data-del title="Supprimer">' + ICON.trash + "</button>";

    var row = node('<div class="tree-row">' +
      '<span class="tree-caret">' + ICON.chevron + "</span>" +
      '<span class="nav-icon">' + icon + "</span>" +
      '<span style="flex:1;font-weight:600">' + esc(n.name) + "</span>" +
      '<span class="chip">' + countTxt + "</span>" +
      '<span class="entity-actions" style="margin-left:8px">' + actions + "</span></div>");
    el.appendChild(row);

    var children = node('<div class="tree-children"></div>');
    if (n.type === "cellule") {
      var robs = robotsInCell(n.id);
      if (!robs.length) children.appendChild(node('<div class="hint" style="padding:6px 8px">Aucun robot affecté.</div>'));
      robs.forEach(function (r) {
        var leaf = node('<div class="tree-row"><span style="width:14px"></span><span class="nav-icon">' + ICON.robot + "</span>" +
          '<span style="flex:1">' + esc(r.name) + '</span><span class="chip">' + esc(r.model || "—") + "</span></div>");
        leaf.addEventListener("click", function () { openDetail("robots", r.id); });
        children.appendChild(leaf);
      });
    } else {
      var kids = orgChildren(n.id, childType);
      if (!kids.length) children.appendChild(node('<div class="hint" style="padding:6px 8px">Vide — ajoutez ' +
        (childType === "ligne" ? "une ligne" : "une cellule") + ".</div>"));
      kids.forEach(function (k) { children.appendChild(buildOrgNode(k)); });
    }
    el.appendChild(children);

    $(".tree-caret", row).addEventListener("click", function (e) { e.stopPropagation(); el.classList.toggle("open"); });
    var addBtn = $("[data-add]", row); if (addBtn) addBtn.addEventListener("click", function (e) { e.stopPropagation(); openOrgForm(childType, n.id); });
    var asg = $("[data-assign]", row); if (asg) asg.addEventListener("click", function (e) { e.stopPropagation(); openAssignToCell(n.id); });
    $("[data-edit]", row).addEventListener("click", function (e) { e.stopPropagation(); openOrgForm(n.type, n.parentId, n.id); });
    $("[data-del]", row).addEventListener("click", function (e) { e.stopPropagation(); deleteOrgNode(n); });
    return el;
  }

  function openOrgForm(type, parentId, id) {
    var L = { site: "site", ligne: "ligne", cellule: "cellule" };
    var ph = { site: "Usine Nord", ligne: "Ligne Carrosserie", cellule: "Cellule A1" };
    var existing = id ? orgNode(id) : null;
    var data = existing || {};
    var html = '<div class="field"><label for="org_name">Nom du ' + L[type] + ' *</label>' +
      '<input id="org_name" class="input" value="' + esc(data.name || "") + '" placeholder="ex. ' + ph[type] + '" /></div>' +
      '<div class="field"><label for="org_note">Note</label><textarea id="org_note" class="input">' + esc(data.note || "") + "</textarea></div>";
    openModal({
      title: (existing ? "Renommer " : "Ajouter ") + "un " + L[type], body: html,
      footer: ['<button class="btn" data-close>Annuler</button>',
        '<button class="btn btn-primary" data-save>' + ICON.check + "Enregistrer</button>"],
      onMount: function (m) {
        $("[data-save]", m).addEventListener("click", function () {
          var name = $("#org_name", m).value.trim();
          if (!name) { toast("Le nom est requis", "warn"); return; }
          var note = $("#org_note", m).value.trim();
          if (existing) { existing.name = name; existing.note = note; existing.updatedAt = nowISO(); }
          else { state.org.push({ id: uid(), type: type, parentId: parentId || null, name: name, note: note, createdAt: nowISO(), updatedAt: nowISO() }); }
          persistNow(); persist(); closeModal(); render(); toast("Enregistré", "ok");
        });
      }
    });
  }

  function deleteOrgNode(n) {
    var kids = descendantsOf(n.id);
    var msg = kids.length
      ? "Supprimer « " + n.name + " » et tout son contenu (" + kids.length + " élément(s)) ? Les robots seront détachés."
      : "Supprimer « " + n.name + " » ?";
    confirmDialog(msg, function () {
      var toRemove = [n.id].concat(kids);
      state.org = state.org.filter(function (x) { return toRemove.indexOf(x.id) < 0; });
      state.robots.forEach(function (r) { if (r.cellId && toRemove.indexOf(r.cellId) >= 0) delete r.cellId; });
      persistNow(); persist(); render(); toast("Supprimé", "ok");
    }, true);
  }

  function openAssignToCell(cellId) {
    var cell = orgNode(cellId);
    var body = state.robots.length ? state.robots.map(function (r) {
      var checked = r.cellId === cellId ? "checked" : "";
      var where = (r.cellId && r.cellId !== cellId && orgNode(r.cellId)) ? ' <span class="hint">(' + esc(cellPath(r.cellId)) + ")</span>" : "";
      return '<label style="display:flex;align-items:center;gap:10px;padding:9px 4px;border-bottom:1px solid var(--border)">' +
        '<input type="checkbox" data-r="' + esc(r.id) + '" ' + checked + "/>" +
        '<span style="flex:1">' + esc(r.name) + where + '</span><span class="chip">' + esc(r.model || "—") + "</span></label>";
    }).join("") : '<div class="hint">Aucun robot. Ajoutez-en d\'abord dans « Parc robots ».</div>';
    openModal({
      title: "Affecter des robots — " + (cell ? cell.name : ""), body: body,
      footer: ['<button class="btn" data-close>Annuler</button>',
        '<button class="btn btn-primary" data-save>' + ICON.check + "Enregistrer</button>"],
      onMount: function (m) {
        $("[data-save]", m).addEventListener("click", function () {
          $$("[data-r]", m).forEach(function (cb) {
            var rob = state.robots.filter(function (x) { return x.id === cb.getAttribute("data-r"); })[0];
            if (!rob) return;
            if (cb.checked) rob.cellId = cellId;
            else if (rob.cellId === cellId) delete rob.cellId;
          });
          persistNow(); persist(); closeModal(); render(); toast("Affectation mise à jour", "ok");
        });
      }
    });
  }

  function openAssignRobot(robotId) {
    var rob = state.robots.filter(function (x) { return x.id === robotId; })[0];
    var cells = cellulesList();
    if (!cells.length) { toast("Créez d'abord une cellule", "warn"); return; }
    var html = '<div class="field"><label for="asg_cell">Affecter « ' + esc(rob.name) + ' » à la cellule</label>' +
      '<select id="asg_cell" class="input">' + cells.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.path) + "</option>"; }).join("") + "</select></div>";
    openModal({
      title: "Affecter un robot", body: html,
      footer: ['<button class="btn" data-close>Annuler</button>',
        '<button class="btn btn-primary" data-save>' + ICON.check + "Enregistrer</button>"],
      onMount: function (m) {
        $("[data-save]", m).addEventListener("click", function () {
          rob.cellId = $("#asg_cell", m).value; persistNow(); persist(); closeModal(); render(); toast("Robot affecté", "ok");
        });
      }
    });
  }

  /* -----------------------------------------------------------------------
     Tableau de bord
     ----------------------------------------------------------------------- */
  function renderDashboard() {
    var wrap = node('<div class="view"></div>');
    var stats = [
      { key: "robots", label: "Robots", icon: "robot" },
      { key: "programs", label: "Programmes", icon: "code" },
      { key: "functions", label: "Fonctions", icon: "fx" },
      { key: "documents", label: "Documents", icon: "file" },
      { key: "faults", label: "Codes défaut", icon: "alert" },
      { key: "maintenance", label: "Interventions", icon: "wrench" }
    ];
    var grid = node('<div class="grid grid-stats"></div>');
    stats.forEach(function (s) {
      var c = node('<div class="card hover stat" style="cursor:pointer">' +
        '<div class="stat-top"><div class="stat-lbl">' + esc(s.label) + '</div><div class="stat-ico">' + ICON[s.icon] + "</div></div>" +
        '<div class="stat-val">' + state[s.key].length + "</div></div>");
      c.addEventListener("click", function () { go(s.key); });
      grid.appendChild(c);
    });
    wrap.appendChild(grid);

    // Robots en aperçu
    wrap.appendChild(node('<div class="section-title">Parc robots</div>'));
    if (state.robots.length) {
      var rg = node('<div class="grid grid-cards"></div>');
      state.robots.slice(0, 6).forEach(function (r) { rg.appendChild(cardFor("robots", r)); });
      wrap.appendChild(rg);
    } else {
      wrap.appendChild(node('<div class="empty">' + ICON.robot + "<h3>Aucun robot</h3><p>Ajoutez votre premier robot dans « Parc robots ».</p></div>"));
    }

    // Dernières modifications
    var recent = [];
    Object.keys(MODULES).forEach(function (k) {
      state[k].forEach(function (it) { recent.push({ mod: k, it: it }); });
    });
    recent.sort(function (a, b) { return (a.it.updatedAt || "") < (b.it.updatedAt || "") ? 1 : -1; });
    recent = recent.slice(0, 8);
    if (recent.length) {
      wrap.appendChild(node('<div class="section-title">Activité récente</div>'));
      var rows = recent.map(function (r) {
        var mod = MODULES[r.mod];
        var prim = mod.fields.filter(function (f) { return f.primary; })[0];
        var t = r.it[prim ? prim.name : "name"] || "(sans titre)";
        return '<tr data-mod="' + r.mod + '" data-id="' + esc(r.it.id) + '">' +
          "<td>" + ICON[mod.icon] + " " + esc(mod.label) + "</td><td>" + esc(t) + "</td><td>" + fmtDate(r.it.updatedAt) + "</td></tr>";
      }).join("");
      var tbl = node('<div class="table-wrap"><table><thead><tr><th>Module</th><th>Élément</th><th>Modifié</th></tr></thead><tbody>' + rows + "</tbody></table></div>");
      $$("tr[data-id]", tbl).forEach(function (tr) {
        tr.style.cursor = "pointer";
        tr.addEventListener("click", function () { openDetail(tr.getAttribute("data-mod"), tr.getAttribute("data-id")); });
      });
      wrap.appendChild(tbl);
    }
    return wrap;
  }

  /* -----------------------------------------------------------------------
     Recherche globale
     ----------------------------------------------------------------------- */
  function renderSearch(query) {
    var wrap = node('<div class="view"></div>');
    var q = (query || "").toLowerCase().trim();
    if (!q) { wrap.appendChild(node('<div class="empty">' + ICON.search + "<h3>Recherche globale</h3><p>Saisissez un terme dans la barre de gauche.</p></div>")); return wrap; }
    var results = [];
    Object.keys(MODULES).forEach(function (k) {
      state[k].forEach(function (it) { if (moduleSearchText(k, it).indexOf(q) >= 0) results.push({ mod: k, it: it }); });
    });
    wrap.appendChild(node('<div class="section-title">' + results.length + ' résultat(s) pour « ' + esc(query) + ' »</div>'));
    if (!results.length) { wrap.appendChild(node('<div class="empty">' + ICON.search + "<h3>Aucun résultat</h3></div>")); return wrap; }
    var grid = node('<div class="grid grid-cards"></div>');
    results.slice(0, 60).forEach(function (r) {
      var mod = MODULES[r.mod];
      var prim = mod.fields.filter(function (f) { return f.primary; })[0];
      var t = r.it[prim ? prim.name : "name"] || "(sans titre)";
      var c = node('<div class="entity"><div class="entity-head"><div class="entity-ico">' + ICON[mod.icon] + "</div>" +
        '<div style="flex:1"><div class="entity-title">' + esc(t) + '</div><div class="entity-sub">' + esc(mod.label) + "</div></div></div></div>");
      c.addEventListener("click", function () { openDetail(r.mod, r.it.id); });
      grid.appendChild(c);
    });
    wrap.appendChild(grid);
    return wrap;
  }

  /* -----------------------------------------------------------------------
     Gestion des données (export / import / sauvegardes)
     ----------------------------------------------------------------------- */
  function openDataManager() {
    var body = '<p style="color:var(--text-soft);margin-bottom:16px">Toutes vos données sont stockées localement sur ce poste. Exportez régulièrement pour ne rien perdre.</p>' +
      '<div style="display:flex;flex-direction:column;gap:10px">' +
      '<button class="btn btn-primary" data-export>' + ICON.download + "Exporter tout (avec fichiers) — .json</button>" +
      '<button class="btn" data-import>' + ICON.copy + "Importer une sauvegarde .json</button>" +
      "</div>" +
      '<div class="section-title">Sauvegardes automatiques</div>' +
      '<div data-backups class="hint">Chargement…</div>' +
      '<div class="section-title" style="color:var(--danger)">Zone sensible</div>' +
      '<button class="btn btn-danger btn-sm" data-reset>' + ICON.trash + "Réinitialiser toutes les données</button>" +
      '<input type="file" accept="application/json" data-file hidden />';

    openModal({
      title: "Données & sauvegardes", body: body,
      footer: ['<button class="btn" data-close>Fermer</button>'],
      onMount: function (m) {
        $("[data-export]", m).addEventListener("click", exportAll);
        $("[data-import]", m).addEventListener("click", function () { $("[data-file]", m).click(); });
        $("[data-file]", m).addEventListener("change", function (e) { if (e.target.files[0]) importAll(e.target.files[0]); });
        $("[data-reset]", m).addEventListener("click", function () {
          confirmDialog("Effacer TOUTES les données et fichiers ? Cette action est irréversible.", function () {
            localStorage.removeItem(STORAGE_KEY);
            DB.clear("files"); DB.clear("backups");
            state = seed(defaultState()); persistNow(); closeModal(); render(); toast("Données réinitialisées", "ok");
          }, true);
        });
        // Liste des sauvegardes
        DB.all("backups").then(function (all) {
          all.sort(function (a, b) { return a.ts < b.ts ? 1 : -1; });
          var host = $("[data-backups]", m);
          if (!all.length) { host.textContent = "Aucune sauvegarde pour le moment."; return; }
          host.classList.remove("hint");
          host.innerHTML = all.slice(0, 10).map(function (b) {
            return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">' +
              '<span class="chip">' + new Date(b.ts).toLocaleString("fr-FR") + "</span>" +
              '<button class="btn btn-sm" data-restore="' + b.id + '" style="margin-left:auto">Restaurer</button></div>';
          }).join("");
          $$("[data-restore]", host).forEach(function (btn) {
            btn.addEventListener("click", function () {
              var b = all.filter(function (x) { return x.id === btn.getAttribute("data-restore"); })[0];
              confirmDialog("Restaurer cette sauvegarde ? L'état actuel sera remplacé.", function () {
                state = migrate(JSON.parse(b.data)); persistNow(); closeModal(); render(); toast("Sauvegarde restaurée", "ok");
              });
            });
          });
        });
      }
    });
  }

  function exportAll() {
    toast("Préparation de l'export…");
    DB.all("files").then(function (files) {
      var fileProms = files.map(function (rec) {
        return new Promise(function (res) {
          var fr = new FileReader();
          fr.onload = function () { res({ id: rec.id, name: rec.name, type: rec.type, size: rec.size, b64: fr.result }); };
          fr.onerror = function () { res(null); };
          fr.readAsDataURL(rec.blob);
        });
      });
      return Promise.all(fileProms);
    }).then(function (files) {
      var payload = { app: "kuka-robot-hub", exportedAt: nowISO(), state: state, files: files.filter(Boolean) };
      var blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = "kuka-hub-sauvegarde-" + todayISO() + ".json";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast("Export terminé", "ok");
    });
  }

  function importAll(file) {
    var fr = new FileReader();
    fr.onload = function () {
      var payload;
      try { payload = JSON.parse(fr.result); } catch (e) { toast("Fichier invalide", "danger"); return; }
      if (!payload.state) { toast("Format non reconnu", "danger"); return; }
      confirmDialog("Importer cette sauvegarde ? Les données actuelles seront remplacées.", function () {
        var fileProms = (payload.files || []).map(function (f) {
          return fetch(f.b64).then(function (r) { return r.blob(); }).then(function (blob) {
            return DB.put("files", { id: f.id, name: f.name, type: f.type, size: f.size, blob: blob });
          });
        });
        Promise.all(fileProms).then(function () {
          state = migrate(payload.state); persistNow(); closeModal(); render(); toast("Import réussi", "ok");
        });
      });
    };
    fr.readAsText(file);
  }

  /* -----------------------------------------------------------------------
     Navigation & rendu
     ----------------------------------------------------------------------- */
  var renderers = {
    dashboard: renderDashboard,
    hierarchy: renderHierarchy,
    __search: function () { return renderSearch(state.settings._search); }
  };
  Object.keys(MODULES).forEach(function (k) { renderers[k] = function () { return renderModuleView(k); }; });

  var VIEW_META = {
    dashboard: { title: "Tableau de bord", sub: "Vue d'ensemble du référentiel" },
    hierarchy: { title: "Hiérarchie du parc", sub: "Organisation Sites › Lignes › Cellules et rattachement des robots" },
    __search: { title: "Recherche", sub: "" }
  };
  Object.keys(MODULES).forEach(function (k) { VIEW_META[k] = { title: MODULES[k].label, sub: MODULES[k].sub }; });

  function buildNav() {
    var nav = $("#nav");
    nav.innerHTML = "";
    // Pilotage
    nav.appendChild(navItem("dashboard", "Tableau de bord", "dashboard"));
    NAV_GROUPS.slice(1).forEach(function (g) {
      nav.appendChild(node('<div class="nav-group-label">' + esc(g) + "</div>"));
      if (g === "Robotique") nav.appendChild(navItem("hierarchy", "Hiérarchie du parc", "folder", cellulesList().length));
      Object.keys(MODULES).forEach(function (k) {
        if (MODULES[k].group === g) nav.appendChild(navItem(k, MODULES[k].label, MODULES[k].icon, state[k].length));
      });
    });
  }
  function navItem(view, label, icon, count) {
    var it = node('<div class="nav-item" data-view="' + view + '">' +
      '<span class="nav-icon">' + ICON[icon] + "</span>" +
      '<span class="nav-label">' + esc(label) + "</span>" +
      (count !== undefined ? '<span class="nav-count">' + count + "</span>" : "") + "</div>");
    it.addEventListener("click", function () { go(view); });
    return it;
  }

  function go(view) {
    state.settings.view = view;
    state.settings._search = "";
    persist();
    render();
    // Ferme le menu mobile
    $("#app").classList.remove("nav-open");
  }

  function render() {
    var view = state.settings.view || "dashboard";
    if (state.settings._search) view = "__search";
    var meta = VIEW_META[view] || { title: "", sub: "" };
    $("#viewTitle").textContent = meta.title;
    $("#viewSub").textContent = meta.sub || "";

    // Actif dans la nav
    $$(".nav-item").forEach(function (n) { n.classList.toggle("active", n.getAttribute("data-view") === view); });

    var host = $("#content");
    host.innerHTML = "";
    var fn = renderers[view] || renderers.dashboard;
    host.appendChild(fn());

    // Met à jour les compteurs de la nav
    Object.keys(MODULES).forEach(function (k) {
      var n = $('.nav-item[data-view="' + k + '"] .nav-count');
      if (n) n.textContent = state[k].length;
    });
    var hc = $('.nav-item[data-view="hierarchy"] .nav-count');
    if (hc) hc.textContent = cellulesList().length;
  }

  /* -----------------------------------------------------------------------
     Initialisation
     ----------------------------------------------------------------------- */
  function init() {
    loadState();
    document.documentElement.setAttribute("data-theme", state.settings.theme || "kuka");
    buildNav();

    // Recherche globale
    $("#globalSearch").addEventListener("input", debounce(function (e) {
      state.settings._search = e.target.value;
      render();
    }, 200));

    // Boutons barre latérale
    $("#btnTheme").addEventListener("click", openThemePicker);
    $("#btnBackup").addEventListener("click", openDataManager);
    $("#btnMenu").addEventListener("click", function () { $("#app").classList.toggle("nav-open"); });

    render();

    // Masque le splash
    setTimeout(function () {
      $("#splash").classList.add("hide");
      $("#app").hidden = false;
      setTimeout(function () { var s = $("#splash"); if (s) s.remove(); }, 450);
    }, 400);
  }

  function openThemePicker() {
    var body = '<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr))">' +
      THEMES.map(function (t) {
        return '<button class="btn" data-theme-id="' + t.id + '" style="justify-content:flex-start">' +
          (state.settings.theme === t.id ? ICON.check : ICON.theme) + esc(t.label) + "</button>";
      }).join("") + "</div>";
    openModal({
      title: "Choisir un thème", body: body,
      footer: ['<button class="btn" data-close>Fermer</button>'],
      onMount: function (m) {
        $$("[data-theme-id]", m).forEach(function (b) {
          b.addEventListener("click", function () { applyTheme(b.getAttribute("data-theme-id")); closeModal(); toast("Thème appliqué", "ok"); });
        });
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
