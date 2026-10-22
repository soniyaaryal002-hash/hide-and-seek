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
const DEFAULT_ZONE = {
    center: null,
    radius: 600,
    roundSeconds: 45 * 60
};

function normalizeZoneCenter(center) {
    if (!center || center.lat === undefined || center.lng === undefined) {
        return null;
    }

    const lat = Number(center.lat);
    const lng = Number(center.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return null;
    }

    return { lat, lng };
}

function resetZoneState(zone) {
    const nextCenter = zone && zone.center ? normalizeZoneCenter(zone.center) : null;
    return {
        center: nextCenter,
        radius: 600,
        roundSeconds: DEFAULT_ZONE.roundSeconds
    };
}

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
        room.gameState.started = false;
        room.gameState.phase = 'Finished';
        room.clues = [];
        room.zone = resetZoneState(room.zone);
        room.gameState.timerSeconds = 45 * 60;
        broadcastRoom(room.roomCode);
        clearInterval(room.timerInterval);
        room.timerInterval = null;
    }, 1000);
}

function createRoom(roomCode) {
    const room = {
        roomCode,
        players: new Map(),
        started: false,
        clues: [],
        zone: resetZoneState(DEFAULT_ZONE),
        gameState: {
            started: false,
            timerSeconds: 45 * 60,
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
        location: player.location || null,
        connectedAt: player.connectedAt
    }));
}

function assignTeam(room) {
    const teamCounts = teamOrder.map((teamName) => ({
        team: teamName,
        count: [...room.players.values()].filter((player) => player.team === teamName).length
    }));

    const leastFull = teamCounts.sort((a, b) => a.count - b.count)[0];
    return leastFull ? leastFull.team : teamOrder[0];
}

function reconcileRoomRoles(room) {
    if (!room || !room.players) return;

    const seekerTeam = normalizeTeam(room.gameState && room.gameState.seekerTeam);

    room.players.forEach((player) => {
        if (!room.started) {
            player.role = 'Hider';
            return;
        }

        player.role = player.team === seekerTeam ? 'Seeker' : 'Hider';
    });
}

function broadcastRoom(roomCode) {
    const room = getRoom(roomCode);

    io.to(roomCode).emit('room:update', {
        roomCode,
        started: room.started,
        players: serializePlayers(room),
        gameState: room.gameState,
        clues: room.clues,
        zone: room.zone
    });
}

