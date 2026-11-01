// ======================================
// MINICAT IA - SCRIPT PRINCIPAL
// ======================================

document.addEventListener("DOMContentLoaded", () => {
  const $ = (selector) => document.querySelector(selector);

  const state = {
    activeSection: "chat",
    activeChat: null,
    chats: [],
    memory: [],
    memoryEnabled: true,
    sidebarOpen: false
  };

  const STORAGE_KEY = "minicat_preferences";

  // Cargar preferencias locales
  function loadPreferences() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));

      if (saved) {
        state.memoryEnabled = saved.memoryEnabled ?? true;
        state.memory = Array.isArray(saved.memory)
          ? saved.memory
          : [];
      }
    } catch {
      console.warn("No se pudieron cargar las preferencias.");
    }
  }

  function savePreferences() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      memoryEnabled: state.memoryEnabled,
      memory: state.memory
    }));
  }

  // ======================================
  // NAVEGACIÓN
  // ======================================

  function openSection(section) {
    state.activeSection = section;

    document.querySelectorAll("[data-section]").forEach(element => {
      element.classList.toggle(
        "active",
        element.dataset.section === section
      );
    });

    document.querySelectorAll(".page-section").forEach(element => {
      element.hidden = element.id !== section;
    });

    closeSidebar();
  }

  document.querySelectorAll("[data-section]").forEach(button => {
    button.addEventListener("click", () => {
      openSection(button.dataset.section);
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

  $("#sidebar-overlay")?.addEventListener("click", closeSidebar);

  // ======================================
  // MENÚ DE LOS TRES PUNTOS
  // ======================================

  const globalMenu = $("#global-menu");
  const globalMenuButton = $("#global-menu-button");

  globalMenuButton?.addEventListener("click", event => {
    event.stopPropagation();
    globalMenu?.classList.toggle("visible");
  });

  document.addEventListener("click", event => {
    if (
      !globalMenu?.contains(event.target) &&
      !globalMenuButton?.contains(event.target)
    ) {
      globalMenu?.classList.remove("visible");
    }
  });

  // ======================================
  // NUEVO CHAT
  // ======================================

  function newChat() {
    const chat = {
      id: crypto.randomUUID(),
      title: "Nuevo chat",
      createdAt: new Date().toISOString()
    };

    state.chats.unshift(chat);
    state.activeChat = chat.id;

    renderChats();
    openSection("chat");

    const input = $("#chat-input");
    if (input) input.value = "";
  }

  $("#new-chat-button")?.addEventListener("click", newChat);

  // ======================================
  // LISTA DE CHATS
  // ======================================

  function renderChats() {
    const container = $("#active-chats");
    if (!container) return;

    container.innerHTML = "";

    state.chats.forEach(chat => {
      const row = document.createElement("div");
      row.className = "chat-item";

      const select = document.createElement("button");
      select.className = "chat-select";
      select.textContent = chat.title;

      select.addEventListener("click", () => {
        state.activeChat = chat.id;
        openSection("chat");
      });

      const menu = document.createElement("button");
      menu.className = "chat-menu-button";
      menu.textContent = "⋯";
      menu.setAttribute("aria-label", "Opciones del chat");

      menu.addEventListener("click", () => {
        showChatMenu(chat.id, menu);
      });

      row.append(select, menu);
      container.appendChild(row);
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

    const name = prompt("Nuevo nombre del chat:");
    if (!name?.trim()) return;

    chat.title = name.trim();
    renderChats();
  }

  function shareChat(id) {
    alert("La función para compartir se conectará al servidor.");
  }

  function archiveChat(id) {
    state.chats = state.chats.filter(chat => chat.id !== id);
    if (state.activeChat === id) state.activeChat = null;
    renderChats();
  }

  function deleteChat(id) {
    if (!confirm("¿Eliminar esta conversación?")) return;

    state.chats = state.chats.filter(chat => chat.id !== id);

    if (state.activeChat === id) {
      state.activeChat = null;
    }

    renderChats();
  }

  // ======================================
  // MEMORIA PERSONAL
  // ======================================

  function renderMemory() {
    const container = $("#memory-list");
    if (!container) return;

    container.innerHTML = "";

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
  // CONFIGURACIÓN DE APARIENCIA
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
  renderChats();
  renderMemory();

  if ($("#memory-toggle")) {
    $("#memory-toggle").checked = state.memoryEnabled;
  }

  const savedTheme = localStorage.getItem("minicat_theme");
  if (savedTheme) {
    document.documentElement.dataset.theme = savedTheme;

    if ($("#theme-selector")) {
      $("#theme-selector").value = savedTheme;
    }
  }

  console.log("MINICAT IA: interfaz inicializada.");
});
