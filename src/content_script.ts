import _ from "lodash";
import { LIMIT_DELTA_TIME, log, getEnumKeys } from "./common";
import {
  States,
  Actions,
  PlayerStateProp,
  MessageTypes,
  Message,
  PortName,
} from "./types";
import { extensionAPI } from "./browser-compat";

// ---------------- WebSocket ---------------- //
const ws = new WebSocket("wss://cr-watchparty-with-chatroom-production.up.railway.app");
let currentRoom = "default-room";

ws.onopen = () => {
  console.log("Connected to Horai chat server");
};

// ---------------- Key Lock State ---------------- //
// When true, all keyboard events are captured by the chat and NOT passed to Crunchyroll.
let g_keyLockEnabled = false;

// Global reference to sendMessage — set by attachChatEvents so the
// global keydown interceptor can call it directly when Enter is pressed
// while the panel is faded and input isn't yet focused.
let g_sendMessage: (() => void) | null = null;
let g_sendFromFs: (() => void) | null = null;
document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (!g_keyLockEnabled) return;

  const chatBox = document.getElementById("watch-chat");
  if (!chatBox) return;

  const inFullscreen = !!document.fullscreenElement;

  // ---- FULLSCREEN path ----
  if (inFullscreen) {
    const fsInput = document.getElementById("chat-input-fs") as HTMLInputElement | null;
    const fsFocused = fsInput && document.activeElement === fsInput;
    if (fsFocused) {
      if (e.key === "Enter") {
        e.stopImmediatePropagation();
        e.preventDefault();
        if (g_sendFromFs) g_sendFromFs();
        return;
      }
      e.stopImmediatePropagation();
      return;
    }
    // Not focused — route key to fsInput
    if (fsInput) {
      if (e.key === "Enter") {
        e.stopImmediatePropagation();
        e.preventDefault();
        fsInput.focus();
        if (g_sendFromFs) g_sendFromFs();
        return;
      }
      fsInput.focus();
    }
    e.stopImmediatePropagation();
    return;
  }

  // ---- NORMAL (non-fullscreen) path ----
  const chatInput = document.getElementById("chat-input") as HTMLInputElement | null;
  const inputFocused = chatInput && document.activeElement === chatInput;
  const inOverlay = chatBox.classList.contains("overlay-mode");
  const panel = chatBox.querySelector("#chat-panel") as HTMLElement | null;
  const panelFaded = panel && panel.style.opacity === "0";

  if (inputFocused) {
    if (e.key === "Enter") {
      e.stopImmediatePropagation();
      e.preventDefault();
      if (g_sendMessage) g_sendMessage();
      return;
    }
    e.stopImmediatePropagation();
    return;
  }

  // Reveal if fully hidden (icon mode)
  if (chatBox.classList.contains("panel-hidden")) {
    chatBox.classList.remove("panel-hidden");
  }

  if (chatInput) {
    if (e.key === "Enter") {
      e.stopImmediatePropagation();
      e.preventDefault();
      chatInput.focus();
      if (g_sendMessage) g_sendMessage();
      return;
    }

    // Non-overlay: reveal panel when user starts typing so they can see what they type
    if (!inOverlay && panelFaded && panel) {
      panel.style.opacity = "1";
      panel.style.pointerEvents = "all";
      if (chatInput) chatInput.style.pointerEvents = "";
    }

    chatInput.focus();
  }

  e.stopImmediatePropagation();
}, true);

// Independent Shift key listener — reveals chatbox panel regardless of any mode.
// Works in normal mode, fullscreen, with or without Chat Focus.
document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key !== "Shift") return;

  // Reveal normal panel if faded and focus its input
  const panel = document.getElementById("watch-chat")?.querySelector("#chat-panel") as HTMLElement | null;
  if (panel && panel.style.opacity === "0") {
    panel.style.opacity = "1";
    panel.style.pointerEvents = "all";
    const chatInput = document.getElementById("chat-input") as HTMLInputElement | null;
    if (chatInput) chatInput.focus();
  }

  // Reveal fullscreen panel if faded and focus its input
  const fsChat = document.getElementById("watch-chat-fs") as HTMLElement | null;
  if (fsChat && fsChat.style.opacity === "0") {
    fsChat.style.opacity = "1";
    fsChat.style.pointerEvents = "all";
    document.getElementById("chat-icon-fs")?.style.setProperty("display", "none");
    const fsInput = document.getElementById("chat-input-fs") as HTMLInputElement | null;
    if (fsInput) fsInput.focus();
  }
}, true);

// ---------------- Overlay message helpers ---------------- //
const MAX_OVERLAY_MESSAGES = 5;

// Map to track scheduled fade timers for overlay messages so we can cancel them
const g_fadeTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>[]>();

