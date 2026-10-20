import { io } from 'socket.io-client';
import './styles.css';

const pingSchedule = [
    { label: 'Scatter', minutes: 0, radius: '800 m', interval: '—' },
    { label: '0–15', minutes: 15, radius: '800 m', interval: '5 min' },
    { label: '15–25', minutes: 25, radius: '600→450 m', interval: '5 min' },
    { label: '25–45', minutes: 45, radius: '450→300 m', interval: '5 min' },
    { label: '45–65', minutes: 65, radius: '300→200 m', interval: '5 min' },
    { label: '65–85', minutes: 85, radius: '120→80 m', interval: '5 min' },
    { label: '85–100', minutes: 100, radius: '50 m', interval: '2 min' }
];

const SEEKER_PASSWORD = 'seekers-only';

const state = {
    started: false,
    totalSeconds: 90 * 60,
    pingIndex: 0,
    lastBuzz: '—',
    players: [],
    socket: null,
    roomCode: '',
    myName: '',
    timerId: null,
    boundaryRadius: 800,
    teams: [],
    photoClues: [],
    seekerTeam: 'Red',
    locationWatchId: null,
    currentLocation: null,
    mapMarkers: new Map(),
    seekerUnlocked: false
};

const countdownEl = document.getElementById('countdown');
const hidersLeftEl = document.getElementById('hiders-left');
const seekersCountEl = document.getElementById('seekers-count');
const phaseNameEl = document.getElementById('phase-name');
const radiusValueEl = document.getElementById('radius-value');
const zoneStatEl = document.getElementById('zone-stat');
const lastBuzzEl = document.getElementById('last-buzz');
const playersListEl = document.getElementById('team-list');
const seekerPlayerListEl = document.getElementById('seeker-player-list');
const pingScheduleEl = document.getElementById('ping-schedule');
const killFeedEl = document.getElementById('kill-feed');
const startGameButton = document.getElementById('start-game');
const triggerPingButton = document.getElementById('trigger-ping');
const photoButton = document.getElementById('drop-photo');
const markFoundButton = document.getElementById('mark-found');
const panicButton = document.getElementById('panic-button');
const joinRoomButton = document.getElementById('join-room');
const roomCodeInput = document.getElementById('room-code');
const playerNameInput = document.getElementById('player-name');
const teamSelect = document.getElementById('team-select');
const captainToggle = document.getElementById('captain-toggle');
const seekerPasswordInput = document.getElementById('seeker-password');
const unlockSeekerButton = document.getElementById('unlock-seeker');
const seekerGateEl = document.getElementById('seeker-gate');
const seekerViewEl = document.getElementById('seeker-view');

const backendUrl =
    import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';
const mapCenter = [51.513269, -0.131];
let map;
let boundaryLayer;

