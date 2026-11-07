export const FRONTEND_SHA = import.meta.env.VITE_BUILD_SHA || 'dev';
export const FRONTEND_VERSION = import.meta.env.VITE_APP_VERSION || 'development';
export const FRONTEND_SOURCE_URL = `https://github.com/L-aros/mailflow-plus/tree/${/^[a-f0-9]{40}$/.test(FRONTEND_SHA) ? FRONTEND_SHA : 'mailflow-plus'}`;
