
// ==========================================
// MINICAT IA - SCRIPT PRINCIPAL
// ==========================================

document.addEventListener("DOMContentLoaded", () => {
  const $ = (selector) => document.querySelector(selector);

  const state = {
    activeSection: "chat",
    activeChat: null,
    chats: [],
    memory: [],
    memoryEnabled: true,
    sidebarOpen: false,
    sending: false,
    musicPlaying: false
  };

  const STORAGE = {
    chats: "minicat_chats",
    preferences: "minicat_preferences",
    memory: "minicat_memory"
  };

  const elements = {
    sidebar: $("#sidebar"),
    overlay: $("#sidebar-overlay"),
    messages: $("#chat-messages"),
    form: $("#chat-form"),
    input: $("#message-input"),
    send: $("#send-message"),
    chats: $("#active-chats"),
    search: $("#search-chats"),
    music: $("#background-music"),
    musicToggle: $("#music-toggle"),
    floatingMusicToggle: $("#floating-music-toggle"),
    volume: $("#music-volume")
  };

  // ==========================================
  // UTILIDADES
  // ==========================================

  function saveLocal(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.warn("No se pudo guardar la información local.");
    }
  }

  function readLocal(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  }

  async function api(url, options = {}) {
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
      throw new Error(data.error || data.message || "Error de conexión.");
    }

    return data;
  }

  function createId() {
    return "chat_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    })[character]);
  }

  function showNotice(message) {
    let notice = $("#minicat-notice");

    if (!notice) {
      notice = document.createElement("div");
      notice.id = "minicat-notice";

      Object.assign(notice.style, {
        position: "fixed",
        top: "78px",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: "9999",
        padding: "12px 18px",
        borderRadius: "10px",
        background: "#12345a",
        border: "1px solid #247cff",
        color: "white",
        fontSize: "13px",
        maxWidth: "90%",
        textAlign: "center"
      });

      document.body.appendChild(notice);
    }

    notice.textContent = message;
    notice.hidden = false;

    clearTimeout(notice.hideTimer);
    notice.hideTimer = setTimeout(() => {
      notice.hidden = true;
    }, 3500);
  }

  // ==========================================
  // NAVEGACIÓN
  // ==========================================

  function showSection(section) {
    const allowed = ["chat", "cuenta", "configuracion", "memoria"];

    if (!allowed.includes(section)) return;

    state.activeSection = section;

    document.querySelectorAll(".section").forEach((element) => {
      const active = element.id === section;
      element.classList.toggle("active", active);
      element.hidden = !active;
    });

    document.querySelectorAll("[data-section]").forEach((button) => {
      button.classList.toggle(
        "active",
        button.dataset.section === section
      );
    });

    const menu = $("#global-menu");
    if (menu) menu.hidden = true;

    closeSidebar();
  }

  function openSidebar() {
    if (!elements.sidebar) return;

    state.sidebarOpen = true;
    elements.sidebar.classList.add("open");

    if (elements.overlay) {
      elements.overlay.hidden = false;
    }
  }

  function closeSidebar() {
    state.sidebarOpen = false;

    if (elements.sidebar) {
      elements.sidebar.classList.remove("open");
    }

    if (elements.overlay) {
      elements.overlay.hidden = true;
    }
  }

  document.querySelectorAll("[data-section]").forEach((button) => {
    button.addEventListener("click", () => {
      showSection(button.dataset.section);
    });
  });

  $("#menu-toggle")?.addEventListener("click", openSidebar);
  $("#sidebar-close")?.addEventListener("click", closeSidebar);
  elements.overlay?.addEventListener("click", closeSidebar);

  $("#global-menu-button")?.addEventListener("click", () => {
    const menu = $("#global-menu");
    if (menu) menu.hidden = !menu.hidden;
  });

  // ==========================================
  // MENSAJES DEL CHAT
  // ==========================================

  function scrollToBottom() {
    if (!elements.messages) return;

    requestAnimationFrame(() => {
      elements.messages.scrollTop = elements.messages.scrollHeight;
    });
  }

  function addMessage(role, content, save = true) {
    if (!elements.messages) return;

    const welcome = elements.messages.querySelector(".welcome-message");
    if (welcome) welcome.remove();

    const message = document.createElement("div");

    message.className =
      role === "user"
        ? "message user-message"
        : "message assistant-message";

    message.textContent = content;
    elements.messages.appendChild(message);

    if (save && state.activeChat) {
      const chat = state.chats.find((item) => item.id === state.activeChat);

      if (chat) {
        chat.messages = chat.messages || [];
        chat.messages.push({ role, content });
        chat.updatedAt = Date.now();
        saveLocal(STORAGE.chats, state.chats);
      }
    }

    scrollToBottom();
    return message;
  }

  function renderMessages(messages = []) {
    if (!elements.messages) return;

    elements.messages.replaceChildren();

    if (!messages.length) {
      const welcome = document.createElement("div");
      welcome.className = "welcome-message";
      welcome.innerHTML = `
        <div class="welcome-icon">⛈️</div>
        <h1>¿En qué puedo ayudarte?</h1>
        <p>Hola, soy MINICAT IA. Estoy aquí para ayudarte.</p>
      `;

      elements.messages.appendChild(welcome);
      return;
    }

    messages.forEach((message) => {
      const element = document.createElement("div");

      element.className =
        message.role === "user"
          ? "message user-message"
          : "message assistant-message";

      element.textContent = message.content || "";
      elements.messages.appendChild(element);
    });

    scrollToBottom();
  }

  // ==========================================
  // CONVERSACIONES
  // ==========================================

  function createChat() {
    const id = createId();

    const chat = {
      id,
      title: "Nuevo chat",
      messages: [],
      updatedAt: Date.now()
    };

    state.chats.unshift(chat);
    state.activeChat = id;

    saveLocal(STORAGE.chats, state.chats);

    renderChats();
    renderMessages([]);

    showSection("chat");

    return chat;
  }

  async function openChat(id) {
    if (!id) return;

    state.activeChat = id;

    const localChat = state.chats.find((chat) => chat.id === id);

    if (localChat) {
      renderMessages(localChat.messages || []);
    } else {
      renderMessages([]);
    }

    showSection("chat");

    try {
      const data = await api(`/api/chat/${encodeURIComponent(id)}`);

      const messages = data.messages || data.chat?.messages || [];

      const chat = state.chats.find((item) => item.id === id);

      if (chat) {
        chat.messages = messages;
        saveLocal(STORAGE.chats, state.chats);
      }

      if (state.activeChat === id) {
        renderMessages(messages);
      }
    } catch (error) {
      console.warn("No se pudo actualizar el historial:", error.message);

      if (!localChat) {
        renderMessages([]);
        showNotice("No se pudo cargar esta conversación.");
      }
    }
  }

  function renderChats(filter = "") {
    if (!elements.chats) return;

    elements.chats.replaceChildren();

    const filtered = state.chats.filter((chat) =>
      String(chat.title || "Nuevo chat")
        .toLowerCase()
        .includes(filter.toLowerCase())
    );

    filtered.forEach((chat) => {
      const item = document.createElement("div");
      item.className = "chat-history-item";
      item.dataset.id = chat.id;

      if (chat.id === state.activeChat) {
        item.classList.add("active");
      }

      const title = document.createElement("span");
      title.textContent = chat.title || "Nuevo chat";

      const menu = document.createElement("button");
      menu.type = "button";
      menu.textContent = "⋮";
      menu.className = "chat-menu-button";
      menu.setAttribute("aria-label", "Opciones del chat");

      item.append(title, menu);

      item.addEventListener("click", (event) => {
        if (event.target === menu) return;
        openChat(chat.id);
      });

      menu.addEventListener("click", (event) => {
        event.stopPropagation();
        showChatMenu(chat.id, menu);
      });

      elements.chats.appendChild(item);
    });
  }

  function showChatMenu(id, anchor) {
    document.querySelector(".chat-context-menu")?.remove();

    const menu = document.createElement("div");
    menu.className = "chat-context-menu";

    Object.assign(menu.style, {
      position: "fixed",
      zIndex: "300",
      padding: "7px",
      borderRadius: "10px",
      background: "#10243d",
      border: "1px solid #28517c",
      boxShadow: "0 10px 25px rgba(0,0,0,.4)"
    });

    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(8, rect.left - 125)}px`;
    menu.style.top = `${rect.bottom + 5}px`;

    const actions = [
      ["Renombrar", () => renameChat(id)],
      ["Compartir", () => shareChat(id)],
      ["Eliminar", () => deleteChat(id)]
    ];

    actions.forEach(([label, callback]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;

      Object.assign(button.style, {
        display: "block",
        width: "100%",
        padding: "10px",
        border: "0",
        borderRadius: "7px",
        background: "transparent",
        color: "white",
        textAlign: "left"
      });

      button.addEventListener("click", () => {
        menu.remove();
        callback();
      });

      menu.appendChild(button);
    });

    document.body.appendChild(menu);

    const close = (event) => {
      if (!menu.contains(event.target) && !anchor.contains(event.target)) {
        menu.remove();
        document.removeEventListener("click", close);
      }
    };

    setTimeout(() => document.addEventListener("click", close), 0);
  }

  function renameChat(id) {
    const chat = state.chats.find((item) => item.id === id);
    if (!chat) return;

    const title = prompt("Nuevo nombre de la conversación:", chat.title);

    if (!title || !title.trim()) return;

    chat.title = title.trim().slice(0, 80);
    saveLocal(STORAGE.chats, state.chats);
    renderChats();

    api(`/api/chat/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ title: chat.title })
    }).catch(() => {});
  }

  async function shareChat(id) {
    const chat = state.chats.find((item) => item.id === id);
    if (!chat) return;

    const content = (chat.messages || [])
      .map((message) =>
        `${message.role === "user" ? "Tú" : "MINICAT IA"}: ${message.content}`
      )
      .join("\n\n");

    try {
      if (navigator.share) {
        await navigator.share({
          title: chat.title,
          text: content
        });
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
        showNotice("Conversación copiada.");
      } else {
        showNotice("No se pudo compartir en este navegador.");
      }
    } catch (error) {
      if (error.name !== "AbortError") {
        showNotice("No se pudo compartir.");
      }
    }
  }

  async function deleteChat(id) {
    const confirmed = confirm("¿Quieres eliminar esta conversación?");
    if (!confirmed) return;

    state.chats = state.chats.filter((chat) => chat.id !== id);

    if (state.activeChat === id) {
      state.activeChat = null;
      renderMessages([]);
    }

    saveLocal(STORAGE.chats, state.chats);
    renderChats();

    try {
      await api(`/api/chat/${encodeURIComponent(id)}`, {
        method: "DELETE"
      });
    } catch (error) {
      console.warn("No se pudo sincronizar la eliminación:", error.message);
    }
  }

  $("#new-chat-button")?.addEventListener("click", createChat);
  $("#new-chat-button-top")?.addEventListener("click", createChat);

  elements.search?.addEventListener("input", () => {
    renderChats(elements.search.value);
  });

  // ==========================================
  // ENVIAR MENSAJES
  // ==========================================

  async function sendMessage(text) {
    if (state.sending) return;

    const question = text.trim();
    if (!question) return;

    if (!state.activeChat) {
      createChat();
    }

    const chat = state.chats.find((item) => item.id === state.activeChat);

    if (!chat) return;

    state.sending = true;

    if (elements.send) elements.send.disabled = true;
    if (elements.input) elements.input.disabled = true;

    addMessage("user", question);

    if (chat.title === "Nuevo chat") {
      chat.title = question.slice(0, 35);
      renderChats();
    }

    const typing = document.createElement("div");
    typing.className = "typing-indicator";
    typing.textContent = "MINICAT IA está escribiendo...";
    elements.messages.appendChild(typing);

    scrollToBottom();

    try {
      const data = await api("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          message: question,
          conversationId: `web:${state.activeChat}`
        })
      });

      typing.remove();

      const answer =
        data.reply ||
        data.response ||
        data.message ||
        "No recibí una respuesta.";

      addMessage("assistant", answer);

      chat.updatedAt = Date.now();
      saveLocal(STORAGE.chats, state.chats);
    } catch (error) {
      typing.remove();

      addMessage(
        "assistant",
        "No pude responder en este momento. Inténtalo nuevamente."
      );

      console.error("Error enviando mensaje:", error);
      showNotice(error.message);
    } finally {
      state.sending = false;

      if (elements.send) elements.send.disabled = false;
      if (elements.input) {
        elements.input.disabled = false;
        elements.input.focus();
      }
    }
  }

  elements.form?.addEventListener("submit", (event) => {
    event.preventDefault();

    const value = elements.input?.value || "";
    if (!value.trim()) return;

    elements.input.value = "";
    elements.input.style.height = "auto";

    sendMessage(value);
  });

  elements.input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      elements.form?.requestSubmit();
    }
  });

  elements.input?.addEventListener("input", () => {
    elements.input.style.height = "auto";
    elements.input.style.height =
      Math.min(elements.input.scrollHeight, 180) + "px";
  });

  // ==========================================
  // ADJUNTAR ARCHIVOS
  // ==========================================

  $("#file-input")?.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);

    if (!files.length) return;

    showNotice("La carga de archivos se habilitará al actualizar el servidor.");

    event.target.value = "";
  });

  // ==========================================
  // MEMORIA
  // ==========================================

  async function loadMemory() {
    state.memory = readLocal(STORAGE.memory, []);

    try {
      const data = await api("/api/memory");
      state.memory = data.memory || [];
      state.memoryEnabled = data.enabled !== false;
      saveLocal(STORAGE.memory, state.memory);
    } catch {
      // Se conserva la copia local hasta que exista la ruta del servidor.
    }

    const toggle = $("#memory-toggle");
    if (toggle) toggle.checked = state.memoryEnabled;

    renderMemory();
  }

  function renderMemory() {
    const container = $("#memory-list");
    if (!container) return;

    container.replaceChildren();

    state.memory.forEach((item, index) => {
      const element = document.createElement("div");
      element.className = "memory-item";
      element.textContent =
        typeof item === "string" ? item : item.content || "";

      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Eliminar";
      remove.addEventListener("click", () => {
        state.memory.splice(index, 1);
        saveLocal(STORAGE.memory, state.memory);
        renderMemory();
      });

      element.appendChild(remove);
      container.appendChild(element);
    });
  }

  $("#add-memory-button")?.addEventListener("click", () => {
    const input = $("#memory-input");
    const value = input?.value.trim();

    if (!value) return;

    state.memory.push({
      content: value,
      createdAt: Date.now()
    });

    saveLocal(STORAGE.memory, state.memory);

    if (input) input.value = "";

    renderMemory();
    showNotice("Memoria guardada en este dispositivo.");
  });

  $("#clear-memory-button")?.addEventListener("click", () => {
    if (!confirm("¿Eliminar toda la memoria guardada?")) return;

    state.memory = [];
    saveLocal(STORAGE.memory, state.memory);
    renderMemory();
  });

  $("#memory-toggle")?.addEventListener("change", (event) => {
    state.memoryEnabled = event.target.checked;

    api("/api/memory", {
      method: "PUT",
      body: JSON.stringify({
        enabled: state.memoryEnabled
      })
    }).catch(() => {});
  });

  // ==========================================
  // CUENTA
  // ==========================================

  async function loadAccount() {
    try {
      const data = await api("/api/me");
      const user = data.user || data;

      const name = $("#account-name");
      const id = $("#account-id");
      const avatar = $("#account-avatar");

      if (name) name.textContent = user.username || user.global_name || "Usuario";
      if (id) id.textContent = user.id || "";

      if (avatar && user.avatar) {
        avatar.src = user.avatar.startsWith("http")
          ? user.avatar
          : `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`;
      }
    } catch (error) {
      console.warn("No se pudo cargar la cuenta:", error.message);
    }
  }

  // ==========================================
  // CONFIGURACIÓN
  // ==========================================

  const preferences = readLocal(STORAGE.preferences, {
    theme: "dark",
    notifications: true,
    volume: 0.25
  });

  function applyPreferences() {
    const theme = preferences.theme || "dark";

    document.documentElement.dataset.theme = theme;

    const selector = $("#theme-selector");
    const notifications = $("#notifications-toggle");

    if (selector) selector.value = theme;
    if (notifications) notifications.checked = preferences.notifications !== false;

    if (elements.music) {
      elements.music.volume = Number(preferences.volume ?? 0.25);
    }

    if (elements.volume) {
      elements.volume.value = preferences.volume ?? 0.25;
    }
  }

  $("#theme-selector")?.addEventListener("change", (event) => {
    preferences.theme = event.target.value;
    saveLocal(STORAGE.preferences, preferences);
    applyPreferences();
  });

  $("#notifications-toggle")?.addEventListener("change", (event) => {
    preferences.notifications = event.target.checked;
    saveLocal(STORAGE.preferences, preferences);
  });

  // ==========================================
  // MÚSICA
  // ==========================================

  function updateMusicButtons() {
    const playing = elements.music && !elements.music.paused;

    if (elements.musicToggle) {
      elements.musicToggle.textContent = playing
        ? "❚❚ Pausar música"
        : "▶ Reproducir música";
    }

    if (elements.floatingMusicToggle) {
      elements.floatingMusicToggle.textContent = playing ? "❚❚" : "▶";
    }
  }

  async function toggleMusic() {
    if (!elements.music) return;

    try {
      if (elements.music.paused) {
        await elements.music.play();
      } else {
        elements.music.pause();
      }
    } catch (error) {
      showNotice("No se pudo reproducir. Comprueba que exista public/music/doma.mp3.");
    }

    updateMusicButtons();
  }

  elements.musicToggle?.addEventListener("click", toggleMusic);
  elements.floatingMusicToggle?.addEventListener("click", toggleMusic);

  elements.music?.addEventListener("play", updateMusicButtons);
  elements.music?.addEventListener("pause", updateMusicButtons);
  elements.music?.addEventListener("ended", updateMusicButtons);

  elements.volume?.addEventListener("input", (event) => {
    if (!elements.music) return;

    const volume = Number(event.target.value);

    elements.music.volume = volume;
    preferences.volume = volume;

    saveLocal(STORAGE.preferences, preferences);
  });

  // ==========================================
  // INICIALIZACIÓN
  // ==========================================

  async function initialize() {
    applyPreferences();

    state.chats = readLocal(STORAGE.chats, []);
    renderChats();

    await Promise.allSettled([
      loadAccount(),
      loadMemory()
    ]);

    try {
      const data = await api("/api/chats");

      const serverChats = data.chats || [];

      serverChats.forEach((serverChat) => {
        const exists = state.chats.some(
          (chat) => chat.id === serverChat.id
        );

        if (!exists) {
          state.chats.push({
            ...serverChat,
            messages: []
          });
        }
      });

      saveLocal(STORAGE.chats, state.chats);
      renderChats();
    } catch (error) {
      console.warn("No se pudo sincronizar el historial:", error.message);
    }

    if (!state.activeChat) {
      renderMessages([]);
    }

    showSection("chat");
    updateMusicButtons();
  }

  initialize().catch((error) => {
    console.error("Error iniciando MINICAT IA:", error);
    showNotice("Ocurrió un error al cargar MINICAT IA.");
  });
});
