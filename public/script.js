
// ======================================
// MINICAT IA - SCRIPT PRINCIPAL
// ======================================

document.addEventListener("DOMContentLoaded", () => {
  const $ = selector => document.querySelector(selector);

  const API = {
    me: "/api/me",
    chat: "/api/chat",
    chats: "/api/chats"
  };

  const STORAGE_KEY = "minicat_chats";
  const PREF_KEY = "minicat_preferences";

  const state = {
    activeSection: "chat",
    activeChat: null,
    chats: [],
    memory: [],
    memoryEnabled: true,
    sending: false,
    sidebarOpen: false,
    attachments: []
  };

  // ======================================
  // UTILIDADES
  // ======================================

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
      throw new Error(data.error || data.message || "Error del servidor.");
    }

    return data;
  }

  function saveLocalChats() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.chats));
  }

  function getActiveChat() {
    return state.chats.find(chat => chat.id === state.activeChat);
  }

  function createMessageElement(role, content) {
    const message = document.createElement("div");
    message.className = `message message-${role}`;

    const text = document.createElement("div");
    text.className = "message-content";
    text.textContent = content;

    message.appendChild(text);
    return message;
  }

  function showMessage(role, content) {
    const container = $("#chat-messages");
    if (!container) return null;

    $(".chat-welcome")?.remove();

    const element = createMessageElement(role, content);
    container.appendChild(element);
    container.scrollTop = container.scrollHeight;

    return element;
  }

  function showError(message) {
    showMessage("error", message);
  }

  // ======================================
  // PREFERENCIAS
  // ======================================

  function loadPreferences() {
    try {
      const saved = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");

      state.memoryEnabled = saved.memoryEnabled ?? true;
      state.memory = Array.isArray(saved.memory) ? saved.memory : [];
    } catch {
      state.memory = [];
    }
  }

  function savePreferences() {
    localStorage.setItem(PREF_KEY, JSON.stringify({
      memoryEnabled: state.memoryEnabled,
      memory: state.memory
    }));
  }

  // ======================================
  // NAVEGACIÓN
  // ======================================

  function openSection(section) {
    state.activeSection = section;

    document.querySelectorAll(".page-section").forEach(element => {
      element.hidden = element.id !== section;
      element.classList.toggle("active", element.id === section);
    });

    document.querySelectorAll("[data-section]").forEach(element => {
      element.classList.toggle(
        "active",
        element.dataset.section === section
      );
    });

    closeSidebar();
    $("#global-menu")?.setAttribute("hidden", "");
  }

  document.querySelectorAll("[data-section]").forEach(element => {
    element.addEventListener("click", () => {
      openSection(element.dataset.section);
    });
  });

  // ======================================
  // MENÚ LATERAL
  // ======================================

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

  $("#menu-toggle")?.addEventListener("click", () => {
    state.sidebarOpen ? closeSidebar() : openSidebar();
  });

  $("#sidebar-close")?.addEventListener("click", closeSidebar);
  $("#sidebar-overlay")?.addEventListener("click", closeSidebar);

  // ======================================
  // MENÚ GLOBAL
  // ======================================

  const globalMenu = $("#global-menu");
  const globalMenuButton = $("#global-menu-button");

  globalMenuButton?.addEventListener("click", event => {
    event.stopPropagation();

    if (globalMenu?.hasAttribute("hidden")) {
      globalMenu.removeAttribute("hidden");
      globalMenu.classList.add("visible");
    } else {
      globalMenu?.setAttribute("hidden", "");
      globalMenu?.classList.remove("visible");
    }
  });

  document.addEventListener("click", event => {
    if (
      !globalMenu?.contains(event.target) &&
      !globalMenuButton?.contains(event.target)
    ) {
      globalMenu?.setAttribute("hidden", "");
      globalMenu?.classList.remove("visible");
    }
  });

  // ======================================
  // CHATS
  // ======================================

  function newChat() {
    const chat = {
      id: crypto.randomUUID(),
      title: "Nuevo chat",
      messages: [],
      createdAt: new Date().toISOString()
    };

    state.chats.unshift(chat);
    state.activeChat = chat.id;

    saveLocalChats();
    renderChats();
    renderMessages();
    openSection("chat");

    $("#message-input")?.focus();
  }

  $("#new-chat-button")?.addEventListener("click", newChat);
  $("#new-chat-button-top")?.addEventListener("click", newChat);

  function renderChats() {
    const container = $("#active-chats");
    if (!container) return;

    container.innerHTML = "";

    if (!state.chats.length) {
      const empty = document.createElement("p");
      empty.className = "empty-chats";
      empty.textContent = "Tus chats aparecerán aquí.";
      container.appendChild(empty);
      return;
    }

    state.chats.forEach(chat => {
      const row = document.createElement("div");
      row.className = "chat-item";

      if (chat.id === state.activeChat) {
        row.classList.add("active");
      }

      const select = document.createElement("button");
      select.className = "chat-select";
      select.textContent = chat.title || "Nuevo chat";

      select.addEventListener("click", () => {
        state.activeChat = chat.id;
        renderChats();
        renderMessages();
        openSection("chat");
      });

      const menuButton = document.createElement("button");
      menuButton.className = "chat-menu-button";
      menuButton.textContent = "⋮";
      menuButton.setAttribute("aria-label", "Opciones del chat");

      menuButton.addEventListener("click", event => {
        event.stopPropagation();
        showChatMenu(chat.id, menuButton);
      });

      row.append(select, menuButton);
      container.appendChild(row);
    });
  }

  function renderMessages() {
    const container = $("#chat-messages");
    if (!container) return;

    container.innerHTML = "";

    const chat = getActiveChat();

    if (!chat || !chat.messages?.length) {
      container.innerHTML = `
        <div class="chat-welcome">
          <img src="/Screenshot_20261101_141227_Discord.jpg"
               alt="MINICAT IA">
          <h1>¿En qué puedo ayudarte?</h1>
          <p>Soy MINICAT IA. Pregúntame lo que quieras.</p>
        </div>
      `;
      return;
    }

    chat.messages.forEach(message => {
      showMessage(message.role, message.content);
    });
  }

  function showChatMenu(chatId, anchor) {
    document.querySelector(".chat-context-menu")?.remove();

    const menu = document.createElement("div");
    menu.className = "chat-context-menu";

    const actions = [
      ["Renombrar", () => renameChat(chatId)],
      ["Compartir", () => shareChat(chatId)],
      ["Archivar", () => archiveChat(chatId)],
      ["Eliminar", () => deleteChat(chatId)]
    ];

    actions.forEach(([label, action]) => {
      const button = document.createElement("button");
      button.textContent = label;

      button.addEventListener("click", () => {
        menu.remove();
        action();
      });

      menu.appendChild(button);
    });

    anchor.parentElement.appendChild(menu);
  }

  function renameChat(id) {
    const chat = state.chats.find(item => item.id === id);
    if (!chat) return;

    const name = prompt("Escribe el nuevo nombre:");

    if (!name?.trim()) return;

    chat.title = name.trim();
    saveLocalChats();
    renderChats();
  }

  async function shareChat(id) {
    const chat = state.chats.find(item => item.id === id);
    if (!chat) return;

    const text = (chat.messages || [])
      .map(message => `${message.role}: ${message.content}`)
      .join("\n\n");

    try {
      if (navigator.share) {
        await navigator.share({
          title: chat.title,
          text
        });
      } else {
        await navigator.clipboard.writeText(text);
        alert("Conversación copiada.");
      }
    } catch (error) {
      if (error.name !== "AbortError") {
        alert("No se pudo compartir la conversación.");
      }
    }
  }

  function archiveChat(id) {
    const chat = state.chats.find(item => item.id === id);
    if (!chat) return;

    chat.archived = true;

    if (state.activeChat === id) {
      state.activeChat = null;
    }

    saveLocalChats();
    renderChats();
    renderMessages();
  }

  function deleteChat(id) {
    if (!confirm("¿Eliminar esta conversación?")) return;

    state.chats = state.chats.filter(chat => chat.id !== id);

    if (state.activeChat === id) {
      state.activeChat = null;
    }

    saveLocalChats();
    renderChats();
    renderMessages();
  }

  // ======================================
  // CARGAR CHATS
  // ======================================

  async function loadChats() {
    try {
      const data = await request(API.chats);

      const chats = Array.isArray(data)
        ? data
        : data.chats;

      if (Array.isArray(chats)) {
        state.chats = chats.map(chat => ({
          ...chat,
          messages: Array.isArray(chat.messages) ? chat.messages : []
        }));
      }
    } catch (error) {
      console.warn("No se pudieron cargar los chats del servidor:", error);

      try {
        state.chats = JSON.parse(
          localStorage.getItem(STORAGE_KEY) || "[]"
        );
      } catch {
        state.chats = [];
      }
    }

    if (!state.activeChat && state.chats.length) {
      state.activeChat = state.chats[0].id;
    }

    renderChats();
    renderMessages();
  }

  // ======================================
  // ENVIAR MENSAJES
  // ======================================

  async function sendMessage(message) {
    if (state.sending || !message.trim()) return;

    if (!state.activeChat) {
      newChat();
    }

    const chat = getActiveChat();
    if (!chat) return;

    state.sending = true;

    const input = $("#message-input");
    const sendButton = $("#send-message");

    if (input) input.disabled = true;
    if (sendButton) sendButton.disabled = true;

    chat.messages ||= [];
    chat.messages.push({
      role: "user",
      content: message
    });

    if (chat.title === "Nuevo chat") {
      chat.title = message.slice(0, 35);
    }

    saveLocalChats();
    renderChats();
    showMessage("user", message);

    const loading = showMessage("assistant", "MINICAT IA está pensando...");

    try {
      const data = await request(API.chat, {
        method: "POST",
        body: JSON.stringify({
          message,
          conversationId: chat.id
        })
      });

      loading?.remove();

      const reply = data.reply || data.response || data.message;

      if (!reply) {
        throw new Error("El servidor no devolvió una respuesta.");
      }

      chat.messages.push({
        role: "assistant",
        content: reply
      });

      showMessage("assistant", reply);
      saveLocalChats();
      renderChats();

    } catch (error) {
      loading?.remove();

      showError("No pude enviar el mensaje: " + error.message);

      // El mensaje del usuario permanece en el historial.
      saveLocalChats();

    } finally {
      state.sending = false;

      if (input) {
        input.disabled = false;
        input.value = "";
        input.focus();
      }

      if (sendButton) sendButton.disabled = false;
    }
  }

  $("#chat-form")?.addEventListener("submit", event => {
    event.preventDefault();

    const input = $("#message-input");
    const message = input?.value.trim();

    if (!message || state.sending) return;

    sendMessage(message);
  });

  // ======================================
  // ARCHIVOS E IMÁGENES - INTERFAZ
  // ======================================

  const composer = $(".composer");

  if (composer && !$("#attachment-button")) {
    const button = document.createElement("button");
    button.type = "button";
    button.id = "attachment-button";
    button.className = "attachment-button";
    button.textContent = "＋";
    button.title = "Adjuntar archivos";

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.id = "attachment-input";
    fileInput.accept = "image/*,.pdf,.txt,.doc,.docx";
    fileInput.multiple = true;
    fileInput.hidden = true;

    const preview = document.createElement("div");
    preview.id = "attachment-preview";
    preview.className = "attachment-preview";

    button.addEventListener("click", () => fileInput.click());

    fileInput.addEventListener("change", () => {
      state.attachments = Array.from(fileInput.files || []);

      preview.innerHTML = "";

      state.attachments.forEach(file => {
        const item = document.createElement("span");
        item.textContent = `📎 ${file.name}`;
        preview.appendChild(item);
      });
    });

    composer.prepend(button, fileInput);
    composer.appendChild(preview);
  }

  // ======================================
  // MEMORIA PERSONAL
  // ======================================

  function renderMemory() {
    const container = $("#memory-list");
    if (!container) return;

    container.innerHTML = "";

    if (!state.memory.length) {
      const empty = document.createElement("p");
      empty.textContent = "No hay información guardada.";
      container.appendChild(empty);
      return;
    }

    state.memory.forEach((memory, index) => {
      const item = document.createElement("div");
      item.className = "memory-item";

      const text = document.createElement("span");
      text.textContent = memory;

      const remove = document.createElement("button");
      remove.textContent = "Eliminar";

      remove.addEventListener("click", () => {
        state.memory.splice(index, 1);
        savePreferences();
        renderMemory();
      });

      item.append(text, remove);
      container.appendChild(item);
    });
  }

  $("#memory-toggle")?.addEventListener("change", event => {
    state.memoryEnabled = event.target.checked;
    savePreferences();
  });

  $("#add-memory-button")?.addEventListener("click", () => {
    const input = $("#memory-input");
    const value = input?.value.trim();

    if (!value) return;

    state.memory.push(value);
    input.value = "";

    savePreferences();
    renderMemory();
  });

  $("#clear-memory-button")?.addEventListener("click", () => {
    if (!confirm("¿Borrar todos los recuerdos?")) return;

    state.memory = [];
    savePreferences();
    renderMemory();
  });

  // ======================================
  // CUENTA DISCORD
  // ======================================

  async function loadAccount() {
    try {
      const data = await request(API.me);
      const user = data.user || data;

      const name = user.global_name || user.username || "Usuario";
      const avatar = user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
        : "/Screenshot_20261101_141227_Discord.jpg";

      if ($("#account-name")) {
        $("#account-name").textContent = name;
      }

      if ($("#account-id")) {
        $("#account-id").textContent = user.id || "Discord";
      }

      if ($("#account-avatar")) {
        $("#account-avatar").src = avatar;
      }

    } catch (error) {
      console.warn("No se pudo cargar la cuenta:", error);
    }
  }

  // ======================================
  // CONFIGURACIÓN
  // ======================================

  $("#theme-selector")?.addEventListener("change", event => {
    const theme = event.target.value;

    document.documentElement.dataset.theme = theme;
    localStorage.setItem("minicat_theme", theme);
  });

  $("#notifications-toggle")?.addEventListener("change", event => {
    localStorage.setItem(
      "minicat_notifications",
      String(event.target.checked)
    );
  });

  function loadSettings() {
    const theme = localStorage.getItem("minicat_theme");

    if (theme) {
      document.documentElement.dataset.theme = theme;

      if ($("#theme-selector")) {
        $("#theme-selector").value = theme;
      }
    }

    const notifications = localStorage.getItem("minicat_notifications");

    if (notifications !== null && $("#notifications-toggle")) {
      $("#notifications-toggle").checked = notifications === "true";
    }

    if ($("#memory-toggle")) {
      $("#memory-toggle").checked = state.memoryEnabled;
    }
  }

  // ======================================
  // BUSCAR CHATS
  // ======================================

  $("#search-chats")?.addEventListener("input", event => {
    const query = event.target.value.toLowerCase();

    document.querySelectorAll(".chat-item").forEach(item => {
      item.hidden = !item.textContent.toLowerCase().includes(query);
    });
  });

  // ======================================
  // INICIALIZACIÓN
  // ======================================

  loadPreferences();
  loadSettings();
  renderMemory();
  loadAccount();
  loadChats();

  console.log("MINICAT IA: interfaz inicializada correctamente.");
});
        
