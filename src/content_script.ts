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
let currentRoom = "default-room";

// Queue for messages that couldn't be sent yet (server waking up / reconnecting)
let g_messageQueue: string[] = [];

let g_heartbeatInterval: ReturnType<typeof setTimeout> | null = null;

// Create WebSocket with auto-reconnect and queue drain
function createWs(): WebSocket {
  const socket = new WebSocket("wss://cr-watchparty-with-chatroom.onrender.com");

  socket.onopen = () => {
    console.log("Connected to Horai chat server");
    
    // Start heartbeat to keep Render connection alive
    if (g_heartbeatInterval) clearInterval(g_heartbeatInterval);
    g_heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 20000);

    // Re-join room if we had one (handles reconnects)
    const chatBox = document.getElementById("watch-chat");
    const username = chatBox?.dataset.username;
    if (username && currentRoom) {
      socket.send(JSON.stringify({ type: "join", room: currentRoom, username }));
    }
    // Drain queued messages
    while (g_messageQueue.length > 0) {
      socket.send(g_messageQueue.shift()!);
    }
  };

  socket.onclose = () => {
    if (g_heartbeatInterval) clearInterval(g_heartbeatInterval);
    console.log("Disconnected from chat server, reconnecting in 3s...");
    setTimeout(() => { ws = createWs(); attachWsHandlers(ws); }, 3000);
  };

  socket.onerror = (err) => {
    console.error("WebSocket error:", err);
  };

  return socket;
}

let ws = createWs();

// ---------------- State ---------------- //
const MESSAGE_FADE_SECONDS = 7;

// ---------------- UI Helpers ---------------- //

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function appendMessage(username: string | null, text: string, isSystem = false): void {
  const messages = document.getElementById("chat-messages");
  if (!messages) return;

  const div = document.createElement("div");
  if (isSystem) {
    div.className = "system-msg hudi-msg";
    div.textContent = text;
  } else {
    div.className = "chat-msg hudi-msg";
    if (username) {
      const nameSpan = document.createElement("span");
      nameSpan.className = "chat-username";
      nameSpan.textContent = username + ": ";
      div.appendChild(nameSpan);
    }
    div.appendChild(document.createTextNode(text));
  }

  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;

  // Individual Message Fade (Syncplay style)
  setTimeout(() => {
    div.classList.add("msg-fade-out");
    // Optionally remove from DOM after transition
    setTimeout(() => div.remove(), 1000);
  }, MESSAGE_FADE_SECONDS * 1000);
}

// ---------------- WebSocket Handlers ---------------- //

function attachWsHandlers(socket: WebSocket): void {
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "chat") {
      appendMessage(msg.username ?? null, msg.text);
    } else if (msg.type === "join" && msg.username) {
      appendMessage(null, `${msg.username} joined the chat`, true);
    } else if (msg.type === "leave" && msg.username) {
      appendMessage(null, `${msg.username} left the chat`, true);
    }
  };
}
attachWsHandlers(ws);

// ---------------- Video Sync & Port ---------------- //

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
  if (ignoreNext[action]) return;

  const { state, currentProgress, timeJump } = getStates();
  const type = MessageTypes.CS2SW_LOCAL_UPDATE;

  switch (action) {
    case Actions.PLAY:
    case Actions.PAUSE:
      try { g_port.postMessage({ type, state, currentProgress }); } catch(e) {}
      break;
    case Actions.TIME_UPDATE:
      if (timeJump) {
        try { g_port.postMessage({ type, state, currentProgress }); } catch(e) {}
      }
      break;
  }
};

function triggerAction(action: Actions, progress: number): void {
  if (!g_player) return;
  const player = g_player;
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
  }
}

function handleRemoteUpdate(message: Message): void {
  if (message.type !== MessageTypes.SW2CS_REMOTE_UPDATE) return;
  const { roomState, roomProgress } = message;
  if (!g_player) {
    setTimeout(() => handleRemoteUpdate(message), 500);
    return;
  }

  const { state, currentProgress } = getStates();

  if (Math.abs(roomProgress - currentProgress) > LIMIT_DELTA_TIME) {
    triggerAction(Actions.TIME_UPDATE, roomProgress);
  }

  if (state !== roomState) {
    if (roomState === States.PAUSED) triggerAction(Actions.PAUSE, roomProgress);
    if (roomState === States.PLAYING) triggerAction(Actions.PLAY, roomProgress);
  }
}

function handleServiceWorkerMessage(serviceWorkerMessage: Message) {
  switch (serviceWorkerMessage.type) {
    case MessageTypes.SW2CS_ROOM_CONNECTION:
      if (g_player) {
        const { state, currentProgress } = getStates();
        g_port.postMessage({ type: MessageTypes.CS2SW_ROOM_CONNECTION, state, currentProgress });
      } else {
        g_port.postMessage({ type: MessageTypes.CS2SW_ROOM_CONNECTION, state: States.PAUSED, currentProgress: 0 });
      }

      if (g_heartBeatInterval) clearInterval(g_heartBeatInterval);
      g_heartBeatInterval = setInterval(() => {
        try { g_port.postMessage({ type: MessageTypes.CS2SW_HEART_BEAT }); } catch (err) {}
      }, 20000);
      break;

    case MessageTypes.SW2CS_ROOM_DISCONNECT:
      if (g_heartBeatInterval) clearInterval(g_heartBeatInterval);
      break;

    case MessageTypes.SW2CS_REMOTE_UPDATE:
      handleRemoteUpdate(serviceWorkerMessage);
      break;
  }
}

