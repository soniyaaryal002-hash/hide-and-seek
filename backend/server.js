const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3001);

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

const rooms = new Map();
const teamOrder = ['Red', 'Blue', 'Green', 'Yellow'];
const MAX_PLAYERS_PER_ROOM = 20;

function normalizeTeam(teamName) {
    const value = String(teamName || '').trim();
    if (!value) return 'Unassigned';

    const match = teamOrder.find((team) => team.toLowerCase() === value.toLowerCase());
    return match || 'Unassigned';
}

function ensureRoomTimer(room) {
    if (room.timerInterval) return;

    room.timerInterval = setInterval(() => {
        if (!room.started) return;

        if (room.gameState.timerSeconds > 0) {
            room.gameState.timerSeconds -= 1;
            broadcastRoom(room.roomCode);
            return;
        }

        room.started = false;
        room.gameState.phase = 'Finished';
        broadcastRoom(room.roomCode);
        clearInterval(room.timerInterval);
        room.timerInterval = null;
    }, 1000);
}

function setCaptainForTeam(room, teamName, captainPlayerId) {
    [...room.players.values()].forEach((player) => {
        if (player.team === teamName) {
            player.captain = player.id === captainPlayerId;
        }
    });
}

function createRoom(roomCode) {
    const room = {
        roomCode,
        players: new Map(),
        started: false,
        clues: [],
        gameState: {
            timerSeconds: 90 * 60,
            phase: 'Scatter',
            seekerTeam: 'Red',
            allowedTeams: teamOrder
        }
    };

    rooms.set(roomCode, room);
    return room;
}

function getRoom(roomCode) {
    return rooms.get(roomCode) || createRoom(roomCode);
}

function serializePlayers(room) {
    return [...room.players.values()].map((player) => ({
        id: player.id,
        name: player.name,
        team: player.team || 'Unassigned',
        role: player.role || 'Hider',
        captain: Boolean(player.captain),
        location: player.location || null,
        connectedAt: player.connectedAt
    }));
}

function assignTeam(room) {
    for (const teamName of teamOrder) {
        const used = [...room.players.values()].some((player) => player.team === teamName);
        if (!used) return teamName;
    }

    return teamOrder[0];
}

function broadcastRoom(roomCode) {
    const room = getRoom(roomCode);

    io.to(roomCode).emit('room:update', {
        roomCode,
        started: room.started,
        players: serializePlayers(room),
        gameState: room.gameState,
        clues: room.clues
    });
}

