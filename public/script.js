
"use strict";

// ============================================
// MINICAT IA - SCRIPT PRINCIPAL
// ============================================

document.addEventListener("DOMContentLoaded", () => {

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => document.querySelectorAll(selector);

  const API = {
    me: "/api/me",
    chats: "/api/chats",
    chat: "/api/chat",
    memory: "/api/memory",
    upload: "/api/upload",
    image: "/api/image"
  };

  const STORAGE = {
    preferences: "minicat_preferences",
    chats: "minicat_chats",
    memory: "minicat_memory"
  };

  const state = {
    user: null,
    chats: [],
    activeChat: null,
    memory: [],
    memoryEnabled: true,
    attachments: [],
    busy: false,
    activeSection: "chat",
    sidebarOpen: false
  };

  // ==========================================
  // UTILIDADES
  // ==========================================

  function createId() {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    })[char]);
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
        ...options.headers
      }
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || "No se pudo completar la solicitud.");
    }

    return data;
  }

  function saveLocal() {
    localStorage.setItem(STORAGE.chats, JSON.stringify(state.chats));
    localStorage.setItem(STORAGE.memory, JSON.stringify(state.memory));

    localStorage.setItem(STORAGE.preferences, JSON.stringify({
      memoryEnabled: state.memoryEnabled,
      activeSection: state.activeSection
    }));
  }

  function loadLocal() {
    try {
      state.chats = JSON.parse(
        localStorage.getItem(STORAGE.chats) || "[]"
      );

      state.memory = JSON.parse(
        localStorage.getItem(STORAGE.memory) || "[]"
      );

      const preferences = JSON.parse(
        localStorage.getItem(STORAGE.preferences) || "{}"
      );

      state.memoryEnabled = preferences.memoryEnabled !== false;

    } catch {
      state.chats = [];
      state.memory = [];
    }
  }

  function notify(message) {
    let element = $("#minicat-notification");

    if (!element) {
      element = document.createElement("div");
      element.id = "minicat-notification";
      element.className = "minicat-notification";
      document.body.appendChild(element);
    }

    element.textContent = message;
    element.classList.add("visible");

    clearTimeout(element._timer);

    element._timer = setTimeout(() => {
      element.classList.remove("visible");
    }, 3000);
  }

  // ==========================================
  // NAVEGACIÓN
  // ==========================================

  function showSection(section) {
    const validSections = [
      "chat",
      "cuenta",
      "configuracion",
      "memoria"
    ];

    if (!validSections.includes(section)) return;

    state.activeSection = section;

    validSections.forEach(name => {
      const element = $("#" + name);

      if (element) {
        element.hidden = name !== section;
        element.classList.toggle("active", name === section);
      }
    });

    $$("[data-section]").forEach(button => {
      button.classList.toggle(
        "active",
        button.dataset.section === section
      );
    });

    closeSidebar();
    closeGlobalMenu();
    saveLocal();
  }

  function openSidebar() {
    state.sidebarOpen = true;
    $("#sidebar")?.classList.add("open");
    $("#sidebar-overlay")?.classList.add("visible");
  }

  function closeSidebar() {
    state.sidebarOpen = false;
    $("#sidebar")?.classList.remove("open");
    $("#sidebar-overlay")?.classList.remove("visible");
  }

  function toggleSidebar() {
    state.sidebarOpen ? closeSidebar() : openSidebar();
  }

  function openGlobalMenu() {
    const menu = $("#global-menu");

    if (!menu) return;

    menu.hidden = false;
    menu.classList.add("visible");
  }

  function closeGlobalMenu() {
    const menu = $("#global-menu");

    if (!menu) return;

    menu.hidden = true;
    menu.classList.remove("visible");
  }

  // ==========================================
  // CHATS
  // ==========================================

  function createChat() {
    const chat = {
      id: "web:" + (state.user?.id || "guest") + ":" + createId(),
      title: "Nuevo chat",
      messages: [],
      updatedAt: new Date().toISOString()
    };

    state.chats.unshift(chat);
    state.activeChat = chat.id;

    saveLocal();
    renderChats();
    renderMessages();

    showSection("chat");
    $("#message-input")?.focus();

    return chat;
  }

  function getActiveChat() {
    return state.chats.find(chat => chat.id === state.activeChat);
  }

  function renderChats(filter = "") {
    const container = $("#active-chats");
    if (!container) return;

    container.innerHTML = "";

    const filtered = state.chats.filter(chat =>
      (chat.title || "Nuevo chat")
        .toLowerCase()
        .includes(filter.toLowerCase())
    );

    filtered.forEach(chat => {
      const item = document.createElement("div");

      item.className = "chat-history-item";
      item.classList.toggle("active", chat.id === state.activeChat);

      const title = document.createElement("button");
      title.className = "chat-history-title";
      title.textContent = chat.title || "Nuevo chat";
      title.addEventListener("click", () => openChat(chat.id));

      const menu = document.createElement("button");
      menu.className = "chat-history-menu";
      menu.textContent = "⋮";
      menu.setAttribute("aria-label", "Opciones del chat");

      menu.addEventListener("click", event => {
        event.stopPropagation();
        showChatOptions(chat.id);
      });

      item.append(title, menu);
      container.appendChild(item);
    });
  }

  async function loadChats() {
    try {
      const data = await request(API.chats);

      if (Array.isArray(data.chats)) {
        state.chats = data.chats.map(chat => ({
          ...chat,
          messages: chat.messages || []
        }));
      }

      saveLocal();
    } catch (error) {
      console.warn("No se pudieron cargar los chats:", error.message);
    }

    renderChats();
  }

  async function openChat(id) {
    const chat = state.chats.find(item => item.id === id);
    if (!chat) return;

    state.activeChat = id;
    showSection("chat");

    try {
      const data = await request(
        API.chat + "/" + encodeURIComponent(id)
      );

      if (Array.isArray(data.messages)) {
        chat.messages = data.messages;
      }
    } catch (error) {
      console.warn("Chat local:", error.message);
    }

    saveLocal();
    renderChats();
    renderMessages();
  }

  function renderMessages() {
    const container = $("#chat-messages");
    if (!container) return;

    container.innerHTML = "";

    const chat = getActiveChat();

    if (!chat || !chat.messages?.length) {
      const welcome = document.createElement("div");
      welcome.className = "chat-welcome";
      welcome.textContent = "¡Hola! Soy MINICAT IA. ¿En qué puedo ayudarte?";
      container.appendChild(welcome);
      return;
    }

    chat.messages.forEach(message => {
      addMessageToDOM(message.role, message.content);
    });

    container.scrollTop = container.scrollHeight;
  }

  function addMessageToDOM(role, content) {
    const container = $("#chat-messages");
    if (!container) return;

    const message = document.createElement("div");

    message.className = "message " +
      (role === "assistant" ? "assistant-message" : "user-message");

    const text = document.createElement("div");
    text.className = "message-content";
    text.textContent = content || "";

    message.appendChild(text);
    container.appendChild(message);

    container.scrollTop = container.scrollHeight;
  }

  function showChatOptions(id) {
    const chat = state.chats.find(item => item.id === id);
    if (!chat) return;

    const action = prompt(
      "Opciones del chat:\n1. Cambiar nombre\n2. Compartir\n3. Eliminar\n\nEscribe el número:"
    );

    if (action === "1") {
      const title = prompt("Nuevo nombre:", chat.title);

      if (title?.trim()) {
        chat.title = title.trim();
        saveLocal();
        renderChats();
        syncChatUpdate(id, { title: chat.title });
      }
    }

    if (action === "2") {
      const text = chat.messages.map(message =>
        (message.role === "user" ? "Tú: " : "MINICAT IA: ") +
        message.content
      ).join("\n\n");

      if (navigator.share) {
        navigator.share({
          title: chat.title,
          text
        }).catch(() => {});
      } else {
        navigator.clipboard.writeText(text)
          .then(() => notify("Conversación copiada."));
      }
    }

    if (action === "3") {
      if (!confirm("¿Quieres eliminar este chat?")) return;

      deleteChat(id);
    }
  }

  async function syncChatUpdate(id, changes) {
    try {
      await request(API.chat + "/" + encodeURIComponent(id), {
        method: "PATCH",
        body: JSON.stringify(changes)
      });
    } catch (error) {
      console.warn("No se pudo sincronizar el chat:", error.message);
    }
  }

  async function deleteChat(id) {
    state.chats = state.chats.filter(chat => chat.id !== id);

    if (state.activeChat === id) {
      state.activeChat = null;
    }

    saveLocal();
    renderChats();
    renderMessages();

    try {
      await request(API.chat + "/" + encodeURIComponent(id), {
        method: "DELETE"
      });
    } catch (error) {
      console.warn("Eliminación remota pendiente:", error.message);
    }

    notify("Chat eliminado.");
  }

  // ==========================================
  // ENVÍO DE MENSAJES
  // ==========================================

  function setBusy(value) {
    state.busy = value;

    const button = $("#send-message");

    if (button) {
      button.disabled = value;
      button.textContent = value ? "..." : "➤";
    }
  }

  async function sendMessage(event) {
    event?.preventDefault();

    if (state.busy) return;

    const input = $("#message-input");
    const message = input?.value.trim();

    if (!message && !state.attachments.length) return;

    if (!state.activeChat) {
      createChat();
    }

    const chat = getActiveChat();
    if (!chat) return;

    if (message.length > 5000) {
      notify("El mensaje supera los 5000 caracteres.");
      return;
    }

    const userMessage = {
      role: "user",
      content: message
    };

    chat.messages.push(userMessage);

    if (chat.title === "Nuevo chat" && message) {
      chat.title = message.slice(0, 45);
    }

    chat.updatedAt = new Date().toISOString();

    if (input) input.value = "";

    addMessageToDOM("user", message || "Archivo adjunto");

    const files = [...state.attachments];
    state.attachments = [];
    renderAttachmentPreview();

    saveLocal();
    renderChats();
    setBusy(true);

    try {
      let uploadedFiles = [];

      if (files.length) {
        uploadedFiles = await uploadFiles(files);
      }

      const data = await request(API.chat, {
        method: "POST",
        body: JSON.stringify({
          message,
          conversationId: chat.id,
          attachments: uploadedFiles
        })
      });

      const answer = data.reply || data.response || data.message;

      if (!answer) {
        throw new Error("La IA no devolvió una respuesta.");
      }

      chat.messages.push({
        role: "assistant",
        content: answer
      });

      addMessageToDOM("assistant", answer);

      chat.updatedAt = new Date().toISOString();
      saveLocal();

    } catch (error) {
      addMessageToDOM(
        "assistant",
        "No pude procesar tu mensaje: " + error.message
      );

      notify(error.message);
    } finally {
      setBusy(false);
      input?.focus();
    }
  }

  // ==========================================
  // ARCHIVOS Y ADJUNTOS
  // ==========================================

  function setupAttachments() {
    const form = $("#chat-form");
    if (!form) return;

    let button = $("#attachment-button");
    let input = $("#attachment-input");

    if (!button) {
      button = document.createElement("button");
      button.id = "attachment-button";
      button.type = "button";
      button.className = "attachment-button";
      button.textContent = "＋";
      button.title = "Adjuntar archivo";

      form.appendChild(button);
    }

    if (!input) {
      input = document.createElement("input");
      input.id = "attachment-input";
      input.type = "file";
      input.accept = "image/*,.pdf,.txt,.doc,.docx";
      input.multiple = true;
      input.hidden = true;

      form.appendChild(input);
    }

    button.addEventListener("click", () => input.click());

    input.addEventListener("change", () => {
      const selected = Array.from(input.files || []);

      for (const file of selected) {
        if (file.size > 10 * 1024 * 1024) {
          notify(file.name + " supera los 10 MB.");
          continue;
        }

        if (state.attachments.length >= 5) {
          notify("Máximo 5 archivos por mensaje.");
          break;
        }

        state.attachments.push(file);
      }

      input.value = "";
      renderAttachmentPreview();
    });
  }

  function renderAttachmentPreview() {
    let preview = $("#attachment-preview");

    if (!preview) {
      preview = document.createElement("div");
      preview.id = "attachment-preview";
      preview.className = "attachment-preview";

      $("#chat-form")?.appendChild(preview);
    }

    preview.innerHTML = "";

    state.attachments.forEach((file, index) => {
      const item = document.createElement("div");
      item.className = "attachment-item";

      const name = document.createElement("span");
      name.textContent = file.name;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", "Quitar archivo");

      remove.addEventListener("click", () => {
        state.attachments.splice(index, 1);
        renderAttachmentPreview();
      });

      item.append(name, remove);
      preview.appendChild(item);
    });
  }

  async function uploadFiles(files) {
    const uploaded = [];

    for (const file of files) {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(API.upload, {
        method: "POST",
        credentials: "same-origin",
        body: formData
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "No se pudo subir " + file.name);
      }

      uploaded.push(data.file);
    }

    return uploaded;
  }

  // ==========================================
  // GENERACIÓN DE IMÁGENES
  // ==========================================

  async function generateImage(prompt) {
    if (!prompt.trim()) return;

    if (!state.activeChat) createChat();

    const chat = getActiveChat();

    chat.messages.push({
      role: "user",
      content: "Generar imagen: " + prompt
    });

    addMessageToDOM("user", "Generar imagen: " + prompt);
    setBusy(true);

    try {
      const data = await request(API.image, {
        method: "POST",
        body: JSON.stringify({ prompt })
      });

      if (!data.image) {
        throw new Error("No se recibió la imagen.");
      }

      const container = $("#chat-messages");
      const wrapper = document.createElement("div");
      wrapper.className = "message assistant-message";

      const image = document.createElement("img");
      image.src = data.image;
      image.alt = "Imagen generada por MINICAT IA";
      image.className = "generated-image";
      image.loading = "lazy";

      wrapper.appendChild(image);
      container?.appendChild(wrapper);

      chat.messages.push({
        role: "assistant",
        content: "[Imagen generada]"
      });

      saveLocal();

    } catch (error) {
      notify(error.message);
      addMessageToDOM("assistant", error.message);
    } finally {
      setBusy(false);
    }
  }

  // ==========================================
  // MEMORIA PERSONAL
  // ==========================================

  async function loadMemory() {
    try {
      const data = await request(API.memory);

      if (Array.isArray(data.memory)) {
        state.memory = data.memory;
      }

      if (typeof data.enabled === "boolean") {
        state.memoryEnabled = data.enabled;
      }
    } catch (error) {
      console.warn("Memoria local:", error.message);
    }

    renderMemory();
  }

  function renderMemory() {
    const container = $("#memory-list");
    const toggle = $("#memory-toggle");

    if (toggle) {
      toggle.checked = state.memoryEnabled;
    }

    if (!container) return;

    container.innerHTML = "";

    if (!state.memory.length) {
      container.textContent = "Todavía no tienes recuerdos guardados.";
      return;
    }

    state.memory.forEach((item, index) => {
      const element = document.createElement("div");
      element.className = "memory-item";

      const text = document.createElement("span");
      text.textContent = typeof item === "string"
        ? item
        : item.content || "";

      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";

      remove.addEventListener("click", () => {
        state.memory.splice(index, 1);
        saveMemory();
      });

      element.append(text, remove);
      container.appendChild(element);
    });
  }

  async function saveMemory() {
    saveLocal();
    renderMemory();

    try {
      await request(API.memory, {
        method: "PUT",
        body: JSON.stringify({
          memory: state.memory,
          enabled: state.memoryEnabled
        })
      });
    } catch (error) {
      console.warn("Memoria pendiente de sincronizar:", error.message);
    }
  }

  async function addMemory() {
    const input = $("#memory-input");
    const value = input?.value.trim();

    if (!value) {
      notify("Escribe algo para guardar.");
      return;
    }

    state.memory.push({
      id: createId(),
      content: value,
      createdAt: new Date().toISOString()
    });

    if (input) input.value = "";

    await saveMemory();
    notify("Recuerdo guardado.");
  }

  async function toggleMemory(enabled) {
    state.memoryEnabled = enabled;
    await saveMemory();

    notify(enabled
      ? "Memoria activada."
      : "Memoria desactivada."
    );
  }

  async function clearMemory() {
    if (!confirm("¿Eliminar todos tus recuerdos?")) return;

    state.memory = [];
    await saveMemory();

    try {
      await request(API.memory, {
        method: "DELETE"
      });
    } catch (error) {
      console.warn(error.message);
    }

    notify("Memoria eliminada.");
  }

  // ==========================================
  // CUENTA
  // ==========================================

  async function loadAccount() {
    try {
      const data = await request(API.me);

      if (!data.authenticated || !data.user) return;

      state.user = data.user;

      const name = $("#account-name");
      const id = $("#account-id");
      const avatar = $("#account-avatar");

      if (name) {
        name.textContent =
          data.user.globalName || data.user.username;
      }

      if (id) id.textCon