// ---------------- Styles ---------------- //

const style = document.createElement("style");
style.textContent = `
#watch-chat {
  position: fixed;
  left: 20px;
  top: 20px;
  width: 400px;
  background: transparent;
  color: white;
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
  font-family: 'Roboto', sans-serif;
  pointer-events: none; /* Let clicks pass through to video unless focused */
}

#chat-messages {
  max-height: 400px;
  overflow: hidden;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hudi-msg {
  background: rgba(0, 0, 0, 0.4);
  padding: 4px 8px;
  border-radius: 4px;
  width: fit-content;
  text-shadow: 1px 1px 2px black;
  font-size: 15px;
  transition: opacity 1s ease;
  opacity: 1;
}

.msg-fade-out {
  opacity: 0;
}

.chat-msg { line-height: 1.4; word-wrap: break-word; }
.chat-username { color: #ff640a; font-weight: bold; }
.system-msg { color: #aaa; font-style: italic; font-size: 13px; }

#chat-input-area {
  padding: 10px;
  display: none;
  align-items: center;
  gap: 5px;
  pointer-events: all;
}

#chat-prompt {
  color: #ff640a;
  font-weight: bold;
  font-size: 18px;
  text-shadow: 1px 1px 2px black;
}

#chat-input {
  flex-grow: 1;
  background: transparent;
  border: none;
  color: white;
  padding: 6px 0;
  outline: none;
  font-size: 16px;
  text-shadow: 1px 1px 2px black;
  font-family: 'Roboto', sans-serif;
}

/* Username area still needs a bit of a box to be readable */
#username-area {
  background: rgba(15, 15, 15, 0.9);
  padding: 20px;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-radius: 8px;
  pointer-events: all;
}

#username-input-box {
  background: #222;
  border: 1px solid #444;
  color: white;
  padding: 8px;
  border-radius: 4px;
  outline: none;
}

#username-confirm-btn {
  background: #ff640a;
  color: white;
  border: none;
  padding: 8px;
  border-radius: 4px;
  cursor: pointer;
}

#chat-header { display: none; } /* No more header box */
`;

document.head.appendChild(style);

// ---------------- Chat Logic ---------------- //

function createChatBoxIfVideoExists(): void {
  if (!window.location.pathname.startsWith("/watch/")) return;
  if (document.getElementById("watch-chat")) return;

  const player = document.querySelector("video");
  if (!player) {
    setTimeout(createChatBoxIfVideoExists, 500);
    return;
  }

  const chatBox = document.createElement("div");
  chatBox.id = "watch-chat";
  chatBox.innerHTML = `
    <div id="username-area">
      <h3 style="margin:0;color:#ff640a">Roll Together</h3>
      <input id="username-input-box" placeholder="Enter username...">
      <button id="username-confirm-btn">Join Chat</button>
    </div>
    <div id="chat-messages"></div>
    <div id="chat-input-area">
      <span id="chat-prompt">_</span>
      <input id="chat-input" placeholder="Type here...">
    </div>
  `;

  document.body.appendChild(chatBox);
  setupChatInteractions(chatBox);
}

function setupChatInteractions(chatBox: HTMLElement) {
  const userArea = document.getElementById("username-area")!;
  const userInput = document.getElementById("username-input-box") as HTMLInputElement;
  const userConfirm = document.getElementById("username-confirm-btn")!;
  const inputArea = document.getElementById("chat-input-area")!;
  const chatInput = document.getElementById("chat-input") as HTMLInputElement;

  // Handle Username Join
  userConfirm.onclick = () => {
    const username = userInput.value.trim();
    if (!username) return;
    chatBox.dataset.username = username;
    userArea.style.display = "none";
    // We don't show inputArea yet — only when Enter is pressed
    
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "join", room: currentRoom, username }));
    }
  };

  userInput.addEventListener("keydown", (e) => e.stopPropagation());

  // Global Enter-to-Type Listener
  window.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      // If not logged in, don't do anything
      if (!chatBox.dataset.username) return;

      if (document.activeElement !== chatInput) {
        // Not focused -> Show input and Focus it
        e.preventDefault();
        e.stopImmediatePropagation();
        inputArea.style.display = "flex";
        chatInput.focus();
      } else {
        // Focused -> Send, Hide & Blur
        const text = chatInput.value.trim();
        if (text) {
          const username = chatBox.dataset.username;
          appendMessage(username!, text);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "chat", text, username }));
          } else {
            g_messageQueue.push(JSON.stringify({ type: "chat", text, username }));
          }
        }
        chatInput.value = "";
        inputArea.style.display = "none";
        chatInput.blur();
      }
    }
  }, true);

  // Fullscreen support: Move chatbox into the video container
  document.addEventListener("fullscreenchange", () => {
    const fsEl = document.fullscreenElement;
    if (fsEl) {
      fsEl.appendChild(chatBox);
    } else {
      document.body.appendChild(chatBox);
    }
  });
}

// ---------------- RUN ---------------- //

let g_playerListenersAttached = false;
function runContentScript(): void {
  if (!g_port.onMessage.hasListener(handleServiceWorkerMessage)) {
    g_port.onMessage.addListener(handleServiceWorkerMessage);
  }

  const player = document.querySelector("video") as HTMLVideoElement;
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

createChatBoxIfVideoExists();
runContentScript();