function pruneOverlayMessages(container: HTMLElement): void {
  const msgs = Array.from(container.querySelectorAll(".overlay-msg:not(.overlay-hidden)"));
  const visible = msgs.filter(m => (m as HTMLElement).style.opacity !== "0");
  if (visible.length > MAX_OVERLAY_MESSAGES) {
    const toHide = visible.slice(0, visible.length - MAX_OVERLAY_MESSAGES);
    toHide.forEach((m) => { (m as HTMLElement).style.opacity = "0"; });
  }
}

// Schedule a message to fade to opacity 0 after 5s — never removed from DOM
// so it can be restored when overlay is turned off.
function scheduleOverlayFade(div: HTMLElement): void {
  const t1 = setTimeout(() => {
    div.style.opacity = "0";
  }, 5000);
  g_fadeTimers.set(div, [t1]);
}

// Cancel fade timer and restore a message to normal visible state
function cancelOverlayFade(el: HTMLElement): void {
  const timers = g_fadeTimers.get(el);
  if (timers) timers.forEach(clearTimeout);
  g_fadeTimers.delete(el);
  el.style.opacity = "1";
  el.classList.remove("overlay-msg");
}

// Convert ALL existing messages in container to overlay-disappearing style.
function convertExistingToOverlay(container: HTMLElement): void {
  Array.from(container.querySelectorAll(".chat-msg, .system-msg")).forEach((msg) => {
    const el = msg as HTMLElement;
    if (!el.classList.contains("overlay-msg")) {
      el.classList.add("overlay-msg");
      scheduleOverlayFade(el);
    }
  });
  pruneOverlayMessages(container);
}

// Restore all overlay messages back to normal (cancel timers, reset opacity)
function restoreOverlayMessages(container: HTMLElement): void {
  Array.from(container.querySelectorAll(".overlay-msg")).forEach((msg) => {
    cancelOverlayFade(msg as HTMLElement);
  });
}

function appendMessage(username: string | null, text: string, isSystem = false): void {
  const inFullscreen = !!document.fullscreenElement;
  const fsMsgs = document.getElementById("chat-messages-fs");
  const normalMsgs = document.getElementById("chat-messages");

  // Always append to normal messages container (persists across fullscreen transitions)
  // Also append to fullscreen container when in fullscreen
  const containers: (HTMLElement | null)[] = [
    normalMsgs,
    inFullscreen ? fsMsgs : null,
  ];

  containers.forEach((messages) => {
    if (!messages) return;

    const div = document.createElement("div");

    if (isSystem) {
      div.classList.add("system-msg");
      div.textContent = text;
    } else {
      div.classList.add("chat-msg");
      if (username) {
        const nameSpan = document.createElement("span");
        nameSpan.classList.add("chat-username");
        nameSpan.textContent = username + ": ";
        div.appendChild(nameSpan);
      }
      div.appendChild(document.createTextNode(text));
    }

    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;

    // Apply overlay fade if relevant container is in overlay mode
    const chatBox = document.getElementById("watch-chat");
    if (messages === normalMsgs && chatBox?.classList.contains("overlay-mode")) {
      div.classList.add("overlay-msg");
      pruneOverlayMessages(messages);
      scheduleOverlayFade(div);
    } else if (messages === fsMsgs && fsMsgs?.classList.contains("fs-overlay-mode")) {
      div.classList.add("overlay-msg");
      pruneOverlayMessages(fsMsgs);
      scheduleOverlayFade(div);
    }
  });
}

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  if (msg.type === "chat") {
    appendMessage(msg.username ?? null, msg.text);
  }

  if (msg.type === "join" && msg.username) {
    appendMessage(null, `${msg.username} joined the chat`, true);
  }

  if (msg.type === "leave" && msg.username) {
    appendMessage(null, `${msg.username} left the chat`, true);
  }
};

ws.onerror = (err) => console.error("WebSocket error:", err);
ws.onclose = () => console.log("Disconnected from chat server");

// ---------------- Video Action Chat Notifications ---------------- //
// Notify the chat when someone plays, pauses, or seeks.
// "local" = this user did it. "remote" = someone else in the room did it.

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function notifyVideoAction(action: "play" | "pause" | "seek", progress: number, isRemote: boolean): void {
  const chatBox = document.getElementById("watch-chat");
  const username = isRemote ? "Someone" : (chatBox?.dataset.username || "You");
  const time = formatTime(progress);
  let text = "";
  if (action === "play")  text = `▶ ${username} resumed at ${time}`;
  if (action === "pause") text = `⏸ ${username} paused at ${time}`;
  if (action === "seek")  text = `⏩ ${username} jumped to ${time}`;
  if (text) appendMessage(null, text, true);
}

