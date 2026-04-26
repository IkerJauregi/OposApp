"use strict";

(function () {
  const root = document.getElementById("app");
  const LETTERS = ["A", "B", "C", "D"];
  const STORAGE_KEYS = {
    setup: "ope-euskadi-setup-v1",
    stats: "ope-euskadi-stats-v1",
  };
  const DEFAULT_SETUP = {
    mode: "practice",
    document: "all",
    amount: 25,
    shuffle: true,
    examMinutes: 15,
  };
  const QUESTION_BANK_SOURCES = ["data/preguntas-bateria-comun.json", "data/preguntas-celador.json"];
  const QUESTION_BANK_FALLBACK_SOURCE = "data/preguntas.json";
  const DOCUMENT_LABELS = {
    BATERIA_COMUN: "Batería común",
    CELADOR: "Celador",
  };
  const OCR_WARNING_PATTERN =
    /Opci.n no disponible|error OCR|\(Correct|\bJncorrecta\b|Incor-\s*recta|Cor-\s*recta/i;
  const IS_ALT_HOME = /(^|[\\/])index2\.html$/i.test(window.location.pathname);

  const state = {
    questions: [],
    documents: [],
    meta: {
      rawCount: 0,
      validCount: 0,
      droppedCount: 0,
    },
    setup: { ...DEFAULT_SETUP },
    stats: createDefaultStats(),
    storageAvailable: false,
    session: null,
    summary: null,
    timerId: null,
    isStatsPanelOpen: false,
    dataStatus: "idle",
    dataError: "",
    canUseJsonFallback: false,
    activeDataSource: "supabase",
    authReady: false,
    userId: null,
    userEmail: "",
    isAdmin: false,
  };

  function createDefaultStats() {
    return {
      totalSessions: 0,
      practiceSessions: 0,
      examSessions: 0,
      totalQuestions: 0,
      totalCorrect: 0,
      totalIncorrect: 0,
      totalUnanswered: 0,
      bestScoreOverTen: 0,
      bestPercentage: 0,
      lastScoreOverTen: null,
      lastPlayedAt: null,
      currentStreak: 0,
      bestStreak: 0,
      recentSessions: [],
    };
  }

  function repairMojibake(value) {
    const text = String(value ?? "");
    if (!/[ÃƒÃ¢â‚¬]/.test(text)) {
      return text;
    }

    try {
      const bytes = Uint8Array.from(Array.from(text, (char) => char.charCodeAt(0)));
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      return decoded.includes("ï¿½") ? text : decoded;
    } catch {
      return text;
    }
  }

  function cleanText(value) {
    let text = repairMojibake(value);

    text = text.replace(
      /(?:En cumpimiento|En cumplimiento|Totono:|Telono:).+?Ramon Montenegro 32,\s*27002\s*\(LUGO\)/gi,
      " ",
    );
    text = text.replace(
      /Puede ejercer sus derechos de acceso.+?Ramon Montenegro 32,\s*27002\s*\(LUGO\)/gi,
      " ",
    );
    text = text.replace(/\(\s*(?:Correct|Correcta|Incorrecta|Jncorrecta)\s*\)/gi, " ");
    text = text.replace(/\(\s*(?:Cor|Incor)-\s*recta\s*\)/gi, " ");
    text = text.replace(/\s*~\s*/g, " ");
    text = text.replace(/\s+/g, " ").trim();

    return text;
  }

  function toTitleCase(value) {
    return value
      .toLowerCase()
      .split(" ")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  function formatDocumentName(value) {
    if (!value) {
      return "Sin categoría";
    }

    if (DOCUMENT_LABELS[value]) {
      return DOCUMENT_LABELS[value];
    }

    return toTitleCase(cleanText(String(value).replace(/_/g, " ")));
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function shuffleArray(items) {
    const cloned = [...items];
    for (let index = cloned.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [cloned[index], cloned[swapIndex]] = [cloned[swapIndex], cloned[index]];
    }
    return cloned;
  }

  function recommendedExamMinutes(questionCount) {
    if (!questionCount) {
      return 0;
    }

    return Math.max(1, Math.ceil(questionCount * 0.6));
  }

  function formatTime(totalSeconds) {
    const seconds = Math.max(0, totalSeconds);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  }

  function safeStorage() {
    try {
      if (!window.localStorage) {
        return null;
      }

      const probeKey = "__ope_euskadi_probe__";
      window.localStorage.setItem(probeKey, "1");
      window.localStorage.removeItem(probeKey);
      return window.localStorage;
    } catch {
      return null;
    }
  }

  function readStorageJson(key, fallbackValue) {
    const storage = safeStorage();
    if (!storage) {
      return fallbackValue;
    }

    try {
      const rawValue = storage.getItem(key);
      if (!rawValue) {
        return fallbackValue;
      }
      return JSON.parse(rawValue);
    } catch {
      return fallbackValue;
    }
  }

  function writeStorageJson(key, value) {
    const storage = safeStorage();
    if (!storage) {
      return false;
    }

    try {
      storage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function loadPersistedSetup() {
    const savedSetup = readStorageJson(STORAGE_KEYS.setup, null);
    if (!savedSetup || typeof savedSetup !== "object") {
      return;
    }

    const nextSetup = {
      ...DEFAULT_SETUP,
      ...savedSetup,
    };

    nextSetup.mode = nextSetup.mode === "exam" ? "exam" : "practice";
    nextSetup.amount = Number.isFinite(Number(nextSetup.amount)) ? Number(nextSetup.amount) : DEFAULT_SETUP.amount;

    const documentExists =
      nextSetup.document === "all" ||
      state.documents.some((document) => document.key === nextSetup.document);

    nextSetup.document = documentExists ? nextSetup.document : "all";
    state.setup = nextSetup;
    clampSetupAmount();
    state.setup.shuffle = true;
    state.setup.examMinutes = recommendedExamMinutes(state.setup.amount);
  }

  function persistSetup() {
    writeStorageJson(STORAGE_KEYS.setup, state.setup);
  }

  function loadPersistedStats() {
    const savedStats = readStorageJson(STORAGE_KEYS.stats, null);
    if (!savedStats || typeof savedStats !== "object") {
      return;
    }

    state.stats = {
      ...createDefaultStats(),
      ...savedStats,
      recentSessions: Array.isArray(savedStats.recentSessions) ? savedStats.recentSessions : [],
    };
  }

  function persistStats() {
    writeStorageJson(STORAGE_KEYS.stats, state.stats);
    void syncStatsToSupabase();
  }

  function resetPersistedStats() {
    state.stats = createDefaultStats();
    persistStats();
  }

  function getStatsTimestamp(stats = state.stats) {
    return stats?.lastPlayedAt ? new Date(stats.lastPlayedAt).getTime() || 0 : 0;
  }

  async function loadRemoteStatsFromSupabase() {
    const service = getSupabaseService();
    if (!service?.hasConfig?.() || !state.userId) {
      return null;
    }

    const client = service.getClient();
    const { data, error } = await client
      .from("user_stats")
      .select("stats_payload, last_played_at")
      .eq("user_id", state.userId)
      .maybeSingle();

    if (error) {
      throw new Error(`No se han podido cargar las estadísticas remotas: ${error.message}`);
    }

    if (!data?.stats_payload || typeof data.stats_payload !== "object") {
      return null;
    }

    return {
      ...createDefaultStats(),
      ...data.stats_payload,
      lastPlayedAt: data.last_played_at || data.stats_payload.lastPlayedAt || null,
      recentSessions: Array.isArray(data.stats_payload.recentSessions) ? data.stats_payload.recentSessions : [],
    };
  }

  async function syncStatsToSupabase() {
    const service = getSupabaseService();
    if (!service?.hasConfig?.() || !state.userId) {
      return false;
    }

    const client = service.getClient();
    const payload = {
      user_id: state.userId,
      stats_payload: state.stats,
      last_played_at: state.stats.lastPlayedAt,
    };

    const { error } = await client.from("user_stats").upsert(payload, { onConflict: "user_id" });
    return !error;
  }

  async function hydrateStats() {
    loadPersistedStats();

    if (!state.userId) {
      return;
    }

    try {
      const remoteStats = await loadRemoteStatsFromSupabase();
      if (remoteStats && getStatsTimestamp(remoteStats) > getStatsTimestamp(state.stats)) {
        state.stats = remoteStats;
        writeStorageJson(STORAGE_KEYS.stats, state.stats);
      } else if (remoteStats && getStatsTimestamp(remoteStats) < getStatsTimestamp(state.stats)) {
        void syncStatsToSupabase();
      }
    } catch (error) {
      console.warn(error);
    }
  }

  function getOverallAccuracy(stats = state.stats) {
    if (!stats.totalQuestions) {
      return 0;
    }

    return Math.round((stats.totalCorrect / stats.totalQuestions) * 100);
  }

  function getAverageScoreOverTen(stats = state.stats) {
    if (!stats.totalQuestions) {
      return "0.00";
    }

    return ((stats.totalCorrect / stats.totalQuestions) * 10).toFixed(2);
  }

  function formatDateTime(value) {
    if (!value) {
      return "Todavía sin sesiones";
    }

    try {
      return new Intl.DateTimeFormat("es-ES", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date(value));
    } catch {
      return String(value);
    }
  }

  function isStrictlyValidQuestion(item) {
    if (!item || !item.pregunta || !Array.isArray(item.opciones) || item.opciones.length !== 4) {
      return false;
    }

    const correctCount = item.opciones.filter((option) => option.estado === "Correcta").length;
    if (correctCount !== 1) {
      return false;
    }

    return item.opciones.every((option) => !OCR_WARNING_PATTERN.test(String(option.texto ?? "")));
  }

  function normalizeQuestion(item, index) {
    const correctIndex = item.opciones.findIndex((option) => option.estado === "Correcta");

    return {
      key: `${item.documento || "GEN"}-${item.id || index}-${index}`,
      sourceId: item.supabaseId ?? null,
      id: item.id || index + 1,
      rawDocument: item.documento || "SIN_CATEGORIA",
      document: formatDocumentName(item.documento),
      question: cleanText(item.pregunta),
      options: item.opciones.map((option, optionIndex) => ({
        letter: LETTERS[optionIndex],
        text: cleanText(option.texto),
      })),
      correctIndex,
    };
  }

  function getSupabaseService() {
    return window.OposAppSupabase || null;
  }

  function isSupabaseConfigured() {
    return Boolean(getSupabaseService()?.hasConfig?.());
  }

  async function loadQuestionBankFromSupabase() {
    const service = getSupabaseService();
    if (!service?.hasConfig?.()) {
      return null;
    }

    const client = service.getClient();
    const config = service.getConfig();
    const { data, error } = await client
      .from(config.questionsTable)
      .select("id, documento, question_number, pregunta, opciones, review_status, is_active")
      .eq("is_active", true)
      .order("documento", { ascending: true })
      .order("question_number", { ascending: true });

    if (error) {
      throw new Error(`Supabase no ha devuelto las preguntas: ${error.message}`);
    }

    return (data || []).map((row) => ({
      supabaseId: row.id,
      documento: row.documento,
      id: row.question_number,
      pregunta: row.pregunta,
      opciones: Array.isArray(row.opciones) ? row.opciones : [],
      review_status: row.review_status,
      is_active: row.is_active,
    }));
  }

  async function loadQuestionSource(path) {
    const response = await fetch(path, { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`No se ha podido cargar ${path} (${response.status}).`);
    }

    const payload = await response.json();
    if (!Array.isArray(payload)) {
      throw new Error(`El archivo ${path} no contiene una lista de preguntas.`);
    }

    return payload;
  }

  async function loadQuestionBank() {
    if (isSupabaseConfigured()) {
      const supabaseQuestions = await loadQuestionBankFromSupabase();
      if (Array.isArray(supabaseQuestions) && supabaseQuestions.length) {
        state.activeDataSource = "supabase";
        return supabaseQuestions;
      }

      throw new Error("Supabase no ha devuelto preguntas activas.");
    }

    state.activeDataSource = "json";
    return await loadQuestionSource(QUESTION_BANK_FALLBACK_SOURCE);
  }

  async function loadQuestionBankFromJsonFallback() {
    state.activeDataSource = "json";
    try {
      const sources = await Promise.all(QUESTION_BANK_SOURCES.map((path) => loadQuestionSource(path)));
      return sources.flat();
    } catch (error) {
      return await loadQuestionSource(QUESTION_BANK_FALLBACK_SOURCE);
    }
  }

  function buildDocuments(questions) {
    const counts = questions.reduce((accumulator, question) => {
      accumulator[question.rawDocument] = (accumulator[question.rawDocument] || 0) + 1;
      return accumulator;
    }, {});

    return Object.entries(counts)
      .map(([key, count]) => ({
        key,
        label: formatDocumentName(key),
        count,
      }))
      .sort((left, right) => left.label.localeCompare(right.label, "es"));
  }

  function prepareData(rawQuestions) {
    const sourceQuestions = Array.isArray(rawQuestions) ? rawQuestions : [];
    const validQuestions = sourceQuestions
      .filter(isStrictlyValidQuestion)
      .map((question, index) => normalizeQuestion(question, index));

    state.questions = validQuestions;
    state.documents = buildDocuments(validQuestions);
    state.meta.rawCount = sourceQuestions.length;
    state.meta.validCount = validQuestions.length;
    state.meta.droppedCount = sourceQuestions.length - validQuestions.length;
    state.setup.amount = Math.min(25, validQuestions.length || 0);
    state.setup.examMinutes = recommendedExamMinutes(state.setup.amount);
  }

  function getQuestionByCompositeKey(questionKey) {
    if (state.session) {
      const inSession = state.session.questions.find((question) => question.key === questionKey);
      if (inSession) {
        return inSession;
      }
    }

    if (state.summary?.mistakes?.length) {
      const inSummary = state.summary.mistakes.find((item) => item.question.key === questionKey);
      if (inSummary) {
        return inSummary.question;
      }
    }

    return state.questions.find((question) => question.key === questionKey) || null;
  }

  async function submitQuestionReport(question) {
    if (!question?.sourceId) {
      window.alert("Esta pregunta no está vinculada todavía a Supabase.");
      return;
    }

    const service = getSupabaseService();
    if (!service?.hasConfig?.()) {
      window.alert("La configuración de Supabase no está lista todavía.");
      return;
    }

    const note = window.prompt("Describe el error que has visto en esta pregunta:");
    if (note === null) {
      return;
    }

    const trimmedNote = note.trim();
    if (!trimmedNote) {
      window.alert("Necesito un poco de contexto para guardar la incidencia.");
      return;
    }

    const client = service.getClient();
    const config = service.getConfig();
    const payload = {
      question_id: question.sourceId,
      note: trimmedNote,
      status: "new",
      question_snapshot: {
        documento: question.rawDocument,
        question_number: question.id,
        pregunta: question.question,
        opciones: question.options.map((option, optionIndex) => ({
          letra: LETTERS[optionIndex].toLowerCase(),
          texto: option.text,
          estado: optionIndex === question.correctIndex ? "Correcta" : "Incorrecta",
        })),
      },
    };

    const { error } = await client.from(config.reportsTable).insert(payload);
    if (error) {
      window.alert(`No he podido guardar la incidencia: ${error.message}`);
      return;
    }

    window.alert("Incidencia guardada para revisarla en el panel admin.");
  }

  function getCurrentPool() {
    if (state.setup.document === "all") {
      return state.questions;
    }

    return state.questions.filter((question) => question.rawDocument === state.setup.document);
  }

  function getQuestionCountChoices(poolSize) {
    const baseChoices = [10, 25, 50, 100, 200];
    const choices = new Set(baseChoices.filter((choice) => choice < poolSize));

    if (poolSize > 0) {
      choices.add(Math.min(poolSize, state.setup.amount || 10));
      choices.add(poolSize);
    }

    return [...choices].sort((left, right) => left - right);
  }

  function clampSetupAmount() {
    const poolSize = getCurrentPool().length;
    if (!poolSize) {
      state.setup.amount = 0;
      state.setup.examMinutes = 0;
      return;
    }

    state.setup.amount = Math.min(Math.max(1, state.setup.amount), poolSize);
    state.setup.shuffle = true;
    state.setup.examMinutes = recommendedExamMinutes(state.setup.amount);
  }

  function buildRecentSessionEntry(summary) {
    return {
      at: new Date().toISOString(),
      mode: summary.mode,
      sourceLabel: summary.sourceLabel,
      total: summary.total,
      correct: summary.correct,
      incorrect: summary.incorrect,
      unanswered: summary.unanswered,
      percentage: summary.percentage,
      scoreOverTen: Number(summary.scoreOverTen),
      timedOut: summary.timedOut,
    };
  }

  function updateStatsFromSummary(summary) {
    const scoreOverTen = Number(summary.scoreOverTen);
    const isPassing = scoreOverTen >= 5;

    state.stats.totalSessions += 1;
    state.stats.practiceSessions += summary.mode === "practice" ? 1 : 0;
    state.stats.examSessions += summary.mode === "exam" ? 1 : 0;
    state.stats.totalQuestions += summary.total;
    state.stats.totalCorrect += summary.correct;
    state.stats.totalIncorrect += summary.incorrect;
    state.stats.totalUnanswered += summary.unanswered;
    state.stats.bestScoreOverTen = Math.max(state.stats.bestScoreOverTen, scoreOverTen);
    state.stats.bestPercentage = Math.max(state.stats.bestPercentage, summary.percentage);
    state.stats.lastScoreOverTen = scoreOverTen;
    state.stats.lastPlayedAt = new Date().toISOString();
    state.stats.currentStreak = isPassing ? state.stats.currentStreak + 1 : 0;
    state.stats.bestStreak = Math.max(state.stats.bestStreak, state.stats.currentStreak);
    state.stats.recentSessions = [buildRecentSessionEntry(summary), ...state.stats.recentSessions].slice(0, 8);

    persistStats();
  }

  function getStorageStatusMarkup() {
    if (state.userId) {
      return `
        <span class="rounded-full bg-emerald-100 px-3 py-1 text-sm font-semibold text-emerald-800">
          Estadísticas vinculadas a ${escapeHtml(state.userEmail || "tu usuario")}
        </span>
      `;
    }

    if (state.storageAvailable) {
      return `
        <span class="rounded-full bg-emerald-100 px-3 py-1 text-sm font-semibold text-emerald-800">
          Progreso guardado en este navegador
        </span>
      `;
    }

    return `
      <span class="rounded-full bg-slate-200 px-3 py-1 text-sm font-semibold text-slate-700">
        Progreso no disponible en este navegador
      </span>
    `;
  }

  function isAdminUser(user) {
    return user?.app_metadata?.role === "admin" || user?.user_metadata?.role === "admin";
  }

  function getAuthActionMarkup(isDark = false) {
    if (state.userId) {
      return `
        <button
          type="button"
          data-auth-logout="true"
          class="inline-flex shrink-0 items-center justify-center rounded-[1rem] ${
            isDark ? "bg-white/15 text-white hover:bg-white/20" : "bg-white/90 text-ink ring-1 ring-slate-200 hover:ring-tide/40"
          } px-4 py-3 text-sm font-semibold transition hover:-translate-y-0.5"
        >
          Salir (${escapeHtml(state.userEmail || "usuario")})
        </button>
      `;
    }

    return `
      <button
        type="button"
        data-auth-login="true"
        class="inline-flex shrink-0 items-center justify-center rounded-[1rem] ${
          isDark ? "bg-white/15 text-white hover:bg-white/20" : "bg-white/90 text-ink ring-1 ring-slate-200 hover:ring-tide/40"
        } px-4 py-3 text-sm font-semibold transition hover:-translate-y-0.5"
      >
        Iniciar sesión
      </button>
    `;
  }

  async function refreshAuthSession() {
    const service = getSupabaseService();
    if (!service?.hasConfig?.()) {
      state.userId = null;
      state.userEmail = "";
      state.isAdmin = false;
      state.authReady = true;
      return;
    }

    const client = service.getClient();
    const { data, error } = await client.auth.getSession();
    if (error) {
      console.warn(error);
      state.userId = null;
      state.userEmail = "";
      state.isAdmin = false;
      state.authReady = true;
      return;
    }

    const session = data.session;
    state.userId = session?.user?.id || null;
    state.userEmail = session?.user?.email || "";
    state.isAdmin = isAdminUser(session?.user);
    state.authReady = true;
  }

  async function signInUser(email, password) {
    const service = getSupabaseService();
    if (!service?.hasConfig?.()) {
      window.alert("La configuración de Supabase no está lista todavía.");
      return;
    }

    const client = service.getClient();
    const { error } = await client.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (error) {
      window.alert(`No se ha podido iniciar sesión: ${error.message}`);
      return;
    }

    await refreshAuthSession();
    await hydrateStats();
    render();
  }

  async function signOutUser() {
    const service = getSupabaseService();
    if (!service?.hasConfig?.()) {
      return;
    }

    const client = service.getClient();
    await client.auth.signOut();
    state.userId = null;
    state.userEmail = "";
    state.isAdmin = false;
    state.stats = createDefaultStats();
    render();
  }

  function getDataSourceMarkup() {
    const isSupabase = state.activeDataSource === "supabase";

    return `
      <span class="rounded-full ${isSupabase ? "bg-cyan-100 text-cyan-900" : "bg-slate-200 text-slate-700"} px-3 py-1 text-sm font-semibold">
        Fuente: ${isSupabase ? "Supabase" : "JSON local"}
      </span>
    `;
  }

  function renderAuthGate() {
    root.innerHTML = `
      <section class="glass-panel mx-auto max-w-5xl rounded-[2rem] border border-white/70 p-6 shadow-soft sm:p-8">
        <div class="grid gap-8 xl:grid-cols-[1.08fr_0.92fr] xl:items-start">
          <div>
            <div class="flex flex-wrap gap-2">
              ${getDataSourceMarkup()}
            </div>
            <p class="mt-5 text-xs font-semibold uppercase tracking-[0.24em] text-tide">Acceso</p>
            <h1 class="mt-3 max-w-2xl font-display text-4xl leading-tight text-ink sm:text-[2.8rem]">
              Inicia sesión para entrar al simulador
            </h1>
            <p class="mt-4 max-w-xl text-base leading-7 text-slate-600">
              Todas las cuentas pasan por el mismo acceso. Si tu usuario tiene rol admin, el escudo saldrá en verde y podrás abrir el panel editorial.
            </p>

            <div class="mt-8 grid gap-4 sm:grid-cols-3">
              <article class="rounded-3xl bg-white/85 p-5 ring-1 ring-slate-200/70">
                <p class="text-sm font-medium text-slate-500">Banco</p>
                <p class="mt-2 text-3xl font-extrabold text-ink">${state.meta.validCount}</p>
                <p class="mt-1 text-sm text-slate-500">preguntas válidas</p>
              </article>
              <article class="rounded-3xl bg-white/85 p-5 ring-1 ring-slate-200/70">
                <p class="text-sm font-medium text-slate-500">Bloques</p>
                <p class="mt-2 text-3xl font-extrabold text-ink">${state.documents.length}</p>
                <p class="mt-1 text-sm text-slate-500">categorías activas</p>
              </article>
              <article class="rounded-3xl bg-ink p-5 text-white">
                <p class="text-sm font-medium text-cyan-200">Acceso admin</p>
                <p class="mt-2 text-lg font-semibold">Mismo login, distinto rol</p>
              </article>
            </div>
          </div>

          <div class="rounded-[1.8rem] bg-white/88 p-6 ring-1 ring-slate-200 shadow-[0_20px_60px_rgba(19,34,56,0.08)]">
            <div class="flex items-center justify-between gap-4">
              <div>
                <p class="font-display text-2xl font-semibold text-ink">Entrar</p>
                <p class="mt-2 text-sm leading-6 text-slate-500">Usa tu cuenta de Supabase Auth.</p>
              </div>
              <span class="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-100 text-slate-500">
                ${getIconMarkup("login")}
              </span>
            </div>

            <form data-login-form class="mt-6 space-y-4">
              <label class="block">
                <span class="text-sm font-semibold text-slate-600">Email</span>
                <input
                  type="email"
                  name="email"
                  required
                  class="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-slate-800 outline-none transition focus:border-tide"
                />
              </label>
              <label class="block">
                <span class="text-sm font-semibold text-slate-600">Contraseña</span>
                <input
                  type="password"
                  name="password"
                  required
                  class="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-slate-800 outline-none transition focus:border-tide"
                />
              </label>
              <button
                type="submit"
                class="inline-flex w-full items-center justify-center rounded-[1.1rem] bg-ink px-5 py-3 font-semibold text-white transition hover:bg-slate-900"
              >
                Entrar al simulador
              </button>
            </form>

            ${
              state.dataError
                ? `<p class="mt-4 rounded-2xl bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800">${escapeHtml(
                    state.dataError,
                  )}</p>`
                : ""
            }
          </div>
        </div>
      </section>
    `;
  }

  function getIconMarkup(icon) {
    const icons = {
      stats: `
        <svg viewBox="0 0 24 24" aria-hidden="true" class="h-5 w-5 fill-none stroke-current" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 19h16"></path>
          <path d="M7 16V9"></path>
          <path d="M12 16V5"></path>
          <path d="M17 16v-3"></path>
        </svg>
      `,
      login: `
        <svg viewBox="0 0 24 24" aria-hidden="true" class="h-5 w-5 fill-none stroke-current" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
          <path d="M10 17l5-5-5-5"></path>
          <path d="M15 12H3"></path>
        </svg>
      `,
      logout: `
        <svg viewBox="0 0 24 24" aria-hidden="true" class="h-5 w-5 fill-none stroke-current" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
          <path d="M16 17l5-5-5-5"></path>
          <path d="M21 12H9"></path>
        </svg>
      `,
      admin: `
        <svg viewBox="0 0 24 24" aria-hidden="true" class="h-5 w-5 fill-none stroke-current" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3l7 4v5c0 5-3.5 7.5-7 9-3.5-1.5-7-4-7-9V7l7-4z"></path>
          <path d="M9.5 12.5l1.5 1.5 3.5-4"></path>
        </svg>
      `,
      shield: `
        <svg viewBox="0 0 24 24" aria-hidden="true" class="h-5 w-5 fill-none stroke-current" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3l7 4v5c0 5-3.5 7.5-7 9-3.5-1.5-7-4-7-9V7l7-4z"></path>
        </svg>
      `,
    };

    return icons[icon] || "";
  }

  function getHeaderActionsMarkup() {
    return `
      <div class="flex items-center gap-2 sm:gap-3">
        <button
          type="button"
          data-toggle-stats-panel="true"
          title="Ver progreso"
          aria-label="Ver progreso"
          class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/90 text-ink ring-1 ring-slate-200 transition hover:-translate-y-0.5 hover:ring-tide/40"
        >
          ${getIconMarkup("stats")}
        </button>
        <button
          type="button"
          data-auth-logout="true"
          title="Cerrar sesión"
          aria-label="Cerrar sesión"
          class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/90 text-ink ring-1 ring-slate-200 transition hover:-translate-y-0.5 hover:ring-tide/40"
        >
          ${getIconMarkup("logout")}
        </button>
        ${
          state.isAdmin
            ? `
              <a
                href="admin.html"
                title="Panel admin"
                aria-label="Panel admin"
                class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-ink text-white transition hover:-translate-y-0.5 hover:bg-slate-900"
              >
                ${getIconMarkup("admin")}
              </a>
            `
            : ""
        }
      </div>
    `;
  }

  function getRoleBadgeMarkup() {
    return `
      <span
        title="${state.isAdmin ? "Cuenta administradora" : "Cuenta estándar"}"
        class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${
          state.isAdmin ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"
        }"
      >
        ${getIconMarkup("shield")}
      </span>
    `;
  }

  function renderStatsPanelMarkup() {
    const overallAccuracy = getOverallAccuracy();
    const averageScore = getAverageScoreOverTen();

    return `
      <div class="fixed inset-0 z-40 ${state.isStatsPanelOpen ? "" : "pointer-events-none"}">
        <button
          type="button"
          data-toggle-stats-panel="true"
          aria-label="Cerrar panel de progreso"
          class="absolute inset-0 bg-slate-950/35 transition ${state.isStatsPanelOpen ? "opacity-100" : "opacity-0"}"
        ></button>

        <aside class="absolute right-0 top-0 h-full w-full max-w-md overflow-y-auto border-l border-white/60 bg-white/92 p-6 shadow-soft backdrop-blur-xl transition duration-300 sm:p-7 ${
          state.isStatsPanelOpen ? "translate-x-0" : "translate-x-full"
        }">
          <div class="flex items-start justify-between gap-4">
            <div>
              <p class="font-display text-2xl font-semibold text-ink">Tu progreso</p>
              <p class="mt-2 text-sm leading-6 text-slate-500">Se actualiza al terminar cada práctica o examen.</p>
            </div>
            <button
              type="button"
              data-toggle-stats-panel="true"
              class="rounded-full bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-600 ring-1 ring-slate-200 transition hover:bg-slate-200"
            >
              Cerrar
            </button>
          </div>

          <div class="mt-6 grid gap-4 sm:grid-cols-2">
            <article class="rounded-3xl bg-slate-50 p-4">
              <p class="text-sm text-slate-500">Sesiones guardadas</p>
              <p class="mt-2 text-3xl font-extrabold text-ink">${state.stats.totalSessions}</p>
            </article>
            <article class="rounded-3xl bg-slate-50 p-4">
              <p class="text-sm text-slate-500">Acierto global</p>
              <p class="mt-2 text-3xl font-extrabold text-ink">${overallAccuracy}%</p>
            </article>
            <article class="rounded-3xl bg-slate-50 p-4">
              <p class="text-sm text-slate-500">Nota media</p>
              <p class="mt-2 text-3xl font-extrabold text-ink">${averageScore}</p>
            </article>
            <article class="rounded-3xl bg-slate-50 p-4">
              <p class="text-sm text-slate-500">Mejor nota</p>
              <p class="mt-2 text-3xl font-extrabold text-ink">${state.stats.bestScoreOverTen.toFixed(2)}</p>
            </article>
            <article class="rounded-3xl bg-slate-50 p-4">
              <p class="text-sm text-slate-500">Racha actual</p>
              <p class="mt-2 text-3xl font-extrabold text-ink">${state.stats.currentStreak}</p>
              <p class="mt-1 text-sm text-slate-500">Mejor: ${state.stats.bestStreak}</p>
            </article>
            <article class="rounded-3xl bg-slate-50 p-4">
              <p class="text-sm text-slate-500">Última nota</p>
              <p class="mt-2 text-3xl font-extrabold text-ink">${
                state.stats.lastScoreOverTen === null ? "--" : state.stats.lastScoreOverTen.toFixed(2)
              }</p>
              <p class="mt-1 text-sm text-slate-500">${formatDateTime(state.stats.lastPlayedAt)}</p>
            </article>
          </div>

          <div class="mt-4 rounded-3xl bg-slate-50 p-4">
            <p class="text-sm text-slate-500">Práctica / Examen</p>
            <p class="mt-2 text-3xl font-extrabold text-ink">${state.stats.practiceSessions}/${state.stats.examSessions}</p>
            <p class="mt-1 text-sm text-slate-500">sesiones completadas</p>
          </div>

          <div class="mt-6">
            <div class="flex items-center justify-between gap-3">
              <p class="font-display text-xl font-semibold text-ink">Sesiones recientes</p>
              <p class="text-sm text-slate-500">Máximo 8</p>
            </div>
            <div class="mt-4 grid gap-3">
              ${renderRecentSessionsMarkup()}
            </div>
          </div>

          ${
            state.storageAvailable
              ? `
                <button
                  type="button"
                  data-reset-stats="true"
                  class="mt-6 inline-flex w-full items-center justify-center rounded-[1.15rem] bg-rose-50 px-5 py-3 font-semibold text-rose-700 ring-1 ring-rose-200 transition hover:bg-rose-100"
                >
                  Borrar estadísticas
                </button>
              `
              : ""
          }
        </aside>
      </div>
    `;
  }

  function renderRecentSessionsMarkup() {
    if (!state.stats.recentSessions.length) {
      return `
        <div class="rounded-3xl bg-white/80 p-5 ring-1 ring-slate-200">
          <p class="text-sm leading-7 text-slate-500">
            Todavía no hay sesiones guardadas. Cuando termines una práctica o un examen, el resumen se quedarán almacenado aquí.
          </p>
        </div>
      `;
    }

    return state.stats.recentSessions
      .map(
        (item) => `
          <article class="rounded-3xl bg-white/85 p-4 ring-1 ring-slate-200">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p class="font-semibold text-ink">${item.mode === "practice" ? "Práctica" : "Examen"}  ${escapeHtml(item.sourceLabel)}</p>
                <p class="mt-1 text-sm text-slate-500">${formatDateTime(item.at)}</p>
              </div>
              <span class="rounded-full ${
                item.scoreOverTen >= 5 ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"
              } px-3 py-1 text-sm font-bold">
                ${item.scoreOverTen.toFixed(2)}
              </span>
            </div>
            <p class="mt-3 text-sm leading-7 text-slate-600">
              ${item.correct}/${item.total} correctas ${item.percentage}% de acierto${
                item.timedOut ? " entregado por tiempo" : ""
              }
            </p>
          </article>
        `,
      )
      .join("");
  }

  function getAnsweredCount(session) {
    return session.answers.filter((answer) => answer !== null).length;
  }

  function getCorrectCount(session) {
    return session.questions.reduce((total, question, index) => {
      return total + (session.answers[index] === question.correctIndex ? 1 : 0);
    }, 0);
  }

  function getRemainingSeconds(session) {
    if (!session || session.mode !== "exam" || !session.endsAt) {
      return 0;
    }

    return Math.max(0, Math.ceil((session.endsAt - Date.now()) / 1000));
  }

  function getQuestionStatus(session, index) {
    const answer = session.answers[index];
    const isCurrent = session.currentIndex === index;
    const isMarked = session.marked.has(index);

    if (isCurrent) {
      return "current";
    }
    if (answer !== null && isMarked) {
      return "marked-answered";
    }
    if (answer !== null) {
      return "answered";
    }
    if (isMarked) {
      return "marked";
    }
    return "idle";
  }

  function startSession(customQuestions = null, forcedMode = null) {
    const mode = forcedMode || state.setup.mode;
    const basePool = customQuestions ? [...customQuestions] : [...getCurrentPool()];
    const sourceLabel = customQuestions
      ? "Repaso de fallos"
      : state.setup.document === "all"
        ? "Todo el banco"
        : formatDocumentName(state.setup.document);

    if (!basePool.length) {
      return;
    }

    const total = customQuestions
      ? basePool.length
      : Math.min(Math.max(1, state.setup.amount), basePool.length);

    const pickedQuestions = state.setup.shuffle ? shuffleArray(basePool).slice(0, total) : basePool.slice(0, total);

    state.summary = null;
    state.isStatsPanelOpen = false;
    state.session = {
      mode,
      sourceLabel,
      questions: pickedQuestions,
      answers: Array(pickedQuestions.length).fill(null),
      currentIndex: 0,
      marked: new Set(),
      startedAt: Date.now(),
      endsAt: mode === "exam" ? Date.now() + state.setup.examMinutes * 60 * 1000 : null,
    };

    persistSetup();
    startTimer();
    render();
  }

  function finishSession(reason = "manual") {
    if (!state.session) {
      return;
    }

    const session = state.session;
    stopTimer();

    const items = session.questions.map((question, index) => {
      const userAnswer = session.answers[index];
      const correctIndex = question.correctIndex;
      const isCorrect = userAnswer === correctIndex;

      return {
        index,
        question,
        userAnswer,
        correctIndex,
        isCorrect,
      };
    });

    const answered = items.filter((item) => item.userAnswer !== null).length;
    const correct = items.filter((item) => item.isCorrect).length;
    const unanswered = items.length - answered;
    const incorrect = items.length - correct - unanswered;
    const scoreOverTen = ((correct / items.length) * 10).toFixed(2);

    state.summary = {
      mode: session.mode,
      sourceLabel: session.sourceLabel,
      total: items.length,
      answered,
      unanswered,
      correct,
      incorrect,
      percentage: Math.round((correct / items.length) * 100),
      scoreOverTen,
      durationSeconds: Math.round((Date.now() - session.startedAt) / 1000),
      timedOut: reason === "timeout",
      items,
      mistakes: items.filter((item) => !item.isCorrect),
    };

    updateStatsFromSummary(state.summary);
    state.session = null;
    render();
  }

  function startTimer() {
    stopTimer();

    if (!state.session || state.session.mode !== "exam") {
      return;
    }

    state.timerId = window.setInterval(() => {
      if (!state.session) {
        stopTimer();
        return;
      }

      const remainingSeconds = getRemainingSeconds(state.session);
      const timerNode = document.querySelector("[data-timer]");
      if (timerNode) {
        timerNode.textContent = formatTime(remainingSeconds);
      }

      if (remainingSeconds <= 0) {
        finishSession("timeout");
      }
    }, 1000);
  }

  function stopTimer() {
    if (state.timerId) {
      window.clearInterval(state.timerId);
      state.timerId = null;
    }
  }

  function selectAnswer(answerIndex) {
    if (!state.session) {
      return;
    }

    const { currentIndex, mode, answers } = state.session;
    if (mode === "practice" && answers[currentIndex] !== null) {
      return;
    }

    answers[currentIndex] = answerIndex;
    render();
  }

  function goToQuestion(index) {
    if (!state.session) {
      return;
    }

    state.session.currentIndex = Math.min(Math.max(0, index), state.session.questions.length - 1);
    render();
  }

  function moveQuestion(step) {
    if (!state.session) {
      return;
    }

    goToQuestion(state.session.currentIndex + step);
  }

  function toggleCurrentMark() {
    if (!state.session || state.session.mode !== "exam") {
      return;
    }

    const { currentIndex, marked } = state.session;
    if (marked.has(currentIndex)) {
      marked.delete(currentIndex);
    } else {
      marked.add(currentIndex);
    }

    render();
  }

  function getOptionClasses(session, question, optionIndex) {
    const currentAnswer = session.answers[session.currentIndex];
    const baseClasses =
      "group flex w-full items-start gap-4 rounded-2xl border px-4 py-4 text-left transition duration-150";

    if (session.mode === "practice" && currentAnswer !== null) {
      if (optionIndex === question.correctIndex) {
        return `${baseClasses} border-emerald-500 bg-emerald-50 text-emerald-950`;
      }

      if (optionIndex === currentAnswer) {
        return `${baseClasses} border-rose-500 bg-rose-50 text-rose-950`;
      }

      return `${baseClasses} border-slate-200 bg-slate-50/80 text-slate-500`;
    }

    if (currentAnswer === optionIndex) {
      return `${baseClasses} border-amber-400 bg-amber-50 text-ink shadow-sm`;
    }

    return `${baseClasses} border-slate-200 bg-white/90 hover:-translate-y-0.5 hover:border-tide/50 hover:shadow-lg`;
  }

  function renderHome() {
    clampSetupAmount();
    const pool = getCurrentPool();
    const questionChoices = getQuestionCountChoices(pool.length);
    const currentDocLabel =
      state.setup.document === "all"
        ? "Todo el banco disponible"
        : formatDocumentName(state.setup.document);
    const docsSummary = state.documents.map((doc) => `${doc.label} (${doc.count})`).join(" · ");

    if (IS_ALT_HOME) {
      root.innerHTML = `
        <div class="space-y-6">
          <section class="glass-panel rounded-[2rem] border border-white/70 p-5 shadow-soft sm:p-7">
            <div class="flex flex-wrap items-start justify-between gap-4">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap gap-2">
                  <span class="rounded-full bg-tide/10 px-3 py-1 text-sm font-semibold text-tide">${state.meta.validCount} preguntas válidas</span>
                  <span class="rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-800">${state.meta.droppedCount} con fallo de OCR</span>
                  ${getDataSourceMarkup()}
                  ${getStorageStatusMarkup()}
                </div>
                <div class="mt-5 flex items-center gap-3">
                  ${getRoleBadgeMarkup()}
                  <p class="text-xs font-semibold uppercase tracking-[0.24em] text-tide">Simulador</p>
                </div>
                <h1 class="mt-2 max-w-2xl font-display text-3xl leading-tight text-ink sm:text-4xl xl:text-[2.6rem]">
                  Práctica tipo test con modo estudio y examen
                </h1>
                <p class="mt-3 max-w-2xl text-sm leading-6 text-slate-600 sm:text-base sm:leading-7">
                  Todo lo importante queda reunido en una sola caja para que la home sea más clara y más cómoda de usar.
                </p>
              </div>
              ${getHeaderActionsMarkup()}
            </div>

            <div class="mt-6 grid gap-3 sm:grid-cols-3">
              <article class="rounded-3xl bg-white/85 p-4 ring-1 ring-slate-200/70">
                <p class="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">Bloque</p>
                <p class="mt-2 text-2xl font-extrabold text-ink">${pool.length}</p>
                <p class="mt-1 text-sm text-slate-500">${escapeHtml(currentDocLabel.toLowerCase())}</p>
              </article>
              <article class="rounded-3xl bg-white/85 p-4 ring-1 ring-slate-200/70">
                <p class="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">Tiempo</p>
                <p class="mt-2 text-2xl font-extrabold text-ink">${state.setup.examMinutes} min</p>
                <p class="mt-1 text-sm text-slate-500">${state.setup.amount} preguntas</p>
              </article>
              <article class="rounded-3xl bg-ink p-4 text-white">
                <p class="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-200">Bloques disponibles</p>
                <p class="mt-2 text-sm leading-6 text-slate-200">${escapeHtml(docsSummary || "No se ha encontrado un bloque disponible.")}</p>
              </article>
            </div>

            <div class="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(19rem,24rem)] xl:items-start">
              <div>
                <div>
                  <p class="text-sm font-semibold uppercase tracking-[0.24em] text-slate-500">Modo</p>
                  <div class="mt-3 grid gap-3 sm:grid-cols-2">
                    ${["practice", "exam"]
                      .map((mode) => {
                        const isActive = state.setup.mode === mode;
                        const label = mode === "practice" ? "Práctica" : "Examen";
                        const description =
                          mode === "practice"
                            ? "Corrige al instante, aprende y avanza pregunta a pregunta."
                            : "Oculta la solución, activa temporizador y corrige al final.";

                        return `
                          <button
                            type="button"
                            data-set-mode="${mode}"
                            class="rounded-3xl border p-4 text-left transition ${
                              isActive
                                ? "border-ink bg-ink text-white shadow-lg"
                                : "border-slate-200 bg-white/85 text-ink hover:border-tide/50 hover:shadow-md"
                            }"
                          >
                            <p class="font-display text-xl font-semibold">${label}</p>
                            <p class="mt-2 text-sm leading-6 ${isActive ? "text-slate-200" : "text-slate-500"}">${description}</p>
                          </button>
                        `;
                      })
                      .join("")}
                  </div>
                </div>

                <div class="mt-8">
                  <p class="text-sm font-semibold uppercase tracking-[0.24em] text-slate-500">Bloque</p>
                  <div class="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      data-set-document="all"
                      class="rounded-full px-4 py-2 text-sm font-semibold transition ${
                        state.setup.document === "all"
                          ? "bg-tide text-white"
                          : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-tide/40"
                      }"
                    >
                      Todo (${state.meta.validCount})
                    </button>
                    ${state.documents
                      .map(
                        (document) => `
                          <button
                            type="button"
                            data-set-document="${escapeHtml(document.key)}"
                            class="rounded-full px-4 py-2 text-sm font-semibold transition ${
                              state.setup.document === document.key
                                ? "bg-tide text-white"
                                : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-tide/40"
                            }"
                          >
                            ${escapeHtml(document.label)} (${document.count})
                          </button>
                        `,
                      )
                      .join("")}
                  </div>
                </div>
              </div>

              <div>
                <div>
                  <div class="flex items-center justify-between gap-3">
                    <p class="text-sm font-semibold uppercase tracking-[0.24em] text-slate-500">Cantidad</p>
                    <p class="text-sm text-slate-500">Disponibles: ${pool.length}</p>
                  </div>
                  <div class="mt-3 flex flex-wrap gap-2">
                    ${questionChoices
                      .map((choice) => {
                        const isAll = choice === pool.length;
                        const label = isAll ? `Todas (${choice})` : String(choice);
                        return `
                          <button
                            type="button"
                            data-set-amount="${choice}"
                            class="rounded-2xl px-4 py-2 text-sm font-semibold transition ${
                              state.setup.amount === choice
                                ? "bg-amber-400 text-amber-950"
                                : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-amber-300"
                            }"
                          >
                            ${label}
                          </button>
                        `;
                      })
                      .join("")}
                  </div>
                </div>

                <div class="mt-8 rounded-3xl bg-white/80 p-5 ring-1 ring-slate-200">
                  <p class="text-sm font-semibold uppercase tracking-[0.22em] text-slate-500">Duración del examen</p>
                  <div class="mt-4 flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <p class="text-4xl font-extrabold text-ink">${state.setup.examMinutes} min</p>
                      <p class="mt-2 text-sm leading-6 text-slate-500">Calculado automáticamente con la regla de tres: 60 minutos por cada 100 preguntas.</p>
                    </div>
                    <span class="rounded-full bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700">
                      ${state.setup.amount} preguntas
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <button
              type="button"
              data-start-session="true"
              class="mt-8 inline-flex w-full items-center justify-center rounded-[1.4rem] bg-ink px-6 py-4 font-display text-lg font-semibold text-white shadow-lg transition hover:-translate-y-0.5 hover:bg-slate-900"
            >
              ${state.setup.mode === "practice" ? "Empezar práctica" : "Empezar examen"}
            </button>
          </section>

          ${renderStatsPanelMarkup()}
        </div>
      `;
      return;
    }
    root.innerHTML = `
      <div class="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,28rem)] 2xl:grid-cols-[minmax(0,1.05fr)_minmax(22rem,30rem)]">
        <section class="space-y-4 xl:hidden">
          <div class="rounded-[1.75rem] bg-white/80 p-5 ring-1 ring-white/70 shadow-[0_12px_36px_rgba(19,34,56,0.08)] backdrop-blur-sm">
            <div class="flex flex-wrap gap-2">
              <span class="rounded-full bg-tide/10 px-3 py-1 text-sm font-semibold text-tide">${state.meta.validCount} preguntas válidas</span>
              <span class="rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-800">${state.meta.droppedCount} con fallo de OCR</span>
              ${getDataSourceMarkup()}
            </div>

            <div class="mt-5">
              <p class="text-xs font-semibold uppercase tracking-[0.24em] text-tide">Simulador</p>
              <h1 class="mt-2 font-display text-3xl leading-tight text-ink">Práctica tipo test</h1>
              <p class="mt-3 text-sm leading-6 text-slate-600">Configura la sesión y empieza desde el móvil sin pasos extra.</p>
            </div>

            <div class="mt-5 grid grid-cols-2 gap-3">
              <article class="rounded-3xl bg-slate-50 p-4">
                <p class="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">Bloque</p>
                <p class="mt-2 text-2xl font-extrabold text-ink">${pool.length}</p>
                <p class="mt-1 text-sm text-slate-500">${escapeHtml(currentDocLabel.toLowerCase())}</p>
              </article>
              <article class="rounded-3xl bg-slate-50 p-4">
                <p class="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">Tiempo</p>
                <p class="mt-2 text-2xl font-extrabold text-ink">${state.setup.examMinutes} min</p>
                <p class="mt-1 text-sm text-slate-500">${state.setup.amount} preguntas</p>
              </article>
            </div>

            <div class="mt-5 rounded-[1.4rem] bg-ink px-4 py-4 text-white">
              <p class="text-xs font-semibold uppercase tracking-[0.22em] text-cyan-200">Bloques disponibles</p>
              <p class="mt-2 text-sm leading-6 text-slate-200">${escapeHtml(docsSummary || "No se ha encontrado un bloque disponible.")}</p>
            </div>
          </div>
        </section>

        <section class="hidden glass-panel rounded-[2rem] border border-white/70 p-6 shadow-soft sm:p-8 xl:block">
          <div class="flex flex-wrap items-center gap-3">
            <span class="rounded-full bg-tide/10 px-3 py-1 text-sm font-semibold text-tide">${state.meta.validCount} preguntas válidas</span>
            <span class="rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-800">${state.meta.droppedCount} con fallo de OCR</span>
            ${getDataSourceMarkup()}
            ${getStorageStatusMarkup()}
          </div>

          <div class="mt-7 max-w-2xl">
            <div class="flex items-center gap-3">
              ${getRoleBadgeMarkup()}
              <p class="font-display text-sm font-semibold uppercase tracking-[0.28em] text-tide">Simulador de oposición</p>
            </div>
            <h1 class="mt-3 font-display text-4xl leading-tight text-ink sm:text-[2.8rem]">
              Práctica tipo test con modo estudio y modo examen
            </h1>
            <p class="mt-4 max-w-xl text-base leading-7 text-slate-600">
              Elige el bloque, ajusta la cantidad de preguntas y empieza cuando quieras.
            </p>
          </div>

          <div class="mt-8 grid gap-4 sm:grid-cols-3">
            <article class="rounded-3xl bg-white/80 p-5 ring-1 ring-slate-200/70">
              <p class="text-sm font-medium text-slate-500">Preguntas disponibles</p>
              <p class="mt-2 text-3xl font-extrabold text-ink">${state.meta.validCount}</p>
              <p class="mt-1 text-sm text-slate-500">listas para practicar</p>
            </article>
            <article class="rounded-3xl bg-white/80 p-5 ring-1 ring-slate-200/70">
              <p class="text-sm font-medium text-slate-500">Bloque seleccionado</p>
              <p class="mt-2 text-3xl font-extrabold text-ink">${pool.length}</p>
              <p class="mt-1 text-sm text-slate-500">preguntas en ${escapeHtml(currentDocLabel.toLowerCase())}</p>
            </article>
            <article class="rounded-3xl bg-white/80 p-5 ring-1 ring-slate-200/70">
              <p class="text-sm font-medium text-slate-500">Tiempo sugerido</p>
              <p class="mt-2 text-3xl font-extrabold text-ink">${recommendedExamMinutes(
                Math.max(1, state.setup.amount),
              )}</p>
              <p class="mt-1 text-sm text-slate-500">minutos para ${state.setup.amount || 0} preguntas</p>
            </article>
          </div>

          <div class="mt-8 rounded-[1.75rem] bg-ink px-6 py-6 text-white">
            <p class="text-sm font-semibold uppercase tracking-[0.24em] text-cyan-200">Bloques disponibles</p>
            <p class="mt-3 text-lg leading-8 text-slate-200">
              ${escapeHtml(docsSummary || "No se ha encontrado un bloque disponible.")}
            </p>
          </div>
        </section>

        <section class="glass-panel rounded-[2rem] border border-white/70 p-6 shadow-soft sm:p-8">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="min-w-0 flex-1">
              <p class="font-display text-2xl font-semibold text-ink">Configura tu sesión</p>
              <p class="mt-2 text-sm leading-6 text-slate-500">Elige el modo, el bloque de preguntas y cuántas quieres lanzar.</p>
            </div>
            ${getHeaderActionsMarkup()}
          </div>

          <div class="mt-8">
            <p class="text-sm font-semibold uppercase tracking-[0.24em] text-slate-500">Modo</p>
            <div class="mt-3 grid gap-3 sm:grid-cols-2">
              ${["practice", "exam"]
                .map((mode) => {
                  const isActive = state.setup.mode === mode;
                  const label = mode === "practice" ? "Práctica" : "Examen";
                  const description =
                    mode === "practice"
                      ? "Corrige al instante, aprende y avanza pregunta a pregunta."
                      : "Oculta la solución, activa temporizador y corrige al final.";

                  return `
                    <button
                      type="button"
                      data-set-mode="${mode}"
                      class="rounded-3xl border p-4 text-left transition ${
                        isActive
                          ? "border-ink bg-ink text-white shadow-lg"
                          : "border-slate-200 bg-white/85 text-ink hover:border-tide/50 hover:shadow-md"
                      }"
                    >
                      <p class="font-display text-xl font-semibold">${label}</p>
                      <p class="mt-2 text-sm leading-6 ${isActive ? "text-slate-200" : "text-slate-500"}">${description}</p>
                    </button>
                  `;
                })
                .join("")}
            </div>
          </div>

          <div class="mt-8">
            <p class="text-sm font-semibold uppercase tracking-[0.24em] text-slate-500">Bloque</p>
            <div class="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                data-set-document="all"
                class="rounded-full px-4 py-2 text-sm font-semibold transition ${
                  state.setup.document === "all"
                    ? "bg-tide text-white"
                    : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-tide/40"
                }"
              >
                Todo (${state.meta.validCount})
              </button>
              ${state.documents
                .map(
                  (document) => `
                    <button
                      type="button"
                      data-set-document="${escapeHtml(document.key)}"
                      class="rounded-full px-4 py-2 text-sm font-semibold transition ${
                        state.setup.document === document.key
                          ? "bg-tide text-white"
                          : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-tide/40"
                      }"
                    >
                      ${escapeHtml(document.label)} (${document.count})
                    </button>
                  `,
                )
                .join("")}
            </div>
          </div>

          <div class="mt-8">
            <div class="flex items-center justify-between gap-3">
              <p class="text-sm font-semibold uppercase tracking-[0.24em] text-slate-500">Cantidad</p>
              <p class="text-sm text-slate-500">Disponibles: ${pool.length}</p>
            </div>
            <div class="mt-3 flex flex-wrap gap-2">
              ${questionChoices
                .map((choice) => {
                  const isAll = choice === pool.length;
                  const label = isAll ? `Todas (${choice})` : String(choice);
                  return `
                    <button
                      type="button"
                      data-set-amount="${choice}"
                      class="rounded-2xl px-4 py-2 text-sm font-semibold transition ${
                        state.setup.amount === choice
                          ? "bg-amber-400 text-amber-950"
                          : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-amber-300"
                      }"
                    >
                      ${label}
                    </button>
                  `;
                })
                .join("")}
            </div>
          </div>

          <div class="mt-8 rounded-3xl bg-white/80 p-5 ring-1 ring-slate-200">
            <p class="text-sm font-semibold uppercase tracking-[0.22em] text-slate-500">Duración del examen</p>
            <div class="mt-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <p class="text-4xl font-extrabold text-ink">${state.setup.examMinutes} min</p>
                <p class="mt-2 text-sm leading-6 text-slate-500">Calculado automáticamente con la regla de tres: 60 minutos por cada 100 preguntas.</p>
              </div>
              <span class="rounded-full bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700">
                ${state.setup.amount} preguntas
              </span>
            </div>
          </div>

          <button
            type="button"
            data-start-session="true"
            class="mt-8 inline-flex w-full items-center justify-center rounded-[1.4rem] bg-ink px-6 py-4 font-display text-lg font-semibold text-white shadow-lg transition hover:-translate-y-0.5 hover:bg-slate-900"
          >
            ${state.setup.mode === "practice" ? "Empezar práctica" : "Empezar examen"}
          </button>
        </section>

        ${renderStatsPanelMarkup()}
      </div>
    `;
  }

  function renderPracticeAside(session) {
    const answered = getAnsweredCount(session);
    const correct = getCorrectCount(session);
    const pending = session.questions.length - answered;

    return `
      <aside class="glass-panel rounded-[2rem] border border-white/70 p-6 shadow-soft">
        <p class="font-display text-2xl font-semibold text-ink">Progreso</p>
        <div class="mt-6 space-y-4">
          <div class="rounded-3xl bg-white/85 p-4 ring-1 ring-slate-200">
            <p class="text-sm text-slate-500">Correctas</p>
            <p class="mt-2 text-3xl font-extrabold text-emerald-600">${correct}</p>
          </div>
          <div class="rounded-3xl bg-white/85 p-4 ring-1 ring-slate-200">
            <p class="text-sm text-slate-500">Respondidas</p>
            <p class="mt-2 text-3xl font-extrabold text-ink">${answered}</p>
          </div>
          <div class="rounded-3xl bg-white/85 p-4 ring-1 ring-slate-200">
            <p class="text-sm text-slate-500">Pendientes</p>
            <p class="mt-2 text-3xl font-extrabold text-amber-600">${pending}</p>
          </div>
        </div>
        <div class="mt-6 rounded-3xl bg-ink p-5 text-sm leading-7 text-slate-200">
          <p class="font-semibold text-white">Cómo usarlo</p>
          <p class="mt-2">Pulsa A-D o 1-4 para responder. Cuando aciertes o falles, verás la opción correcta al momento.</p>
        </div>
      </aside>
    `;
  }

  function renderExamAside(session) {
    const answered = getAnsweredCount(session);
    const marked = session.marked.size;

    return `
      <aside class="glass-panel rounded-[2rem] border border-white/70 p-6 shadow-soft">
        <div class="rounded-[1.6rem] bg-ink p-5 text-white">
          <p class="text-sm uppercase tracking-[0.22em] text-cyan-200">Tiempo restante</p>
          <p data-timer class="mt-3 font-display text-4xl font-semibold">${formatTime(getRemainingSeconds(session))}</p>
        </div>

        <div class="mt-5 grid grid-cols-2 gap-3">
          <div class="rounded-3xl bg-white/85 p-4 ring-1 ring-slate-200">
            <p class="text-sm text-slate-500">Respondidas</p>
            <p class="mt-2 text-2xl font-extrabold text-ink">${answered}</p>
          </div>
          <div class="rounded-3xl bg-white/85 p-4 ring-1 ring-slate-200">
            <p class="text-sm text-slate-500">Marcadas</p>
            <p class="mt-2 text-2xl font-extrabold text-amber-600">${marked}</p>
          </div>
        </div>

        <div class="mt-6">
          <div class="flex items-center justify-between gap-3">
            <p class="font-display text-xl font-semibold text-ink">Panel</p>
            <button
              type="button"
              data-toggle-mark="true"
              class="rounded-full bg-amber-100 px-4 py-2 text-sm font-semibold text-amber-800 transition hover:bg-amber-200"
            >
              ${session.marked.has(session.currentIndex) ? "Quitar marca" : "Marcar revisión"}
            </button>
          </div>

          <div class="mt-4 grid grid-cols-5 gap-2">
            ${session.questions
              .map((question, index) => {
                const status = getQuestionStatus(session, index);
                const classes =
                  status === "current"
                    ? "bg-ink text-white"
                    : status === "marked-answered"
                      ? "bg-amber-400 text-amber-950"
                      : status === "answered"
                        ? "bg-tide text-white"
                        : status === "marked"
                          ? "bg-amber-100 text-amber-900 ring-2 ring-amber-300"
                          : "bg-white text-slate-600 ring-1 ring-slate-200";

                return `
                  <button
                    type="button"
                    data-jump="${index}"
                    class="aspect-square rounded-2xl text-sm font-bold transition hover:-translate-y-0.5 ${classes}"
                    title="${escapeHtml(question.document)}"
                  >
                    ${index + 1}
                  </button>
                `;
              })
              .join("")}
          </div>
        </div>

        <button
          type="button"
          data-finish-session="true"
          class="mt-6 inline-flex w-full items-center justify-center rounded-[1.2rem] bg-rose-500 px-5 py-3 font-semibold text-white transition hover:bg-rose-600"
        >
          Entregar examen
        </button>
      </aside>
    `;
  }

  function renderSession() {
    const session = state.session;
    const question = session.questions[session.currentIndex];
    const currentAnswer = session.answers[session.currentIndex];
    const progress = Math.round(((session.currentIndex + 1) / session.questions.length) * 100);
    const isPracticeAnswered = session.mode === "practice" && currentAnswer !== null;
    const isLastQuestion = session.currentIndex === session.questions.length - 1;
    const correctOption = question.options[question.correctIndex];

    const feedback = isPracticeAnswered
      ? `
        <div class="rounded-[1.6rem] border ${
          currentAnswer === question.correctIndex
            ? "border-emerald-300 bg-emerald-50 text-emerald-950"
            : "border-rose-300 bg-rose-50 text-rose-950"
        } p-5">
          <p class="text-sm font-semibold uppercase tracking-[0.22em]">
            ${currentAnswer === question.correctIndex ? "Respuesta correcta" : "Respuesta incorrecta"}
          </p>
          <p class="mt-3 leading-7">
            La correcta es <span class="font-bold">${correctOption.letter}</span>. ${escapeHtml(correctOption.text)}
          </p>
        </div>
      `
      : "";

    root.innerHTML = `
      <div class="grid gap-6 ${session.mode === "exam" ? "xl:grid-cols-[1fr_21rem]" : "xl:grid-cols-[1fr_19rem]"}">
        <section class="glass-panel rounded-[2rem] border border-white/70 p-6 shadow-soft sm:p-8">
          <div class="flex flex-wrap items-center gap-3">
            <span class="rounded-full ${
              session.mode === "practice" ? "bg-tide text-white" : "bg-amber-300 text-amber-950"
            } px-4 py-2 text-sm font-semibold">
              ${session.mode === "practice" ? "Modo práctica" : "Modo examen"}
            </span>
            ${getDataSourceMarkup()}
            <span class="rounded-full bg-white/90 px-4 py-2 text-sm font-semibold text-slate-600 ring-1 ring-slate-200">
              ${escapeHtml(question.document)}
            </span>
            <span class="rounded-full bg-white/90 px-4 py-2 text-sm font-semibold text-slate-600 ring-1 ring-slate-200">
              Pregunta ${session.currentIndex + 1} de ${session.questions.length}
            </span>
            <button
              type="button"
              data-go-home="true"
              class="ml-auto rounded-full bg-white/90 px-4 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 transition hover:-translate-y-0.5 hover:ring-tide/40"
            >
              Volver al inicio
            </button>
          </div>

          <div class="mt-5 overflow-hidden rounded-full bg-slate-200">
            <div class="h-3 rounded-full bg-gradient-to-r from-tide via-cyan-400 to-amber-300" style="width: ${progress}%"></div>
          </div>

          <article class="mt-8 rounded-[1.8rem] bg-white/90 p-6 ring-1 ring-slate-200">
            <div class="flex flex-wrap items-center gap-3">
              <p class="text-sm font-semibold uppercase tracking-[0.22em] text-slate-400">Enunciado</p>
              <span class="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-600">
                N.º ${question.id}
              </span>
            </div>
            <h2 class="mt-4 text-2xl font-bold leading-10 text-ink">
              ${escapeHtml(question.question)}
            </h2>

            <div class="mt-8 grid gap-3">
              ${question.options
                .map(
                  (option, optionIndex) => `
                    <button
                      type="button"
                      data-answer="${optionIndex}"
                      class="${getOptionClasses(session, question, optionIndex)}"
                    >
                      <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${
                        currentAnswer === optionIndex
                          ? "bg-white/80 text-ink"
                          : "bg-slate-100 text-slate-500 group-hover:bg-tide/10 group-hover:text-tide"
                      } font-display text-lg font-semibold">
                        ${option.letter}
                      </span>
                      <span class="leading-7">${escapeHtml(option.text)}</span>
                    </button>
                  `,
                )
                .join("")}
            </div>
          </article>

          <div class="mt-5">${feedback}</div>

          <div class="mt-8 flex flex-wrap items-center justify-between gap-3">
            <div class="flex flex-wrap gap-3">
              <button
                type="button"
                data-nav="prev"
                class="rounded-[1.1rem] bg-white px-5 py-3 font-semibold text-slate-700 ring-1 ring-slate-200 transition hover:-translate-y-0.5 hover:ring-tide/40"
              >
                Anterior
              </button>
              <button
                type="button"
                data-nav="next"
                class="rounded-[1.1rem] bg-white px-5 py-3 font-semibold text-slate-700 ring-1 ring-slate-200 transition hover:-translate-y-0.5 hover:ring-tide/40"
              >
                ${isLastQuestion ? "Última" : "Siguiente"}
              </button>
            </div>

            <div class="flex flex-wrap gap-3">
              <button
                type="button"
                data-report-question="${escapeHtml(question.key)}"
                class="rounded-[1.1rem] bg-white px-5 py-3 font-semibold text-slate-700 ring-1 ring-slate-200 transition hover:-translate-y-0.5 hover:ring-coral/40"
              >
                Reportar pregunta
              </button>
              ${
                session.mode === "practice"
                  ? `
                    <button
                      type="button"
                      data-finish-session="true"
                      class="rounded-[1.1rem] bg-ink px-5 py-3 font-semibold text-white transition hover:bg-slate-900"
                    >
                      ${isLastQuestion && isPracticeAnswered ? "Ver resultados" : "Terminar práctica"}
                    </button>
                  `
                  : `
                    <button
                      type="button"
                      data-finish-session="true"
                      class="rounded-[1.1rem] bg-ink px-5 py-3 font-semibold text-white transition hover:bg-slate-900"
                    >
                      Finalizar examen
                    </button>
                  `
              }
            </div>
          </div>
        </section>

        ${session.mode === "practice" ? renderPracticeAside(session) : renderExamAside(session)}
      </div>
    `;
  }

  function renderSummary() {
    const summary = state.summary;
    const mistakesMarkup =
      summary.mistakes.length > 0
        ? summary.mistakes
            .map((item) => {
              const userAnswer =
                item.userAnswer === null
                  ? "Sin responder"
                  : `${item.question.options[item.userAnswer].letter}. ${item.question.options[item.userAnswer].text}`;
              const correctAnswer = `${item.question.options[item.correctIndex].letter}. ${item.question.options[item.correctIndex].text}`;

              return `
                <article class="rounded-[1.5rem] bg-white/90 p-5 ring-1 ring-slate-200">
                  <div class="flex flex-wrap items-center gap-3">
                    <span class="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                      Pregunta ${item.index + 1}
                    </span>
                    <span class="rounded-full bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-slate-600 ring-1 ring-slate-200">
                      N.º ${item.question.id}
                    </span>
                    <span class="rounded-full bg-tide/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-tide">
                      ${escapeHtml(item.question.document)}
                    </span>
                  </div>
                  <h3 class="mt-4 text-lg font-bold leading-8 text-ink">${escapeHtml(item.question.question)}</h3>
                  <p class="mt-4 rounded-2xl bg-rose-50 px-4 py-3 text-sm leading-7 text-rose-900">
                    <span class="font-semibold">Tu respuesta:</span> ${escapeHtml(userAnswer)}
                  </p>
                  <p class="mt-3 rounded-2xl bg-emerald-50 px-4 py-3 text-sm leading-7 text-emerald-900">
                    <span class="font-semibold">Correcta:</span> ${escapeHtml(correctAnswer)}
                  </p>
                  <button
                    type="button"
                    data-report-question="${escapeHtml(item.question.key)}"
                    class="mt-4 rounded-[1rem] bg-white px-4 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 transition hover:-translate-y-0.5 hover:ring-coral/40"
                  >
                    Reportar incidencia
                  </button>
                </article>
              `;
            })
            .join("")
        : `
          <div class="rounded-[1.6rem] border border-emerald-300 bg-emerald-50 p-6 text-emerald-950">
            <p class="font-display text-2xl font-semibold">Sin fallos en esta sesión</p>
            <p class="mt-2 text-sm leading-7">No hay preguntas para revisar. Puedes repetir el examen o lanzar otra práctica.</p>
          </div>
        `;

    root.innerHTML = `
      <div class="space-y-6">
        <section class="glass-panel rounded-[2rem] border border-white/70 p-6 shadow-soft sm:p-8">
          <div class="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
            <div>
              <p class="font-display text-sm font-semibold uppercase tracking-[0.28em] text-tide">Resultados</p>
              <h1 class="mt-3 font-display text-4xl font-semibold leading-tight text-ink">
                ${summary.mode === "practice" ? "Resumen de práctica" : "Corrección del examen"}
              </h1>
              <p class="mt-4 max-w-2xl text-lg leading-8 text-slate-600">
                ${summary.timedOut ? "El tiempo se agotó y el examen se entregó automáticamente." : "La sesión ya está corregida y lista para revisar."}
              </p>
              <p class="mt-2 text-sm leading-6 text-slate-500">
                ${state.storageAvailable ? "Este resultado ya se ha guardado en la memoria del navegador." : "No se ha podido guardar el resultado en este navegador."}
              </p>
              <p class="mt-3 text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
                Bloque: ${escapeHtml(summary.sourceLabel)}
              </p>
            </div>

            <div class="rounded-[1.75rem] bg-ink p-6 text-white">
              <p class="text-sm uppercase tracking-[0.24em] text-cyan-200">Puntuación</p>
              <p class="mt-4 font-display text-6xl font-semibold">${summary.scoreOverTen}</p>
              <p class="mt-2 text-slate-300">Equivale al ${summary.percentage}% de aciertos.</p>
              <p class="mt-5 text-sm text-slate-300">Duración: ${formatTime(summary.durationSeconds)}</p>
            </div>
          </div>

          <div class="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <article class="rounded-3xl bg-white/90 p-5 ring-1 ring-slate-200">
              <p class="text-sm text-slate-500">Correctas</p>
              <p class="mt-2 text-3xl font-extrabold text-emerald-600">${summary.correct}</p>
            </article>
            <article class="rounded-3xl bg-white/90 p-5 ring-1 ring-slate-200">
              <p class="text-sm text-slate-500">Incorrectas</p>
              <p class="mt-2 text-3xl font-extrabold text-rose-600">${summary.incorrect}</p>
            </article>
            <article class="rounded-3xl bg-white/90 p-5 ring-1 ring-slate-200">
              <p class="text-sm text-slate-500">Sin responder</p>
              <p class="mt-2 text-3xl font-extrabold text-amber-600">${summary.unanswered}</p>
            </article>
            <article class="rounded-3xl bg-white/90 p-5 ring-1 ring-slate-200">
              <p class="text-sm text-slate-500">Preguntas</p>
              <p class="mt-2 text-3xl font-extrabold text-ink">${summary.total}</p>
            </article>
          </div>

          <div class="mt-8 flex flex-wrap gap-3">
            <button
              type="button"
              data-repeat-mode="${summary.mode}"
              class="rounded-[1.15rem] bg-ink px-5 py-3 font-semibold text-white transition hover:bg-slate-900"
            >
              Repetir ${summary.mode === "practice" ? "práctica" : "examen"}
            </button>
            <button
              type="button"
              data-go-home="true"
              class="rounded-[1.15rem] bg-white px-5 py-3 font-semibold text-slate-700 ring-1 ring-slate-200 transition hover:-translate-y-0.5 hover:ring-tide/40"
            >
              Volver al inicio
            </button>
            ${
              summary.mistakes.length
                ? `
                  <button
                    type="button"
                    data-retry-mistakes="true"
                    class="rounded-[1.15rem] bg-amber-300 px-5 py-3 font-semibold text-amber-950 transition hover:bg-amber-400"
                  >
                    Practicar fallos
                  </button>
                `
                : ""
            }
          </div>

          <div class="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <article class="rounded-3xl bg-slate-50 p-4 ring-1 ring-slate-200">
              <p class="text-sm text-slate-500">Sesiones acumuladas</p>
              <p class="mt-2 text-3xl font-extrabold text-ink">${state.stats.totalSessions}</p>
            </article>
            <article class="rounded-3xl bg-slate-50 p-4 ring-1 ring-slate-200">
              <p class="text-sm text-slate-500">Acierto global</p>
              <p class="mt-2 text-3xl font-extrabold text-ink">${getOverallAccuracy()}%</p>
            </article>
            <article class="rounded-3xl bg-slate-50 p-4 ring-1 ring-slate-200">
              <p class="text-sm text-slate-500">Mejor nota</p>
              <p class="mt-2 text-3xl font-extrabold text-ink">${state.stats.bestScoreOverTen.toFixed(2)}</p>
            </article>
            <article class="rounded-3xl bg-slate-50 p-4 ring-1 ring-slate-200">
              <p class="text-sm text-slate-500">Racha aprobada</p>
              <p class="mt-2 text-3xl font-extrabold text-ink">${state.stats.currentStreak}</p>
            </article>
          </div>
        </section>

        <section class="glass-panel rounded-[2rem] border border-white/70 p-6 shadow-soft sm:p-8">
          <div class="flex items-center justify-between gap-4">
            <div>
              <p class="font-display text-2xl font-semibold text-ink">Revisión</p>
              <p class="mt-2 text-sm leading-6 text-slate-500">Aquí tienes las preguntas falladas o sin responder para repasar rápido.</p>
            </div>
            <span class="rounded-full bg-white/90 px-4 py-2 text-sm font-semibold text-slate-600 ring-1 ring-slate-200">
              ${summary.mistakes.length} para revisar
            </span>
          </div>

          <div class="mt-6 grid max-h-[40rem] gap-4 overflow-auto pr-1">
            ${mistakesMarkup}
          </div>
        </section>
      </div>
    `;
  }

  function renderEmptyState() {
    const title =
      state.dataStatus === "loading"
        ? "Cargando preguntas"
        : state.dataStatus === "error"
          ? "No he podido montar el simulador"
          : "No he podido montar el simulador";
    const description =
      state.dataStatus === "loading"
        ? `Estoy cargando el banco de preguntas desde ${state.activeDataSource === "json" ? "los archivos JSON" : "Supabase"}.`
        : state.dataStatus === "error"
          ? `${
              state.canUseJsonFallback
                ? "No se han podido cargar las preguntas desde Supabase."
                : `No se han podido cargar las preguntas desde ${state.activeDataSource === "json" ? "los JSON" : "la fuente configurada"}.`
            } ${escapeHtml(state.dataError || "")} ${
              state.activeDataSource === "json" && window.location.protocol === "file:"
                ? "Si estás abriendo el HTML directamente, lánzalo con un servidor local para que el navegador permita leer los JSON."
                : ""
            }`
          : "No se han encontrado preguntas válidas para iniciar una sesión.";
    const action =
      state.dataStatus === "error" && state.canUseJsonFallback
        ? `
          <button
            type="button"
            data-load-json-fallback="true"
            class="mt-6 inline-flex items-center justify-center rounded-[1.1rem] bg-ink px-5 py-3 font-semibold text-white transition hover:bg-slate-900"
          >
            Usar copia local JSON
          </button>
        `
        : "";

    root.innerHTML = `
      <section class="glass-panel mx-auto max-w-3xl rounded-[2rem] border border-white/70 p-8 text-center shadow-soft">
        <p class="font-display text-3xl font-semibold text-ink">${title}</p>
        <p class="mt-4 text-lg leading-8 text-slate-600">
          ${description}
        </p>
        ${action}
      </section>
    `;
  }

  function render() {
    if (!state.questions.length) {
      renderEmptyState();
      return;
    }

    if (state.authReady && !state.userId) {
      renderAuthGate();
      return;
    }

    if (state.session) {
      renderSession();
      return;
    }

    if (state.summary) {
      renderSummary();
      return;
    }

    renderHome();
  }

  async function handleClick(event) {
    const target = event.target.closest("[data-set-mode], [data-set-document], [data-set-amount], [data-toggle-stats-panel], [data-start-session], [data-answer], [data-nav], [data-jump], [data-finish-session], [data-toggle-mark], [data-go-home], [data-repeat-mode], [data-retry-mistakes], [data-reset-stats], [data-report-question], [data-load-json-fallback], [data-auth-login], [data-auth-logout]");

    if (!target) {
      return;
    }

    if (target.dataset.setMode) {
      state.setup.mode = target.dataset.setMode;
      persistSetup();
      render();
      return;
    }

    if (target.dataset.setDocument) {
      state.setup.document = target.dataset.setDocument;
      clampSetupAmount();
      persistSetup();
      render();
      return;
    }

    if (target.dataset.setAmount) {
      const nextAmount = Number(target.dataset.setAmount);
      if (Number.isFinite(nextAmount)) {
        state.setup.amount = nextAmount;
        state.setup.examMinutes = recommendedExamMinutes(nextAmount);
      }
      persistSetup();
      render();
      return;
    }

    if (target.dataset.toggleStatsPanel) {
      state.isStatsPanelOpen = !state.isStatsPanelOpen;
      render();
      return;
    }

    if (target.dataset.authLogout) {
      await signOutUser();
      return;
    }

    if (target.dataset.startSession) {
      startSession();
      return;
    }

    if (target.dataset.answer !== undefined) {
      selectAnswer(Number(target.dataset.answer));
      return;
    }

    if (target.dataset.nav) {
      moveQuestion(target.dataset.nav === "next" ? 1 : -1);
      return;
    }

    if (target.dataset.jump !== undefined) {
      goToQuestion(Number(target.dataset.jump));
      return;
    }

    if (target.dataset.finishSession) {
      finishSession();
      return;
    }

    if (target.dataset.toggleMark) {
      toggleCurrentMark();
      return;
    }

    if (target.dataset.goHome) {
      stopTimer();
      state.session = null;
      state.summary = null;
      state.isStatsPanelOpen = false;
      render();
      return;
    }

    if (target.dataset.resetStats) {
      resetPersistedStats();
      render();
      return;
    }

    if (target.dataset.repeatMode) {
      state.setup.mode = target.dataset.repeatMode;
      persistSetup();
      startSession();
      return;
    }

    if (target.dataset.retryMistakes && state.summary?.mistakes?.length) {
      startSession(
        state.summary.mistakes.map((item) => item.question),
        "practice",
      );
      return;
    }

    if (target.dataset.reportQuestion) {
      const question = getQuestionByCompositeKey(target.dataset.reportQuestion);
      if (question) {
        await submitQuestionReport(question);
      }
      return;
    }

    if (target.dataset.loadJsonFallback) {
      state.dataStatus = "loading";
      state.dataError = "";
      render();

      try {
        const rawQuestions = await loadQuestionBankFromJsonFallback();
        prepareData(rawQuestions);
        loadPersistedSetup();
        await hydrateStats();
        state.dataStatus = "ready";
        state.dataError = "";
        state.canUseJsonFallback = false;
      } catch (error) {
        state.dataStatus = "error";
        state.dataError = error instanceof Error ? error.message : "Error desconocido al cargar el JSON.";
      }
      render();
    }
  }

  function handleKeyDown(event) {
    if (!state.session) {
      return;
    }

    const activeTag = document.activeElement?.tagName;
    if (activeTag === "INPUT" || activeTag === "TEXTAREA") {
      return;
    }

    const key = event.key.toLowerCase();

    if (["1", "2", "3", "4", "a", "b", "c", "d"].includes(key)) {
      const index = ["1", "2", "3", "4"].includes(key)
        ? Number(key) - 1
        : LETTERS.map((letter) => letter.toLowerCase()).indexOf(key);
      if (index >= 0) {
        event.preventDefault();
        selectAnswer(index);
      }
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      moveQuestion(1);
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveQuestion(-1);
      return;
    }

    if (event.key.toLowerCase() === "m") {
      toggleCurrentMark();
    }
  }

  root.addEventListener("submit", async (event) => {
    const form = event.target;

    if (!form.matches("[data-login-form]")) {
      return;
    }

    event.preventDefault();
    const email = form.elements.namedItem("email").value.trim();
    const password = form.elements.namedItem("password").value;
    await signInUser(email, password);
  });

  async function init() {
    state.storageAvailable = Boolean(safeStorage());
    state.dataStatus = "loading";
    root.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    render();

    try {
      await refreshAuthSession();
      const rawQuestions = await loadQuestionBank();
      prepareData(rawQuestions);
      loadPersistedSetup();
      await hydrateStats();
      state.dataStatus = "ready";
      state.dataError = "";
      state.canUseJsonFallback = false;
    } catch (error) {
      state.dataStatus = "error";
      state.dataError = error instanceof Error ? error.message : "Error desconocido al cargar las preguntas.";
      state.canUseJsonFallback = isSupabaseConfigured();
      state.authReady = true;
    }

    render();
  }

  init();
})();
