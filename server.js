import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

// Store game rooms: roomId -> { players: [ws1, ws2], gameState: {...}, roomCode: string }
const rooms = new Map();

// Store player connections: ws -> { playerId, roomId, playerSymbol }
const players = new Map();

// Store disconnected players: playerId -> { roomId, playerSymbol, disconnectedAt }
const disconnectedPlayers = new Map();

// Reconnection timeout (5 minutes)
const RECONNECTION_TIMEOUT = 5 * 60 * 1000;

// Room cleanup timeouts
const INCOMPLETE_ROOM_TIMEOUT = 10 * 60 * 1000; // 10 minutes for rooms with only 1 player
const STALE_ROOM_TIMEOUT = 60 * 60 * 1000; // 1 hour for inactive complete rooms
const CLEANUP_INTERVAL = 5 * 60 * 1000; // Run cleanup every 5 minutes

// Track room timeouts
const roomTimeouts = new Map();

console.log(`WebSocket server started on port ${PORT}`);

// Periodic cleanup of stale rooms
setInterval(() => {
    cleanupStaleRooms();
}, CLEANUP_INTERVAL);

wss.on('connection', (ws) => {
    console.log('New client connected');

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            handleMessage(ws, message);
        } catch (error) {
            console.error('Error parsing message:', error);
            sendError(ws, 'Invalid message format');
        }
    });

    ws.on('close', () => {
        handleDisconnect(ws);
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

function handleMessage(ws, message) {
    const { type, payload } = message;

    switch (type) {
        case 'CREATE_ROOM':
            handleCreateRoom(ws, payload);
            break;
        case 'JOIN_ROOM':
            handleJoinRoom(ws, payload);
            break;
        case 'RECONNECT':
            handleReconnect(ws, payload);
            break;
        case 'MAKE_MOVE':
            handleMakeMove(ws, payload);
            break;
        case 'RESTART_GAME':
            handleRestartGame(ws, payload);
            break;
        case 'LEAVE_ROOM':
            handleLeaveRoom(ws);
            break;
        case 'CHECK_ROOM':
            handleCheckRoom(ws, payload);
            break;
        default:
            sendError(ws, `Unknown message type: ${type}`);
    }
}

function handleCheckRoom(ws, payload) {
    const { roomCode, playerId } = payload;

    if (!roomCode || !playerId) {
        sendError(ws, 'Missing roomCode or playerId');
        return;
    }

    // Find room by code
    const room = Array.from(rooms.values()).find(r => r.code === roomCode);

    if (!room) {
        send(ws, {
            type: 'ROOM_CHECK_RESULT',
            payload: { exists: false },
        });
        return;
    }

    // Check if player was in this room
    const wasInRoom = room.playerIds.includes(playerId);
    const hasOpponent = room.players.some(p => p !== null && players.get(p)?.playerId !== playerId);

    send(ws, {
        type: 'ROOM_CHECK_RESULT',
        payload: {
            exists: true,
            wasInRoom,
            hasOpponent,
            canReconnect: wasInRoom && hasOpponent,
        },
    });
} function handleCreateRoom(ws, payload) {
    const roomCode = generateRoomCode();
    const roomId = uuidv4();
    const playerId = uuidv4();

    const room = {
        id: roomId,
        code: roomCode,
        players: [ws],
        playerIds: [playerId],
        playerSymbols: { [playerId]: 'x' },
        gameState: createInitialGameState(),
        currentTurn: 'x',
        activeBoard: -1,
        createdAt: Date.now(),
        lastActivity: Date.now(),
    };

    rooms.set(roomId, room);
    players.set(ws, { playerId, roomId, playerSymbol: 'x' });

    // Set timeout to clean up room if second player never joins
    const timeoutId = setTimeout(() => {
        const r = rooms.get(roomId);
        if (r && r.players.filter(p => p !== null).length === 1) {
            // Notify the waiting player
            r.players.forEach(playerWs => {
                if (playerWs) {
                    send(playerWs, {
                        type: 'ROOM_TIMEOUT',
                        payload: { message: 'Room closed due to inactivity' },
                    });
                }
            });
            rooms.delete(roomId);
            roomTimeouts.delete(roomId);
            console.log(`Room ${roomCode} timed out - no second player joined`);
        }
    }, INCOMPLETE_ROOM_TIMEOUT);

    roomTimeouts.set(roomId, timeoutId);

    send(ws, {
        type: 'ROOM_CREATED',
        payload: {
            roomCode,
            roomId,
            playerId,
            playerSymbol: 'x',
        },
    });

    console.log(`Room created: ${roomCode} (${roomId})`);
}

function handleJoinRoom(ws, payload) {
    const { roomCode } = payload;

    // Find room by code
    const room = Array.from(rooms.values()).find(r => r.code === roomCode);

    if (!room) {
        sendError(ws, 'Room not found');
        return;
    }

    // Count active players (non-null slots)
    const activePlayers = room.players.filter(p => p !== null).length;

    if (activePlayers >= 2) {
        sendError(ws, 'Room is full');
        return;
    }

    const playerId = uuidv4();

    // If there's a null slot (disconnected player), replace it
    const disconnectedIndex = room.players.indexOf(null);
    if (disconnectedIndex !== -1) {
        room.players[disconnectedIndex] = ws;
        room.playerIds[disconnectedIndex] = playerId;
        room.playerSymbols[playerId] = disconnectedIndex === 0 ? 'x' : 'o';
        players.set(ws, { playerId, roomId: room.id, playerSymbol: room.playerSymbols[playerId] });
    } else {
        // Normal join - add as second player
        room.players.push(ws);
        room.playerIds.push(playerId);
        room.playerSymbols[playerId] = 'o';
        players.set(ws, { playerId, roomId: room.id, playerSymbol: 'o' });
    }

    room.lastActivity = Date.now();

    // Clear the incomplete room timeout since game is now full
    const timeoutId = roomTimeouts.get(room.id);
    if (timeoutId) {
        clearTimeout(timeoutId);
        roomTimeouts.delete(room.id);
    }

    // Notify both players that game can start
    send(ws, {
        type: 'ROOM_JOINED',
        payload: {
            roomId: room.id,
            roomCode: room.code,
            playerId,
            playerSymbol: 'o',
            gameState: room.gameState,
            currentTurn: room.currentTurn,
            activeBoard: room.activeBoard,
        },
    });

    // Notify the room creator
    send(room.players[0], {
        type: 'OPPONENT_JOINED',
        payload: {
            message: 'Opponent has joined!',
        },
    });

    console.log(`Player joined room: ${roomCode}`);
}

function handleReconnect(ws, payload) {
    const { playerId, roomCode } = payload;

    if (!playerId || !roomCode) {
        sendError(ws, 'Missing playerId or roomCode for reconnection');
        return;
    }

    // Check if player has a disconnection record
    const disconnectInfo = disconnectedPlayers.get(playerId);
    if (!disconnectInfo) {
        sendError(ws, 'No disconnection record found. Please create or join a new room.');
        return;
    }

    const room = rooms.get(disconnectInfo.roomId);
    if (!room || room.code !== roomCode) {
        disconnectedPlayers.delete(playerId);
        sendError(ws, 'Room no longer exists. Please create or join a new room.');
        return;
    }

    // Restore player connection
    const playerIndex = room.playerIds.indexOf(playerId);
    if (playerIndex === -1) {
        sendError(ws, 'Player not found in room');
        return;
    }

    room.players[playerIndex] = ws;
    players.set(ws, {
        playerId,
        roomId: disconnectInfo.roomId,
        playerSymbol: disconnectInfo.playerSymbol,
    });

    // Remove from disconnected list
    disconnectedPlayers.delete(playerId);

    // Send current game state to reconnected player
    send(ws, {
        type: 'RECONNECTED',
        payload: {
            roomId: room.id,
            roomCode: room.code,
            playerId,
            playerSymbol: disconnectInfo.playerSymbol,
            gameState: room.gameState,
            currentTurn: room.currentTurn,
            activeBoard: room.activeBoard,
        },
    });

    // Notify other players about reconnection
    room.players.forEach((playerWs) => {
        if (playerWs && playerWs !== ws) {
            send(playerWs, {
                type: 'PLAYER_RECONNECTED',
                payload: { message: 'Your opponent has reconnected!' },
            });
        }
    });

    console.log(`Player ${playerId} reconnected to room ${roomCode}`);
}

function handleMakeMove(ws, payload) {
    const playerInfo = players.get(ws);
    if (!playerInfo) {
        sendError(ws, 'Player not in a room');
        return;
    }

    const room = rooms.get(playerInfo.roomId);
    if (!room) {
        sendError(ws, 'Room not found');
        return;
    }

    const { boardIndex, cellIndex } = payload;
    const { playerId, playerSymbol } = playerInfo;

    // Validate turn
    if (room.currentTurn !== playerSymbol) {
        sendError(ws, 'Not your turn');
        return;
    }

    // Update game state on server
    room.gameState.smallBoards[boardIndex].cells[cellIndex] = playerSymbol;

    // Update game state
    const move = {
        playedBy: playerSymbol,
        boardIndex,
        cellIndex,
        playerId,
    };

    // Broadcast move to all players in room
    room.players.forEach((playerWs) => {
        send(playerWs, {
            type: 'MOVE_MADE',
            payload: move,
        });
    });

    // Toggle turn
    room.currentTurn = room.currentTurn === 'x' ? 'o' : 'x';
    room.lastActivity = Date.now();

    // Update active board
    if (cellIndex >= 0 && cellIndex < 9) {
        // Check if the target board is already won
        const targetBoardStatus = room.gameState.bigBoard[cellIndex];
        if (targetBoardStatus === '') {
            room.activeBoard = cellIndex;
        } else {
            room.activeBoard = -1;
        }
    } else {
        room.activeBoard = -1;
    }

    console.log(`Move made in room ${room.code}: board ${boardIndex}, cell ${cellIndex}`);
}

function handleRestartGame(ws, payload) {
    const playerInfo = players.get(ws);
    if (!playerInfo) {
        sendError(ws, 'Player not in a room');
        return;
    }

    const room = rooms.get(playerInfo.roomId);
    if (!room) {
        sendError(ws, 'Room not found');
        return;
    }

    // Prevent rapid restart requests (debounce)
    const now = Date.now();
    if (room.lastRestart && (now - room.lastRestart) < 1000) {
        console.log(`Ignoring rapid restart request in room ${room.code}`);
        return;
    }
    room.lastRestart = now;

    // Initialize restart approval tracking
    if (!room.restartApprovals) {
        room.restartApprovals = new Set();
    }

    // Add this player's approval
    room.restartApprovals.add(playerInfo.playerId);

    const activePlayers = room.players.filter(p => p !== null).length;

    // If both players approved (or only one player in room), restart
    if (room.restartApprovals.size >= activePlayers) {
        // Reset game state
        room.gameState = createInitialGameState();
        room.currentTurn = 'x';
        room.activeBoard = -1;
        room.lastActivity = Date.now();
        room.restartApprovals.clear();

        // Notify all active players (skip null)
        room.players.forEach((playerWs) => {
            if (playerWs !== null) {
                send(playerWs, {
                    type: 'GAME_RESTARTED',
                    payload: {
                        gameState: room.gameState,
                        currentTurn: room.currentTurn,
                        activeBoard: room.activeBoard,
                    },
                });
            }
        });

        console.log(`Game restarted in room ${room.code}`);
    } else {
        // Notify other players that this player wants to restart
        room.players.forEach((playerWs) => {
            if (playerWs !== null && playerWs !== ws) {
                send(playerWs, {
                    type: 'RESTART_REQUESTED',
                    payload: {
                        message: 'Opponent wants to restart',
                    },
                });
            }
        });
        console.log(`Restart requested in room ${room.code} (${room.restartApprovals.size}/${activePlayers})`);
    }
}

function handleLeaveRoom(ws) {
    const playerInfo = players.get(ws);
    if (!playerInfo) return;

    const room = rooms.get(playerInfo.roomId);
    if (room) {
        // Remove from disconnected players if present
        disconnectedPlayers.delete(playerInfo.playerId);

        // Clear restart approvals
        if (room.restartApprovals) {
            room.restartApprovals.delete(playerInfo.playerId);
        }

        // Notify other players
        room.players.forEach((playerWs) => {
            if (playerWs && playerWs !== ws) {
                send(playerWs, {
                    type: 'OPPONENT_LEFT',
                    payload: { message: 'Opponent has left the game' },
                });
            }
        });

        // Remove room completely when player explicitly leaves
        rooms.delete(playerInfo.roomId);

        // Clear any pending timeout
        const timeoutId = roomTimeouts.get(playerInfo.roomId);
        if (timeoutId) {
            clearTimeout(timeoutId);
            roomTimeouts.delete(playerInfo.roomId);
        }

        console.log(`Room ${room.code} closed - player left`);
    }

    players.delete(ws);
} function handleDisconnect(ws) {
    console.log('Client disconnected');

    const playerInfo = players.get(ws);
    if (!playerInfo) return;

    const room = rooms.get(playerInfo.roomId);
    if (!room) {
        players.delete(ws);
        return;
    }

    // Store disconnection info for potential reconnection
    disconnectedPlayers.set(playerInfo.playerId, {
        roomId: playerInfo.roomId,
        playerSymbol: playerInfo.playerSymbol,
        disconnectedAt: Date.now(),
    });

    // Remove WebSocket from room but keep room alive
    const playerIndex = room.players.indexOf(ws);
    if (playerIndex !== -1) {
        room.players[playerIndex] = null; // Mark as disconnected
    }

    // Notify other players about disconnection
    room.players.forEach((playerWs) => {
        if (playerWs && playerWs !== ws) {
            send(playerWs, {
                type: 'PLAYER_DISCONNECTED',
                payload: {
                    message: 'Your opponent has disconnected',
                    canReconnect: true,
                },
            });
        }
    });

    players.delete(ws);

    // Set timeout to close room if player doesn't reconnect
    setTimeout(() => {
        const disconnectInfo = disconnectedPlayers.get(playerInfo.playerId);
        if (disconnectInfo) {
            // Player didn't reconnect, close the room
            const room = rooms.get(disconnectInfo.roomId);
            if (room) {
                // Check if all players are disconnected or left
                const hasActivePlayer = room.players.some(p => p !== null);
                if (!hasActivePlayer) {
                    rooms.delete(disconnectInfo.roomId);

                    // Clear any pending timeout
                    const timeoutId = roomTimeouts.get(disconnectInfo.roomId);
                    if (timeoutId) {
                        clearTimeout(timeoutId);
                        roomTimeouts.delete(disconnectInfo.roomId);
                    }

                    console.log(`Room ${room.code} closed due to all players disconnecting`);
                }
            }
            disconnectedPlayers.delete(playerInfo.playerId);
        }
    }, RECONNECTION_TIMEOUT);

    console.log(`Player ${playerInfo.playerId} disconnected, can reconnect within ${RECONNECTION_TIMEOUT / 1000}s`);
} function cleanupStaleRooms() {
    const now = Date.now();
    let cleanedCount = 0;

    rooms.forEach((room, roomId) => {
        const activePlayerCount = room.players.filter(p => p !== null).length;

        // Clean up incomplete rooms (1 player waiting too long)
        if (activePlayerCount === 1 && (now - room.createdAt) > INCOMPLETE_ROOM_TIMEOUT) {
            // Notify the waiting player
            room.players.forEach(playerWs => {
                if (playerWs) {
                    send(playerWs, {
                        type: 'ROOM_TIMEOUT',
                        payload: { message: 'Room closed due to inactivity' },
                    });
                }
            });

            rooms.delete(roomId);
            const timeoutId = roomTimeouts.get(roomId);
            if (timeoutId) {
                clearTimeout(timeoutId);
                roomTimeouts.delete(roomId);
            }
            cleanedCount++;
            console.log(`Cleaned up incomplete room ${room.code}`);
        }
        // Clean up stale complete rooms (no activity for too long)
        else if (activePlayerCount === 2 && (now - room.lastActivity) > STALE_ROOM_TIMEOUT) {
            // Notify players
            room.players.forEach(playerWs => {
                if (playerWs) {
                    send(playerWs, {
                        type: 'ROOM_TIMEOUT',
                        payload: { message: 'Room closed due to inactivity' },
                    });
                }
            });

            rooms.delete(roomId);
            cleanedCount++;
            console.log(`Cleaned up stale room ${room.code}`);
        }
        // Clean up rooms with no active players at all
        else if (activePlayerCount === 0) {
            rooms.delete(roomId);
            const timeoutId = roomTimeouts.get(roomId);
            if (timeoutId) {
                clearTimeout(timeoutId);
                roomTimeouts.delete(roomId);
            }
            cleanedCount++;
            console.log(`Cleaned up empty room ${room.code}`);
        }
    });

    // Clean up orphaned disconnected players
    disconnectedPlayers.forEach((info, playerId) => {
        if ((now - info.disconnectedAt) > RECONNECTION_TIMEOUT) {
            disconnectedPlayers.delete(playerId);
        }
    });

    if (cleanedCount > 0) {
        console.log(`Cleanup: Removed ${cleanedCount} stale rooms. Active rooms: ${rooms.size}, Disconnected players: ${disconnectedPlayers.size}`);
    }
}

function createInitialGameState() {
    return {
        bigBoard: ['', '', '', '', '', '', '', '', ''],
        smallBoards: Array(9).fill(null).map(() => ({
            cells: ['', '', '', '', '', '', '', '', ''],
            winner: '',
            isGameOver: false,
        })),
    };
}

function generateRoomCode() {
    // Generate a 6-character room code
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function send(ws, message) {
    if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(JSON.stringify(message));
    }
}

function sendError(ws, error) {
    send(ws, {
        type: 'ERROR',
        payload: { error },
    });
}