// ---------------- Video Sync ---------------- //
let g_port = extensionAPI.runtime.connect({ name: PortName.CONTENT_SCRIPT });

g_port.onDisconnect.addListener(() => {
  console.log("Port disconnected, reconnecting...");
  try {
    g_port = extensionAPI.runtime.connect({ name: PortName.CONTENT_SCRIPT });
    g_port.onMessage.addListener(handleServiceWorkerMessage);
  } catch(e) {
    console.log("Reconnect failed:", e);
  }
});

const ignoreNext: { [index: string]: boolean } = {};
let g_player: HTMLVideoElement | undefined = undefined;
let g_lastFrameProgress: number | undefined = undefined;
let g_heartBeatInterval: ReturnType<typeof setInterval> | undefined = undefined;

function getState(stateName: PlayerStateProp): boolean | number {
  return (g_player as any)[stateName];
}

function getStates(): { state: States; currentProgress: number; timeJump: boolean } {
  const [paused, currentProgress]: [boolean, number] = [
    getState("paused") as boolean,
    getState("currentTime") as number,
  ];

  g_lastFrameProgress = g_lastFrameProgress || currentProgress;
  const timeJump = Math.abs(currentProgress - g_lastFrameProgress) > LIMIT_DELTA_TIME;
  const state: States = paused ? States.PAUSED : States.PLAYING;
  g_lastFrameProgress = currentProgress;

  return { state, currentProgress, timeJump };
}

const handleLocalAction = (action: Actions) => (): void => {
  if (ignoreNext[action]) {
    return;
  }

  const { state, currentProgress, timeJump } = getStates();
  const type = MessageTypes.CS2SW_LOCAL_UPDATE;

  log("Local Action", action, { type, state, currentProgress, timeJump });

  switch (action) {
    case Actions.PLAY:
    case Actions.PAUSE:
      try { g_port.postMessage({ type, state, currentProgress }); } catch(e) {}
      notifyVideoAction(action === Actions.PLAY ? "play" : "pause", currentProgress, false);
      break;

    case Actions.TIME_UPDATE:
      if (timeJump) {
        try { g_port.postMessage({ type, state, currentProgress }); } catch(e) {}
        notifyVideoAction("seek", currentProgress, false);
      }
      break;
  }
};

function triggerAction(action: Actions, progress: number): void {
  if (_.isNil(g_player)) return log("Player undefined, action skipped");

  const player = g_player as HTMLVideoElement;
  ignoreNext[action] = true;
  setTimeout(() => { ignoreNext[action] = false; }, 1000);

  switch (action) {
    case Actions.PAUSE:
      player.pause();
      player.currentTime = progress;
      break;

    case Actions.PLAY:
      player.play();
      break;

    case Actions.TIME_UPDATE:
      player.currentTime = progress;
      break;

    default:
      ignoreNext[action] = false;
  }
}

function handleRemoteUpdate(message: Message): void {
  if (message.type !== MessageTypes.SW2CS_REMOTE_UPDATE)
    throw "Invalid message type";

  const { roomState, roomProgress } = message;

  if (!g_player) {
    setTimeout(() => handleRemoteUpdate(message), 500);
    return;
  }

  const { state, currentProgress } = getStates();

  if (Math.abs(roomProgress - currentProgress) > LIMIT_DELTA_TIME) {
    triggerAction(Actions.TIME_UPDATE, roomProgress);
    notifyVideoAction("seek", roomProgress, true);
  }

  if (state !== roomState) {
    if (roomState === States.PAUSED) {
      triggerAction(Actions.PAUSE, roomProgress);
      notifyVideoAction("pause", roomProgress, true);
    }
    if (roomState === States.PLAYING) {
      triggerAction(Actions.PLAY, roomProgress);
      notifyVideoAction("play", roomProgress, true);
    }
  }
}

function handleServiceWorkerMessage(serviceWorkerMessage: Message) {
  switch (serviceWorkerMessage.type) {
    case MessageTypes.SW2CS_ROOM_CONNECTION:
      if (g_player) {
        const { state, currentProgress } = getStates();
        g_port.postMessage({
          type: MessageTypes.CS2SW_ROOM_CONNECTION,
          state,
          currentProgress,
        });
      } else {
        g_port.postMessage({
          type: MessageTypes.CS2SW_ROOM_CONNECTION,
          state: States.PAUSED,
          currentProgress: 0,
        });
      }

      if (g_heartBeatInterval) clearInterval(g_heartBeatInterval);
      g_heartBeatInterval = setInterval(() => {
        try {
          g_port.postMessage({ type: MessageTypes.CS2SW_HEART_BEAT });
        } catch (err) {
          console.log("Heartbeat failed:", err);
        }
      }, 20000);
      break;

    case MessageTypes.SW2CS_ROOM_DISCONNECT:
      if (g_heartBeatInterval) clearInterval(g_heartBeatInterval);
      break;

    case MessageTypes.SW2CS_REMOTE_UPDATE:
      handleRemoteUpdate(serviceWorkerMessage);
      break;

    default:
      throw "Invalid service worker message type";
  }
}