function formatTime(totalSeconds) {
    const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

function getBoundaryRadius() {
    if (state.totalSeconds > 75 * 60) return 800;
    if (state.totalSeconds > 65 * 60) return 700;
    if (state.totalSeconds > 45 * 60) return 550;
    if (state.totalSeconds > 25 * 60) return 400;
    if (state.totalSeconds > 15 * 60) return 250;
    if (state.totalSeconds > 5 * 60) return 140;
    return 90;
}

function getTeamColor(teamName) {
    switch (teamName) {
        case 'Red':
            return '#d65042';
        case 'Blue':
            return '#355bdb';
        case 'Green':
            return '#2d8a6d';
        default:
            return '#f39c12';
    }
}

function normalizeTeamName(teamName) {
    const value = String(teamName || '').trim();
    if (!value) return 'Unassigned';

    const match = ['Red', 'Blue', 'Green', 'Yellow'].find((team) => team.toLowerCase() === value.toLowerCase());
    return match || 'Unassigned';
}

function getPlayerGroups() {
    const groups = new Map();
    const orderedTeams = ['Red', 'Blue', 'Green', 'Yellow'];

    state.players.forEach((player) => {
        const teamName = normalizeTeamName(player.team);
        if (!groups.has(teamName)) {
            groups.set(teamName, []);
        }
        groups.get(teamName).push(player);
    });

    return orderedTeams.map((teamName) => {
        const players = groups.get(teamName) || [];
        const captainPlayer = players.find((player) => player.captain);
        const captainName = captainPlayer ? captainPlayer.name : (players[0] ? players[0].name : 'Captain');
        const captainLabel = captainName === 'Captain' ? 'Captain' : `${captainName} • captain`;

        return {
            name: teamName,
            captain: captainName,
            captainLabel,
            players: players.map((player) => player.name)
        };
    });
}

function initMap() {
    if (map) return;

    map = L.map('board-map', {
        zoomControl: false,
        attributionControl: true,
        scrollWheelZoom: true,
        dragging: true,
        doubleClickZoom: false,
        tap: false,
    }).setView(mapCenter, 15);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    boundaryLayer = L.circle(mapCenter, {
        radius: 800,
        color: '#18b56a',
        weight: 3,
        fillColor: '#18b56a',
        fillOpacity: 0.12,
        dashArray: '7 10'
    }).addTo(map);

    const spawnMarker = L.circleMarker(mapCenter, {
        radius: 7,
        color: '#f39c12',
        fillColor: '#ffd36d',
        fillOpacity: 1
    }).addTo(map);

    spawnMarker.bindPopup('Rally point');
    map.fitBounds([
        [51.509, -0.14],
        [51.517, -0.11]
    ]);
}

function updateBoundary() {
    if (!boundaryLayer) return;

    const nextRadius = getBoundaryRadius();
    state.boundaryRadius = nextRadius;
    boundaryLayer.setRadius(nextRadius);
    const radiusText = `${nextRadius} m`;
    radiusValueEl.textContent = radiusText;
    if (zoneStatEl) {
        zoneStatEl.textContent = radiusText;
    }
}

function renderMapMarkers() {
    if (!map) return;

    state.mapMarkers.forEach((marker) => map.removeLayer(marker));
    state.mapMarkers.clear();

    const playersWithLocations = state.players.filter((player) => player.location);
    playersWithLocations.forEach((player) => {
        const marker = L.circleMarker([player.location.lat, player.location.lng], {
            radius: player.role === 'Seeker' ? 9 : 7,
            color: getTeamColor(player.team || 'Red'),
            fillColor: player.role === 'Seeker' ? '#ff5a5f' : '#9fe3a6',
            fillOpacity: 1,
            weight: 2
        }).addTo(map);

        marker.bindPopup(`
            <strong>${player.name}</strong><br>
            ${player.team || 'Unassigned'} • ${player.role || 'Hider'}<br>
            ${player.location.lat.toFixed(5)}, ${player.location.lng.toFixed(5)}
        `);

        state.mapMarkers.set(player.id, marker);
    });
}

function renderPlayers() {
    playersListEl.innerHTML = '';
    state.teams = getPlayerGroups();

    if (!state.teams.length) {
        playersListEl.innerHTML = '<div class="empty-state">No players in this room yet. Join with a room code to sync live teams.</div>';
        hidersLeftEl.textContent = '0';
        seekersCountEl.textContent = '0';
        return;
    }

    state.teams.forEach((team) => {
        const teamCard = document.createElement('div');
        const teamClass = `team-${team.name.toLowerCase()}`;
        teamCard.className = `team-card ${teamClass}`;

        const members = team.players.length ?
            team.players.map((member) => `<span class="team-member">${member}</span>`).join('') :
            '<span class="team-member empty">No players yet</span>';

        teamCard.innerHTML = `
            <div class="team-topline">
                <strong>${team.name}</strong>
                <span class="player-role role-${team.name.toLowerCase()}">${team.captainLabel}</span>
            </div>
            <div class="team-members">${members}</div>
        `;
        playersListEl.appendChild(teamCard);
    });

    const hiders = state.players.filter((player) => player.role !== 'Seeker').length;
    const seekers = state.players.filter((player) => player.role === 'Seeker').length;
    hidersLeftEl.textContent = String(hiders);
    seekersCountEl.textContent = String(seekers);
}

function renderSeekerView() {
    if (!seekerPlayerListEl) return;
    seekerPlayerListEl.innerHTML = '';

    if (!state.players.length) {
        seekerPlayerListEl.innerHTML = '<div class="empty-state">No players connected yet.</div>';
        return;
    }

    const list = state.players
        .map((player) => `
            <div class="player-row">
                <span>${player.name}</span>
                <strong>${player.role || 'Hider'}</strong>
            </div>
        `)
        .join('');

    seekerPlayerListEl.innerHTML = list;
}

function renderSchedule() {
    pingScheduleEl.innerHTML = '';
    pingSchedule.forEach((step) => {
        const item = document.createElement('div');
        item.className = 'timeline-item';
        item.innerHTML = `
      <strong>${step.label}</strong>
      <span>Radius: ${step.radius}</span>
      <small>Interval: ${step.interval}</small>
    `;
        pingScheduleEl.appendChild(item);
    });
}

function renderFeed() {
    const feedEntries = [
        ...state.photoClues.map((clue) => ({
            type: 'photo',
            text: `${clue.team} captain ${clue.captain} dropped a photo clue.`,
            image: clue.image,
            caption: clue.caption
        })),
        ...state.photoClues.map((clue) => ({
            type: 'note',
            text: `${clue.team} • ${clue.caption}`
        }))
    ];

    killFeedEl.innerHTML = '';
    feedEntries.slice(0, 7).forEach((entry) => {
        const li = document.createElement('li');

        if (entry.type === 'photo') {
            li.innerHTML = `
                <div>${entry.text}</div>
                <img src="${entry.image}" alt="Photo clue" style="width: 100%; max-height: 180px; object-fit: cover; border-radius: 10px; margin-top: 8px;" />
                <small style="display:block; margin-top: 6px; color: #5a6479;">${entry.caption}</small>
            `;
        } else {
            li.textContent = entry.text;
        }

        killFeedEl.appendChild(li);
    });
}

function updatePhaseName() {
    const phase = pingSchedule[state.pingIndex];
    phaseNameEl.textContent = phase ? phase.label : 'Endgame';
    radiusValueEl.textContent = phase ? phase.radius : '50 m';
}

function triggerPing() {
    const phase = pingSchedule[state.pingIndex];
    state.lastBuzz = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    lastBuzzEl.textContent = state.lastBuzz;

    const circles = document.querySelectorAll('.ping-circle');
    circles.forEach((circle, idx) => {
        const baseRadius = 56 + idx * 8;
        circle.setAttribute('r', Math.max(18, baseRadius * (state.pingIndex / 6 + 0.4)));
        circle.style.opacity = '1';
    });

    const headline = phase ? `${phase.label} ping — ${phase.radius}` : 'Endgame ping';
    const pingEntry = `Ping: ${headline}`;
    state.photoClues.unshift({
        id: `ping-${Date.now()}`,
        team: 'Game',
        captain: 'System',
        caption: pingEntry,
        image: null,
        createdAt: Date.now()
    });
    renderFeed();

    state.pingIndex = Math.min(state.pingIndex + 1, pingSchedule.length - 1);
    updatePhaseName();
}

function startTimer() {
    state.started = true;
    countdownEl.textContent = formatTime(state.totalSeconds);
    updateBoundary();
}

function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function dropPhotoClue() {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';

    fileInput.addEventListener('change', async(event) => {
        const [file] = event.target.files || [];
        if (!file) return;

        const dataUrl = await fileToDataUrl(file);
        const clue = {
            team: state.seekerTeam || 'Red',
            captain: state.myName || 'Captain',
            caption: 'Photo clue dropped for the team',
            image: dataUrl,
            createdAt: Date.now()
        };

        state.photoClues.unshift(clue);
        if (state.socket) {
            state.socket.emit('photo:drop', {
                roomCode: state.roomCode,
                team: clue.team,
                captain: clue.captain,
                image: clue.image,
                caption: clue.caption
            });
        }

        renderFeed();
    });

    fileInput.click();
}

function markFoundPlayer() {
    const available = (state.players || []).filter((player) => player.role !== 'Seeker');
    if (!available.length) {
        state.photoClues.unshift({
            id: `found-${Date.now()}`,
            team: 'Game',
            captain: 'System',
            caption: 'No active hidden player left to convert.',
            image: null,
            createdAt: Date.now()
        });
        renderFeed();
        return;
    }

    const target = available[0];
    target.role = 'Seeker';
    state.seekerTeam = target.team || state.seekerTeam;

    if (state.socket) {
        state.socket.emit('player:found', {
            roomCode: state.roomCode,
            playerId: target.id
        });
    }

    state.photoClues.unshift({
        id: `found-${Date.now()}`,
        team: target.team || 'Game',
        captain: target.name,
        caption: `${target.name} has been found and moved to the seeker team.`,
        image: null,
        createdAt: Date.now()
    });

    renderFeed();
    renderPlayers();
    renderMapMarkers();
    renderSeekerView();
}

function triggerPanic() {
    state.photoClues.unshift({
        id: `panic-${Date.now()}`,
        team: 'Game',
        captain: 'System',
        caption: 'Panic button: everyone regroup at the rally point.',
        image: null,
        createdAt: Date.now()
    });
    renderFeed();
    phaseNameEl.textContent = 'Panic';
    radiusValueEl.textContent = 'freeze';
    state.started = false;
}

function watchLocation() {
    if (!navigator.geolocation) {
        state.photoClues.unshift({
            id: `gps-${Date.now()}`,
            team: 'System',
            captain: 'Device',
            caption: 'Geolocation is not available on this browser.',
            image: null,
            createdAt: Date.now()
        });
        renderFeed();
        return;
    }

    const sendLocation = ({ coords }) => {
        const payload = {
            lat: coords.latitude,
            lng: coords.longitude,
            accuracy: coords.accuracy || 0
        };

        state.currentLocation = payload;

        if (state.socket && state.roomCode) {
            state.socket.emit('location:update', payload);
        }
    };

    state.locationWatchId = navigator.geolocation.watchPosition(sendLocation, () => {}, {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 60000
    });
}

function unlockSeekerView() {
    const enteredPassword = seekerPasswordInput.value.trim();
    if (enteredPassword !== SEEKER_PASSWORD) {
        seekerPasswordInput.value = '';
        seekerPasswordInput.placeholder = 'Wrong password';
        return;
    }

    state.seekerUnlocked = true;
    seekerGateEl.classList.add('hidden');
    seekerViewEl.classList.remove('hidden');
    renderSeekerView();
}

function syncRoomState(snapshot = {}) {
    const nextPlayers = Array.isArray(snapshot.players) ? snapshot.players : state.players;
    state.players = nextPlayers;
    state.roomCode = snapshot.roomCode || state.roomCode;

    if (snapshot.gameState) {
        state.started = Boolean(snapshot.gameState.started || state.started);
        if (snapshot.gameState.seekerTeam) state.seekerTeam = snapshot.gameState.seekerTeam;

        if (typeof snapshot.gameState.timerSeconds === 'number' && snapshot.gameState.timerSeconds >= 0) {
            state.totalSeconds = snapshot.gameState.timerSeconds;
        }

        countdownEl.textContent = formatTime(state.totalSeconds);
        phaseNameEl.textContent = snapshot.gameState.phase || 'Scatter';
        if (snapshot.gameState.phase === 'Scatter') {
            radiusValueEl.textContent = '800 m';
        }
    }

    if (Array.isArray(snapshot.clues) && snapshot.clues.length) {
        state.photoClues = snapshot.clues.slice(0, 5);
    }

    renderPlayers();
    renderMapMarkers();
    renderSeekerView();
    renderFeed();
}

function updateMyTeamAssignment() {
    if (!state.socket || !state.roomCode) return;

    state.socket.emit('player:assign', {
        roomCode: state.roomCode,
        playerId: state.socket.id,
        team: teamSelect.value || 'Red',
        captain: captainToggle.checked
    });
}

function connectSocket() {
    const socket = io(backendUrl, { transports: ['websocket', 'polling'] });
    state.socket = socket;

    socket.on('connect', () => {
        const name = playerNameInput.value.trim() || 'Player One';
        const roomCode = roomCodeInput.value.trim().toUpperCase() || 'SONIYA';
        const selectedTeam = teamSelect.value || 'Red';
        state.roomCode = roomCode;
        state.myName = name;
        socket.emit('join-room', {
            roomCode,
            name,
            team: selectedTeam,
            captain: captainToggle.checked
        });
        watchLocation();
    });

    socket.on('room:update', ({ players, roomCode, gameState, clues }) => {
        syncRoomState({ players, roomCode, gameState, clues });
    });

    socket.on('ping:triggered', ({ phase }) => {
        if (phase) {
            phaseNameEl.textContent = phase;
            radiusValueEl.textContent = phase === 'Scatter' ? '800 m' : 'Ping';
        }
        triggerPing();
    });

    socket.on('photo:drop', (clue) => {
        if (!clue) return;
        state.photoClues.unshift(clue);
        renderFeed();
    });
}

function joinRoom() {
    if (!state.socket) {
        connectSocket();
        return;
    }

    state.myName = playerNameInput.value.trim() || 'Player One';
    state.roomCode = roomCodeInput.value.trim().toUpperCase() || 'SONIYA';

    const optimisticPlayer = {
        id: state.socket.id || `local-${Date.now()}`,
        name: state.myName,
        team: teamSelect.value || 'Red',
        role: 'Hider',
        captain: Boolean(captainToggle.checked),
        location: null
    };

    const existingPlayers = (state.players || []).filter((player) => player.name !== state.myName);
    state.players = [...existingPlayers, optimisticPlayer];

    renderPlayers();
    renderMapMarkers();
    renderSeekerView();

    state.socket.emit('join-room', {
        roomCode: state.roomCode,
        name: state.myName,
        team: teamSelect.value || 'Red',
        captain: captainToggle.checked
    });
}

startGameButton.addEventListener('click', () => {
    if (state.socket) {
        state.socket.emit('start-game', { roomCode: state.roomCode, seekerTeam: state.seekerTeam });
    }
    state.started = true;
    startTimer();
    triggerPing();
    updateBoundary();
});

triggerPingButton.addEventListener('click', () => {
    if (state.socket) {
        state.socket.emit('trigger-ping', { roomCode: state.roomCode });
    }
    triggerPing();
});

photoButton.addEventListener('click', dropPhotoClue);
markFoundButton.addEventListener('click', markFoundPlayer);
panicButton.addEventListener('click', triggerPanic);
joinRoomButton.addEventListener('click', joinRoom);
teamSelect.addEventListener('change', updateMyTeamAssignment);
captainToggle.addEventListener('change', updateMyTeamAssignment);
unlockSeekerButton.addEventListener('click', unlockSeekerView);
seekerPasswordInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        unlockSeekerView();
    }
});

initMap();
renderPlayers();
renderSchedule();
renderFeed();
renderSeekerView();
updateBoundary();
countdownEl.textContent = formatTime(state.totalSeconds);
updatePhaseName();
countdownEl.textContent = formatTime(state.totalSeconds);
renderPlayers();
updateBoundary();
connectSocket();