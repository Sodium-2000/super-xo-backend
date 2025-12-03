# Super XO - WebSocket Backend Server

WebSocket server for Super XO (Ultimate Tic-Tac-Toe) online multiplayer game.

## Features

- 🎮 Real-time multiplayer gameplay
- 🔄 Automatic reconnection support (5-minute window)
- 🧹 Automatic cleanup of stale/inactive rooms
- 📊 Room-based game sessions with unique 6-character codes
- 🔐 Player identification and session management
- ⚡ Lightweight and efficient (handles 600-700+ concurrent players on 512MB RAM)

## Setup

1. Install Node.js (v18 or higher)
2. Install dependencies:
   ```bash
   npm install
   ```

## Running the Server

### Development (with auto-reload):
```bash
npm run dev
```

### Production:
```bash
npm start
```

The server will start on port 8080 by default. You can change this by setting the `PORT` environment variable.

## Architecture & Memory Management

### Automatic Cleanup
- **Incomplete rooms**: Auto-cleaned after 10 minutes (1 player waiting)
- **Stale rooms**: Auto-cleaned after 1 hour of inactivity
- **Empty rooms**: Immediately cleaned when detected
- **Cleanup interval**: Runs every 5 minutes
- **Disconnected players**: 5-minute reconnection window

### Capacity Estimates
**0.5 CPU / 512 MB RAM:**
- ~300-350 concurrent games
- ~600-700 concurrent players

**1 CPU / 2 GB RAM:**
- ~1,200-1,500 concurrent games
- ~2,400-3,000 concurrent players

## WebSocket Protocol

### Client -> Server Messages

#### Create Room
```json
{
  "type": "CREATE_ROOM",
  "payload": {}
}
```

#### Join Room
```json
{
  "type": "JOIN_ROOM",
  "payload": {
    "roomCode": "ABC123"
  }
}
```

#### Make Move
```json
{
  "type": "MAKE_MOVE",
  "payload": {
    "boardIndex": 0,
    "cellIndex": 4
  }
}
```

#### Restart Game
```json
{
  "type": "RESTART_GAME",
  "payload": {}
}
```

#### Leave Room
```json
{
  "type": "LEAVE_ROOM",
  "payload": {}
}
```

#### Reconnect (after disconnection)
```json
{
  "type": "RECONNECT",
  "payload": {
    "playerId": "uuid",
    "roomCode": "ABC123"
  }
}
```

### Server -> Client Messages

#### Room Created
```json
{
  "type": "ROOM_CREATED",
  "payload": {
    "roomCode": "ABC123",
    "roomId": "uuid",
    "playerId": "uuid",
    "playerSymbol": "x"
  }
}
```

#### Room Joined
```json
{
  "type": "ROOM_JOINED",
  "payload": {
    "roomId": "uuid",
    "roomCode": "ABC123",
    "playerId": "uuid",
    "playerSymbol": "o",
    "gameState": {...},
    "currentTurn": "x",
    "activeBoard": -1
  }
}
```

#### Opponent Joined
```json
{
  "type": "OPPONENT_JOINED",
  "payload": {
    "message": "Opponent has joined!"
  }
}
```

#### Move Made
```json
{
  "type": "MOVE_MADE",
  "payload": {
    "playedBy": "x",
    "boardIndex": 0,
    "cellIndex": 4,
    "playerId": "uuid"
  }
}
```

#### Game Restarted
```json
{
  "type": "GAME_RESTARTED",
  "payload": {
    "gameState": {...},
    "currentTurn": "x",
    "activeBoard": -1
  }
}
```

#### Opponent Left
```json
{
  "type": "OPPONENT_LEFT",
  "payload": {
    "message": "Opponent has left the game"
  }
}
```

#### Player Disconnected
```json
{
  "type": "PLAYER_DISCONNECTED",
  "payload": {
    "message": "Your opponent has disconnected",
    "canReconnect": true
  }
}
```

#### Player Reconnected
```json
{
  "type": "PLAYER_RECONNECTED",
  "payload": {
    "message": "Your opponent has reconnected!"
  }
}
```

#### Reconnected (confirmation)
```json
{
  "type": "RECONNECTED",
  "payload": {
    "roomId": "uuid",
    "roomCode": "ABC123",
    "playerId": "uuid",
    "playerSymbol": "x",
    "gameState": {...},
    "currentTurn": "x",
    "activeBoard": -1
  }
}
```

#### Room Timeout
```json
{
  "type": "ROOM_TIMEOUT",
  "payload": {
    "message": "Room closed due to inactivity"
  }
}
```

#### Error
```json
{
  "type": "ERROR",
  "payload": {
    "error": "Error message"
  }
}
```

## Deployment

### Render.com
1. Create a new Web Service
2. Connect your repository
3. Build command: `npm install`
4. Start command: `npm start`

### Heroku
```bash
heroku create your-app-name
git push heroku main
```

### Docker
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 8080
CMD ["npm", "start"]
```

## License

ISC