let g_playerListenersAttached = false;

function runContentScript(): void {
  if (!g_port.onMessage.hasListener(handleServiceWorkerMessage)) {
    g_port.onMessage.addListener(handleServiceWorkerMessage);
  }

  const player = document.getElementById("player0") as HTMLVideoElement;

  if (!player) {
    setTimeout(runContentScript, 500);
    return;
  }

  if (!g_playerListenersAttached || g_player !== player) {
    g_player = player;
    g_playerListenersAttached = true;
    for (const action of getEnumKeys(Actions)) {
      g_player.addEventListener(Actions[action], handleLocalAction(Actions[action]));
    }
  }
}

// ---------------- Styles ---------------- //
const style = document.createElement("style");

style.textContent = `
#watch-chat {
  position: fixed;
  left: calc(100vw - 320px);
  top: 120px;
  width: 290px;
  z-index: 2147483647;
}

#chat-icon {
  position: fixed;
  right: 20px;
  top: 72px;
  width: 42px;
  height: 42px;
  background: #ff640a;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 20px;
  cursor: pointer;
  z-index: 2147483647;
  box-shadow: 0 0 10px rgba(0,0,0,0.5);
  transition: transform 0.15s ease;
}

#chat-icon:hover { transform: scale(1.1); }

#chat-panel {
  background: #111;
  color: white;
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  font-family: sans-serif;
  box-shadow: 0 0 10px rgba(0,0,0,0.5);
  transition: opacity 0.4s ease;
  overflow: visible;
}

/* Clip inner sections so the panel still looks rounded */
#chat-header { border-radius: 10px 10px 0 0; overflow: hidden; }
#chat-messages { border-radius: 0; }
#chat-input-area { border-radius: 0 0 10px 10px; overflow: hidden; }

#watch-chat.panel-hidden #chat-panel { display: none; }

#chat-header {
  padding: 10px;
  background: #222;
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: move;
  user-select: none;
  gap: 8px;
}

#chat-title { color: #ff640a; font-weight: bold; flex-shrink: 0; }

#chat-header-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: nowrap;
}

#overlay-control, #keylock-control {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

#overlay-label, #keylock-label {
  color: #ff640a;
  font-size: 12px;
  white-space: nowrap;
}

/* Fix 5: Tooltip on hover over the Keys toggle area */
#keylock-control {
  position: relative;
  cursor: default;
}

#keylock-tooltip {
  display: none;
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  background: #333;
  color: #fff;
  font-size: 11px;
  padding: 5px 8px;
  border-radius: 6px;
  white-space: nowrap;
  box-shadow: 0 2px 8px rgba(0,0,0,0.5);
  pointer-events: none;
  z-index: 2147483647;
}

#keylock-tooltip::after {
  content: "";
  position: absolute;
  bottom: 100%;
  right: 10px;
  border: 5px solid transparent;
  border-bottom-color: #333;
}

#keylock-control:hover #keylock-tooltip {
  display: block;
}

#chat-messages {
  overflow-y: auto;
  padding: 6px 10px;
  max-height: 200px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.chat-msg {
  font-size: 13px;
  line-height: 1.4;
  word-break: break-word;
  color: #ddd;
  font-family: sans-serif;
}

.chat-username {
  color: #ff640a;
  font-weight: bold;
}

.system-msg {
  font-size: 11px;
  color: #888;
  font-style: italic;
  text-align: center;
  padding: 2px 0;
  font-family: sans-serif;
}

#chat-input-area {
  display: flex;
  width: 100%;
  box-sizing: border-box;
}

#chat-input {
  flex: 1;
  border: none;
  padding: 8px;
  background: #222;
  color: white;
  outline: none;
  box-sizing: border-box;
  font-size: 13px;
}

#chat-send {
  border: none;
  background: #ff640a;
  color: white;
  padding: 8px 10px;
  cursor: pointer;
  flex-shrink: 0;
}

#chat-send:hover { background: #ff7a2b; }

.overlay-switch {
  position: relative;
  display: inline-block;
  width: 34px;
  height: 18px;
}

.overlay-switch input { opacity: 0; width: 0; height: 0; }

.slider {
  position: absolute;
  cursor: pointer;
  top: 0; left: 0; right: 0; bottom: 0;
  background: #555;
  border-radius: 20px;
  transition: .3s;
}

.slider:before {
  position: absolute;
  content: "";
  height: 14px;
  width: 14px;
  left: 2px;
  bottom: 2px;
  background: white;
  border-radius: 50%;
  transition: .3s;
}

input:checked + .slider { background: #ff640a; }
input:checked + .slider:before { transform: translateX(16px); }

/* ---- Fix 5: Overlay messages bigger and higher up ---- */
.overlay-mode #chat-messages {
  position: fixed;
  right: 20px;
  bottom: 200px;
  width: 320px;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  max-height: 210px;
  overflow: hidden;
  background: transparent;
  padding: 0;
  gap: 6px;
  justify-content: flex-end;
}

.overlay-msg {
  background: rgba(0,0,0,0.6);
  padding: 5px 12px;
  margin: 0;
  border-radius: 6px;
  width: fit-content;
  max-width: 310px;
  font-size: 15px;
  font-family: sans-serif;
  color: #fff;
  transition: opacity 1s ease;
  word-break: break-word;
  text-align: right;
  box-sizing: border-box;
  flex-shrink: 0;
  line-height: 1.5;
}

.overlay-msg .chat-username {
  color: #ff640a;
  font-weight: bold;
}

#username-input-area {
  display: flex;
  width: 100%;
  padding: 10px;
  box-sizing: border-box;
  gap: 8px;
}

#username-input {
  flex: 1;
  min-width: 0;
  background: #1a1a1a;
  border: none;
  color: white;
  padding: 8px;
  border-radius: 6px;
  outline: none;
  font-size: 13px;
}

#username-confirm {
  background: #ff640a;
  border: none;
  color: white;
  padding: 8px 10px;
  cursor: pointer;
  border-radius: 6px;
  font-weight: bold;
  white-space: nowrap;
  flex-shrink: 0;
}

#username-confirm:hover { background: #ff7a2b; }

/* ---- Fullscreen chat panel ---- */
#watch-chat-fs {
  position: absolute;
  right: 20px;
  top: 20px;
  width: 320px;
  z-index: 2147483647;
  pointer-events: all;
  font-family: sans-serif;
  transition: opacity 0.4s ease;
}

#chat-panel-fs {
  background: rgba(17,17,17,0.92);
  color: white;
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 0 12px rgba(0,0,0,0.7);
  overflow: visible;
}

/* Clip inner sections for rounded look */
#chat-header-fs { border-radius: 10px 10px 0 0; overflow: hidden; }
#chat-input-area-fs { border-radius: 0 0 10px 10px; overflow: hidden; }

#chat-header-fs {
  padding: 8px 10px;
  background: rgba(34,34,34,0.95);
  display: flex;
  align-items: center;
  justify-content: space-between;
  user-select: none;
  cursor: move;
  gap: 8px;
}

#chat-title-fs {
  color: #ff640a;
  font-weight: bold;
  font-size: 13px;
  flex-shrink: 0;
}

#chat-header-controls-fs {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: nowrap;
}

#overlay-control-fs, #keylock-control-fs {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

#overlay-label-fs, #keylock-label-fs {
  color: #ff640a;
  font-size: 12px;
  white-space: nowrap;
}

#chat-messages-fs {
  overflow-y: auto;
  padding: 6px 10px;
  max-height: 180px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

#chat-input-area-fs {
  display: flex;
  width: 100%;
  box-sizing: border-box;
}

#chat-input-fs {
  flex: 1;
  border: none;
  padding: 8px;
  background: #333;
  color: white;
  outline: none;
  box-sizing: border-box;
  font-size: 13px;
}

#chat-send-fs {
  border: none;
  background: #ff640a;
  color: white;
  padding: 8px 10px;
  cursor: pointer;
  flex-shrink: 0;
}

#chat-send-fs:hover { background: #ff7a2b; }

/* ---- Fullscreen overlay mode messages — higher up ---- */
#chat-messages-fs.fs-overlay-mode {
  position: absolute;
  bottom: 220px;
  right: 20px;
  left: auto;
  top: auto;
  width: 320px;
  max-height: 210px;
  pointer-events: none;
  background: transparent;
  padding: 0;
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  overflow: hidden;
  justify-content: flex-end;
}
`;

