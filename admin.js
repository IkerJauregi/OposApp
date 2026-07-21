"use strict";

(function () {
  const root = document.getElementById("admin-app");
  const LETTERS = ["A", "B", "C", "D"];
  const DOCUMENT_OPTIONS = [
    { value: "BATERIA_COMUN", label: "Batería común" },
    { value: "CELADOR", label: "Celador" },
    { value: "RADIOGRAFIA", label: "Radiografía" },
  ];
  const REVIEW_STATUS_OPTIONS = [
    { value: "published", label: "Publicada" },
    { value: "pending", label: "Pendiente" },
    { value: "needs_review", label: "Necesita revisión" },
  ];
  const REPORT_STATUS_OPTIONS = [
    { value: "new", label: "Nueva" },
    { value: "reviewing", label: "En revisión" },
    { value: "resolved", label: "Resuelta" },
    { value: "dismissed", label: "Descartada" },
  ];

  const state = {
    client: null,
    authStatus: "loading",
    userEmail: "",
    isAdmin: false,
    dataStatus: "idle",
    error: "",
    saveMessage: "",
    questions: [],
    reports: [],
    filters: {
      document: "all",
      reviewStatus: "all",
      search: "",
    },
    selectedQuestionId: null,
    draftQuestion: null,
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
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
    return repairMojibake(value).replace(/\s+/g, " ").trim();
  }

  function formatDocumentName(value) {
    const found = DOCUMENT_OPTIONS.find((item) => item.value === value);
    return found ? found.label : cleanText(String(value || "Sin categoría").replace(/_/g, " "));
  }

  function formatDateTime(value) {
    if (!value) {
      return "Sin fecha";
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

  function getSupabaseService() {
    return window.OposAppSupabase || null;
  }

  function isAdminUser(user) {
    return user?.app_metadata?.role === "admin" || user?.user_metadata?.role === "admin";
  }

  function createDraftQuestion() {
    return {
      id: null,
      documento: "BATERIA_COMUN",
      question_number: 1,
      pregunta: "",
      opciones: LETTERS.map((letter, index) => ({
        letra: letter.toLowerCase(),
        texto: "",
        estado: index === 0 ? "Correcta" : "Incorrecta",
      })),
      review_status: "pending",
      is_active: true,
      editor_note: "",
    };
  }

  function normalizeOptions(options) {
    const base = Array.isArray(options) ? options : [];
    return LETTERS.map((letter, index) => {
      const current = base[index] || {};
      return {
        letra: String(current.letra || letter).toLowerCase(),
        texto: cleanText(current.texto || ""),
        estado: current.estado === "Correcta" ? "Correcta" : "Incorrecta",
      };
    });
  }

  function normalizeQuestion(row) {
    return {
      id: row.id,
      documento: row.documento,
      question_number: Number(row.question_number) || 0,
      pregunta: cleanText(row.pregunta),
      opciones: normalizeOptions(row.opciones),
      review_status: row.review_status || "pending",
      is_active: row.is_active !== false,
      editor_note: cleanText(row.editor_note || ""),
      updated_at: row.updated_at || row.created_at || null,
    };
  }

  function getReportStatusLabel(value) {
    const found = REPORT_STATUS_OPTIONS.find((item) => item.value === value);
    return found ? found.label : value;
  }

  function getReviewStatusLabel(value) {
    const normalized = normalizeReviewStatus(value);
    const found = REVIEW_STATUS_OPTIONS.find((item) => item.value === normalized);
    return found ? found.label : value;
  }

  function normalizeReviewStatus(value) {
    const status = cleanText(value || "pending").toLowerCase();

    if (["published", "publicada", "publicado"].includes(status)) {
      return "published";
    }

    if (["needs_review", "needs review", "needs-review", "reviewing", "en revision", "en revisión", "revision", "revisión"].includes(status)) {
      return "needs_review";
    }

    return "pending";
  }

  function questionNeedsReview(question) {
    return normalizeReviewStatus(question.review_status) === "needs_review" || getOpenReportCount(question.id) > 0;
  }

  function getOpenReportCount(questionId) {
    return state.reports.filter(
      (report) =>
        report.question_id === questionId && report.status !== "resolved" && report.status !== "dismissed",
    ).length;
  }

  function getSelectedQuestion() {
    if (state.selectedQuestionId === "new") {
      return state.draftQuestion || createDraftQuestion();
    }

    return state.questions.find((question) => question.id === state.selectedQuestionId) || null;
  }

  function getSelectedQuestionReports() {
    const question = getSelectedQuestion();
    if (!question?.id) {
      return [];
    }

    return state.reports.filter((report) => report.question_id === question.id);
  }

  function getFilteredQuestions() {
    const search = state.filters.search.trim().toLowerCase();

    return state.questions.filter((question) => {
      if (state.filters.document !== "all" && question.documento !== state.filters.document) {
        return false;
      }

      if (state.filters.reviewStatus === "needs_review" && !questionNeedsReview(question)) {
        return false;
      }

      if (
        state.filters.reviewStatus !== "all" &&
        state.filters.reviewStatus !== "needs_review" &&
        normalizeReviewStatus(question.review_status) !== state.filters.reviewStatus
      ) {
        return false;
      }

      if (!search) {
        return true;
      }

      const haystack = [
        question.documento,
        String(question.question_number),
        question.pregunta,
        ...question.opciones.map((option) => option.texto),
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(search);
    });
  }

  async function loadData() {
    if (!state.client) {
      return;
    }

    state.dataStatus = "loading";
    state.error = "";
    state.saveMessage = "";
    render();

    const config = getSupabaseService().getConfig();
    const questionsRequest = state.client
      .from(config.questionsTable)
      .select("id, documento, question_number, pregunta, opciones, review_status, is_active, editor_note, created_at, updated_at")
      .order("documento", { ascending: true })
      .order("question_number", { ascending: true });

    const reportsRequest = state.client
      .from(config.reportsTable)
      .select("id, question_id, note, status, created_at, question_snapshot")
      .order("created_at", { ascending: false });

    const [{ data: questions, error: questionsError }, { data: reports, error: reportsError }] =
      await Promise.all([questionsRequest, reportsRequest]);

    if (questionsError || reportsError) {
      state.dataStatus = "error";
      state.error = questionsError?.message || reportsError?.message || "No se han podido cargar los datos.";
      render();
      return;
    }

    state.questions = (questions || []).map(normalizeQuestion);
    state.reports = reports || [];
    state.dataStatus = "ready";

    if (!state.selectedQuestionId && state.questions.length) {
      state.selectedQuestionId = state.questions[0].id;
    } else if (
      state.selectedQuestionId !== "new" &&
      state.selectedQuestionId !== null &&
      !state.questions.some((question) => question.id === state.selectedQuestionId)
    ) {
      state.selectedQuestionId = state.questions[0]?.id || null;
    }

    render();
  }

  async function saveQuestion() {
    if (!state.client) {
      return;
    }

    const form = root.querySelector("[data-question-form]");
    if (!form) {
      return;
    }

    const questionId = form.elements.namedItem("question_id").value.trim();
    const documento = form.elements.namedItem("documento").value;
    const questionNumber = Number(form.elements.namedItem("question_number").value);
    const pregunta = cleanText(form.elements.namedItem("pregunta").value);
    const reviewStatus = form.elements.namedItem("review_status").value;
    const isActive = form.elements.namedItem("is_active").checked;
    const editorNote = cleanText(form.elements.namedItem("editor_note").value);
    const correctIndex = Number(form.elements.namedItem("correct_index").value);
    const opciones = LETTERS.map((letter, index) => ({
      letra: letter.toLowerCase(),
      texto: cleanText(form.elements.namedItem(`option_${index}`).value),
      estado: index === correctIndex ? "Correcta" : "Incorrecta",
    }));

    if (!documento || !pregunta || !Number.isFinite(questionNumber) || questionNumber <= 0) {
      state.saveMessage = "Completa documento, número y enunciado antes de guardar.";
      render();
      return;
    }

    if (opciones.some((option) => !option.texto)) {
      state.saveMessage = "Las cuatro opciones tienen que tener texto.";
      render();
      return;
    }

    const payload = {
      documento,
      question_number: questionNumber,
      pregunta,
      opciones,
      review_status: reviewStatus,
      is_active: isActive,
      editor_note: editorNote,
      updated_at: new Date().toISOString(),
    };

    state.saveMessage = "Guardando cambios...";
    render();

    const config = getSupabaseService().getConfig();
    let result;

    if (questionId) {
      result = await state.client
        .from(config.questionsTable)
        .update(payload)
        .eq("id", Number(questionId))
        .select("id")
        .single();
    } else {
      result = await state.client.from(config.questionsTable).insert(payload).select("id").single();
    }

    if (result.error) {
      state.saveMessage = `No se ha podido guardar: ${result.error.message}`;
      render();
      return;
    }

    state.selectedQuestionId = result.data.id;
    state.draftQuestion = null;
    state.saveMessage = "Pregunta guardada.";
    await loadData();
  }

  async function updateReportStatus(reportId, status) {
    if (!state.client) {
      return;
    }

    const config = getSupabaseService().getConfig();
    const { error } = await state.client
      .from(config.reportsTable)
      .update({ status })
      .eq("id", Number(reportId));

    if (error) {
      state.error = error.message;
      render();
      return;
    }

    state.reports = state.reports.map((report) =>
      report.id === Number(reportId)
        ? {
            ...report,
            status,
          }
        : report,
    );
    render();
  }

  async function signOut() {
    if (!state.client) {
      return;
    }

    await state.client.auth.signOut();
    state.authStatus = "signed_out";
    state.userEmail = "";
    state.isAdmin = false;
    state.selectedQuestionId = null;
    state.draftQuestion = null;
    render();
  }

  function renderSetupState() {
    root.innerHTML = `
      <section class="glass-panel mx-auto max-w-3xl rounded-[2rem] border border-white/70 p-8 shadow-soft">
        <p class="text-sm font-semibold uppercase tracking-[0.24em] text-tide">Supabase</p>
        <h1 class="mt-3 font-display text-4xl font-semibold text-ink">Falta la configuración pública</h1>
        <p class="mt-4 text-lg leading-8 text-slate-600">
          Rellena <code>supabase-config.js</code> con la URL y la anon key del proyecto para activar el panel.
        </p>
      </section>
    `;
  }

  function renderLoginState() {
    root.innerHTML = `
      <div class="grid gap-6 xl:grid-cols-[1fr_24rem]">
        <section class="glass-panel rounded-[2rem] border border-white/70 p-8 shadow-soft">
          <p class="text-sm font-semibold uppercase tracking-[0.24em] text-tide">Panel admin</p>
          <h1 class="mt-3 font-display text-4xl font-semibold text-ink">Editar preguntas desde cualquier navegador</h1>
          <p class="mt-4 max-w-2xl text-lg leading-8 text-slate-600">
            El acceso está unificado con el simulador. Primero inicia sesión desde la portada y luego vuelve aquí con la misma sesión.
          </p>
          <div class="mt-8 grid gap-4 sm:grid-cols-3">
            <article class="rounded-3xl bg-white/85 p-5 ring-1 ring-slate-200">
              <p class="text-sm text-slate-500">Proyecto</p>
              <p class="mt-2 text-2xl font-extrabold text-ink">${escapeHtml(
                getSupabaseService().getConfig().siteName,
              )}</p>
            </article>
            <article class="rounded-3xl bg-white/85 p-5 ring-1 ring-slate-200">
              <p class="text-sm text-slate-500">Edición</p>
              <p class="mt-2 text-2xl font-extrabold text-ink">En vivo</p>
            </article>
            <article class="rounded-3xl bg-white/85 p-5 ring-1 ring-slate-200">
              <p class="text-sm text-slate-500">Publicación</p>
              <p class="mt-2 text-2xl font-extrabold text-ink">GitHub Pages</p>
            </article>
          </div>
        </section>

        <section class="glass-panel rounded-[2rem] border border-white/70 p-8 shadow-soft">
          <p class="font-display text-2xl font-semibold text-ink">Mismo acceso</p>
          <p class="mt-4 text-sm leading-7 text-slate-600">
            Usa el login del simulador para entrar. Cuando tu cuenta tenga rol admin, podrás abrir este panel sin volver a autenticarte.
          </p>
          <a
            href="index.html"
            class="mt-6 inline-flex w-full items-center justify-center rounded-[1.1rem] bg-ink px-5 py-3 font-semibold text-white transition hover:bg-slate-900"
          >
            Ir al acceso
          </a>
          ${
            state.error
              ? `<p class="mt-4 rounded-2xl bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800">${escapeHtml(
                  state.error,
                )}</p>`
              : ""
          }
        </section>
      </div>
    `;
  }

  function renderUnauthorizedState() {
    root.innerHTML = `
      <section class="glass-panel mx-auto max-w-3xl rounded-[2rem] border border-white/70 p-8 text-center shadow-soft">
        <div class="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-3xl bg-rose-100 text-rose-700">
          <svg viewBox="0 0 24 24" aria-hidden="true" class="h-7 w-7 fill-none stroke-current" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3l7 4v5c0 5-3.5 7.5-7 9-3.5-1.5-7-4-7-9V7l7-4z"></path>
          </svg>
        </div>
        <p class="mt-5 font-display text-3xl font-semibold text-ink">Acceso restringido</p>
        <p class="mt-4 text-lg leading-8 text-slate-600">
          La sesión de ${escapeHtml(state.userEmail || "este usuario")} está activa, pero no tiene rol admin.
        </p>
        <a
          href="index.html"
          class="mt-6 inline-flex items-center justify-center rounded-[1.1rem] bg-ink px-5 py-3 font-semibold text-white transition hover:bg-slate-900"
        >
          Volver al simulador
        </a>
      </section>
    `;
  }

  function renderQuestionListItem(question) {
    const isSelected = state.selectedQuestionId === question.id;
    const openReports = getOpenReportCount(question.id);

    return `
      <button
        type="button"
        data-select-question="${question.id}"
        class="w-full rounded-[1.2rem] border p-4 text-left transition ${
          isSelected
            ? "border-ink bg-ink text-white shadow-lg"
            : "border-slate-200 bg-white/85 text-ink hover:border-tide/50 hover:shadow-md"
        }"
      >
        <div class="flex flex-wrap items-center gap-2">
          <span class="rounded-full ${
            isSelected ? "bg-white/20 text-white" : "bg-slate-100 text-slate-700"
          } px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em]">
            ${escapeHtml(formatDocumentName(question.documento))}
          </span>
          <span class="rounded-full ${
            openReports
              ? isSelected
                ? "bg-amber-300 text-amber-950"
                : "bg-amber-100 text-amber-800"
              : isSelected
                ? "bg-white/20 text-white"
                : "bg-slate-100 text-slate-600"
          } px-3 py-1 text-xs font-semibold">
            ${openReports ? `${openReports} incidencias` : "Sin incidencias"}
          </span>
        </div>
        <p class="mt-3 text-sm font-semibold ${
          isSelected ? "text-slate-200" : "text-slate-500"
        }">Pregunta ${question.question_number} · ${escapeHtml(getReviewStatusLabel(question.review_status))}</p>
        <p class="mt-2 line-clamp-3 text-sm leading-6 ${isSelected ? "text-white" : "text-slate-700"}">
          ${escapeHtml(question.pregunta)}
        </p>
      </button>
    `;
  }

  function renderEditor() {
    const question = getSelectedQuestion();

    if (!question) {
      return `
        <section class="glass-panel rounded-[2rem] border border-white/70 p-8 shadow-soft">
          <p class="font-display text-2xl font-semibold text-ink">Editor</p>
          <p class="mt-4 text-slate-600">Selecciona una pregunta para empezar a editarla.</p>
        </section>
      `;
    }

    const correctIndex = Math.max(
      0,
      question.opciones.findIndex((option) => option.estado === "Correcta"),
    );
    const questionReports = getSelectedQuestionReports();

    return `
      <section class="glass-panel rounded-[2rem] border border-white/70 p-6 shadow-soft sm:p-8">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p class="font-display text-2xl font-semibold text-ink">
              ${question.id ? `Editar pregunta ${question.question_number}` : "Nueva pregunta"}
            </p>
            <p class="mt-2 text-sm leading-6 text-slate-500">
              ${question.id ? `Último cambio: ${escapeHtml(formatDateTime(question.updated_at))}` : "Se guardará en Supabase al enviar el formulario."}
            </p>
          </div>
          <a
            href="index.html"
            class="rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 transition hover:ring-tide/40"
          >
            Abrir simulador
          </a>
        </div>

        <form data-question-form class="mt-8 space-y-5">
          <input type="hidden" name="question_id" value="${question.id || ""}" />

          <div class="grid gap-4 md:grid-cols-2">
            <label class="block">
              <span class="text-sm font-semibold text-slate-600">Bloque</span>
              <select
                name="documento"
                class="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-slate-800 outline-none transition focus:border-tide"
              >
                ${DOCUMENT_OPTIONS.map(
                  (option) => `
                    <option value="${option.value}" ${question.documento === option.value ? "selected" : ""}>
                      ${escapeHtml(option.label)}
                    </option>
                  `,
                ).join("")}
              </select>
            </label>

            <label class="block">
              <span class="text-sm font-semibold text-slate-600">Número de pregunta</span>
              <input
                type="number"
                min="1"
                name="question_number"
                value="${question.question_number || 1}"
                class="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-slate-800 outline-none transition focus:border-tide"
              />
            </label>
          </div>

          <label class="block">
            <span class="text-sm font-semibold text-slate-600">Enunciado</span>
            <textarea
              name="pregunta"
              rows="4"
              class="mt-2 w-full rounded-[1.2rem] border border-slate-200 bg-white px-4 py-3 text-slate-800 outline-none transition focus:border-tide"
            >${escapeHtml(question.pregunta)}</textarea>
          </label>

          <div class="grid gap-4">
            ${question.opciones
              .map(
                (option, index) => `
                  <label class="block">
                    <span class="text-sm font-semibold text-slate-600">Opción ${LETTERS[index]}</span>
                    <textarea
                      name="option_${index}"
                      rows="3"
                      class="mt-2 w-full rounded-[1.2rem] border border-slate-200 bg-white px-4 py-3 text-slate-800 outline-none transition focus:border-tide"
                    >${escapeHtml(option.texto)}</textarea>
                  </label>
                `,
              )
              .join("")}
          </div>

          <div class="grid gap-4 md:grid-cols-3">
            <label class="block">
              <span class="text-sm font-semibold text-slate-600">Respuesta correcta</span>
              <select
                name="correct_index"
                class="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-slate-800 outline-none transition focus:border-tide"
              >
                ${LETTERS.map(
                  (letter, index) => `
                    <option value="${index}" ${correctIndex === index ? "selected" : ""}>${letter}</option>
                  `,
                ).join("")}
              </select>
            </label>

            <label class="block">
              <span class="text-sm font-semibold text-slate-600">Estado editorial</span>
              <select
                name="review_status"
                class="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-slate-800 outline-none transition focus:border-tide"
              >
                ${REVIEW_STATUS_OPTIONS.map(
                  (option) => `
                    <option value="${option.value}" ${normalizeReviewStatus(question.review_status) === option.value ? "selected" : ""}>
                      ${escapeHtml(option.label)}
                    </option>
                  `,
                ).join("")}
              </select>
            </label>

            <label class="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3">
              <input type="checkbox" name="is_active" class="h-4 w-4" ${question.is_active ? "checked" : ""} />
              <span class="text-sm font-semibold text-slate-700">Visible en la app</span>
            </label>
          </div>

          <label class="block">
            <span class="text-sm font-semibold text-slate-600">Nota interna</span>
            <textarea
              name="editor_note"
              rows="3"
              class="mt-2 w-full rounded-[1.2rem] border border-slate-200 bg-white px-4 py-3 text-slate-800 outline-none transition focus:border-tide"
            >${escapeHtml(question.editor_note || "")}</textarea>
          </label>

          <div class="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              data-save-question="true"
              class="rounded-[1.1rem] bg-ink px-5 py-3 font-semibold text-white transition hover:bg-slate-900"
            >
              Guardar
            </button>
            <button
              type="button"
              data-new-question="true"
              class="rounded-[1.1rem] bg-white px-5 py-3 font-semibold text-slate-700 ring-1 ring-slate-200 transition hover:ring-tide/40"
            >
              Nueva pregunta
            </button>
            ${
              state.saveMessage
                ? `<p class="text-sm font-medium text-slate-600">${escapeHtml(state.saveMessage)}</p>`
                : ""
            }
          </div>
        </form>

        <div class="mt-8">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <p class="font-display text-xl font-semibold text-ink">Incidencias de esta pregunta</p>
            <span class="rounded-full bg-slate-100 px-3 py-1 text-sm font-semibold text-slate-600">
              ${questionReports.length}
            </span>
          </div>
          <div class="mt-4 grid gap-3">
            ${
              questionReports.length
                ? questionReports
                    .map(
                      (report) => `
                        <article class="rounded-[1.2rem] bg-white/85 p-4 ring-1 ring-slate-200">
                          <div class="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <p class="text-sm font-semibold text-ink">${escapeHtml(getReportStatusLabel(report.status))}</p>
                              <p class="mt-1 text-xs text-slate-500">${escapeHtml(formatDateTime(report.created_at))}</p>
                            </div>
                            <div class="flex flex-wrap gap-2">
                              ${REPORT_STATUS_OPTIONS.map(
                                (option) => `
                                  <button
                                    type="button"
                                    data-update-report="${report.id}"
                                    data-report-status="${option.value}"
                                    class="rounded-full px-3 py-1 text-xs font-semibold transition ${
                                      option.value === report.status
                                        ? "bg-ink text-white"
                                        : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                                    }"
                                  >
                                    ${escapeHtml(option.label)}
                                  </button>
                                `,
                              ).join("")}
                            </div>
                          </div>
                          <p class="mt-3 text-sm leading-7 text-slate-700">${escapeHtml(report.note || "Sin detalle.")}</p>
                        </article>
                      `,
                    )
                    .join("")
                : `
                  <div class="rounded-[1.2rem] bg-white/85 p-5 ring-1 ring-slate-200">
                    <p class="text-sm leading-7 text-slate-500">Todavía no hay incidencias asociadas a esta pregunta.</p>
                  </div>
                `
            }
          </div>
        </div>
      </section>
    `;
  }

  function renderDashboard() {
    const filteredQuestions = getFilteredQuestions();
    const totalReports = state.reports.filter(
      (report) => report.status !== "resolved" && report.status !== "dismissed",
    ).length;

    root.innerHTML = `
      <div class="space-y-6">
        <section class="glass-panel rounded-[2rem] border border-white/70 p-6 shadow-soft sm:p-8">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p class="text-sm font-semibold uppercase tracking-[0.24em] text-tide">Panel editorial</p>
              <h1 class="mt-3 font-display text-4xl font-semibold text-ink">Banco de preguntas en Supabase</h1>
              <p class="mt-4 max-w-3xl text-lg leading-8 text-slate-600">
                Aquí podéis corregir preguntas, ocultar las que estén mal y revisar las incidencias que lleguen desde la app pública.
              </p>
            </div>
            <div class="flex flex-wrap gap-3">
              <button
                type="button"
                data-refresh="true"
                class="rounded-[1.1rem] bg-white px-5 py-3 font-semibold text-slate-700 ring-1 ring-slate-200 transition hover:ring-tide/40"
              >
                Recargar
              </button>
              <button
                type="button"
                data-sign-out="true"
                class="rounded-[1.1rem] bg-ink px-5 py-3 font-semibold text-white transition hover:bg-slate-900"
              >
                Cerrar sesión
              </button>
            </div>
          </div>

          <div class="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <article class="rounded-3xl bg-white/85 p-5 ring-1 ring-slate-200">
              <p class="text-sm text-slate-500">Preguntas</p>
              <p class="mt-2 text-3xl font-extrabold text-ink">${state.questions.length}</p>
            </article>
            <article class="rounded-3xl bg-white/85 p-5 ring-1 ring-slate-200">
              <p class="text-sm text-slate-500">Pendientes</p>
              <p class="mt-2 text-3xl font-extrabold text-amber-600">${
                state.questions.filter((question) => normalizeReviewStatus(question.review_status) !== "published").length
              }</p>
            </article>
            <article class="rounded-3xl bg-white/85 p-5 ring-1 ring-slate-200">
              <p class="text-sm text-slate-500">Incidencias abiertas</p>
              <p class="mt-2 text-3xl font-extrabold text-coral">${totalReports}</p>
            </article>
            <article class="rounded-3xl bg-white/85 p-5 ring-1 ring-slate-200">
              <p class="text-sm text-slate-500">Filtradas</p>
              <p class="mt-2 text-3xl font-extrabold text-ink">${filteredQuestions.length}</p>
            </article>
          </div>

          ${
            state.error
              ? `<p class="mt-6 rounded-2xl bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800">${escapeHtml(
                  state.error,
                )}</p>`
              : ""
          }
        </section>

        <div class="grid gap-6 xl:grid-cols-[24rem_1fr]">
          <section class="glass-panel rounded-[2rem] border border-white/70 p-6 shadow-soft">
            <div class="flex items-center justify-between gap-3">
              <p class="font-display text-2xl font-semibold text-ink">Preguntas</p>
              <button
                type="button"
                data-new-question="true"
                class="rounded-full bg-amber-300 px-4 py-2 text-sm font-semibold text-amber-950 transition hover:bg-amber-400"
              >
                Nueva
              </button>
            </div>

            <div class="mt-6 grid gap-3">
              <input
                type="search"
                data-filter-search="true"
                value="${escapeHtml(state.filters.search)}"
                placeholder="Buscar por texto o número"
                class="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-slate-800 outline-none transition focus:border-tide"
              />
              <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                <select
                  data-filter-document="true"
                  class="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-slate-800 outline-none transition focus:border-tide"
                >
                  <option value="all">Todos los bloques</option>
                  ${DOCUMENT_OPTIONS.map(
                    (option) => `
                      <option value="${option.value}" ${state.filters.document === option.value ? "selected" : ""}>
                        ${escapeHtml(option.label)}
                      </option>
                    `,
                  ).join("")}
                </select>
                <select
                  data-filter-review="true"
                  class="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-slate-800 outline-none transition focus:border-tide"
                >
                  <option value="all">Todos los estados</option>
                  ${REVIEW_STATUS_OPTIONS.map(
                    (option) => `
                      <option value="${option.value}" ${state.filters.reviewStatus === option.value ? "selected" : ""}>
                        ${escapeHtml(option.label)}
                      </option>
                    `,
                  ).join("")}
                </select>
              </div>
            </div>

            <div class="mt-6 grid max-h-[65vh] gap-3 overflow-auto pr-1">
              ${
                filteredQuestions.length
                  ? filteredQuestions.map(renderQuestionListItem).join("")
                  : `
                    <div class="rounded-[1.2rem] bg-white/85 p-5 ring-1 ring-slate-200">
                      <p class="text-sm leading-7 text-slate-500">No hay preguntas con los filtros actuales.</p>
                    </div>
                  `
              }
            </div>
          </section>

          ${renderEditor()}
        </div>
      </div>
    `;
  }

  function renderLoadingState() {
    root.innerHTML = `
      <section class="glass-panel mx-auto max-w-3xl rounded-[2rem] border border-white/70 p-8 text-center shadow-soft">
        <p class="font-display text-3xl font-semibold text-ink">Cargando panel</p>
        <p class="mt-4 text-lg leading-8 text-slate-600">
          Estoy conectando con Supabase y preparando el editor.
        </p>
      </section>
    `;
  }

  function render() {
    const service = getSupabaseService();
    if (!service?.hasConfig?.()) {
      renderSetupState();
      return;
    }

    if (state.authStatus === "loading" || state.dataStatus === "loading") {
      renderLoadingState();
      return;
    }

    if (state.authStatus !== "signed_in") {
      renderLoginState();
      return;
    }

    if (!state.isAdmin) {
      renderUnauthorizedState();
      return;
    }

    renderDashboard();
  }

  function restoreSearchFocus(value, selectionStart, selectionEnd) {
    const input = root.querySelector("[data-filter-search]");
    if (!input) {
      return;
    }

    input.focus();
    if (typeof selectionStart === "number" && typeof selectionEnd === "number") {
      input.setSelectionRange(selectionStart, selectionEnd);
      return;
    }

    const end = String(value || "").length;
    input.setSelectionRange(end, end);
  }

  async function initAuth() {
    const service = getSupabaseService();
    if (!service?.hasConfig?.()) {
      render();
      return;
    }

    state.client = service.getClient();
    const { data, error } = await state.client.auth.getSession();

    if (error) {
      state.authStatus = "signed_out";
      state.error = error.message;
      render();
      return;
    }

    state.authStatus = data.session ? "signed_in" : "signed_out";
    state.userEmail = data.session?.user?.email || "";
    state.isAdmin = isAdminUser(data.session?.user);

    state.client.auth.onAuthStateChange(async (_event, session) => {
      state.authStatus = session ? "signed_in" : "signed_out";
      state.userEmail = session?.user?.email || "";
      state.isAdmin = isAdminUser(session?.user);
      if (session) {
        if (!state.isAdmin) {
          render();
          return;
        }
        await loadData();
        return;
      }

      state.questions = [];
      state.reports = [];
      state.selectedQuestionId = null;
      state.draftQuestion = null;
      render();
    });

    if (data.session && state.isAdmin) {
      await loadData();
      return;
    }

    render();
  }

  root.addEventListener("click", async (event) => {
    const target = event.target.closest(
      "[data-select-question], [data-new-question], [data-refresh], [data-sign-out], [data-update-report]",
    );

    if (!target) {
      return;
    }

    if (target.dataset.selectQuestion) {
      state.selectedQuestionId = Number(target.dataset.selectQuestion);
      state.draftQuestion = null;
      state.saveMessage = "";
      render();
      return;
    }

    if (target.dataset.newQuestion) {
      state.selectedQuestionId = "new";
      state.draftQuestion = createDraftQuestion();
      state.saveMessage = "";
      render();
      return;
    }

    if (target.dataset.refresh) {
      await loadData();
      return;
    }

    if (target.dataset.signOut) {
      await signOut();
      return;
    }

    if (target.dataset.updateReport) {
      await updateReportStatus(target.dataset.updateReport, target.dataset.reportStatus);
    }
  });

  root.addEventListener("input", (event) => {
    const target = event.target;

    if (target.matches("[data-filter-search]")) {
      const { selectionStart, selectionEnd, value } = target;
      state.filters.search = target.value;
      render();
      restoreSearchFocus(value, selectionStart, selectionEnd);
    }
  });

  root.addEventListener("change", (event) => {
    const target = event.target;

    if (target.matches("[data-filter-document]")) {
      state.filters.document = target.value;
      render();
      return;
    }

    if (target.matches("[data-filter-review]")) {
      state.filters.reviewStatus = target.value;
      render();
    }
  });

  root.addEventListener("submit", async (event) => {
    const form = event.target;

    if (form.matches("[data-question-form]")) {
      event.preventDefault();
      await saveQuestion();
    }
  });

  render();
  initAuth();
})();
