const WebSocket = require("ws");

const wss = new WebSocket.Server({ port: 3000 });

const rooms = {};

wss.on("connection", (ws) => {
  let currentRoom = null;
  let currentUsername = null;

  ws.on("message", (data) => {
    const msg = JSON.parse(data);

    if (msg.type === "join") {
      // If already in a room, remove from it first
      if (currentRoom && rooms[currentRoom]) {
        rooms[currentRoom] = rooms[currentRoom].filter(c => c !== ws);
      }

      currentRoom = msg.room;
      currentUsername = msg.username || null;

      if (!rooms[currentRoom]) {
        rooms[currentRoom] = [];
      }

      // Add to room only if not already present
      if (!rooms[currentRoom].includes(ws)) {
        rooms[currentRoom].push(ws);
      }

      // Only broadcast join notification if they actually have a username
      if (msg.username) {
        rooms[currentRoom].forEach(client => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: "join",
              username: msg.username
            }));
          }
        });
      }

      return;
    }

    if (msg.type === "chat") {
      if (!currentRoom || !rooms[currentRoom]) return;

      rooms[currentRoom].forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: "chat",
            text: msg.text,
            username: msg.username,
            sessionId: msg.sessionId
          }));
        }
      });

      return;
    }

    // FIX: Broadcast video play/pause/seek actions with the username who triggered it
    if (msg.type === "video_action") {
      if (!currentRoom || !rooms[currentRoom]) return;

      rooms[currentRoom].forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: "video_action",
            action: msg.action,
            progress: msg.progress,
            username: msg.username
          }));
        }
      });

      return;
    }
  });

  ws.on("close", () => {
    if (!currentRoom) return;

    if (currentUsername && rooms[currentRoom]) {
      rooms[currentRoom].forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: "leave",
            username: currentUsername
          }));
        }
      });
    }

    if (rooms[currentRoom]) {
      rooms[currentRoom] = rooms[currentRoom].filter(c => c !== ws);
    }
  });
});

console.log("Horai Chat server running on port 3000");