document.head.appendChild(style);

// ---------------- ChatBox ---------------- //

function createChatBoxIfVideoExists(): void {
  const player = document.getElementById("player0") as HTMLVideoElement;
  if (!player) {
    setTimeout(createChatBoxIfVideoExists, 500);
    return;
  }

  if (document.getElementById("watch-chat")) return;

  const icon = document.createElement("div");
  icon.id = "chat-icon";
  icon.textContent = "💬";
  document.body.appendChild(icon);

  const chatBox = document.createElement("div");
  chatBox.id = "watch-chat";
  chatBox.innerHTML = `
<div id="chat-panel">
  <div id="chat-header">
    <span id="chat-title">Horai Chat</span>
    <div id="chat-header-controls">
      <div id="overlay-control">
        <span id="overlay-label">Overlay</span>
        <label class="overlay-switch">
          <input type="checkbox" id="overlay-toggle">
          <span class="slider"></span>
        </label>
      </div>
      <div id="keylock-control">
        <span id="keylock-label">Chat Focus</span>
        <label class="overlay-switch">
          <input type="checkbox" id="keylock-toggle">
          <span class="slider"></span>
        </label>
        <span id="keylock-tooltip">Chat Focus — redirects all keyboard input to chat</span>
      </div>
    </div>
  </div>
  <div id="username-input-area">
    <input id="username-input" placeholder="Your username">
    <button id="username-confirm">OK</button>
  </div>
  <div id="chat-messages"></div>
  <div id="chat-input-area" style="display:none">
    <input id="chat-input" placeholder="Type message">
    <button id="chat-send">Send</button>
  </div>
</div>
  `;

  document.body.appendChild(chatBox);
  attachChatEvents(chatBox, icon);
  watchFullscreen(chatBox);
}

