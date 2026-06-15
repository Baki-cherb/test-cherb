# KUKA Robot Hub

Référentiel technique pour vos robots **KUKA** — pensé pour être **complémentaire** d'Atlas-AAI
et construit avec la même approche : **HTML + CSS + JavaScript vanilla** (aucun framework, aucun build),
données **100 % locales** et **hors-ligne**, empaqueté en **application de bureau Windows** via Electron.

## ✨ Fonctionnalités

Tout ce qui concerne vos robots, au même endroit :

| Module | Description |
|--------|-------------|
| **Tableau de bord** | Vue d'ensemble, compteurs, activité récente |
| **Parc robots** | Cartes signalétiques : modèle, contrôleur **KRC**, version **KSS**, n° de série, axes, charge, portée, site, cellule, secteur, photo |
| **Programmes** | Archives `.src` / `.dat` / `.zip` + **journal de ce qui a été fait dans le code** (versions, mots-clés, robot lié) |
| **Bibliothèque de fonctions** | Toutes vos fonctions **KRL** réutilisables (paramètres, description, code avec coloration syntaxique, copier en un clic) |
| **Variables** | Catalogue des variables : type, portée, valeur/déclaration, robot |
| **Instructions de travail** | Par robot et par secteur |
| **Standards de programmation** | Règles de nommage, structure, sécurité, E/S… |
| **Documents KUKA** | Manuels, notices, datasheets, schémas (fichiers stockés localement) |
| **Codes défaut** | Base de connaissances : code, cause, solution, gravité |
| **Maintenance** | Journal des interventions (préventive, corrective, mastering…) |
| **Contacts** | Support KUKA, intégrateurs, fournisseurs |
| **Glossaire** | Termes et abréviations |

Plus : **recherche globale**, **thèmes** multiples (KUKA Orange, Minuit, Carbone, Émeraude, Clair),
interface **entièrement en français**, **responsive**.

## 🗄️ Données & sécurité

- **`localStorage`** : données structurées (state) + fonction `migrate()` d'évolution du schéma.
- **IndexedDB** : fichiers binaires (programmes, documents, photos) + **sauvegardes automatiques** (20 dernières).
- **Jamais de perte** : export / import complet `.json` (fichiers inclus en base64) via le bouton **Données**.
- Aucune connexion réseau requise — tout reste sur le poste.

## 🚀 Lancer en développement

```bash
npm install
npm start
```

> Sans Electron, vous pouvez aussi simplement ouvrir `index.html` dans un navigateur récent.

## 📦 Générer l'installateur Windows

```bash
npm install
npm run dist:win
```

L'installateur **NSIS** est produit dans `release/`. Installation **par utilisateur**
(`oneClick`, **sans droits administrateur**), avec raccourcis Bureau et Menu Démarrer.

> Placez votre logo dans `build/icon.ico` (256×256). Sinon l'icône Electron par défaut est utilisée.

## 🧱 Architecture (vanilla, dans l'esprit d'Atlas-AAI)

- `index.html` + `css/styles.css` + `js/app.js` — **une seule IIFE**, aucun build.
- Rendu maison : `render()` → `renderers[vue]()`, méta-données `VIEW_META`, chaque vue renvoie un nœud DOM.
- Moteur **piloté par configuration** : l'objet `MODULES` décrit chaque module (champs, mise en page) ;
  ajouter un module = ajouter une entrée, sans réécrire les formulaires, listes ni la vue détail.
- Helpers : `$ / $$`, `esc()`, `openModal / closeModal`, `confirmDialog`, `toast()`, objet `ICON` (SVG en ligne).
- Thèmes via variables CSS + `[data-theme]`, `color-mix`, fond en trame de points, animations d'apparition.