io.on('connection', (socket) => {
    socket.on('join-room', ({ roomCode, name, team, captain }) => {
        const code = String(roomCode || 'SONIYA').trim().toUpperCase();
        const playerName = String(name || 'Player').trim() || 'Player';
        const room = getRoom(code);

        const existingPlayer = room.players.get(socket.id);
        if (existingPlayer) {
            room.players.delete(socket.id);
        }

        if (room.players.size >= MAX_PLAYERS_PER_ROOM && !existingPlayer) {
            socket.emit('room:full', {
                roomCode: code,
                maxPlayers: MAX_PLAYERS_PER_ROOM,
                message: 'This room is full. You can move teams only for players already in the room.'
            });
            return;
        }

        socket.join(code);
        socket.data.roomCode = code;
        socket.data.name = playerName;

        const requestedTeam = normalizeTeam(team || assignTeam(room));
        const teamPlayers = [...room.players.values()].filter((player) => normalizeTeam(player.team) === requestedTeam);
        const captainRequested = Boolean(captain);
        const isCaptain = captainRequested || teamPlayers.length === 0;

        room.players.set(socket.id, {
            id: socket.id,
            name: playerName,
            team: requestedTeam,
            captain: isCaptain,
            role: room.started ? (room.gameState.seekerTeam === requestedTeam ? 'Seeker' : 'Hider') : 'Hider',
            location: null,
            connectedAt: Date.now()
        });

        if (isCaptain) {
            setCaptainForTeam(room, requestedTeam, socket.id);
        }

        broadcastRoom(code);
    });

    socket.on('set-role', ({ role }) => {
        const roomCode = socket.data.roomCode;
        if (!roomCode) return;

        const room = getRoom(roomCode);
        const player = room.players.get(socket.id);
        if (!player) return;

        player.role = role === 'Seeker' ? 'Seeker' : 'Hider';
        broadcastRoom(roomCode);
    });

    socket.on('player:assign', ({ roomCode, playerId, team, captain }) => {
        const code = String(roomCode || socket.data.roomCode || 'SONIYA').trim().toUpperCase();
        const room = getRoom(code);
        const player = room.players.get(playerId || socket.id);
        if (!player) return;

        const nextTeam = normalizeTeam(team || player.team || assignTeam(room));
        player.team = nextTeam;
        player.role = room.started ? (room.gameState.seekerTeam === nextTeam ? 'Seeker' : 'Hider') : 'Hider';

        if (captain === true) {
            setCaptainForTeam(room, nextTeam, player.id);
        } else if (captain === false) {
            player.captain = false;
        } else if (!player.captain) {
            const hasCaptain = [...room.players.values()].some((entry) => entry.team === nextTeam && entry.captain && entry.id !== player.id);
            if (!hasCaptain) {
                player.captain = true;
            }
        }

        broadcastRoom(code);
    });

    socket.on('location:update', ({ lat, lng, accuracy }) => {
        const roomCode = socket.data.roomCode;
        if (!roomCode) return;

        const room = getRoom(roomCode);
        const player = room.players.get(socket.id);
        if (!player) return;

        player.location = {
            lat,
            lng,
            accuracy,
            updatedAt: Date.now()
        };

        broadcastRoom(roomCode);
    });

    socket.on('start-game', ({ roomCode, seekerTeam }) => {
        const code = String(roomCode || socket.data.roomCode || 'SONIYA').trim().toUpperCase();
        const room = getRoom(code);

        room.started = true;
        room.gameState.phase = 'Scatter';
        room.gameState.timerSeconds = 90 * 60;
        room.gameState.seekerTeam = seekerTeam || 'Red';

        [...room.players.values()].forEach((player) => {
            player.role = room.gameState.seekerTeam === player.team ? 'Seeker' : 'Hider';
        });

        ensureRoomTimer(room);
        broadcastRoom(code);
    });

    socket.on('trigger-ping', ({ roomCode }) => {
        const code = String(roomCode || socket.data.roomCode || 'SONIYA').trim().toUpperCase();
        const room = getRoom(code);

        room.gameState.phase = room.gameState.phase === 'Scatter' ? '0–15' : 'Ping';

        io.to(code).emit('ping:triggered', {
            roomCode: code,
            phase: room.gameState.phase,
            timestamp: Date.now()
        });

        broadcastRoom(code);
    });

    socket.on('player:found', ({ roomCode, playerId }) => {
        const code = String(roomCode || socket.data.roomCode || 'SONIYA').trim().toUpperCase();
        const room = getRoom(code);

        const player = room.players.get(playerId) || [...room.players.values()].find((entry) => entry.name === playerId);
        if (!player) return;

        player.role = 'Seeker';
        room.gameState.seekerTeam = player.team || room.gameState.seekerTeam;
        broadcastRoom(code);
    });

    socket.on('photo:drop', ({ roomCode, team, captain, image, caption }) => {
        const code = String(roomCode || socket.data.roomCode || 'SONIYA').trim().toUpperCase();
        const room = getRoom(code);

        if (!image) return;

        room.clues.unshift({
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            team: team || 'Red',
            caption: caption || 'Photo clue dropped',
            captain: captain || 'Captain',
            image,
            createdAt: Date.now()
        });

        io.to(code).emit('photo:drop', room.clues[0]);
        broadcastRoom(code);
    });

    socket.on('disconnect', () => {
        const roomCode = socket.data.roomCode;
        if (!roomCode) return;

        const room = rooms.get(roomCode);
        if (!room) return;

        room.players.delete(socket.id);

        if (room.players.size === 0) {
            if (room.timerInterval) {
                clearInterval(room.timerInterval);
            }
            rooms.delete(roomCode);
            return;
        }

        broadcastRoom(roomCode);
    });
});

app.get('/health', (req, res) => {
    res.json({ ok: true, rooms: rooms.size, service: 'soniyas-hide-and-seek-backend' });
});

server.listen(PORT, () => {
    console.log(`Hide & Seek backend running on http://localhost:${PORT}`);
});