// ---------------- Fullscreen handler ---------------- //

function watchFullscreen(chatBox: HTMLElement): void {
  document.addEventListener("fullscreenchange", () => {
    document.getElementById("watch-chat-fs")?.remove();
    document.getElementById("chat-icon-fs")?.remove();
    document.getElementById("chat-messages-fs")?.remove();

    const fsEl = document.fullscreenElement as HTMLElement | null;
    if (!fsEl) return;

    if (getComputedStyle(fsEl).position === "static") {
      fsEl.style.position = "relative";
    }

    const fsChat = document.createElement("div");
    fsChat.id = "watch-chat-fs";
    fsChat.innerHTML = `
<div id="chat-panel-fs">
  <div id="chat-header-fs">
    <span id="chat-title-fs">💬 Horai Chat</span>
    <div id="chat-header-controls-fs">
      <div id="overlay-control-fs">
        <span id="overlay-label-fs">Overlay</span>
        <label class="overlay-switch">
          <input type="checkbox" id="overlay-toggle-fs">
          <span class="slider"></span>
        </label>
      </div>
      <div id="keylock-control-fs">
        <span id="keylock-label-fs">Chat Focus</span>
        <label class="overlay-switch">
          <input type="checkbox" id="keylock-toggle-fs">
          <span class="slider"></span>
        </label>
      </div>
    </div>
  </div>
  <div id="chat-messages-fs"></div>
  <div id="chat-input-area-fs">
    <input id="chat-input-fs" placeholder="Type message">
    <button id="chat-send-fs">Send</button>
  </div>
</div>
    `;
    fsEl.appendChild(fsChat);

    const fsIcon = document.createElement("div");
    fsIcon.id = "chat-icon-fs";
    fsIcon.textContent = "💬";
    fsIcon.style.cssText = `
      position: absolute;
      right: 20px;
      top: 20px;
      width: 38px;
      height: 38px;
      background: #ff640a;
      color: white;
      display: none;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      font-size: 18px;
      cursor: pointer;
      z-index: 2147483647;
      box-shadow: 0 0 10px rgba(0,0,0,0.5);
      transition: transform 0.15s ease;
    `;
    fsEl.appendChild(fsIcon);

    const fsInput       = fsChat.querySelector("#chat-input-fs") as HTMLInputElement;
    const fsSendBtn     = fsChat.querySelector("#chat-send-fs") as HTMLButtonElement;
    const fsOverlay     = fsChat.querySelector("#overlay-toggle-fs") as HTMLInputElement;
    const fsKeylockTgl  = fsChat.querySelector("#keylock-toggle-fs") as HTMLInputElement;
    const fsHeader      = fsChat.querySelector("#chat-header-fs") as HTMLElement;
    const fsMsgs        = fsChat.querySelector("#chat-messages-fs") as HTMLElement;
    const fsPanelEl     = fsChat.querySelector("#chat-panel-fs") as HTMLElement;
    const fsInputArea   = fsChat.querySelector("#chat-input-area-fs") as HTMLElement;

    // Sync fullscreen keylock toggle with global state
    fsKeylockTgl.checked = g_keyLockEnabled;
    fsKeylockTgl.addEventListener("change", () => {
      g_keyLockEnabled = fsKeylockTgl.checked;
      if (g_keyLockEnabled) {
        fsInput.focus();
      }
    });

    let fsHideTimer: ReturnType<typeof setTimeout>;
    let fsOverlayActive = false;

    function showPanel() {
      fsChat.style.opacity = "1";
      fsChat.style.pointerEvents = "all";
      fsIcon.style.display = "none";
      resetHideTimer();
    }

    function hidePanel() {
      fsChat.style.opacity = "0";
      fsChat.style.pointerEvents = "none";
      fsIcon.style.display = "flex";
    }

    function resetHideTimer() {
      clearTimeout(fsHideTimer);
      fsHideTimer = setTimeout(hidePanel, 5000);
    }

    fsIcon.addEventListener("click", showPanel);

    fsChat.addEventListener("mouseenter", () => {
      clearTimeout(fsHideTimer);
    });

    fsChat.addEventListener("mouseleave", () => {
      if (document.activeElement === fsInput) return;
      resetHideTimer();
    });

    fsInput.addEventListener("focus", () => {
      if (!g_keyLockEnabled) clearTimeout(fsHideTimer);
    });

    fsInput.addEventListener("blur", () => {
      resetHideTimer();
    });

    fsOverlay.addEventListener("change", () => {
      clearTimeout(fsHideTimer);
      fsOverlayActive = fsOverlay.checked;

      if (fsOverlayActive) {
        fsMsgs.classList.add("fs-overlay-mode");
        fsEl.appendChild(fsMsgs);
        // Fix 1: convert pre-existing messages so they also fade out
        convertExistingToOverlay(fsMsgs);
        fsChat.style.opacity = "1";
        fsChat.style.pointerEvents = "all";
        fsIcon.style.display = "none";
        resetHideTimer();
      } else {
        fsMsgs.classList.remove("fs-overlay-mode");
        fsPanelEl.insertBefore(fsMsgs, fsInputArea);
        fsPanelEl.style.display = "flex";
        fsPanelEl.style.height = "";
        fsPanelEl.style.maxHeight = "";
        fsChat.style.opacity = "1";
        fsChat.style.pointerEvents = "all";
        fsIcon.style.display = "none";
        fsMsgs.querySelectorAll(".overlay-msg").forEach((msg) => {
          cancelOverlayFade(msg as HTMLElement);
        });
        resetHideTimer();
      }
    });

    function sendFromFs() {
      const username = chatBox.dataset.username;
      if (!username || !fsInput.value.trim()) return;
      const text = fsInput.value.trim();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "chat", text, username }));
        appendMessage(username, text);
      }
      fsInput.value = "";
      fsInput.focus();
      resetHideTimer();
    }

    g_sendFromFs = sendFromFs;

    fsSendBtn.addEventListener("click", sendFromFs);
    fsInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        sendFromFs();
      }
    }, true);

    // Drag
    let fsDragging = false, fsOffX = 0, fsOffY = 0;

    fsHeader.addEventListener("mousedown", (e) => {
      fsDragging = true;
      fsOffX = e.clientX - fsChat.getBoundingClientRect().left;
      fsOffY = e.clientY - fsChat.getBoundingClientRect().top;
      fsHeader.style.cursor = "grabbing";
    });

    fsEl.addEventListener("mousemove", (e) => {
      if (!fsDragging) return;
      fsChat.style.left  = (e.clientX - fsOffX) + "px";
      fsChat.style.top   = (e.clientY - fsOffY) + "px";
      fsChat.style.right = "auto";
    });

    fsEl.addEventListener("mouseup", () => {
      fsDragging = false;
      fsHeader.style.cursor = "";
    });

    showPanel();
  });
}

