const WebSocket = require("ws");

const wss = new WebSocket.Server({ port: 3000 });

const rooms = {};

wss.on("connection", (ws) => {
  let currentRoom = null;
  let currentUsername = null;

  ws.on("message", (data) => {
    const msg = JSON.parse(data);

    if (msg.type === "join") {
      currentRoom = msg.room;
      currentUsername = msg.username;

      if (!rooms[currentRoom]) {
        rooms[currentRoom] = [];
      }

      rooms[currentRoom].push(ws);

      // Broadcast join notification to everyone EXCEPT the sender
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
      if (!rooms[currentRoom]) return;

      // Broadcast to everyone EXCEPT the sender, and forward username + sessionId
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
    }
  });

  ws.on("close", () => {
    if (!currentRoom) return;

    // Broadcast leave notification to everyone remaining
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

    rooms[currentRoom] = rooms[currentRoom].filter(c => c !== ws);
  });
});

console.log("Horai Chat server running on port 3000");