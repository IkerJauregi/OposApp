"use strict";

(function () {
  const DEFAULTS = {
    url: "",
    anonKey: "",
    questionsTable: "questions",
    reportsTable: "question_reports",
    siteName: "Simulador OPE Euskadi",
  };

  function getConfig() {
    const config = window.OposAppConfig?.supabase || {};
    return {
      ...DEFAULTS,
      ...config,
    };
  }

  function hasConfig() {
    const config = getConfig();
    return Boolean(config.url && config.anonKey);
  }

  function getClient() {
    if (!hasConfig()) {
      throw new Error("Falta la configuración pública de Supabase.");
    }

    if (!window.supabase?.createClient) {
      throw new Error("La librería de Supabase no está cargada en la página.");
    }

    if (!window.__oposAppSupabaseClient) {
      const config = getConfig();
      window.__oposAppSupabaseClient = window.supabase.createClient(config.url, config.anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      });
    }

    return window.__oposAppSupabaseClient;
  }

  window.OposAppSupabase = {
    getConfig,
    getClient,
    hasConfig,
  };
})();