// ---------------- Events ---------------- //

function attachChatEvents(chatBox: HTMLElement, icon: HTMLElement): void {
  const usernameArea    = chatBox.querySelector("#username-input-area") as HTMLElement;
  const usernameInput   = chatBox.querySelector("#username-input") as HTMLInputElement;
  const usernameConfirm = chatBox.querySelector("#username-confirm") as HTMLButtonElement;
  const input           = chatBox.querySelector("#chat-input") as HTMLInputElement;
  const sendButton      = chatBox.querySelector("#chat-send") as HTMLButtonElement;
  const header          = chatBox.querySelector("#chat-header") as HTMLElement;
  const overlayToggle   = chatBox.querySelector("#overlay-toggle") as HTMLInputElement;
  const keylockToggle   = chatBox.querySelector("#keylock-toggle") as HTMLInputElement;
  const messages        = chatBox.querySelector("#chat-messages") as HTMLElement;
  const panel           = chatBox.querySelector("#chat-panel") as HTMLElement;
  let hideTimer: ReturnType<typeof setTimeout>;

  icon.addEventListener("click", () => {
    chatBox.classList.toggle("panel-hidden");
  });

  usernameConfirm.addEventListener("click", () => {
    if (!usernameInput.value.trim()) return;
    const username = usernameInput.value.trim();
    chatBox.dataset.username = username;
    usernameArea.style.display = "none";
    (chatBox.querySelector("#chat-input-area") as HTMLElement).style.display = "flex";

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "join", room: currentRoom, username }));
    }
  });

  usernameInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
  });

  // Key lock toggle — hides panel immediately and blocks all keys from Crunchyroll
  keylockToggle.addEventListener("change", () => {
    g_keyLockEnabled = keylockToggle.checked;
    if (g_keyLockEnabled) {
      // Hide panel immediately — all keys now go to chat
      if (panel) {
        panel.style.opacity = "0";
        panel.style.pointerEvents = "none";
        input.style.pointerEvents = "all";
      }
      const chatInputArea = chatBox.querySelector("#chat-input-area") as HTMLElement;
      if (chatInputArea.style.display !== "none") {
        input.focus();
      }
    } else {
      // Turning off — reveal panel and restart normal hide timer
      revealPanel();
      startHideTimer();
    }
  });

  function sendMessage() {
    const username = chatBox.dataset.username;
    if (!username || !input.value.trim()) return;
    const text = input.value.trim();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "chat", text, username }));
      appendMessage(username, text);
    }
    input.value = "";
    input.focus();
  }

  // Expose sendMessage globally so the keydown interceptor can call it
  // directly when Enter is pressed while the panel is faded.
  g_sendMessage = sendMessage;

  sendButton.addEventListener("click", sendMessage);

  // Fix 1 (Enter in Chat Focus mode): listener on the input in capture phase.
  // This fires before the global keydown interceptor, so when Enter is pressed
  // while Chat Focus is on, we handle it here directly regardless of focus state.
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      sendMessage();
    }
  }, true);

  // Drag
  let offsetX = 0, offsetY = 0, isDragging = false;

  header.addEventListener("mousedown", (e) => {
    isDragging = true;
    offsetX = e.clientX - chatBox.getBoundingClientRect().left;
    offsetY = e.clientY - chatBox.getBoundingClientRect().top;
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    chatBox.style.left   = (e.clientX - offsetX) + "px";
    chatBox.style.top    = (e.clientY - offsetY) + "px";
    chatBox.style.right  = "auto";
    chatBox.style.bottom = "auto";
    icon.style.left  = (e.clientX - offsetX + chatBox.offsetWidth - 20) + "px";
    icon.style.top   = (e.clientY - offsetY - 52) + "px";
    icon.style.right = "auto";
  });

  document.addEventListener("mouseup", () => { isDragging = false; });

  // Fix 1: Overlay toggle — convert pre-existing messages when turning overlay ON,
  // and fully restore (cancel timers + reset opacity) when turning it OFF
  overlayToggle.addEventListener("change", () => {
    chatBox.classList.toggle("overlay-mode");
    if (overlayToggle.checked) {
      // Move messages to body so panel opacity:0 doesn't hide them
      document.body.appendChild(messages);
      convertExistingToOverlay(messages);
      startHideTimer();
    } else {
      // Put messages back inside panel before the input area
      const inputArea = chatBox.querySelector("#chat-input-area") as HTMLElement;
      panel.insertBefore(messages, inputArea);
      restoreOverlayMessages(messages);
      startHideTimer();
    }
  });

  // Fix 2/3/4: Hide/show logic
  // - Hovering chatbox: show panel, cancel timer
  // - Clicking video (anywhere outside chatbox): start 5s hide timer
  // - Typing in input: cancel timer, keep panel visible
  // - Key lock ON: never hide

  function startHideTimer() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (panel) {
        panel.style.opacity = "0";
        panel.style.pointerEvents = "none";
        input.style.pointerEvents = "all";
      }
    }, 5000);
  }

  function revealPanel() {
    clearTimeout(hideTimer);
    if (panel) {
      panel.style.opacity = "1";
      panel.style.pointerEvents = "all";
      input.style.pointerEvents = "";
    }
  }

  // Show on hover over chatbox or icon
  chatBox.addEventListener("mouseenter", revealPanel);
  icon.addEventListener("mouseenter", revealPanel);

  // Fix 4: clicking outside chatbox (i.e. the video) starts hide timer
  document.addEventListener("mousedown", (e) => {
    const target = e.target as Node;
    if (!chatBox.contains(target) && target !== icon) {
      startHideTimer();
    }
  });

  // While input is focused, keep panel visible — UNLESS Chat Focus is on
  // (in that case panel is intentionally allowed to stay faded while typing)
  input.addEventListener("focus", () => {
    if (!g_keyLockEnabled) revealPanel();
  });

  startHideTimer();
}

// ---------------- RUN ---------------- //

createChatBoxIfVideoExists();
runContentScript();