io.on('connection', (socket) => {
    socket.on('join-room', ({ roomCode, name, team }) => {
        const code = String(roomCode || socket.data.roomCode || 'SONIYA').trim().toUpperCase() || 'SONIYA';
        const playerName = String(name || 'Player').trim() || 'Player';
        const room = getRoom(code);
        const isFreshRoom = room.players.size === 0 && !room.started && !room.zone.center && room.gameState.timerSeconds === 45 * 60;

        if (!room.started && isFreshRoom) {
            if (room.timerInterval) {
                clearInterval(room.timerInterval);
                room.timerInterval = null;
            }

            room.started = false;
            room.gameState.started = false;
            room.gameState.phase = 'Scatter';
            room.gameState.timerSeconds = 45 * 60;
            room.clues = [];
            room.zone = resetZoneState({ center: null });
        }

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

        room.players.set(socket.id, {
            id: socket.id,
            name: playerName,
            team: requestedTeam,
            role: 'Hider',
            location: null,
            connectedAt: Date.now()
        });

        reconcileRoomRoles(room);
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

    socket.on('player:assign', ({ roomCode, playerId, team }) => {
        const code = String(roomCode || socket.data.roomCode || 'SONIYA').trim().toUpperCase();
        const room = getRoom(code);
        const player = room.players.get(playerId || socket.id);
        if (!player) return;

        const nextTeam = normalizeTeam(team || player.team || assignTeam(room));
        player.team = nextTeam;

        reconcileRoomRoles(room);
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

        if (!room.zone || !room.zone.center) {
            socket.emit('room:error', {
                message: 'Set the safe zone first using the current GPS center before starting the round.'
            });
            return;
        }

        if (room.timerInterval) {
            clearInterval(room.timerInterval);
            room.timerInterval = null;
        }

        room.started = true;
        room.gameState.started = true;
        room.gameState.phase = room.gameState.phase === 'Finished' ? 'Scatter' : (room.gameState.phase || 'Scatter');
        room.gameState.timerSeconds = Number.isFinite(room.gameState.timerSeconds) && room.gameState.timerSeconds > 0 ?
            room.gameState.timerSeconds :
            45 * 60;
        room.gameState.seekerTeam = seekerTeam || room.gameState.seekerTeam || 'Red';
        room.clues = [];
        room.zone = resetZoneState(room.zone);

        reconcileRoomRoles(room);

        ensureRoomTimer(room);
        broadcastRoom(code);
    });

    socket.on('zone:update', ({ roomCode, center, radius, reset }) => {
        const code = String(roomCode || socket.data.roomCode || 'SONIYA').trim().toUpperCase();
        const room = getRoom(code);

        if (reset || !room.zone) {
            let centerValue = room.zone && room.zone.center ? room.zone.center : null;
            if (center) {
                centerValue = center;
            }
            room.zone = resetZoneState({ center: centerValue });
        }

        if (center) {
            room.zone.center = normalizeZoneCenter(center);
        }

        if (Number.isFinite(Number(radius)) && Number(radius) > 0) {
            room.zone.radius = Number(radius);
        } else {
            room.zone.radius = 600;
        }

        room.gameState.phase = room.started ? room.gameState.phase || 'Scatter' : 'Scatter';
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

    socket.on('pause-round', ({ roomCode }) => {
        const code = String(roomCode || socket.data.roomCode || 'SONIYA').trim().toUpperCase();
        const room = getRoom(code);

        if (room.timerInterval) {
            clearInterval(room.timerInterval);
            room.timerInterval = null;
        }

        room.started = false;
        room.gameState.started = false;
        room.gameState.phase = room.gameState.phase === 'Finished' ? 'Finished' : 'Paused';

        io.to(code).emit('round:paused', {
            roomCode: code,
            timerSeconds: room.gameState.timerSeconds,
            phase: room.gameState.phase
        });
        broadcastRoom(code);
    });

    socket.on('end-round', ({ roomCode }) => {
        const code = String(roomCode || socket.data.roomCode || 'SONIYA').trim().toUpperCase();
        const room = getRoom(code);

        if (room.timerInterval) {
            clearInterval(room.timerInterval);
            room.timerInterval = null;
        }

        room.started = false;
        room.gameState.started = false;
        room.gameState.phase = 'Finished';
        room.gameState.timerSeconds = 45 * 60;
        room.clues = [];
        room.zone = resetZoneState({ center: null });

        io.to(code).emit('round:ended');
        broadcastRoom(code);
    });

    socket.on('reset-round', ({ roomCode }) => {
        const code = String(roomCode || socket.data.roomCode || 'SONIYA').trim().toUpperCase();
        const room = getRoom(code);

        if (room.timerInterval) {
            clearInterval(room.timerInterval);
            room.timerInterval = null;
        }

        room.started = false;
        room.gameState.started = false;
        room.gameState.phase = 'Scatter';
        room.gameState.timerSeconds = 45 * 60;
        room.clues = [];
        room.zone = resetZoneState({ center: null });

        broadcastRoom(code);
    });

    socket.on('player:found', ({ roomCode, playerId }) => {
        const code = String(roomCode || socket.data.roomCode || 'SONIYA').trim().toUpperCase();
        const room = getRoom(code);

        const player = room.players.get(playerId) || [...room.players.values()].find((entry) => entry.name === playerId);
        if (!player) return;

        player.role = 'Seeker';
        room.gameState.seekerTeam = player.team || room.gameState.seekerTeam;

        const foundMessage = {
            id: `found-${Date.now()}`,
            team: player.team || 'Game',
            caption: `${player.name} has been found and moved to the seeker team.`,
            image: null,
            createdAt: Date.now()
        };

        room.clues.unshift(foundMessage);
        io.to(code).emit('photo:drop', foundMessage);
        broadcastRoom(code);
    });

    socket.on('photo:drop', ({ roomCode, team, image, caption }) => {
        const code = String(roomCode || socket.data.roomCode || 'SONIYA').trim().toUpperCase();
        const room = getRoom(code);

        if (!room.started) return;
        if (!image) return;

        const clueEntry = {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            team: team || 'Red',
            caption: caption || 'Photo clue dropped',
            image,
            createdAt: Date.now()
        };

        room.clues.unshift(clueEntry);
        room.clues = room.clues.slice(0, 10);

        io.to(code).emit('photo:drop', clueEntry);
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