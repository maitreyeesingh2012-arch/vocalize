// Deployment settings for this bundle.
//
// On the website these can stay empty: the app talks to the server it was loaded from.
// The native apps load this bundle from the device (capacitor://localhost), so they must
// point at your hosted server. mobile/scripts/sync-web.mjs rewrites this file when it
// copies the web app into the native project, using VOCALIZE_API_BASE.
window.VOCALIZE_CONFIG = {
  apiBase: '',      // e.g. 'https://api.vocalize.app' in the native apps
};
