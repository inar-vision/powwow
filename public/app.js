/* powwow browser client: terminal + presence + turn-taking controls.
 * Handlers are wired up first so the UI never silently dies if the terminal
 * library fails to load; any failure is surfaced in the notice bar. */
(function () {
  "use strict";

  var token = new URLSearchParams(location.search).get("t") || "";
  var youId = null;
  var driverId = null;
  var amDriver = false;
  var ws = null;
  var term = null;
  var fit = null;
  var suggestions = [];
  var currentName = "";
  var reconnectAttempts = 0;
  var MAX_RECONNECT = 5;

  // --- UI elements --------------------------------------------------------
  var overlay = document.getElementById("overlay");
  var nameInput = document.getElementById("nameInput");
  var joinBtn = document.getElementById("joinBtn");
  var participantsEl = document.getElementById("participants");
  var noticeEl = document.getElementById("notice");
  var roleLabel = document.getElementById("roleLabel");
  var requestBtn = document.getElementById("requestBtn");
  var yieldBtn = document.getElementById("yieldBtn");
  var suggestionTray = document.getElementById("suggestionTray");
  var suggestArea = document.getElementById("suggestArea");
  var suggestText = document.getElementById("suggestText");
  var suggestBtn = document.getElementById("suggestBtn");
  var typingIds = {}; // id -> clearTimeout handle
  var typingActive = {}; // id -> bool, separate from handle so 0 is never falsy
  var lastParticipants = [];
  var suggestTypingThrottle = null;

  function setNotice(text) {
    noticeEl.textContent = text;
  }

  function syncNoDriverNotice() {
    if (!driverId && youId) {
      noticeEl.textContent = "No one is driving — take control to send input to Claude.";
      noticeEl.style.color = "#d29922";
    } else {
      noticeEl.style.color = "";
    }
  }

  // --- terminal (created on join so load failures surface cleanly) --------
  var reflowTimer = null;
  function reflowTerminal() {
    clearTimeout(reflowTimer);
    reflowTimer = setTimeout(function () {
      if (fit) fit.fit();
      maybeSendResize();
    }, 50);
  }

  function initTerminal() {
    if (typeof Terminal === "undefined") {
      throw new Error("terminal library failed to load (check /vendor/xterm.js)");
    }
    term = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      theme: { background: "#0d1117", foreground: "#e6edf3" },
    });
    if (typeof FitAddon !== "undefined" && FitAddon.FitAddon) {
      fit = new FitAddon.FitAddon();
      term.loadAddon(fit);
    }
    term.open(document.getElementById("terminal"));
    // Defer fit() so the browser has time to reflow after the overlay hides.
    requestAnimationFrame(function () {
      if (fit) fit.fit();
      maybeSendResize();
    });

    term.onData(function (data) {
      if (amDriver && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "input", data: data }));
      }
    });

    window.addEventListener("resize", reflowTerminal);
  }

  function maybeSendResize() {
    if (!amDriver || !term || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }

  // --- presence + role ----------------------------------------------------
  function chipClasses(p) {
    var cls = "chip";
    if (p.isDriver) cls += " driver";
    if (p.requestingControl) cls += " waiting";
    if (p.id === youId) cls += " you";
    if (typingActive[p.id]) cls += " typing";
    return cls;
  }

  function chipLabel(p) {
    var text = p.name + (p.id === youId ? " (you)" : "");
    if (p.isDriver) text += " · driving";
    else if (p.requestingControl) text += " · waiting";
    return text;
  }

  // Chips persist across updates so CSS animations are never restarted.
  function renderParticipants(list) {
    lastParticipants = list;
    var seen = {};
    list.forEach(function (p) {
      seen[p.id] = true;
      var chip = participantsEl.querySelector('[data-pid="' + p.id + '"]');
      if (!chip) {
        chip = document.createElement("span");
        chip.dataset.pid = p.id;
        var dot = document.createElement("span");
        dot.className = "dot";
        var label = document.createElement("span");
        label.className = "chip-label";
        chip.appendChild(dot);
        chip.appendChild(label);
        participantsEl.appendChild(chip);
      }
      chip.className = chipClasses(p);
      chip.querySelector(".chip-label").textContent = chipLabel(p);
      // Sync typing dots without recreating if already present
      var dots = chip.querySelector(".typing-dots");
      if (typingActive[p.id] && !dots) {
        dots = document.createElement("span");
        dots.className = "typing-dots";
        dots.innerHTML = "<span></span><span></span><span></span>";
        chip.appendChild(dots);
      } else if (!typingActive[p.id] && dots) {
        chip.removeChild(dots);
      }
    });
    // Remove chips for participants who left
    Array.from(participantsEl.querySelectorAll("[data-pid]")).forEach(function (chip) {
      if (!seen[chip.dataset.pid]) participantsEl.removeChild(chip);
    });
  }

  // --- typing indicator ---------------------------------------------------
  function showTyping(id) {
    if (id === youId) return;
    var wasTyping = typingActive[id] === true;
    typingActive[id] = true;
    if (typingIds[id]) clearTimeout(typingIds[id]);
    typingIds[id] = setTimeout(function () {
      delete typingIds[id];
      delete typingActive[id];
      // Remove dots directly from the chip — no full re-render
      var chip = participantsEl.querySelector('[data-pid="' + id + '"]');
      if (chip) {
        chip.classList.remove("typing");
        var dots = chip.querySelector(".typing-dots");
        if (dots) chip.removeChild(dots);
      }
    }, 1500);
    if (!wasTyping) {
      // Add dots directly to the chip — no full re-render
      var chip = participantsEl.querySelector('[data-pid="' + id + '"]');
      if (chip) {
        chip.classList.add("typing");
        if (!chip.querySelector(".typing-dots")) {
          var dots = document.createElement("span");
          dots.className = "typing-dots";
          dots.innerHTML = "<span></span><span></span><span></span>";
          chip.appendChild(dots);
        }
      }
    }
  }

  // --- suggestion queue ---------------------------------------------------
  function renderSuggestions() {
    suggestionTray.innerHTML = "";
    if (suggestions.length === 0) {
      if (suggestionTray.style.display !== "none") {
        suggestionTray.style.display = "none";
        reflowTerminal();
      }
      return;
    }
    var wasHidden = suggestionTray.style.display === "none";
    suggestionTray.style.display = "";
    if (wasHidden) reflowTerminal();
    suggestions.forEach(function (s) {
      var item = document.createElement("div");
      item.className = "suggestion-item";

      var from = document.createElement("span");
      from.className = "suggestion-from";
      from.textContent = s.fromName + ":";

      var text = document.createElement("span");
      text.className = "suggestion-text";
      text.textContent = s.text;
      text.title = s.text;

      item.appendChild(from);
      item.appendChild(text);

      if (amDriver) {
        var actions = document.createElement("div");
        actions.className = "suggestion-actions";

        var sendBtn = document.createElement("button");
        sendBtn.className = "btn-send";
        sendBtn.textContent = "Send →";
        (function (sid) {
          sendBtn.onclick = function () {
            if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "accept_suggestion", id: sid }));
          };
        })(s.id);

        var dismissBtn = document.createElement("button");
        dismissBtn.textContent = "×";
        (function (sid) {
          dismissBtn.onclick = function () {
            if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "dismiss_suggestion", id: sid }));
          };
        })(s.id);

        actions.appendChild(sendBtn);
        actions.appendChild(dismissBtn);
        item.appendChild(actions);
      } else if (s.fromId === youId) {
        var actions = document.createElement("div");
        actions.className = "suggestion-actions";
        var retractBtn = document.createElement("button");
        retractBtn.textContent = "Retract";
        (function (sid) {
          retractBtn.onclick = function () {
            if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "dismiss_suggestion", id: sid }));
          };
        })(s.id);
        actions.appendChild(retractBtn);
        item.appendChild(actions);
      }

      suggestionTray.appendChild(item);
    });
  }

  function submitSuggestion() {
    var text = (suggestText.value || "").trim();
    if (!text || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: "suggest", text: text }));
    suggestText.value = "";
  }

  function updateRole() {
    amDriver = youId !== null && youId === driverId;
    if (amDriver) {
      roleLabel.textContent = "driving";
      roleLabel.style.color = "#3fb950";
      requestBtn.style.display = "none";
      yieldBtn.style.display = "";
      suggestArea.style.display = "none";
      if (term) term.focus();
      maybeSendResize();
    } else {
      roleLabel.textContent = driverId ? "observing" : "no driver";
      roleLabel.style.color = driverId ? "#8b949e" : "#d29922";
      requestBtn.style.display = "";
      yieldBtn.style.display = "none";
      if (driverId) {
        requestBtn.textContent = "Request control";
        requestBtn.classList.remove("primary");
      } else {
        requestBtn.textContent = "Take control";
        requestBtn.classList.add("primary");
      }
      suggestArea.style.display = youId ? "" : "none";
    }
    renderSuggestions();
    syncNoDriverNotice();
  }

  // --- websocket ----------------------------------------------------------
  function connect(name) {
    var proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(proto + "://" + location.host + "/ws?t=" + encodeURIComponent(token));

    ws.onopen = function () {
      var hello = { type: "hello", name: name };
      var storedClientId = sessionStorage.getItem("powwow_cid");
      if (storedClientId) hello.clientId = storedClientId;
      ws.send(JSON.stringify(hello));
      setNotice("Connected.");
    };

    ws.onmessage = function (ev) {
      var msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      switch (msg.type) {
        case "init":
          youId = msg.youId;
          driverId = msg.driverId;
          suggestions = msg.suggestions || [];
          reconnectAttempts = 0;
          if (msg.clientId) sessionStorage.setItem("powwow_cid", msg.clientId);
          if (term && msg.cols && msg.rows) term.resize(msg.cols, msg.rows);
          renderParticipants(msg.participants);
          updateRole();
          break;
        case "output":
          if (term) term.write(msg.data);
          break;
        case "typing":
          showTyping(msg.id);
          break;
        case "resize":
          if (term) term.resize(msg.cols, msg.rows);
          break;
        case "presence":
          driverId = msg.driverId;
          renderParticipants(msg.participants);
          updateRole();
          break;
        case "suggestion":
          suggestions.push(msg.suggestion);
          renderSuggestions();
          break;
        case "suggestion_cleared":
          suggestions = suggestions.filter(function (s) { return s.id !== msg.id; });
          renderSuggestions();
          break;
        case "notice":
          setNotice(msg.text);
          break;
        case "exit":
          setNotice("The wrapped program exited" + (msg.code != null ? " (code " + msg.code + ")" : "") + ". Session over.");
          if (term) term.write("\r\n\x1b[33m[powwow] session ended\x1b[0m\r\n");
          break;
      }
    };

    ws.onclose = function () {
      if (reconnectAttempts < MAX_RECONNECT && youId) {
        reconnectAttempts++;
        setNotice("Reconnecting… (" + reconnectAttempts + "/" + MAX_RECONNECT + ")");
        setTimeout(function () { connect(currentName); }, 1500);
      } else {
        setNotice("Disconnected from session.");
        roleLabel.textContent = "disconnected";
      }
    };
    ws.onerror = function () {
      setNotice("Connection error — is the session still running?");
    };
  }

  // --- join flow ----------------------------------------------------------
  function join() {
    var name = (nameInput.value || "").trim() || "anon";
    currentName = name;
    try {
      overlay.style.display = "none";
      initTerminal();
      connect(name);
    } catch (err) {
      overlay.style.display = "";
      setNotice("Could not start: " + (err && err.message ? err.message : err));
      console.error("[powwow] join failed:", err);
    }
  }

  // Wire handlers immediately, before anything that could throw.
  joinBtn.addEventListener("click", join);
  nameInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") join();
  });
  requestBtn.addEventListener("click", function () {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "request_control" }));
  });
  yieldBtn.addEventListener("click", function () {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "yield_control" }));
  });
  suggestBtn.addEventListener("click", submitSuggestion);
  suggestText.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); submitSuggestion(); return; }
    if (!suggestTypingThrottle && ws && ws.readyState === 1 && youId) {
      ws.send(JSON.stringify({ type: "typing" }));
      suggestTypingThrottle = setTimeout(function () { suggestTypingThrottle = null; }, 300);
    }
  });
  nameInput.focus();
})();
